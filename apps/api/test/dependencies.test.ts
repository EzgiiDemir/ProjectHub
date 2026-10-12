import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

/** One local server playing both OSV.dev and the npm registry (the real scan job talks to it over HTTP). */
function fakeOsvAndNpm() {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/osv/v1/querybatch') {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const { queries } = JSON.parse(raw) as { queries: { package: { name: string }; version: string }[] };
        send(200, { results: queries.map((q) => (q.package.name === 'lodash' && q.version === '4.17.20' ? { vulns: [{ id: 'GHSA-35jh-r3h4-6jhm' }] } : {})) });
      });
      return;
    }
    if (req.url === '/osv/v1/vulns/GHSA-35jh-r3h4-6jhm') {
      return send(200, {
        id: 'GHSA-35jh-r3h4-6jhm',
        summary: 'Command Injection in lodash',
        aliases: ['CVE-2021-23337'],
        database_specific: { severity: 'HIGH' },
        affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
      });
    }
    if (req.url === '/npm/react/latest') return send(200, { name: 'react', version: '19.2.0' });
    if (req.url === '/npm/dayjs/latest') return send(200, { name: 'dayjs', version: '1.11.13' });
    send(404, {});
  });
  return server;
}

let h: Harness;
const fake = fakeOsvAndNpm();
const admin = makeClient(() => h.base);
const slug = 'paket-projesi';

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  h = await startHarness({ worker: true, env: { OSV_API_URL: `${url}/osv`, NPM_REGISTRY_URL: `${url}/npm`, OLLAMA_BASE_URL: 'http://127.0.0.1:9' } });
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  await admin.post('/projects', { name: 'Paket Projesi', slug, source: { type: 'empty', template: 'custom' } });
  await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  const head = ((await admin.get(`/projects/${slug}/repo/branches`)).data as { branches: { sha: string }[] }).branches[0]!.sha;
  const commit = await admin.post(`/projects/${slug}/repo/commits`, {
    branch: 'main',
    baseCommit: head,
    message: 'paketler',
    changes: [
      { action: 'upsert', path: 'package.json', content: JSON.stringify({ name: 'paket', dependencies: { react: '^18.3.1', dayjs: '^1.11.13' } }) },
      {
        action: 'upsert',
        path: 'package-lock.json',
        content: JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { dependencies: { react: '^18.3.1', dayjs: '^1.11.13' } },
            'node_modules/react': { version: '18.3.1' },
            'node_modules/dayjs': { version: '1.11.13' },
            'node_modules/lodash': { version: '4.17.20' },
          },
        }),
      },
      { action: 'upsert', path: 'src/app.js', content: "import React from 'react';\nimport { createRoot } from \"react-dom/client\";\n" },
      { action: 'upsert', path: 'src/legacy.js', content: "const R = require('react');\n// react is great\n" },
      { action: 'upsert', path: 'README.md', content: 'Built with react.\n' },
    ],
  });
  expect(commit.status).toBe(201);
}, 120_000);

afterAll(async () => {
  await h?.close();
  fake.close();
});

describe('dependency center', () => {
  type Item = { name: string; version: string; latest: string | null; update: string | null; risk: string; direct: boolean; fixedVersion: string | null; vulnerabilities: { advisoryId: string | null; severity: string }[] };
  type List = { scannedAt: string | null; registryCheck: boolean; summary: Record<string, number>; items: Item[] };

  it('shows current vs latest, vulnerabilities and risk after a real scan', async () => {
    const startedAt = Date.now();
    expect((await admin.post(`/projects/${slug}/security/scans`)).status).toBe(201);
    const list = await waitFor(async () => {
      const l = (await admin.get(`/projects/${slug}/dependencies`)).data as List;
      return l.scannedAt && new Date(l.scannedAt).getTime() >= startedAt ? l : null;
    }, 60_000);
    expect(list.registryCheck).toBe(true);
    const by = Object.fromEntries(list.items.map((i) => [i.name, i]));
    expect(by.react).toMatchObject({ version: '18.3.1', latest: '19.2.0', update: 'major', risk: 'medium', direct: true, vulnerabilities: [] });
    expect(by.dayjs).toMatchObject({ latest: '1.11.13', update: null, risk: 'none' });
    // Transitive and vulnerable: listed even though the inventory only keeps direct packages.
    expect(by.lodash).toMatchObject({ version: '4.17.20', direct: false, risk: 'high', fixedVersion: '4.17.21', vulnerabilities: [expect.objectContaining({ advisoryId: 'CVE-2021-23337', severity: 'high' })] });
    expect(list.items[0]!.name).toBe('lodash');
    expect(list.summary).toMatchObject({ total: 3, direct: 2, outdated: 1, major: 1, vulnerable: 1 });
  }, 90_000);

  it('estimates upgrade impact from real imports only', async () => {
    const u = (await admin.get(`/projects/${slug}/dependencies/usage?ecosystem=npm&name=react`)).data as { supported: boolean; files: { path: string }[] };
    expect(u.supported).toBe(true);
    expect(u.files.map((f) => f.path).sort()).toEqual(['src/app.js', 'src/legacy.js']);
    expect(((await admin.get(`/projects/${slug}/dependencies/usage?ecosystem=Go&name=x`)).data as { supported: boolean }).supported).toBe(false);
  });

  it('does not create an AI task for "Yükseltmeyi hazırla" when the AI model is unavailable', async () => {
    const r = await admin.post(`/projects/${slug}/dependencies/upgrade`, { ecosystem: 'npm', name: 'react' });
    expect(r.status).toBe(503);
    expect(r.error).toMatchObject({ code: 'AI_NOT_CONFIGURED', message: expect.stringContaining('görev oluşturulmadı') });
    expect(((await admin.get(`/projects/${slug}/ai/tasks`)).data as unknown[]).length).toBe(0);
  });

  it('exports a CycloneDX SBOM with transitive packages and their vulnerabilities', async () => {
    const res = await fetch(`${h.base}/api/v1/projects/${slug}/sbom`, { headers: { cookie: await sessionCookie() } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/vnd.cyclonedx+json');
    expect(res.headers.get('content-disposition')).toContain(`${slug}-sbom.cdx.json`);
    const bom = (await res.json()) as { bomFormat: string; specVersion: string; components: { purl: string }[]; vulnerabilities: { id: string; affects: { ref: string }[] }[] };
    expect(bom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.6' });
    expect(bom.components.map((c) => c.purl).sort()).toEqual(['pkg:npm/dayjs@1.11.13', 'pkg:npm/lodash@4.17.20', 'pkg:npm/react@18.3.1']);
    expect(bom.vulnerabilities).toEqual([expect.objectContaining({ id: 'CVE-2021-23337', affects: [{ ref: 'pkg:npm/lodash@4.17.20' }] })]);
  });
});

/** Logs in on a raw fetch to read the SBOM as a file download (the harness client parses JSON envelopes). */
async function sessionCookie() {
  const res = await fetch(`${h.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'projecthub' }, body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }) });
  return res.headers.getSetCookie().find((c) => c.startsWith('ph_session='))!.split(';')[0]!;
}
