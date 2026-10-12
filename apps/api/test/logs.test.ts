import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

let h: Harness;
const admin = makeClient(() => h.base);
const slug = 'log-projesi';

type Match = { source: string; label: string; level: string; text: string; step: string | null; at: string };
type Result = { stats: { error: number; warn: number; lines: number }; bySource: Record<string, { documents: number; error: number }>; total: number; matches: Match[] };

const manifest = (cmd: string) => ['project:', '  name: Log Projesi', 'runtime:', '  type: other', 'build:', `  command: ${JSON.stringify(cmd)}`, 'preview:', '  enabled: false', ''].join('\n');

/** Commits a manifest whose build command prints the given lines, runs a real build and waits for it to finish. */
async function build(cmd: string) {
  const head = ((await admin.get(`/projects/${slug}/repo/branches`)).data as { branches: { sha: string }[] }).branches[0]!.sha;
  expect((await admin.post(`/projects/${slug}/repo/commits`, { branch: 'main', baseCommit: head, message: 'build', changes: [{ action: 'upsert', path: 'projecthub.yml', content: manifest(cmd) }] })).status).toBe(201);
  const b = (await admin.post(`/projects/${slug}/builds`, {})).data as { id: string };
  return waitFor(async () => {
    const x = (await admin.get(`/builds/${b.id}`)).data as { status: string };
    return ['passed', 'failed'].includes(x.status) ? x.status : null;
  }, 90_000);
}

beforeAll(async () => {
  h = await startHarness({ worker: true });
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  await admin.post('/projects', { name: 'Log Projesi', slug, source: { type: 'empty', template: 'custom' } });
  await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  expect(await build(`node -e "console.log('derleme tamam'); console.warn('Warning: eski API kullanılıyor')"`)).toBe('passed');
  expect(await build(`node -e "console.error('Error: ödeme servisi zaman aşımı'); process.exit(1)"`)).toBe('failed');
}, 240_000);

afterAll(async () => {
  await h?.close();
});

describe('log search', () => {
  it('finds lines across real build logs with levels, steps and counts', async () => {
    const all = (await admin.get(`/projects/${slug}/logs`)).data as Result;
    expect(all.bySource.build!.documents).toBeGreaterThanOrEqual(2);
    expect(all.stats.error).toBeGreaterThanOrEqual(1);
    expect(all.stats.warn).toBeGreaterThanOrEqual(1);

    const hit = (await admin.get(`/projects/${slug}/logs?q=${encodeURIComponent('ödeme servisi')}`)).data as Result;
    expect(hit.matches.length).toBeGreaterThanOrEqual(1);
    expect(hit.matches[0]).toMatchObject({ source: 'build', level: 'error', text: expect.stringContaining('Error: ödeme servisi zaman aşımı') });
    expect(hit.matches[0]!.label).toMatch(/^Build #\d+ · main$/);
    expect(hit.matches[0]!.step).toBeTruthy();

    const errors = (await admin.get(`/projects/${slug}/logs?level=error`)).data as Result;
    expect(errors.matches.every((m) => m.level === 'error')).toBe(true);
    expect(errors.matches.some((m) => m.text.includes('eski API'))).toBe(false);
    const warns = (await admin.get(`/projects/${slug}/logs?level=warn&q=eski`)).data as Result;
    expect(warns.matches.map((m) => m.level)).toContain('warn');
  });

  it('filters by source, environment and time window', async () => {
    expect(((await admin.get(`/projects/${slug}/logs?source=deployment&q=ödeme`)).data as Result).total).toBe(0);
    const env = ((await admin.get(`/projects/${slug}/environments`)).data as { id: string }[])[0]!.id;
    expect(((await admin.get(`/projects/${slug}/logs?environmentId=${env}`)).data as Result).bySource.build!.documents).toBe(0);
    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    const older = new Date(Date.now() - 9 * 86400_000).toISOString();
    expect(((await admin.get(`/projects/${slug}/logs?from=${old}&to=${older}`)).data as Result).total).toBe(0);
    expect((await admin.get(`/projects/${slug}/logs?level=debug`)).status).toBe(400);
  });
});
