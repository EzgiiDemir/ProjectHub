import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../../../test/support/db.js';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

const TARGET_DB = 'ph_restore_target';
let h: Harness;
const admin = makeClient(() => h.base);
const lead = makeClient(() => h.base);
const slug = 'db-projesi';
let envs: Record<string, string> = {};
let versionId = '';
const pgDumpWorks = (() => {
  try {
    execFileSync(process.env.PG_DUMP_BINARY ?? 'pg_dump', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const adminUrl = new URL(TEST_DATABASE_URL);
const targetUrl = () => {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${TARGET_DB}`;
  return u.toString();
};
async function sqlOn(url: string, q: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(q)).rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  if (!pgDumpWorks) return;
  h = await startHarness({ worker: true });
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  await admin.post('/projects', { name: 'DB Projesi', slug, source: { type: 'empty', template: 'custom' } });
  await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  const head = ((await admin.get(`/projects/${slug}/repo/branches`)).data as { branches: { sha: string }[] }).branches[0]!.sha;
  const manifest = ['project:', '  name: DB Projesi', 'runtime:', '  type: other', 'database:', '  type: postgresql', '  migrate:', '    command: node -e "console.log(1)"', '    directory: db/migrations', 'preview:', '  enabled: false', ''].join('\n');
  await admin.post(`/projects/${slug}/repo/commits`, {
    branch: 'main',
    baseCommit: head,
    message: 'migrations',
    changes: [
      { action: 'upsert', path: 'projecthub.yml', content: manifest },
      { action: 'upsert', path: 'db/migrations/0001_orders.sql', content: 'CREATE TABLE orders (id int);\nALTER TABLE customers DROP COLUMN legacy;\n' },
    ],
  });
  const b = (await admin.post(`/projects/${slug}/builds`, {})).data as { id: string };
  await waitFor(async () => ((await admin.get(`/builds/${b.id}`)).data as { status: string }).status === 'passed', 60_000);
  versionId = ((await admin.post(`/projects/${slug}/versions`, { version: '1.0.0', buildId: b.id, releaseNotes: '' })).data as { id: string }).id;

  envs = Object.fromEntries(((await admin.get(`/projects/${slug}/environments`)).data as { id: string; type: string }[]).map((e) => [e.type, e.id]));
  await admin.put(`/projects/${slug}/environments/${envs.staging}/target`, { adapter: 'local', remotePath: path.join(h.config.storageDir, 'deploy-local', 'db-projesi-staging') });
  await sqlOn(TEST_DATABASE_URL, `DROP DATABASE IF EXISTS ${TARGET_DB}`);
  await sqlOn(TEST_DATABASE_URL, `CREATE DATABASE ${TARGET_DB}`);
  for (const env of [envs.staging, envs.production]) {
    await admin.put(`/projects/${slug}/database`, { environmentId: env, host: adminUrl.hostname, port: Number(adminUrl.port), database: TARGET_DB, username: decodeURIComponent(adminUrl.username), password: decodeURIComponent(adminUrl.password), sslMode: 'disable' });
  }
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (pgDumpWorks) await sqlOn(TEST_DATABASE_URL, `DROP DATABASE IF EXISTS ${TARGET_DB} WITH (FORCE)`).catch(() => undefined);
});

describe.skipIf(!pgDumpWorks)('database safety: update analysis, migrations, verified backups, restores', () => {
  it('analyses a deployment before it runs and records applied migrations per environment', async () => {
    const pre = (await admin.get(`/projects/${slug}/deployments/preflight?environmentId=${envs.staging}&versionId=${versionId}`)).data as {
      pendingMigrations: { name: string; riskLevel: string }[];
      checks: { key: string; status: string; label: string }[];
      blocked: boolean;
    };
    expect(pre.blocked).toBe(false);
    expect(pre.pendingMigrations).toEqual([expect.objectContaining({ name: '0001_orders', riskLevel: 'high' })]);
    expect(pre.checks.find((c) => c.key === 'migrations')).toMatchObject({ status: 'warn', label: '1 migration uygulanacak' });
    expect(pre.checks.find((c) => c.key === 'backup')?.status).toBe('ok');

    const d = (await admin.post(`/projects/${slug}/deployments`, { environmentId: envs.staging, versionId, runMigrations: true, backup: true })).data as { id: string };
    const done = await waitFor(async () => {
      const x = (await admin.get(`/deployments/${d.id}`)).data as { status: string; steps: { key: string; status: string }[] };
      return ['succeeded', 'failed', 'rolled_back'].includes(x.status) ? x : null;
    }, 90_000);
    expect(done.status).toBe('succeeded');
    expect(done.steps.find((s) => s.key === 'backup')?.status).toBe('passed');
    expect(done.steps.find((s) => s.key === 'migrate')?.status).toBe('passed');

    const migrations = (await admin.get(`/projects/${slug}/migrations`)).data as { environments: { id: string; appliedAt: string | null }[] }[];
    expect(migrations[0]!.environments.find((e) => e.id === envs.staging)?.appliedAt).toBeTruthy();
    expect(migrations[0]!.environments.find((e) => e.id === envs.production)?.appliedAt).toBeNull();
    const overview = (await admin.get(`/projects/${slug}/database/overview`)).data as { environments: { environment: { id: string }; pending: unknown[]; currentVersion: string | null; lastBackup: { verifiedAt: string | null } | null }[] };
    const st = overview.environments.find((e) => e.environment.id === envs.staging)!;
    expect(st).toMatchObject({ currentVersion: '1.0.0', pending: [] });
    expect(st.lastBackup?.verifiedAt).toBeTruthy();
    expect(overview.environments.find((e) => e.environment.id === envs.production)!.pending).toHaveLength(1);
  }, 120_000);

  it('restores a verified backup (with a safety dump first) and needs a second person for production', async () => {
    await sqlOn(targetUrl(), 'CREATE TABLE notes (body text); INSERT INTO notes VALUES (\'ilk\')');
    type B = { id: string; status: string; versionLabel: string | null; verifiedAt: string | null; environmentId: string };
    const before = new Set(((await admin.get(`/projects/${slug}/backups`)).data as B[]).map((b) => b.id));
    await admin.post(`/projects/${slug}/backups`, { environmentId: envs.staging });
    const backup = await waitFor(async () => ((await admin.get(`/projects/${slug}/backups`)).data as B[]).find((b) => !before.has(b.id) && b.status === 'completed' && b.verifiedAt && b.environmentId === envs.staging && b), 60_000);
    expect(backup.versionLabel).toBe('1.0.0');
    await sqlOn(targetUrl(), "INSERT INTO notes VALUES ('sonradan')");

    const r = (await admin.post(`/backups/${backup.id}/restore`, { environmentId: envs.staging })).data as { status: string };
    expect(r.status).toBe('queued');
    type R = { id: string; status: string; error: string | null; environmentId: string; canApprove: boolean };
    const finished = await waitFor(async () => ((await admin.get(`/projects/${slug}/restores`)).data as R[]).find((x) => x.environmentId === envs.staging && ['completed', 'failed'].includes(x.status)), 60_000);
    expect(finished.error).toBeNull();
    expect(finished.status).toBe('completed');
    expect((await sqlOn(targetUrl(), 'SELECT body FROM notes ORDER BY body')).map((x) => x.body)).toEqual(['ilk']);
    expect(((await admin.get(`/projects/${slug}/backups`)).data as B[]).some((b) => b.versionLabel === 'geri-yükleme-öncesi')).toBe(true);

    // Production: requested by one person, approved by another database manager.
    const prod = (await admin.post(`/backups/${backup.id}/restore`, { environmentId: envs.production })).data as { id: string; status: string };
    expect(prod.status).toBe('pending_approval');
    expect((await admin.post(`/restores/${prod.id}/approve`)).status).toBe(403);
    const roles = (await admin.get('/admin/roles')).data as { id: string; key: string }[];
    const inv = await admin.post('/admin/users', { email: 'lead@example.com', displayName: 'Lider Geliştirici', roleIds: [roles.find((x) => x.key === 'lead_developer')!.id] });
    await lead.post('/auth/invitations/accept', { token: new URL((inv.data as { invitationUrl: string }).invitationUrl).pathname.split('/').pop()!, password: 'Lider-Gelistirici-2026' });
    const me = (await lead.get('/auth/me')).data as { user: { id: string } };
    await admin.post(`/projects/${slug}/members`, { userId: me.user.id, roleId: null });
    expect((await lead.post(`/restores/${prod.id}/approve`)).status).toBe(201);
    const prodDone = await waitFor(async () => ((await admin.get(`/projects/${slug}/restores`)).data as R[]).find((x) => x.id === prod.id && ['completed', 'failed'].includes(x.status)), 60_000);
    expect(prodDone.status).toBe('completed');
  }, 180_000);

  it('verifies on demand and protects recent production backups from deletion', async () => {
    type B = { id: string; status: string; environmentId: string; verifiedAt: string | null };
    const all = (await admin.get(`/projects/${slug}/backups`)).data as B[];
    const prodBackup = all.find((b) => b.environmentId === envs.production && b.status === 'completed')!;
    const stagingBackup = all.find((b) => b.environmentId === envs.staging && b.status === 'completed')!;
    expect((await admin.post(`/backups/${stagingBackup.id}/verify`)).status).toBe(201);
    const del = await admin.del(`/backups/${prodBackup.id}`);
    expect(del.error?.code).toBe('POLICY_DENIED');
    expect((await admin.del(`/backups/${stagingBackup.id}`)).status).toBe(200);
  });
});
