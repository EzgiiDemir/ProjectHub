import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

let h: Harness;
const admin = makeClient(() => h.base);
const dev = makeClient(() => h.base);
const viewer = makeClient(() => h.base);
const slug = 'ana-sayfa-projesi';

type Sections = {
  work: { myPullRequests: { title: string }[]; reviewRequests: { title: string; author: string }[]; recentBuilds: { status: string }[] } | null;
  management: { projectsAtRisk: { slug: string; reasons: string[] }[]; upcomingReleases: { version: string }[]; customerReviews: unknown[] } | null;
  security: { openCritical: number; newSecrets: { title: string }[]; exceptions: { reason: string | null; by: string | null }[]; trend: { score: number }[] } | null;
};

async function invite(c: ReturnType<typeof makeClient>, email: string, roleKey: string) {
  const roles = (await admin.get('/admin/roles')).data as { id: string; key: string }[];
  const inv = await admin.post('/admin/users', { email, displayName: email.split('@')[0], roleIds: [roles.find((r) => r.key === roleKey)!.id] });
  await c.post('/auth/invitations/accept', { token: new URL((inv.data as { invitationUrl: string }).invitationUrl).pathname.split('/').pop()!, password: 'Kullanici-Parola-2026' });
  const me = (await c.get('/auth/me')).data as { user: { id: string } };
  await admin.post(`/projects/${slug}/members`, { userId: me.user.id, roleId: null });
}

beforeAll(async () => {
  h = await startHarness({ worker: true });
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  await admin.post('/projects', { name: 'Ana Sayfa Projesi', slug, source: { type: 'empty', template: 'static' } });
  await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  await invite(dev, 'gelistirici@example.com', 'developer');
  await invite(viewer, 'izleyici@example.com', 'viewer');

  // A passing build → a draft version (an upcoming release).
  const b = (await admin.post(`/projects/${slug}/builds`, {})).data as { id: string };
  await waitFor(async () => ((await admin.get(`/builds/${b.id}`)).data as { status: string }).status === 'passed', 90_000);
  expect((await admin.post(`/projects/${slug}/versions`, { version: '2.0.0', buildId: b.id, releaseNotes: '' })).status).toBe(201);

  // The developer opens a pull request that the admin has not reviewed yet.
  await dev.post(`/projects/${slug}/repo/branches`, { name: 'feature/menu', from: 'main' });
  const sha = ((await dev.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string; sha: string }[] }).branches.find((x) => x.name === 'feature/menu')!.sha;
  await dev.post(`/projects/${slug}/repo/commits`, { branch: 'feature/menu', baseCommit: sha, message: 'menü', changes: [{ action: 'upsert', path: 'menu.html', content: '<nav></nav>' }] });
  expect((await dev.post(`/projects/${slug}/pull-requests`, { title: 'Yeni menü', sourceBranch: 'feature/menu', targetBranch: 'main' })).status).toBe(201);

  // A leaked token on main → a new critical secret finding after the scan.
  const main = ((await admin.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string; sha: string }[] }).branches.find((x) => x.name === 'main')!.sha;
  await admin.post(`/projects/${slug}/repo/commits`, { branch: 'main', baseCommit: main, message: 'config', changes: [{ action: 'upsert', path: 'deploy.sh', content: `export GH_TOKEN=ghp_${'Q7wErT9yUiOp3aSdFgHjKlZx5cVbNm1q2W4e'}\n` }] });
  const started = Date.now();
  await admin.post(`/projects/${slug}/security/scans`);
  await waitFor(async () => {
    const s = (await admin.get(`/projects/${slug}/security`)).data as { lastScan: { finishedAt: string | null } | null };
    return s.lastScan?.finishedAt && new Date(s.lastScan.finishedAt).getTime() >= started;
  }, 60_000);
}, 240_000);

afterAll(async () => {
  await h?.close();
});

describe('role-based home sections', () => {
  it('shows a developer their own work and nothing managerial', async () => {
    const s = (await dev.get('/home/sections')).data as Sections;
    expect(s.management).toBeNull();
    expect(s.security).toBeNull();
    expect(s.work!.myPullRequests.map((p) => p.title)).toEqual(['Yeni menü']);
    expect(s.work!.reviewRequests).toEqual([]); // own PR is not a review request
  });

  it('shows managers and security owners their sections', async () => {
    const s = (await admin.get('/home/sections')).data as Sections;
    expect(s.work!.reviewRequests).toEqual([expect.objectContaining({ title: 'Yeni menü', author: 'gelistirici' })]);
    expect(s.management!.upcomingReleases.map((v) => v.version)).toEqual(['2.0.0']);
    expect(s.management!.projectsAtRisk).toEqual([expect.objectContaining({ slug, reasons: expect.arrayContaining([expect.stringMatching(/kritik güvenlik bulgusu/)]) })]);
    expect(s.security!.openCritical).toBeGreaterThanOrEqual(1);
    expect(s.security!.newSecrets.length).toBeGreaterThanOrEqual(1);
    expect(s.security!.trend.length).toBeGreaterThanOrEqual(1);
    expect(s.security!.exceptions).toEqual([]);

    // Accepting the risk turns the finding into an exception to re-check, with who and why.
    const findings = ((await admin.get(`/projects/${slug}/security`)).data as { findings: { id: string; type: string; severity: string }[] }).findings;
    const secret = findings.find((f) => f.type === 'secret' && f.severity === 'critical')!;
    expect((await admin.post(`/security/findings/${secret.id}`, { status: 'accepted', reason: 'Token iptal edildi, geçmişten temizlenecek' })).status).toBe(201);
    const after = (await admin.get('/home/sections')).data as Sections;
    expect(after.security!.exceptions).toEqual([expect.objectContaining({ reason: 'Token iptal edildi, geçmişten temizlenecek', by: 'Test Yönetici' })]);
  });

  it('gives viewers no role sections', async () => {
    expect((await viewer.get('/home/sections')).data).toEqual({ work: null, management: null, security: null });
  });
});
