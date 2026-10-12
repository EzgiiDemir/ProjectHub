import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, count, eq, inArray, lt, sql } from 'drizzle-orm';
import pg from 'pg';
import type { Manifest, StepStatus } from '@projecthub/contracts';
import {
  audit,
  copyDir,
  emitDomainEvent,
  enqueue,
  getOrgSettings,
  nextNumber,
  PermanentJobError,
  publish,
  QUEUES,
  readSecret,
  resolveEnvSecrets,
  sha256,
  SYSTEM_ACTOR,
  timeline,
  type JobContext,
  missingRequiredEnv,
} from '@projecthub/core';
import {
  aiRemediations,
  artifacts,
  backups,
  builds,
  databaseConnections,
  deployments,
  deploymentSteps,
  deploymentTargets,
  environments,
  healthChecks,
  incidents,
  previews,
  projects,
  securityFindings,
  users,
  versions,
} from '@projecthub/database';
import { loadProject, type WorkerCtx } from '../context.js';
import { createAdapter, type ReleaseRef } from '../deploy/adapters.js';
import { recordMigrationRuns, verifyBackupFile } from './database.js';
import { BuildLog, runCommand, runtimeEnv, sanitizedEnv } from '../runner/process.js';
import { registerPeriodic } from './maintenance.js';

type StepKey = 'policy' | 'artifact' | 'prepare' | 'backup' | 'migrate' | 'deploy' | 'post' | 'health' | 'smoke' | 'finalize';
const STEPS: [StepKey, string][] = [
  ['policy', 'Yetki ve policy kontrolü'],
  ['artifact', 'Versiyon ve artifact doğrulama'],
  ['prepare', 'Yayın paketi hazırlama'],
  ['backup', 'Yedekleme'],
  ['migrate', 'Veritabanı migration'],
  ['deploy', 'Yayına alma'],
  ['post', 'Sunucu komutu'],
  ['health', 'Sağlık kontrolü'],
  ['smoke', 'Smoke test'],
  ['finalize', 'Sürüm kaydı'],
];

class StepFailed extends Error {}

export async function databaseUrl(ctx: WorkerCtx, environmentId: string): Promise<{ url: string; conn: typeof databaseConnections.$inferSelect } | null> {
  const conn = (await ctx.db.select().from(databaseConnections).where(eq(databaseConnections.environmentId, environmentId)))[0];
  if (!conn) return null;
  const password = conn.passwordSecretId ? await readSecret(ctx.db, ctx.config.encryptionKey, conn.passwordSecretId) : '';
  const url = `postgresql://${encodeURIComponent(conn.username)}:${encodeURIComponent(password)}@${conn.host}:${conn.port}/${encodeURIComponent(conn.databaseName)}?sslmode=${conn.sslMode}`;
  return { url, conn };
}

/** pg_dump in custom format into STORAGE_DIR/backups (spec §31, §53). */
export async function dumpDatabase(ctx: WorkerCtx, input: { organizationId: string; projectId: string; environmentId: string; deploymentId: string | null; versionLabel: string | null; createdBy: string | null }, log: (l: string) => void) {
  const db = await databaseUrl(ctx, input.environmentId);
  if (!db) return null;
  const password = db.conn.passwordSecretId ? await readSecret(ctx.db, ctx.config.encryptionKey, db.conn.passwordSecretId) : '';
  const row = (
    await ctx.db
      .insert(backups)
      .values({ organizationId: input.organizationId, projectId: input.projectId, environmentId: input.environmentId, deploymentId: input.deploymentId, versionLabel: input.versionLabel, type: 'database', status: 'running', createdBy: input.createdBy })
      .returning()
  )[0]!;
  const key = ctx.storage.backupKey(input.projectId, `${row.id}.dump`);
  await fs.mkdir(path.dirname(ctx.storage.resolve(key)), { recursive: true });
  const args = ['-h', db.conn.host, '-p', String(db.conn.port), '-U', db.conn.username, '-d', db.conn.databaseName, '-Fc', '-f', ctx.storage.resolve(key), '--no-password'];
  log(`pg_dump ${db.conn.host}:${db.conn.port}/${db.conn.databaseName}`);
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(ctx.config.PG_DUMP_BINARY, args, { env: { ...process.env, PGPASSWORD: password, PGSSLMODE: db.conn.sslMode, PGCONNECT_TIMEOUT: '15' }, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => resolve({ code: -1, stderr: `pg_dump başlatılamadı: ${e.message}` }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
  if (result.code !== 0) {
    await ctx.db.update(backups).set({ status: 'failed', error: result.stderr.slice(0, 2000) }).where(eq(backups.id, row.id));
    throw new Error(`Veritabanı yedeği alınamadı: ${result.stderr.trim().slice(0, 300)}`);
  }
  const buf = await fs.readFile(ctx.storage.resolve(key));
  await ctx.db.update(backups).set({ status: 'completed', location: key, sizeBytes: buf.length, checksum: sha256(buf) }).where(eq(backups.id, row.id));
  // A backup only counts as verified once pg_restore can read its table of contents.
  const check = await verifyBackupFile(ctx, row.id);
  log(check.ok ? `Yedek doğrulandı: ${check.message}` : `Uyarı: yedek doğrulanamadı — ${check.message}`);
  log(`Yedek alındı: ${(buf.length / 1024 / 1024).toFixed(2)} MB · ${row.id}`);
  return row.id;
}

export async function httpCheck(url: string, timeoutMs = 10_000): Promise<{ ok: boolean; status: number | null; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { 'user-agent': 'ProjectHub-HealthCheck/1.0' } });
    return { ok: res.status < 400, status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: null, ms: Date.now() - started, error: (e as Error).message };
  }
}

/** Durable deployment workflow (spec §45, §95). Each step is recorded; failures after the swap roll back. */
export async function executeDeployment(ctx: WorkerCtx, { job, logger }: JobContext) {
  const { deploymentId } = job.payload as { deploymentId: string };
  const db = ctx.db;
  const d = (await db.select().from(deployments).where(eq(deployments.id, deploymentId)))[0];
  if (!d) throw new PermanentJobError('deployment not found');
  if (d.status === 'running') return interruptedDeployment(ctx, d);
  if (d.status !== 'queued') return { skipped: d.status };
  const project = await loadProject(ctx, d.projectId);
  const env = (await db.select().from(environments).where(eq(environments.id, d.environmentId)))[0]!;
  const v = (await db.select().from(versions).where(eq(versions.id, d.versionId)))[0]!;
  const target = (await db.select().from(deploymentTargets).where(eq(deploymentTargets.environmentId, env.id)))[0];
  const logKey = ctx.storage.deploymentLogKey(project.id, d.id);
  await fs.mkdir(path.dirname(ctx.storage.resolve(logKey)), { recursive: true });
  const log = new BuildLog(ctx.storage.resolve(logKey));
  const notify = () => publish(db, { type: 'deployment.updated', organizationId: d.organizationId, projectId: d.projectId, id: d.id });
  await db.delete(deploymentSteps).where(eq(deploymentSteps.deploymentId, d.id));
  const stepIds = new Map<StepKey, string>();
  for (const [i, [key, name]] of STEPS.entries()) {
    stepIds.set(key, (await db.insert(deploymentSteps).values({ deploymentId: d.id, key, name, seq: i }).returning({ id: deploymentSteps.id }))[0]!.id);
  }
  await db.update(deployments).set({ status: 'running', startedAt: new Date() }).where(eq(deployments.id, d.id));
  await notify();
  const step = async (key: StepKey, status: StepStatus, output?: string) => {
    await db
      .update(deploymentSteps)
      .set({ status, ...(status === 'running' ? { startedAt: new Date() } : { finishedAt: new Date() }), ...(output !== undefined ? { output: output.slice(0, 4000) } : {}) })
      .where(eq(deploymentSteps.id, stepIds.get(key)!));
    await notify();
  };
  const run = async (key: StepKey, fn: () => Promise<string | void>) => {
    await step(key, 'running');
    log.section(STEPS.find((s) => s[0] === key)![1]);
    try {
      const out = await fn();
      await step(key, 'passed', out ?? '');
      if (out) log.line(out);
    } catch (e) {
      const msg = (e as Error).message;
      log.line(`HATA: ${msg}`);
      await step(key, 'failed', msg);
      throw new StepFailed(msg);
    }
  };
  const skip = async (key: StepKey, reason: string) => {
    await step(key, 'skipped', reason);
    log.section(`${STEPS.find((s) => s[0] === key)![1]} — atlandı: ${reason}`);
  };

  const workspace = ctx.storage.resolve(ctx.storage.workspaceKey('deploy', d.id));
  let release: ReleaseRef | null = null;
  let adapter: ReturnType<typeof createAdapter> | null = null;
  let manifest: Manifest | null = null;
  let artifactDir = '';
  let deployed = false;
  try {
    await run('policy', async () => {
      if (!target) throw new Error('Deployment hedefi tanımlı değil');
      if (d.requestedBy) {
        const u = (await db.select({ status: users.status }).from(users).where(eq(users.id, d.requestedBy)))[0];
        if (u?.status !== 'active') throw new Error('Deployment\'ı isteyen kullanıcı artık aktif değil');
      }
      if (env.type === 'production' && !d.policyOverride) {
        const crit = (await db.select({ n: count() }).from(securityFindings).where(and(eq(securityFindings.projectId, project.id), eq(securityFindings.status, 'open'), eq(securityFindings.severity, 'critical'))))[0]?.n ?? 0;
        if (crit > 0) throw new Error(`${crit} açık kritik güvenlik bulgusu var; production policy deployment'ı engelliyor`);
      }
      return `${env.name} (${env.type}) · ${target.adapter.toUpperCase()} · ${d.policyOverride ? `policy istisnası: ${d.policyOverride.by} — ${d.policyOverride.reason}` : 'policy uygun'}`;
    });

    await run('artifact', async () => {
      const b = (await db.select().from(builds).where(eq(builds.id, v.buildId)))[0];
      if (!b?.artifactId) throw new Error('Versiyonun build artifact\'ı yok');
      const a = (await db.select().from(artifacts).where(eq(artifacts.id, b.artifactId)))[0];
      if (!a || !(await ctx.storage.exists(a.storageKey))) throw new Error('Artifact dosyaları bulunamadı');
      artifactDir = ctx.storage.resolve(a.storageKey);
      manifest = b.manifest;
      return `v${v.version} · build #${b.number} · ${v.commitSha.slice(0, 7)}`;
    });

    await run('prepare', async () => {
      const m = manifest!;
      const source = m.deploy?.source ?? (m.build?.output ?? '.');
      const src = path.resolve(artifactDir, source);
      if (!src.startsWith(artifactDir)) throw new Error('deploy.source artifact dışını gösteremez');
      try {
        await fs.access(src);
      } catch {
        throw new Error(`Yayın klasörü bulunamadı: ${source} (manifest deploy.source)`);
      }
      const exclude = new Set(['.git', ...(target!.adapter === 'local' ? [] : ['node_modules']), ...(m.deploy?.exclude ?? [])]);
      await fs.rm(workspace, { recursive: true, force: true });
      await copyDir(src, workspace, (rel) => !rel.split('/').some((seg) => exclude.has(seg)) && !/(^|\/)\.env$/.test(rel));
      const files = await fs.readdir(workspace, { recursive: true });
      const known = await resolveEnvSecrets(db, ctx.config.encryptionKey, { organizationId: d.organizationId, projectId: project.id, environmentId: env.id, scope: 'runtime' });
      const missing = missingRequiredEnv(m, known);
      if (missing.length) log.line(`Uyarı: manifestte zorunlu olan ${missing.join(', ')} için ${env.name} ortamında secret yok; değer sunucuda tanımlı değilse uygulama başlamayabilir.`);
      return `${source} → ${files.length} öğe (hariç: ${[...exclude].join(', ')})${missing.length ? ` · eksik zorunlu değişken: ${missing.join(', ')}` : ''}`;
    });

    if (d.backup) {
      await run('backup', async () => {
        const id = await dumpDatabase(ctx, { organizationId: d.organizationId, projectId: project.id, environmentId: env.id, deploymentId: d.id, versionLabel: v.version, createdBy: d.requestedBy }, (l) => log.line(l));
        return id ? `Veritabanı yedeği: ${id}; dosyalar için önceki sürüm hedefte saklanır` : 'Veritabanı bağlantısı tanımlı değil; dosyalar için önceki sürüm hedefte saklanır';
      });
    } else await skip('backup', 'Bu deployment için yedekleme kapatıldı');

    const migrateCmd = (manifest as Manifest | null)?.database.migrate?.command;
    const migrationsSummary = v.migrations.length ? v.migrations.map((m) => `${m.name} [${m.risk}] ${m.operations.join(', ')}`).join('\n') : 'Yeni migration yok';
    if (d.runMigrations && migrateCmd) {
      await run('migrate', async () => {
        const dbUrl = await databaseUrl(ctx, env.id);
        const secrets = await resolveEnvSecrets(db, ctx.config.encryptionKey, { organizationId: d.organizationId, projectId: project.id, environmentId: env.id, scope: 'deploy' });
        if (!dbUrl && !secrets.DATABASE_URL) throw new Error('Migration için veritabanı bağlantısı (Veritabanı sayfası) veya DATABASE_URL secret\'ı gerekli');
        log.line(migrationsSummary);
        const r = await runCommand({
          command: migrateCmd,
          cwd: artifactDir,
          env: sanitizedEnv({ ...runtimeEnv((manifest as Manifest | null)?.runtime?.type), ...secrets, ...(dbUrl ? { DATABASE_URL: dbUrl.url } : {}) }),
          timeoutMs: 15 * 60_000,
          onOutput: (t) => log.write(t),
        });
        log.flush();
        if (r.exitCode !== 0) throw new Error(`Migration başarısız (çıkış kodu ${r.exitCode}). Uygulama yayına alınmadı; yedekten geri dönüş mümkün.`);
        // The migrations are in the database now, even if a later step fails — record them per environment.
        const recorded = await recordMigrationRuns(db, { projectId: project.id, environmentId: env.id, deploymentId: d.id, versionId: v.id });
        return `${v.migrations.length} yeni migration bu sürümde · ${recorded} migration bu ortamda uygulandı olarak kaydedildi\n${migrationsSummary}`;
      });
    } else await skip('migrate', !migrateCmd ? `Manifestte migrate komutu yok. ${migrationsSummary}` : 'Migration çalıştırma kapatıldı');

    adapter = createAdapter(target!, target!.credentialSecretId ? await readSecret(db, ctx.config.encryptionKey, target!.credentialSecretId) : null);
    await run('deploy', async () => {
      release = await adapter!.deploy(workspace, `${d.number}-${Date.now().toString(36)}`, (l) => log.line(l));
      deployed = true;
      await db.update(deployments).set({ releaseRef: release.releaseId }).where(eq(deployments.id, d.id));
      return `Yayında: ${target!.adapter === 'local' ? target!.remotePath : `${target!.host}:${target!.remotePath}`}`;
    });

    const post = target!.configuration.postDeployCommand;
    if (post && target!.adapter === 'ssh' && adapter.exec) {
      await run('post', async () => {
        const code = await adapter!.exec!(post, (l) => log.line(l));
        if (code !== 0) throw new Error(`Sunucu komutu başarısız (çıkış kodu ${code})`);
        return post;
      });
    } else await skip('post', post ? 'Sunucu komutu yalnızca SSH adaptöründe çalışır' : 'Tanımlı sunucu komutu yok');

    if (env.url) {
      await run('health', async () => {
        const url = new URL(env.healthPath || manifest!.health.path, env.url).toString();
        let last: Awaited<ReturnType<typeof httpCheck>> | null = null;
        for (let i = 0; i < 10; i++) {
          last = await httpCheck(url);
          log.line(`${url} → ${last.status ?? last.error} (${last.ms} ms)`);
          if (last.ok) break;
          await new Promise((r) => setTimeout(r, 3_000));
        }
        await db.insert(healthChecks).values({ environmentId: env.id, ok: !!last?.ok, httpStatus: last?.status ?? null, latencyMs: last?.ms ?? null, error: last?.error ?? null });
        if (!last?.ok) throw new Error(`Sağlık kontrolü başarısız: ${url} → ${last?.status ?? last?.error}`);
        return `${url} → HTTP ${last.status} (${last.ms} ms)`;
      });
      const paths = manifest!.smoke?.paths ?? ['/'];
      await run('smoke', async () => {
        const results: string[] = [];
        for (const p of paths) {
          const r = await httpCheck(new URL(p, env.url).toString());
          results.push(`${p} → ${r.status ?? r.error} (${r.ms} ms)`);
          if (!r.ok) throw new Error(`Smoke test başarısız: ${results.join(', ')}`);
        }
        return results.join('\n');
      });
    } else {
      await skip('health', 'Ortam adresi (URL) tanımlı değil');
      await skip('smoke', 'Ortam adresi (URL) tanımlı değil');
    }

    await run('finalize', async () => {
      await db.transaction(async (tx) => {
        await tx.update(deployments).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(deployments.id, d.id));
        await tx.update(environments).set({ currentVersionId: v.id, currentDeploymentId: d.id, status: env.url ? 'healthy' : env.status, consecutiveFailures: 0, lastHealthAt: env.url ? new Date() : env.lastHealthAt }).where(eq(environments.id, env.id));
        if (env.type === 'production') {
          await tx.update(versions).set({ status: 'released', releasedAt: new Date() }).where(eq(versions.id, v.id));
          await tx.update(projects).set({ currentVersion: v.version }).where(eq(projects.id, project.id));
        }
        await audit(tx, { organizationId: d.organizationId, projectId: project.id, actor: SYSTEM_ACTOR, action: 'deployment.succeeded', resourceType: 'deployment', resourceId: d.id, metadata: { environment: env.name, version: v.version } });
        await timeline(tx, { organizationId: d.organizationId, projectId: project.id, kind: 'deploy', tone: 'ok', title: `v${v.version} ${env.name} ortamına alındı`, description: `D-${d.number} · ${target!.adapter.toUpperCase()}`, refType: 'deployment', refId: d.id });
        await emitDomainEvent(tx, { event: 'deployment.succeeded', organizationId: d.organizationId, projectId: project.id, data: { deploymentId: d.id, environment: env.name, version: v.version, requestedBy: d.requestedBy } });
        await enqueue(tx, { queue: QUEUES.maintenance, type: 'project.health', projectId: project.id, organizationId: d.organizationId, dedupeKey: `health:${project.id}`, payload: { projectId: project.id } });
      });
      return 'Tamamlandı';
    });
    return { status: 'succeeded' };
  } catch (e) {
    const message = (e as Error).message;
    if (!(e instanceof StepFailed)) logger.error({ err: e }, 'deployment crashed');
    let status: 'failed' | 'rolled_back' = 'failed';
    if (deployed && release && adapter) {
      log.section('Otomatik geri alma');
      try {
        await adapter.rollback(release, (l) => log.line(l));
        status = 'rolled_back';
      } catch (re) {
        log.line(`Geri alma başarısız: ${(re as Error).message}`);
      }
    }
    await db.transaction(async (tx) => {
      await tx.update(deployments).set({ status, error: message.slice(0, 2000), finishedAt: new Date() }).where(eq(deployments.id, d.id));
      await tx.update(deploymentSteps).set({ status: 'skipped' }).where(and(eq(deploymentSteps.deploymentId, d.id), eq(deploymentSteps.status, 'pending')));
      if (status === 'rolled_back') await tx.update(versions).set({ status: 'rolled_back' }).where(and(eq(versions.id, v.id), sql`${versions.status} <> 'released'`));
      await audit(tx, { organizationId: d.organizationId, projectId: project.id, actor: SYSTEM_ACTOR, action: `deployment.${status}`, resourceType: 'deployment', resourceId: d.id, metadata: { error: message } });
      await timeline(tx, {
        organizationId: d.organizationId,
        projectId: project.id,
        kind: 'deploy',
        tone: 'bad',
        title: status === 'rolled_back' ? `D-${d.number} geri alındı (v${v.version} → ${env.name})` : `D-${d.number} başarısız (v${v.version} → ${env.name})`,
        description: message,
        refType: 'deployment',
        refId: d.id,
      });
      await emitDomainEvent(tx, {
        event: status === 'rolled_back' ? 'deployment.rolled_back' : 'deployment.failed',
        organizationId: d.organizationId,
        projectId: project.id,
        data: { deploymentId: d.id, environment: env.name, version: v.version, requestedBy: d.requestedBy, error: message },
      });
      if (env.type === 'production' && deployed) {
        const number = await nextNumber(tx, d.organizationId, 'incident');
        const inc = (
          await tx
            .insert(incidents)
            .values({ organizationId: d.organizationId, projectId: project.id, environmentId: env.id, number, title: `Production deployment D-${d.number} başarısız: ${message.slice(0, 200)}`, severity: 'high', source: 'deployment', status: status === 'rolled_back' ? 'resolved' : 'open', resolvedAt: status === 'rolled_back' ? new Date() : null, rootCause: status === 'rolled_back' ? 'Otomatik geri alma ile önceki sürüme dönüldü' : null })
            .returning()
        )[0]!;
        await emitDomainEvent(tx, { event: 'incident.opened', organizationId: d.organizationId, projectId: project.id, data: { incidentId: inc.id, title: inc.title } });
      }
      await enqueue(tx, { queue: QUEUES.maintenance, type: 'project.health', projectId: project.id, organizationId: d.organizationId, dedupeKey: `health:${project.id}`, payload: { projectId: project.id } });
    });
    await notify();
    return { status, error: message };
  } finally {
    log.close();
    await adapter?.close().catch(() => undefined);
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function testTarget(ctx: WorkerCtx, { job }: JobContext) {
  const { environmentId, requestedBy } = job.payload as { environmentId: string; requestedBy: string };
  const env = (await ctx.db.select().from(environments).where(eq(environments.id, environmentId)))[0];
  const target = env ? (await ctx.db.select().from(deploymentTargets).where(eq(deploymentTargets.environmentId, env.id)))[0] : undefined;
  if (!env || !target) throw new PermanentJobError('target missing');
  const adapter = createAdapter(target, target.credentialSecretId ? await readSecret(ctx.db, ctx.config.encryptionKey, target.credentialSecretId) : null);
  let ok = true;
  let message: string;
  try {
    message = await adapter.test();
  } catch (e) {
    ok = false;
    message = (e as Error).message;
  } finally {
    await adapter.close().catch(() => undefined);
  }
  await timeline(ctx.db, { organizationId: env.organizationId, projectId: env.projectId, kind: 'deploy', tone: ok ? 'ok' : 'bad', title: `${env.name} hedef bağlantı testi ${ok ? 'başarılı' : 'başarısız'}`, description: message });
  await publish(ctx.db, { type: 'notification', organizationId: env.organizationId, data: { userId: requestedBy, title: `${env.name}: ${ok ? '✓' : '✗'} ${message}` } });
  await publish(ctx.db, { type: 'environment.updated', organizationId: env.organizationId, projectId: env.projectId, id: env.id, data: { test: { ok, message } } });
  return { ok, message };
}

export async function checkDatabase(ctx: WorkerCtx, { job }: JobContext) {
  const { environmentId } = job.payload as { environmentId: string };
  const conn = await databaseUrl(ctx, environmentId);
  if (!conn) return { skipped: true };
  const client = new pg.Client({ connectionString: conn.url, connectionTimeoutMillis: 10_000 });
  let ok = false;
  let message = '';
  try {
    await client.connect();
    const v = await client.query<{ server_version: string }>('SHOW server_version');
    const t = await client.query<{ n: string; size: string }>("SELECT count(*)::text AS n, pg_size_pretty(pg_database_size(current_database())) AS size FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')");
    ok = true;
    message = `PostgreSQL ${v.rows[0]?.server_version} · ${t.rows[0]?.n} tablo · ${t.rows[0]?.size}`;
  } catch (e) {
    message = (e as Error).message;
  } finally {
    await client.end().catch(() => undefined);
  }
  await ctx.db.update(databaseConnections).set({ lastCheckedAt: new Date(), lastCheckOk: ok, lastCheckMessage: message.slice(0, 500) }).where(eq(databaseConnections.environmentId, environmentId));
  const env = (await ctx.db.select().from(environments).where(eq(environments.id, environmentId)))[0];
  if (env) await publish(ctx.db, { type: 'environment.updated', organizationId: env.organizationId, projectId: env.projectId, id: env.id });
  return { ok, message };
}

export async function backupDatabase(ctx: WorkerCtx, { job }: JobContext) {
  const { environmentId, requestedBy } = job.payload as { environmentId: string; requestedBy: string | null };
  const env = (await ctx.db.select().from(environments).where(eq(environments.id, environmentId)))[0];
  if (!env) throw new PermanentJobError('environment missing');
  const current = env.currentVersionId ? (await ctx.db.select({ v: versions.version }).from(versions).where(eq(versions.id, env.currentVersionId)))[0]?.v : null;
  const id = await dumpDatabase(ctx, { organizationId: env.organizationId, projectId: env.projectId, environmentId: env.id, deploymentId: null, versionLabel: current ?? null, createdBy: requestedBy }, () => undefined);
  await timeline(ctx.db, { organizationId: env.organizationId, projectId: env.projectId, kind: 'deploy', tone: 'ok', title: `${env.name} veritabanı yedeği alındı`, description: id ?? '' });
  await publish(ctx.db, { type: 'backup.updated', organizationId: env.organizationId, projectId: env.projectId });
  return { backupId: id };
}

/* ---------------- environment health monitor (spec §36, §38, §86) ---------------- */

registerPeriodic({
  name: 'health-monitor',
  everyMinutes: 5,
  run: async (ctx) => {
    const envs = await ctx.db.select().from(environments).where(and(eq(environments.monitor, true), sql`${environments.url} <> ''`));
    for (const env of envs) {
      const url = new URL(env.healthPath || '/', env.url).toString();
      const r = await httpCheck(url);
      await ctx.db.insert(healthChecks).values({ environmentId: env.id, ok: r.ok, httpStatus: r.status, latencyMs: r.ms, error: r.error ?? null });
      const failures = r.ok ? 0 : env.consecutiveFailures + 1;
      const status = r.ok ? (r.ms > 3000 ? 'degraded' : 'healthy') : failures >= 3 ? 'down' : 'degraded';
      await ctx.db.update(environments).set({ status, consecutiveFailures: failures, lastHealthAt: new Date() }).where(eq(environments.id, env.id));
      const open = (await ctx.db.select().from(incidents).where(and(eq(incidents.environmentId, env.id), eq(incidents.status, 'open'), eq(incidents.source, 'monitor'))))[0];
      if (failures === 3 && !open) {
        const selfHealing = (await getOrgSettings(ctx.db, env.organizationId)).ai.selfHealing;
        const recentRemediations = selfHealing.enabled && !selfHealing.emergencyStop && selfHealing.autoRecheckHealth
          ? (await ctx.db.select({ n: count() }).from(aiRemediations).where(and(eq(aiRemediations.organizationId, env.organizationId), sql`${aiRemediations.createdAt} >= now() - interval '1 hour'`)))[0]?.n ?? 0
          : selfHealing.maxAttemptsPerHour;
        await ctx.db.transaction(async (tx) => {
          const number = await nextNumber(tx, env.organizationId, 'incident');
          const inc = (
            await tx
              .insert(incidents)
              .values({ organizationId: env.organizationId, projectId: env.projectId, environmentId: env.id, number, title: `${env.name} erişilemiyor (${r.status ?? r.error})`, severity: env.type === 'production' ? 'critical' : 'medium', source: 'monitor' })
              .returning()
          )[0]!;
          await timeline(tx, { organizationId: env.organizationId, projectId: env.projectId, kind: 'incident', tone: 'bad', title: `INC-${number} açıldı: ${inc.title}`, refType: 'incident', refId: inc.id });
          await emitDomainEvent(tx, { event: 'incident.opened', organizationId: env.organizationId, projectId: env.projectId, data: { incidentId: inc.id, title: inc.title } });
          if (selfHealing.enabled && !selfHealing.emergencyStop && selfHealing.autoRecheckHealth && recentRemediations < selfHealing.maxAttemptsPerHour) {
            const remediation = (
              await tx
                .insert(aiRemediations)
                .values({ organizationId: env.organizationId, projectId: env.projectId, incidentId: inc.id, action: 'recheck_health', riskLevel: 'low', trigger: 'automatic', diagnosis: 'Üç ardışık izleme hatasından sonra değişiklik yapmadan HTTP sağlık kontrolünü tekrar çalıştır.', attempt: 1 })
                .returning({ id: aiRemediations.id })
            )[0]!;
            await enqueue(tx, { queue: QUEUES.ai, type: 'ai.remediation.run', organizationId: env.organizationId, projectId: env.projectId, maxAttempts: 1, dedupeKey: `remediation:${remediation.id}`, payload: { remediationId: remediation.id } });
            await audit(tx, { organizationId: env.organizationId, projectId: env.projectId, actor: SYSTEM_ACTOR, action: 'ai.remediation.auto_requested', resourceType: 'ai_remediation', resourceId: remediation.id, metadata: { incidentId: inc.id, action: 'recheck_health', risk: 'low' } });
          }
        });
      } else if (r.ok && open) {
        await ctx.db.transaction(async (tx) => {
          await tx.update(incidents).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(incidents.id, open.id));
          await timeline(tx, { organizationId: env.organizationId, projectId: env.projectId, kind: 'incident', tone: 'ok', title: `INC-${open.number} kendiliğinden düzeldi`, description: `${url} → HTTP ${r.status}`, refType: 'incident', refId: open.id });
          await emitDomainEvent(tx, { event: 'incident.resolved', organizationId: env.organizationId, projectId: env.projectId, data: { incidentId: open.id, title: open.title } });
        });
      }
      await publish(ctx.db, { type: 'environment.updated', organizationId: env.organizationId, projectId: env.projectId, id: env.id });
    }
    return envs.length;
  },
});

/* ---------------- retention (spec §49, §112) ---------------- */

registerPeriodic({
  name: 'retention',
  everyMinutes: 60,
  run: async (ctx) => {
    const now = new Date();
    // Rows left "running" by a job whose worker died for good (no job left to finish them) are closed here,
    // so screens never spin forever. Thresholds are far above any legitimate run time.
    await ctx.db.execute(sql`UPDATE backups SET status = 'failed', error = 'Yedekleme yarıda kaldı (worker kesintisi)' WHERE status = 'running' AND created_at < now() - interval '3 hours'`);
    await ctx.db.execute(sql`UPDATE security_scans SET status = 'failed', error = 'Tarama yarıda kaldı (worker kesintisi)', finished_at = now() WHERE status IN ('queued', 'running') AND created_at < now() - interval '3 hours' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'security.scan' AND j.status IN ('queued', 'running') AND j.payload->>'scanId' = security_scans.id::text)`);
    await ctx.db.execute(sql`UPDATE responsive_tests SET status = 'failed', error = 'Test yarıda kaldı (worker kesintisi)', finished_at = now() WHERE status IN ('queued', 'running') AND created_at < now() - interval '3 hours' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'responsive.test' AND j.status IN ('queued', 'running') AND j.payload->>'testId' = responsive_tests.id::text)`);
    const live = await ctx.db.select({ buildId: previews.buildId }).from(previews).where(inArray(previews.status, ['queued', 'starting', 'ready']));
    const keepBuilds = new Set(live.map((l) => l.buildId));
    const expired = await ctx.db.select().from(artifacts).where(lt(artifacts.retentionUntil, now)).limit(500);
    let removed = 0;
    for (const a of expired) {
      if (a.buildId && keepBuilds.has(a.buildId)) continue;
      await ctx.storage.remove(a.storageKey);
      await ctx.db.delete(artifacts).where(eq(artifacts.id, a.id));
      removed++;
    }
    // Health checks and raw logs older than the policy.
    const orgs = await ctx.db.execute<{ id: string }>(sql`SELECT id FROM organizations`);
    for (const o of orgs.rows) {
      const { retention } = await getOrgSettings(ctx.db, o.id);
      await ctx.db.execute(sql`DELETE FROM health_checks h USING environments e WHERE h.environment_id = e.id AND e.organization_id = ${o.id} AND h.checked_at < now() - make_interval(days => ${retention.healthCheckDays})`);
      const cutoff = Date.now() - retention.rawLogDays * 86400_000;
      const logsDir = ctx.storage.resolve('logs');
      for (const proj of await fs.readdir(logsDir).catch(() => [])) {
        for (const f of await fs.readdir(path.join(logsDir, proj)).catch(() => [])) {
          const full = path.join(logsDir, proj, f);
          const st = await fs.stat(full).catch(() => null);
          if (st && st.mtimeMs < cutoff) await fs.rm(full, { force: true });
        }
      }
    }
    // Disk pressure: above 90 % remove artifacts of stopped/expired previews early (spec §112).
    try {
      const s = await fs.statfs(ctx.storage.root);
      const used = 1 - s.bavail / s.blocks;
      if (used > 0.9) {
        const stale = await ctx.db
          .select({ a: artifacts })
          .from(artifacts)
          .innerJoin(builds, eq(builds.artifactId, artifacts.id))
          .where(and(eq(artifacts.type, 'build'), sql`NOT EXISTS (SELECT 1 FROM previews p WHERE p.build_id = ${builds.id} AND p.status IN ('queued','starting','ready'))`))
          .orderBy(artifacts.createdAt)
          .limit(100);
        for (const { a } of stale) {
          await ctx.storage.remove(a.storageKey);
          await ctx.db.delete(artifacts).where(eq(artifacts.id, a.id));
          removed++;
        }
        ctx.logger.warn({ usedPercent: Math.round(used * 100) }, 'disk above 90%, removed temporary build artifacts');
      }
    } catch {
      /* statfs unsupported */
    }
    return removed;
  },
});

/**
 * The worker stopped or crashed while this deployment was running (its job was re-queued or its lease expired).
 * Resuming blindly is unsafe — the worker cannot know whether the release swap happened — so the deployment is
 * failed with an explanation and, when the target may have been touched, an incident asks a human to verify it.
 */
async function interruptedDeployment(ctx: WorkerCtx, d: typeof deployments.$inferSelect) {
  const db = ctx.db;
  const steps = await db.select().from(deploymentSteps).where(eq(deploymentSteps.deploymentId, d.id));
  const inFlight = steps.find((s) => s.status === 'running');
  const touched = steps.some((s) => s.key === 'deploy' && (s.status === 'running' || s.status === 'passed'));
  const env = (await db.select().from(environments).where(eq(environments.id, d.environmentId)))[0]!;
  const message = `Deployment, worker yeniden başladığı için ${inFlight ? `"${inFlight.name}" adımında` : ''} yarıda kaldı. ${touched ? 'Hedef sunucu değişmiş olabilir; canlı sürümü kontrol edin, gerekirse önceki sürüme dönün.' : 'Hedefte değişiklik yapılmadı; yeniden deploy edebilirsiniz.'}`;
  await db.transaction(async (tx) => {
    if (inFlight) await tx.update(deploymentSteps).set({ status: 'failed', output: 'Worker kesintisi', finishedAt: new Date() }).where(eq(deploymentSteps.id, inFlight.id));
    await tx.update(deploymentSteps).set({ status: 'skipped' }).where(and(eq(deploymentSteps.deploymentId, d.id), eq(deploymentSteps.status, 'pending')));
    await tx.update(deployments).set({ status: 'failed', error: message, finishedAt: new Date() }).where(eq(deployments.id, d.id));
    await audit(tx, { organizationId: d.organizationId, projectId: d.projectId, actor: SYSTEM_ACTOR, action: 'deployment.interrupted', resourceType: 'deployment', resourceId: d.id, metadata: { step: inFlight?.key ?? null, targetTouched: touched } });
    await timeline(tx, { organizationId: d.organizationId, projectId: d.projectId, kind: 'deploy', tone: 'bad', title: `D-${d.number} yarıda kaldı (${env.name})`, description: message, refType: 'deployment', refId: d.id });
    await emitDomainEvent(tx, { event: 'deployment.failed', organizationId: d.organizationId, projectId: d.projectId, data: { deploymentId: d.id, environment: env.name, requestedBy: d.requestedBy, error: message } });
    if (touched) {
      const number = await nextNumber(tx, d.organizationId, 'incident');
      const inc = (
        await tx
          .insert(incidents)
          .values({ organizationId: d.organizationId, projectId: d.projectId, environmentId: env.id, number, title: `D-${d.number} yarıda kaldı: ${env.name} kontrol edilmeli`, severity: env.type === 'production' ? 'high' : 'medium', source: 'deployment' })
          .returning()
      )[0]!;
      await emitDomainEvent(tx, { event: 'incident.opened', organizationId: d.organizationId, projectId: d.projectId, data: { incidentId: inc.id, title: inc.title } });
    }
    await publish(tx, { type: 'deployment.updated', organizationId: d.organizationId, projectId: d.projectId, id: d.id });
  });
  return { status: 'interrupted', targetTouched: touched };
}
