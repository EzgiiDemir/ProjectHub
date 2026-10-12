import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

let h: Harness;
const admin = makeClient(() => h.base);
const slug = 'pencere-projesi';
let staging = '';
let versionId = '';

/** "HH:MM" in UTC, `deltaMinutes` from now. */
const utcClock = (deltaMinutes: number) => {
  const d = new Date(Date.now() + deltaMinutes * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const outsideNow = (outside: 'require_approval' | 'deny') => ({ enabled: true, environmentTypes: ['staging'], days: ALL_DAYS, start: utcClock(120), end: utcClock(180), timezone: 'UTC', outside });

beforeAll(async () => {
  h = await startHarness({ worker: true });
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  await admin.post('/projects', { name: 'Pencere Projesi', slug, source: { type: 'empty', template: 'static' } });
  await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  const b = (await admin.post(`/projects/${slug}/builds`, {})).data as { id: string };
  await waitFor(async () => ((await admin.get(`/builds/${b.id}`)).data as { status: string }).status === 'passed', 90_000);
  versionId = ((await admin.post(`/projects/${slug}/versions`, { version: '1.0.0', buildId: b.id, releaseNotes: '' })).data as { id: string }).id;
  staging = ((await admin.get(`/projects/${slug}/environments`)).data as { id: string; type: string }[]).find((e) => e.type === 'staging')!.id;
  expect((await admin.put(`/projects/${slug}/environments/${staging}/target`, { adapter: 'local', remotePath: path.join(h.config.storageDir, 'deploy-local', 'pencere-staging') })).status).toBe(200);
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const deploy = () => admin.post(`/projects/${slug}/deployments`, { environmentId: staging, versionId, runMigrations: false, backup: false });

describe('deployment window policy', () => {
  it('validates and stores the window', async () => {
    expect((await admin.get(`/projects/${slug}/deployment-window`)).data).toMatchObject({ window: null, productionNow: 'not_applicable', canEdit: true });
    expect((await admin.put(`/projects/${slug}/deployment-window`, { ...outsideNow('deny'), timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await admin.put(`/projects/${slug}/deployment-window`, { ...outsideNow('deny'), days: [] })).status).toBe(400);
  });

  it('outside the window: requires an approval, or denies the deployment', async () => {
    expect((await admin.put(`/projects/${slug}/deployment-window`, outsideNow('require_approval'))).status).toBe(200);
    const pre = (await admin.get(`/projects/${slug}/deployments/preflight?environmentId=${staging}&versionId=${versionId}`)).data as { checks: { key: string; status: string }[]; blocked: boolean };
    expect(pre.checks.find((c) => c.key === 'window')?.status).toBe('warn');
    expect(pre.blocked).toBe(false);
    const d = await deploy();
    expect(d.status).toBe(201);
    expect((d.data as { status: string }).status).toBe('pending_approval');
    expect((await admin.post(`/deployments/${(d.data as { id: string }).id}/cancel`)).status).toBe(201);

    expect((await admin.put(`/projects/${slug}/deployment-window`, outsideNow('deny'))).status).toBe(200);
    const denied = await deploy();
    expect(denied.status).toBe(403);
    expect(denied.error).toMatchObject({ code: 'POLICY_DENIED', message: expect.stringContaining('zaman penceresi dışında') });
    expect(((await admin.get(`/projects/${slug}/deployments/preflight?environmentId=${staging}&versionId=${versionId}`)).data as { blocked: boolean }).blocked).toBe(true);
  });

  it('inside the window the deployment runs without extra approval', async () => {
    expect((await admin.put(`/projects/${slug}/deployment-window`, { ...outsideNow('deny'), start: utcClock(-60), end: utcClock(60) })).status).toBe(200);
    const d = await deploy();
    expect(d.status).toBe(201);
    expect(['queued', 'running', 'succeeded']).toContain((d.data as { status: string }).status);
    const audit = (await admin.get(`/admin/audit?action=deployment.window_changed`)).data as { items?: unknown[] } | unknown[];
    expect((Array.isArray(audit) ? audit : (audit.items ?? [])).length).toBeGreaterThanOrEqual(3);
  });
});
