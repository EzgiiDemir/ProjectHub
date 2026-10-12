import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

let h: Harness;
const admin = makeClient(() => h.base);
const dev = makeClient(() => h.base);
const slug = 'bildirim-projesi';

type Notifications = { items?: { title: string }[] } | { title: string }[];
const titles = async () => {
  const d = (await admin.get('/notifications')).data as Notifications;
  return (Array.isArray(d) ? d : (d.items ?? [])).map((n) => n.title);
};

beforeAll(async () => {
  h = await startHarness({ worker: true });
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  await admin.post('/projects', { name: 'Bildirim Projesi', slug, source: { type: 'empty' } });
  await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  const roles = (await admin.get('/admin/roles')).data as { id: string; key: string }[];
  const inv = await admin.post('/admin/users', { email: 'dev@example.com', displayName: 'Deniz Geliştirici', roleIds: [roles.find((r) => r.key === 'developer')!.id] });
  await dev.post('/auth/invitations/accept', { token: new URL((inv.data as { invitationUrl: string }).invitationUrl).pathname.split('/').pop()!, password: 'Gelistirici-2026' });
  const me = (await dev.get('/auth/me')).data as { user: { id: string } };
  await admin.post(`/projects/${slug}/members`, { userId: me.user.id, roleId: null });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

/** The developer opens a pull request from a fresh branch; the admin (who can push) is a recipient. */
async function openPr(branch: string, title: string) {
  expect((await dev.post(`/projects/${slug}/repo/branches`, { name: branch, from: 'main' })).status).toBe(201);
  const sha = ((await dev.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string; sha: string }[] }).branches.find((b) => b.name === branch)!.sha;
  expect((await dev.post(`/projects/${slug}/repo/commits`, { branch, baseCommit: sha, message: title, changes: [{ action: 'upsert', path: `${branch}.txt`, content: title }] })).status).toBe(201);
  expect((await dev.post(`/projects/${slug}/pull-requests`, { title, sourceBranch: branch, targetBranch: 'main' })).status).toBe(201);
}

describe('notification preferences', () => {
  it('validates and stores per-category channels', async () => {
    expect(((await admin.get('/auth/notification-preferences')).data as { preferences: object }).preferences).toEqual({});
    expect((await admin.put('/auth/notification-preferences', { unknown: { inApp: false } })).status).toBe(400);
    expect((await admin.put('/auth/notification-preferences', { code: { inApp: 'no' } })).status).toBe(400);
    const r = await admin.put('/auth/notification-preferences', { code: { inApp: false }, security: { email: true }, build: {} });
    expect(r.status).toBe(200);
    expect((r.data as { preferences: object }).preferences).toEqual({ code: { inApp: false }, security: { email: true } });
  });

  it('is honoured by the real dispatcher: muted categories create no in-app notification', async () => {
    await openPr('feature/sessiz', 'Sessiz PR');
    // Preferences are read when the worker dispatches the event: let the notification queue drain first.
    const pending = async () => Number((await h.server.handle.pool.query("SELECT count(*) AS n FROM jobs WHERE queue = 'notification' AND status IN ('queued', 'running')")).rows[0].n);
    await waitFor(async () => (await pending()) === 0, 20_000);
    expect((await titles()).some((t) => t.includes('Sessiz PR'))).toBe(false);

    expect((await admin.put('/auth/notification-preferences', { code: { inApp: true } })).status).toBe(200);
    await openPr('feature/sesli', 'Sesli PR');
    await waitFor(async () => (await titles()).some((t) => t.includes('Sesli PR')), 20_000);
  }, 60_000);
});
