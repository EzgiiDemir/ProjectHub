import { spawn } from 'node:child_process';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { audit, PermanentJobError, publish, readSecret, SYSTEM_ACTOR, timeline, type AppConfig, type JobContext } from '@projecthub/core';
import { backupRestores, backups, environments, migrationRuns, projectMigrations, versions, type Executor } from '@projecthub/database';
import type { WorkerCtx } from '../context.js';
import { databaseUrl, dumpDatabase } from './deploy.js';

/** pg_restore lives next to pg_dump (same PostgreSQL client installation). */
export function pgRestoreBinary(config: AppConfig): string {
  return config.PG_DUMP_BINARY.replace(/pg_dump(\.exe)?$/i, (_m, ext: string | undefined) => `pg_restore${ext ?? ''}`);
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 30 * 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${bin} başlatılamadı: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Verifies a dump is readable: pg_restore must list its table of contents (spec §53 "Verify"). */
export async function verifyBackupFile(ctx: WorkerCtx, backupId: string): Promise<{ ok: boolean; message: string }> {
  const b = (await ctx.db.select().from(backups).where(eq(backups.id, backupId)))[0];
  if (!b?.location) return { ok: false, message: 'Yedek dosyası yok' };
  const r = await run(pgRestoreBinary(ctx.config), ['--list', ctx.storage.resolve(b.location)], process.env, 5 * 60_000);
  if (r.code !== 0) return { ok: false, message: r.stderr.trim().slice(0, 300) || `pg_restore çıkış kodu ${r.code}` };
  const tables = r.stdout.split('\n').filter((l) => / TABLE DATA /.test(l)).length;
  await ctx.db.update(backups).set({ verifiedAt: new Date() }).where(eq(backups.id, backupId));
  return { ok: true, message: `${tables} tablo verisi okunabilir` };
}

export async function verifyBackup(ctx: WorkerCtx, { job }: JobContext) {
  const { backupId } = job.payload as { backupId: string };
  const r = await verifyBackupFile(ctx, backupId);
  const b = (await ctx.db.select().from(backups).where(eq(backups.id, backupId)))[0];
  if (b) {
    await timeline(ctx.db, { organizationId: b.organizationId, projectId: b.projectId, kind: 'deploy', tone: r.ok ? 'ok' : 'bad', title: r.ok ? 'Yedek doğrulandı' : 'Yedek doğrulanamadı', description: r.message });
    await publish(ctx.db, { type: 'backup.updated', organizationId: b.organizationId, projectId: b.projectId });
  }
  return r;
}

/** Drops every user schema (recreating an empty `public`) in one transaction. Returns an error message or null. */
async function resetUserSchemas(url: string): Promise<string | null> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
    await client.query('BEGIN');
    const { rows } = await client.query<{ name: string }>(
      `SELECT nspname AS name FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`,
    );
    for (const { name } of rows) await client.query(`DROP SCHEMA ${pg.escapeIdentifier(name)} CASCADE`);
    await client.query('CREATE SCHEMA public');
    await client.query('COMMIT');
    return null;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    return `Hedef veritabanı temizlenemedi: ${(e as Error).message}`;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Restores a backup into an environment's database. A safety dump of the target is always taken first, so the
 * restore itself can be undone; production restores reach this job only after a second person approved them.
 */
export async function restoreBackup(ctx: WorkerCtx, { job }: JobContext) {
  const { restoreId } = job.payload as { restoreId: string };
  const r = (await ctx.db.select().from(backupRestores).where(eq(backupRestores.id, restoreId)))[0];
  if (!r) throw new PermanentJobError('restore not found');
  if (r.status !== 'queued') return { skipped: r.status };
  const b = (await ctx.db.select().from(backups).where(eq(backups.id, r.backupId)))[0];
  const env = (await ctx.db.select().from(environments).where(eq(environments.id, r.environmentId)))[0];
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const finish = async (status: 'completed' | 'failed', error: string | null) => {
    await ctx.db.update(backupRestores).set({ status, error, log: lines.join('\n').slice(0, 20_000), finishedAt: new Date() }).where(eq(backupRestores.id, r.id));
    await audit(ctx.db, { organizationId: r.organizationId, projectId: r.projectId, actor: SYSTEM_ACTOR, action: `database.restore_${status}`, resourceType: 'backup', resourceId: r.backupId, metadata: { environment: env?.name, error } });
    await timeline(ctx.db, { organizationId: r.organizationId, projectId: r.projectId, kind: 'deploy', tone: status === 'completed' ? 'ok' : 'bad', title: `${env?.name ?? 'Ortam'} veritabanı geri yükleme ${status === 'completed' ? 'tamamlandı' : 'başarısız'}`, description: error ?? lines.at(-1) ?? '' });
    await publish(ctx.db, { type: 'backup.updated', organizationId: r.organizationId, projectId: r.projectId });
    return { status, error };
  };
  await ctx.db.update(backupRestores).set({ status: 'running' }).where(eq(backupRestores.id, r.id));
  await publish(ctx.db, { type: 'backup.updated', organizationId: r.organizationId, projectId: r.projectId });
  if (!b?.location || b.status !== 'completed') return finish('failed', 'Yedek dosyası kullanılamıyor');
  if (!env) return finish('failed', 'Ortam bulunamadı');
  const target = await databaseUrl(ctx, env.id);
  if (!target) return finish('failed', `${env.name} için veritabanı bağlantısı tanımlı değil`);
  let safetyId: string | null;
  try {
    log(`Güvenlik yedeği alınıyor (${env.name})…`);
    safetyId = await dumpDatabase(ctx, { organizationId: r.organizationId, projectId: r.projectId, environmentId: env.id, deploymentId: null, versionLabel: 'geri-yükleme-öncesi', createdBy: r.requestedBy }, log);
    log(`Güvenlik yedeği: ${safetyId}`);
  } catch (e) {
    return finish('failed', `Güvenlik yedeği alınamadı, geri yükleme yapılmadı: ${(e as Error).message}`);
  }
  const password = target.conn.passwordSecretId ? await readSecret(ctx.db, ctx.config.encryptionKey, target.conn.passwordSecretId) : '';
  const restoreFrom = async (file: string) => {
    // Restoring means "the database looks exactly like the backup": objects created after it must go too, which
    // pg_restore --clean alone would keep. User schemas are emptied first; pg_restore then runs as one transaction.
    const reset = await resetUserSchemas(target.url);
    if (reset) return reset;
    const res = await run(
      pgRestoreBinary(ctx.config),
      ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '-h', target.conn.host, '-p', String(target.conn.port), '-U', target.conn.username, '-d', target.conn.databaseName, '--no-password', file],
      { ...process.env, PGPASSWORD: password, PGSSLMODE: target.conn.sslMode, PGCONNECT_TIMEOUT: '15' },
    );
    return res.code === 0 ? null : res.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500) || `pg_restore çıkış kodu ${res.code}`;
  };
  log(`pg_restore → ${target.conn.host}:${target.conn.port}/${target.conn.databaseName}`);
  const failure = await restoreFrom(ctx.storage.resolve(b.location));
  if (failure) {
    log(failure);
    const safety = safetyId ? (await ctx.db.select().from(backups).where(eq(backups.id, safetyId)))[0] : null;
    if (!safety?.location) return finish('failed', `${failure} — güvenlik yedeği de yok, veritabanını kontrol edin`);
    log('Geri yükleme başarısız; güvenlik yedeğine dönülüyor…');
    const back = await restoreFrom(ctx.storage.resolve(safety.location));
    return finish('failed', back ? `${failure} — güvenlik yedeğine dönülemedi: ${back}` : `${failure} — veritabanı geri yükleme öncesi haline döndürüldü`);
  }
  log('Geri yükleme tamamlandı');
  return finish('completed', null);
}

/**
 * After a deployment ran its migration command successfully, every migration that belongs to the deployed
 * version (or an earlier one) counts as applied in that environment (spec §44, §52).
 */
export async function recordMigrationRuns(db: Executor, input: { projectId: string; environmentId: string; deploymentId: string; versionId: string }) {
  const due = await db
    .select({ id: projectMigrations.id })
    .from(projectMigrations)
    .innerJoin(versions, eq(versions.id, projectMigrations.firstVersionId))
    .where(and(eq(projectMigrations.projectId, input.projectId), sql`${versions.createdAt} <= (select v2.created_at from versions v2 where v2.id = ${input.versionId})`));
  if (!due.length) return 0;
  const rows = await db
    .insert(migrationRuns)
    .values(due.map((m) => ({ migrationId: m.id, environmentId: input.environmentId, deploymentId: input.deploymentId })))
    .onConflictDoNothing()
    .returning({ id: migrationRuns.id });
  return rows.length;
}
