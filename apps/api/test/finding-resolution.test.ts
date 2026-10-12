import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

let h: Harness;
const admin = makeClient(() => h.base);
const slug = 'cozum-projesi';
const TOKEN = `ghp_${'Q7wErT9yUiOp3aSdFgHjKlZx5cVbNm1q2W4e'}`;

type Finding = { id: string; type: string; status: string; filePath: string | null };
type Verification = { state: string; message: string };

const head = async () => ((await admin.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string; sha: string }[] }).branches.find((b) => b.name === 'main')!.sha;
const commit = async (content: string) => expect((await admin.post(`/projects/${slug}/repo/commits`, { branch: 'main', baseCommit: await head(), message: 'deploy.sh', changes: [{ action: 'upsert', path: 'deploy.sh', content }] })).status).toBe(201);
const secretFinding = async () => ((await admin.get(`/projects/${slug}/security?status=all`)).data as { findings: Finding[] }).findings.find((f) => f.type === 'secret' && f.filePath === 'deploy.sh')!;
const verify = (id: string, scanId: string) =>
  waitFor(async () => {
    const v = (await admin.get(`/security/findings/${id}/verification?scanId=${scanId}`)).data as Verification;
    return v.state === 'pending' ? null : v;
  }, 60_000);

beforeAll(async () => {
  h = await startHarness({ worker: true });
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  await admin.post('/projects', { name: 'Çözüm Projesi', slug, source: { type: 'empty', template: 'static' } });
  await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  await commit(`export GH_TOKEN=${TOKEN}\n`);
  const started = Date.now();
  await admin.post(`/projects/${slug}/security/scans`);
  await waitFor(async () => {
    const s = (await admin.get(`/projects/${slug}/security`)).data as { lastScan: { finishedAt: string | null } | null };
    return s.lastScan?.finishedAt && new Date(s.lastScan.finishedAt).getTime() >= started;
  }, 60_000);
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe('"Çözüldü" with verification', () => {
  it('reopens the finding when the problem is still in the code', async () => {
    const f = await secretFinding();
    expect(f.status).toBe('open');
    const r = await admin.post(`/security/findings/${f.id}/resolve`, {});
    expect(r.status).toBe(201);
    const v = await verify(f.id, (r.data as { scanId: string }).scanId);
    expect(v.state).toBe('still_present');
    expect((await secretFinding()).status).toBe('open');
  }, 90_000);

  it('confirms the fix once the code no longer contains the problem', async () => {
    const f = await secretFinding();
    const started = Date.now();
    await commit('export GH_TOKEN="$GH_TOKEN"\n');
    // Pressing "Çözüldü" right after the fix: either the verification scan or the push's own scan closes it.
    const r = await admin.post(`/security/findings/${f.id}/resolve`, { note: 'Token iptal edildi, Secret olarak taşındı' });
    let scanId = (r.data as { scanId?: string } | undefined)?.scanId;
    if (r.status === 412) {
      // The automatic scan after the push was faster; verify against that scan instead.
      scanId = await waitFor(async () => {
        const s = (await admin.get(`/projects/${slug}/security`)).data as { lastScan: { id: string; finishedAt: string | null } | null };
        return s.lastScan?.finishedAt && new Date(s.lastScan.finishedAt).getTime() >= started ? s.lastScan.id : null;
      }, 60_000);
    }
    const v = await verify(f.id, scanId!);
    expect(v).toMatchObject({ state: 'verified', message: expect.stringContaining('sorun bulunamadı') });
    expect((await secretFinding()).status).toBe('resolved');
    expect((await admin.post(`/security/findings/${f.id}/resolve`, {})).status).toBe(412);
  }, 120_000);
});
