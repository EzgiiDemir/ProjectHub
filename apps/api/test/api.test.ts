import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client as makeClient, startHarness, type Harness } from './harness.js';

let h: Harness;
let base: string;
let server: Harness['server'];
const client = () => makeClient(() => base);

beforeAll(async () => {
  h = await startHarness();
  base = h.base;
  server = h.server;
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('API (real server, real database)', () => {
  const admin = client();
  const viewer = client();
  let viewerEmail = 'ayse.viewer@example.com';
  let projectSlug = '';

  it('reports readiness', async () => {
    const r = await fetch(`${base}/health/ready`);
    expect(r.status).toBe(200);
  });

  it('authenticates with a generic error for bad credentials and case-insensitive e-mail', async () => {
    const bad = await admin.post('/auth/login', { email: ADMIN.email, password: 'yanlis-sifre-123' });
    expect(bad.status).toBe(401);
    const unknown = await admin.post('/auth/login', { email: 'nobody@example.com', password: 'yanlis-sifre-123' });
    expect(unknown.error!.message).toBe(bad.error!.message); // no account enumeration
    const ok = await admin.post('/auth/login', { email: ADMIN.email.toLowerCase(), password: ADMIN.password });
    expect(ok.status).toBe(200);
    const me = await admin.get('/auth/me');
    expect(me.data).toMatchObject({ user: { email: 'admin@example.com' }, organization: { slug: 'test-sirketi' } });
    expect((me.data as { permissions: string[] }).permissions).toContain('admin.users.manage');
  });

  it('rejects cookie-authenticated writes without the CSRF header or from a foreign origin', async () => {
    const noHeader = await admin.raw('POST', '/projects', { name: 'X', slug: 'x-proj', source: { type: 'empty' } }, { 'x-requested-with': '' });
    expect(noHeader.status).toBe(403);
    const foreign = await admin.post('/projects', { name: 'X', slug: 'x-proj', source: { type: 'empty' } }, { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
  });

  it('creates projects with validated, unique, non-reserved slugs', async () => {
    const created = await admin.post('/projects', { name: 'Kurumsal Site', slug: 'kurumsal-site', source: { type: 'empty' } });
    expect(created.status).toBe(201);
    projectSlug = (created.data as { slug: string }).slug;
    expect(projectSlug).toBe('kurumsal-site');
    const dup = await admin.post('/projects', { name: 'Başka', slug: 'kurumsal-site', source: { type: 'empty' } });
    expect(dup.status).toBe(409);
    const reserved = await admin.post('/projects', { name: 'Yeni', slug: 'new', source: { type: 'empty' } });
    expect(reserved.status).toBe(400);
    const envs = await admin.get(`/projects/${projectSlug}/environments`);
    expect((envs.data as { type: string }[]).map((e) => e.type)).toEqual(['development', 'staging', 'production']);
  });

  it('requires an explicit trust decision before repository commands can run', async () => {
    const detail = await admin.get(`/projects/${projectSlug}`);
    expect(detail.data).toMatchObject({ settings: { executionTrust: 'trusted' } });
    expect((await admin.patch(`/projects/${projectSlug}`, { executionTrust: 'untrusted' })).status).toBe(200);
    const blocked = await admin.post(`/projects/${projectSlug}/builds`, { branch: 'main', createPreview: false });
    expect(blocked.status).toBe(412);
    expect(blocked.error?.message).toContain('güvenilmeyen kaynak');
    expect((await admin.patch(`/projects/${projectSlug}`, { executionTrust: 'trusted' })).status).toBe(200);
  });

  it('invites a user with single-use links and enforces the password policy', async () => {
    const roles = (await admin.get('/admin/roles')).data as { id: string; key: string }[];
    const viewerRole = roles.find((r) => r.key === 'viewer')!.id;
    const inv = await admin.post('/admin/users', { email: viewerEmail, displayName: 'Ayşe Görür', roleIds: [viewerRole] });
    expect(inv.status).toBe(201);
    const token = new URL((inv.data as { invitationUrl: string }).invitationUrl).pathname.split('/').pop()!;
    expect((await viewer.get(`/auth/invitations/${token}`)).status).toBe(200);
    const weak = await viewer.post('/auth/invitations/accept', { token, password: 'kisa' });
    expect(weak.status).toBe(400);
    const ok = await viewer.post('/auth/invitations/accept', { token, password: 'Goruntuleyici-2026' });
    expect(ok.status).toBe(200);
    expect(((await viewer.get('/auth/me')).data as { user: { displayName: string } }).user.displayName).toBe('Ayşe Görür');
    const reuse = await client().post('/auth/invitations/accept', { token, password: 'Baska-Sifre-2026' });
    expect(reuse.status).toBe(404);
  });

  it('enforces project visibility and role permissions', async () => {
    expect((await viewer.get('/projects')).data).toEqual([]);
    expect([403, 404]).toContain((await viewer.get(`/projects/${projectSlug}`)).status);
    expect((await viewer.post('/projects', { name: 'Yetkisiz', slug: 'yetkisiz', source: { type: 'empty' } })).status).toBe(403);
    expect((await viewer.get('/admin/users')).status).toBe(403);

    const me = (await viewer.get('/auth/me')).data as { user: { id: string } };
    expect((await admin.post(`/projects/${projectSlug}/members`, { userId: me.user.id, roleId: null })).status).toBe(201);
    const p = await viewer.get(`/projects/${projectSlug}`);
    expect(p.status).toBe(200);
    expect((p.data as { permissions: string[] }).permissions).not.toContain('project.update');
    expect((await viewer.patch(`/projects/${projectSlug}`, { name: 'Değişmesin' })).status).toBe(403);
    expect((await viewer.get(`/projects/${projectSlug}/secrets`)).status).toBe(403);
  });

  it('keeps cross-project intelligence permission-filtered', async () => {
    expect((await admin.post('/projects', { name: 'Yalnız Yönetici', slug: 'yalniz-yonetici', source: { type: 'empty' } })).status).toBe(201);
    const adminPortfolio = await admin.get('/ai/portfolio');
    expect(adminPortfolio.status).toBe(200);
    expect((adminPortfolio.data as { projectCount: number }).projectCount).toBe(2);
    const viewerPortfolio = await viewer.get('/ai/portfolio');
    expect(viewerPortfolio.status).toBe(200);
    const visible = viewerPortfolio.data as { projectCount: number; projects: { slug: string }[] };
    expect(visible.projectCount).toBe(1);
    expect(visible.projects.map((project) => project.slug)).toEqual([projectSlug]);
  });

  it('authenticates API tokens (no CSRF for bearer requests) and stops them when revoked', async () => {
    const t = await admin.post('/auth/tokens', { name: 'ci', expiresInDays: 30 });
    const raw = (t.data as { token: string; id: string }).token;
    expect(raw).toMatch(/^ph_/);
    const anon = client();
    const me = await anon.get('/auth/me', { authorization: `Bearer ${raw}` });
    expect(me.status).toBe(200);
    const write = await anon.raw('PATCH', `/projects/${projectSlug}`, { description: 'Token ile güncellendi' }, { authorization: `Bearer ${raw}`, 'x-requested-with': '' });
    expect(write.status).toBe(200);
    await admin.del(`/auth/tokens/${(t.data as { id: string }).id}`);
    expect((await anon.get('/auth/me', { authorization: `Bearer ${raw}` })).status).toBe(401);
  });

  it('persists project memory with provenance and enforces project permissions', async () => {
    const created = await admin.post(`/projects/${projectSlug}/ai/memory`, {
      category: 'decision',
      title: 'Kimlik doğrulama kararı',
      content: 'Oturum kimlik doğrulaması HttpOnly çerez kullanır.',
      verification: 'verified',
      sourceLabel: 'ADR-001',
    });
    expect(created.status).toBe(201);
    const memory = created.data as { id: string; sourceType: string; verification: string };
    expect(memory).toMatchObject({ sourceType: 'user', verification: 'verified' });

    const list = await admin.get(`/projects/${projectSlug}/ai/memory`);
    expect(list.status).toBe(200);
    expect((list.data as { memories: { id: string; title: string }[] }).memories).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: memory.id, title: 'Kimlik doğrulama kararı' })]),
    );
    expect((await viewer.post(`/projects/${projectSlug}/ai/memory`, { category: 'fact', title: 'Yetkisiz', content: 'Bu kayıt yazılmamalı.' })).status).toBe(403);

    const updated = await admin.patch(`/projects/${projectSlug}/ai/memory/${memory.id}`, { verification: 'historical' });
    expect(updated.status).toBe(200);
    expect(updated.data).toMatchObject({ verification: 'historical', approvedBy: null });
    expect((await admin.post(`/projects/${projectSlug}/ai/memory/${memory.id}/delete`, {})).status).toBe(201);
  });

  it('cancels a queued autonomous AI task through the audited server-side policy', async () => {
    const created = await admin.post(`/projects/${projectSlug}/ai/tasks`, { title: 'İptal testi', instruction: 'Bu görev çalışmadan iptal edilecek.', sourceType: 'manual' });
    expect(created.status).toBe(201);
    const task = created.data as { id: string; status: string };
    expect(task.status).toBe('queued');
    const cancelled = await admin.post(`/ai/tasks/${task.id}/cancel`, {});
    expect(cancelled.status).toBe(201);
    expect(cancelled.data).toMatchObject({ id: task.id, status: 'cancelled', error: 'Kullanıcı tarafından iptal edildi' });
  });

  it('records an append-only audit trail', async () => {
    const audit = await admin.get('/admin/audit?limit=200');
    const actions = (audit.data as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['user.bootstrap_admin', 'auth.login', 'auth.login_failed', 'project.created', 'user.invited', 'user.invitation_accepted', 'project.member_set', 'auth.token_created', 'auth.token_revoked', 'ai.memory.created', 'ai.memory.updated', 'ai.memory.deleted', 'ai.task.created', 'ai.task.cancelled']));
    await expect(server.handle.pool.query(`UPDATE audit_events SET action = 'tampered'`)).rejects.toThrow();
    await expect(server.handle.pool.query('DELETE FROM audit_events')).rejects.toThrow();
  });

  it('logs users out and invalidates the session', async () => {
    expect((await viewer.post('/auth/logout')).status).toBe(200);
    expect((await viewer.get('/auth/me')).status).toBe(401);
  });
});
