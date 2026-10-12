import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, client as makeClient, startHarness, waitFor, type Harness } from './harness.js';

const git = promisify(execFile);
let h: Harness;
const admin = makeClient(() => h.base);
const dev = makeClient(() => h.base);
let projectId = '';
const slug = 'pr-projesi';

type Pr = { number: number; status: string; checks: { mergeable: boolean; approvals: number; blockers: string[] }; headCommit: string; diff: { files: { path: string }[] } };

beforeAll(async () => {
  h = await startHarness({ worker: true });
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  const created = await admin.post('/projects', { name: 'PR Projesi', slug, source: { type: 'empty' } });
  projectId = (created.data as { id: string }).id;
  await waitFor(async () => ((await admin.get(`/projects/${slug}`)).data as { repository: { status: string } | null }).repository?.status === 'ready');
  // A developer, invited and added to the project.
  const roles = (await admin.get('/admin/roles')).data as { id: string; key: string }[];
  const inv = await admin.post('/admin/users', { email: 'dev@example.com', displayName: 'Deniz Geliştirici', roleIds: [roles.find((r) => r.key === 'developer')!.id] });
  const token = new URL((inv.data as { invitationUrl: string }).invitationUrl).pathname.split('/').pop()!;
  await dev.post('/auth/invitations/accept', { token, password: 'Gelistirici-2026' });
  const me = (await dev.get('/auth/me')).data as { user: { id: string } };
  await admin.post(`/projects/${slug}/members`, { userId: me.user.id, roleId: null });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const head = async (branch: string) => ((await dev.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string; sha: string }[] }).branches.find((b) => b.name === branch)?.sha;
const commit = (branch: string, baseCommit: string, path: string, content: string) => dev.post(`/projects/${slug}/repo/commits`, { branch, baseCommit, message: `edit ${path}`, changes: [{ action: 'upsert', path, content }] });

describe('pull requests and branch protection (real API, worker and Git)', () => {
  it('protects main: no web edits, direct merges or deletion — only reviewed pull requests', async () => {
    const main = (await head('main'))!;
    expect((await dev.post(`/projects/${slug}/repo/branches`, { name: 'feature/iletisim', from: 'main' })).status).toBe(201);
    expect((await commit('feature/iletisim', main, 'iletisim.html', '<h1>İletişim</h1>')).status).toBe(201);

    expect((await dev.put(`/projects/${slug}/branch-protection`, { branches: ['main'], requiredApprovals: 1, requirePassingBuild: false })).status).toBe(403); // developer is not a project admin
    expect((await admin.put(`/projects/${slug}/branch-protection`, { branches: ['main'], requiredApprovals: 1, requirePassingBuild: false })).status).toBe(200);

    expect((await commit('main', main, 'x.txt', 'x')).status).toBe(403);
    expect((await dev.post(`/projects/${slug}/repo/merge`, { source: 'feature/iletisim', target: 'main' })).status).toBe(403);
    expect((await dev.raw('DELETE', `/projects/${slug}/repo/branches?name=main`)).status).toBe(403);
  });

  it('requires an approval on the current head, from someone other than the author', async () => {
    const opened = await dev.post(`/projects/${slug}/pull-requests`, { title: 'İletişim sayfası', description: 'Yeni sayfa', sourceBranch: 'feature/iletisim', targetBranch: 'main' });
    expect(opened.status).toBe(201);
    const n = (opened.data as Pr).number;
    expect(n).toBe(1);
    expect((await dev.post(`/projects/${slug}/pull-requests`, { title: 'Tekrar', sourceBranch: 'feature/iletisim', targetBranch: 'main' })).status).toBe(409);

    let pr = (await dev.get(`/projects/${slug}/pull-requests/1`)).data as Pr;
    expect(pr.diff.files.map((f) => f.path)).toEqual(['iletisim.html']);
    expect(pr.checks.mergeable).toBe(false);
    expect(pr.checks.blockers.join()).toContain('1 onay gerekli');

    expect((await dev.post(`/projects/${slug}/pull-requests/1/reviews`, { decision: 'approved' })).status).toBe(403); // own PR
    expect((await dev.post(`/projects/${slug}/pull-requests/1/merge`, {})).status).toBe(412);

    pr = (await admin.post(`/projects/${slug}/pull-requests/1/reviews`, { decision: 'approved', body: 'Uygun' })).data as Pr;
    expect(pr.checks).toMatchObject({ approvals: 1, mergeable: true });

    // A new commit after the approval makes it stale.
    expect((await commit('feature/iletisim', pr.headCommit, 'iletisim.html', '<h1>Bize ulaşın</h1>')).status).toBe(201);
    pr = (await dev.get(`/projects/${slug}/pull-requests/1`)).data as Pr;
    expect(pr.checks).toMatchObject({ approvals: 0, mergeable: false });

    await admin.post(`/projects/${slug}/pull-requests/1/reviews`, { decision: 'approved' });
    await dev.post(`/projects/${slug}/pull-requests/1/comments`, { body: 'Teşekkürler!' });
    const merged = await dev.post(`/projects/${slug}/pull-requests/1/merge`, { deleteSourceBranch: true });
    expect(merged.status).toBe(200);
    expect((merged.data as Pr).status).toBe('merged');

    const file = await dev.get(`/projects/${slug}/repo/file?path=iletisim.html`);
    expect((file.data as { content: string }).content).toBe('<h1>Bize ulaşın</h1>');
    expect(await head('feature/iletisim')).toBeUndefined();
    const timeline = (await admin.get(`/projects/${slug}/timeline`)).data as { title: string }[];
    expect(timeline.map((t) => t.title).join('\n')).toContain('PR #1 açıldı');
  });

  it('rejects a git push to the protected branch over HTTPS', async () => {
    const tok = (await dev.post('/auth/tokens', { name: 'cli', expiresInDays: 1 })).data as { token: string };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-clone-'));
    const url = `${h.base.replace('http://', `http://dev:${tok.token}@`)}/git/${projectId}.git`;
    try {
      await git('git', ['clone', '-q', url, dir]);
      await fs.writeFile(path.join(dir, 'push.txt'), 'doğrudan push');
      await git('git', ['-C', dir, 'add', '.']);
      await git('git', ['-C', dir, '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'direct push']);
      const push = await git('git', ['-C', dir, 'push', 'origin', 'HEAD:main']).then(
        () => ({ ok: true, stderr: '' }),
        (e: { stderr: string }) => ({ ok: false, stderr: e.stderr }),
      );
      expect(push.ok).toBe(false);
      expect(push.stderr).toContain('korumali bir branch');
      // Other branches are still pushable.
      await git('git', ['-C', dir, 'push', '-q', 'origin', 'HEAD:refs/heads/feature/cli']);
      expect(await head('feature/cli')).toBeTruthy();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
