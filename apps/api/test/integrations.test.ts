import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

/** A WordPress site as far as the REST API is concerned: /wp-json/ and /wp/v2/users/me with an application password. */
function fakeWordPress() {
  return http.createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/wp-json/') return json(200, { name: 'Şirket Sitesi', namespaces: ['wp/v2', 'wpforms/v1'] });
    if (req.url?.startsWith('/wp-json/wp/v2/users/me')) {
      // WordPress ignores the spaces it shows in application passwords.
      const ok = req.headers.authorization === `Basic ${Buffer.from('editor:abcdefghijklmnop').toString('base64')}`;
      return ok ? json(200, { name: 'Site Editörü', roles: ['editor'] }) : json(401, { code: 'invalid_username' });
    }
    json(404, {});
  });
}

let h: Harness;
const wp = fakeWordPress();
let site = '';
const admin = makeClient(() => h.base);
const dev = makeClient(() => h.base);
const slug = 'entegrasyon-projesi';

type Item = { id: string; provider: string; enabled: boolean; fields: { key: string; env: string; value: string | null; stored: boolean }[]; lastCheckOk: boolean | null };

beforeAll(async () => {
  await new Promise<void>((r) => wp.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(wp.address() as AddressInfo).port}`;
  h = await startHarness({ worker: true });
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  await admin.post('/projects', { name: 'Entegrasyon Projesi', slug, source: { type: 'empty', template: 'custom' } });
  await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  const roles = (await admin.get('/admin/roles')).data as { id: string; key: string }[];
  const inv = await admin.post('/admin/users', { email: 'dev@example.com', displayName: 'Deniz', roleIds: [roles.find((r) => r.key === 'developer')!.id] });
  await dev.post('/auth/invitations/accept', { token: new URL((inv.data as { invitationUrl: string }).invitationUrl).pathname.split('/').pop()!, password: 'Gelistirici-2026' });
  await admin.post(`/projects/${slug}/members`, { userId: ((await dev.get('/auth/me')).data as { user: { id: string } }).user.id, roleId: null });
}, 180_000);

afterAll(async () => {
  await h?.close();
  wp.close();
});

/** Runs a real build whose command prints which integration variables it received. */
async function buildEnv(): Promise<string> {
  const head = ((await admin.get(`/projects/${slug}/repo/branches`)).data as { branches: { sha: string }[] }).branches[0]!.sha;
  const cmd = `node -e "console.log('ENV:' + ['WORDPRESS_URL','WORDPRESS_USERNAME','WORDPRESS_APP_PASSWORD'].map(k => k + '=' + (process.env[k] ? (k.includes('PASSWORD') ? 'set' : process.env[k]) : '-')).join(','))"`;
  const manifest = ['project:', '  name: Entegrasyon Projesi', 'runtime:', '  type: other', 'build:', `  command: ${JSON.stringify(cmd)}`, 'preview:', '  enabled: false', ''].join('\n');
  await admin.post(`/projects/${slug}/repo/commits`, { branch: 'main', baseCommit: head, message: 'build', changes: [{ action: 'upsert', path: 'projecthub.yml', content: manifest }] });
  const b = (await admin.post(`/projects/${slug}/builds`, {})).data as { id: string };
  await waitFor(async () => ['passed', 'failed'].includes(((await admin.get(`/builds/${b.id}`)).data as { status: string }).status), 90_000);
  const logs = await fetch(`${h.base}/api/v1/projects/${slug}/logs?q=ENV:`, { headers: { cookie: await cookie() } }).then((r) => r.json() as Promise<{ data: { matches: { text: string; refId: string }[] } }>);
  return logs.data.matches.find((m) => m.refId === b.id)?.text ?? '';
}
async function cookie() {
  const res = await fetch(`${h.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'projecthub' }, body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }) });
  return res.headers.getSetCookie().find((c) => c.startsWith('ph_session='))!.split(';')[0]!;
}

describe('project integrations', () => {
  let wpId = '';

  it('validates input and permissions', async () => {
    expect(((await admin.get('/integrations/catalog')).data as { id: string }[]).map((p) => p.id)).toContain('microsoft-entra');
    expect((await admin.post(`/projects/${slug}/integrations`, { provider: 'microsoft-entra', name: 'Giriş', values: { tenantId: 'x', clientId: 'y', clientSecret: 'z' } })).status).toBe(400);
    expect((await admin.post(`/projects/${slug}/integrations`, { provider: 'wordpress', name: 'Site', values: { siteUrl: site } })).status).toBe(400); // missing required
    expect((await dev.post(`/projects/${slug}/integrations`, { provider: 'google-analytics', name: 'GA', values: { measurementId: 'G-ABC1234' } })).status).toBe(403);
    expect((await admin.post(`/projects/${slug}/integrations`, { provider: 'rest-api', name: 'Kargo', values: { baseUrl: 'https://api.ornek.com' } })).status).toBe(400); // prefix required
  });

  it('stores WordPress credentials as encrypted variables and tests the real connection', async () => {
    const r = await admin.post(`/projects/${slug}/integrations`, { provider: 'wordpress', name: 'Şirket sitesi', values: { siteUrl: site, username: 'editor', appPassword: 'abcd efgh ijkl mnop' } });
    expect(r.status).toBe(201);
    const item = r.data as Item;
    wpId = item.id;
    expect(item.fields.find((f) => f.key === 'appPassword')).toMatchObject({ env: 'WORDPRESS_APP_PASSWORD', value: null, stored: true });
    const t = (await admin.post(`/projects/${slug}/integrations/${wpId}/test`)).data as { ok: boolean; message: string; details: string[] };
    expect(t).toMatchObject({ ok: true, message: 'Şirket Sitesi sitesine bağlanıldı' });
    expect(t.details).toEqual(['Kullanıcı: Site Editörü (editor)', 'WP Forms REST uç noktası bulundu']);
    // Variables are visible (names only) on the secrets page.
    const secrets = (await admin.get(`/projects/${slug}/secrets`)).data as { name: string }[];
    expect(secrets.map((s) => s.name)).toEqual(expect.arrayContaining(['WORDPRESS_URL', 'WORDPRESS_USERNAME', 'WORDPRESS_APP_PASSWORD']));

    // Wrong password → failing test; an empty secret on update keeps the stored one.
    await admin.put(`/projects/${slug}/integrations/${wpId}`, { provider: 'wordpress', name: 'Şirket sitesi', values: { appPassword: 'yanlis' } });
    expect(((await admin.post(`/projects/${slug}/integrations/${wpId}/test`)).data as { ok: boolean }).ok).toBe(false);
    await admin.put(`/projects/${slug}/integrations/${wpId}`, { provider: 'wordpress', name: 'Şirket sitesi', values: { appPassword: 'abcdefghijklmnop', siteUrl: site } });
    expect(((await admin.post(`/projects/${slug}/integrations/${wpId}/test`)).data as { ok: boolean }).ok).toBe(true);
  });

  it('delivers the variables to builds, and stops when disabled or removed', async () => {
    expect(await buildEnv()).toContain(`ENV:WORDPRESS_URL=${site},WORDPRESS_USERNAME=editor,WORDPRESS_APP_PASSWORD=set`);
    await admin.put(`/projects/${slug}/integrations/${wpId}`, { provider: 'wordpress', name: 'Şirket sitesi', values: {}, enabled: false });
    expect(await buildEnv()).toContain('ENV:WORDPRESS_URL=-,WORDPRESS_USERNAME=-,WORDPRESS_APP_PASSWORD=-');
    expect((await admin.del(`/projects/${slug}/integrations/${wpId}`)).status).toBe(200);
    const secrets = (await admin.get(`/projects/${slug}/secrets`)).data as { name: string }[];
    expect(secrets.some((s) => s.name.startsWith('WORDPRESS_'))).toBe(false);
  }, 240_000);

  it('keeps prefixed integrations apart and refuses clashes', async () => {
    expect((await admin.post(`/projects/${slug}/integrations`, { provider: 'rest-api', name: 'Kargo', prefix: 'KARGO', values: { baseUrl: `${site}/wp-json/` } })).status).toBe(201);
    expect((await admin.post(`/projects/${slug}/integrations`, { provider: 'rest-api', name: 'Kargo 2', prefix: 'KARGO', values: { baseUrl: 'https://b.ornek.com' } })).status).toBe(409);
    const erp = await admin.post(`/projects/${slug}/integrations`, { provider: 'rest-api', name: 'ERP', prefix: 'ERP', values: { baseUrl: `${site}/wp-json/`, apiKey: 'k' } });
    expect(erp.status).toBe(201);
    expect(((await admin.post(`/projects/${slug}/integrations/${(erp.data as Item).id}/test`)).data as { ok: boolean; details: string[] }).details).toEqual(['ERP_BASE_URL → HTTP 200']);
  });
});
