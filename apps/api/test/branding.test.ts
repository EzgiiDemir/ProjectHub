import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

let h: Harness;
const admin = makeClient(() => h.base);
const dev = makeClient(() => h.base);
const visitor = makeClient(() => h.base);
const slug = 'marka-projesi';
let token = '';

// 1×1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;

beforeAll(async () => {
  h = await startHarness({ worker: true });
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  await admin.post('/projects', { name: 'Marka Projesi', slug, source: { type: 'empty', template: 'static' } });
  await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  const roles = (await admin.get('/admin/roles')).data as { id: string; key: string }[];
  const inv = await admin.post('/admin/users', { email: 'dev@example.com', displayName: 'Deniz', roleIds: [roles.find((r) => r.key === 'developer')!.id] });
  await dev.post('/auth/invitations/accept', { token: new URL((inv.data as { invitationUrl: string }).invitationUrl).pathname.split('/').pop()!, password: 'Gelistirici-2026' });
  const me = (await dev.get('/auth/me')).data as { user: { id: string } };
  await admin.post(`/projects/${slug}/members`, { userId: me.user.id, roleId: null });

  // A real static preview and a customer link for it.
  const b = (await admin.post(`/projects/${slug}/builds`, {})).data as { id: string };
  await waitFor(async () => ((await admin.get(`/builds/${b.id}`)).data as { status: string }).status === 'passed', 90_000);
  const pv = (await admin.post(`/projects/${slug}/previews`, { buildId: b.id })).data as { id: string };
  await waitFor(async () => ((await admin.get(`/projects/${slug}/previews`)).data as { id: string; status: string }[]).find((p) => p.id === pv.id)?.status === 'ready', 60_000);
  const review = (await admin.post(`/projects/${slug}/reviews`, { previewId: pv.id, name: 'Ana sayfa incelemesi', expiresInMinutes: 120 })).data as { url: string };
  token = new URL(review.url).pathname.split('/').pop()!;
}, 240_000);

afterAll(async () => {
  await h?.close();
});

describe('customer portal branding', () => {
  it('validates logos and colours and enforces permissions', async () => {
    expect((await admin.put(`/projects/${slug}/branding`, { logo: SVG, customerLogo: null, accent: null })).status).toBe(400);
    expect((await admin.put(`/projects/${slug}/branding`, { logo: null, customerLogo: null, accent: 'red' })).status).toBe(400);
    expect((await dev.put(`/projects/${slug}/branding`, { logo: PNG, customerLogo: null, accent: null })).status).toBe(403);
    expect((await dev.put('/organization/branding', { logo: PNG })).status).toBe(403);
    expect(((await dev.get(`/projects/${slug}/branding`)).data as { canEdit: boolean }).canEdit).toBe(false);
  });

  it('shows the company logo, project and customer logos and the accent colour on the customer portal', async () => {
    const before = (await visitor.get(`/public/reviews/${token}`)).data as { branding: Record<string, unknown> };
    expect(before.branding).toEqual({ companyLogo: null, projectLogo: null, customerLogo: null, accent: null });

    expect((await admin.put('/organization/branding', { logo: PNG })).status).toBe(200);
    const saved = await admin.put(`/projects/${slug}/branding`, { logo: PNG, customerLogo: PNG, accent: '#C2410C' });
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({ logo: PNG, customerLogo: PNG, accent: '#C2410C', companyLogo: PNG, canEdit: true });

    const after = (await visitor.get(`/public/reviews/${token}`)).data as { branding: Record<string, unknown> };
    expect(after.branding).toEqual({ companyLogo: PNG, projectLogo: PNG, customerLogo: PNG, accent: '#C2410C' });

    // Removing a logo falls back to the initials badge.
    await admin.put(`/projects/${slug}/branding`, { logo: null, customerLogo: PNG, accent: '#C2410C' });
    expect(((await visitor.get(`/public/reviews/${token}`)).data as { branding: { projectLogo: unknown } }).branding.projectLogo).toBeNull();
  });
});
