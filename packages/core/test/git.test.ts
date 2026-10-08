import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitRepository, normaliseRepoPath } from '../src/git.js';

const author = { name: 'Test User', email: 'test@example.com' };
let tmp: string;
let repo: GitRepository;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-git-'));
  repo = await GitRepository.initBare(path.join(tmp, 'repo.git'), 'main');
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GitRepository', () => {
  it('commits files without a working copy and reads them back', async () => {
    expect(await repo.isEmpty()).toBe(true);
    const c1 = await repo.commitChanges({
      branch: 'main',
      baseCommit: null,
      message: 'Initial commit',
      author,
      changes: [
        { action: 'upsert', path: 'README.md', content: '# Demo\n\nŞirket projesi.\n' },
        { action: 'upsert', path: 'src/app.ts', content: 'export const x = 1;\n' },
      ],
    });
    expect(c1).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.resolve('main')).toBe(c1);
    const tree = await repo.listTree(c1);
    expect(tree.map((t) => t.name)).toEqual(['src', 'README.md']);
    const file = await repo.readFile(c1, 'README.md');
    expect(file?.content.toString('utf8')).toContain('Şirket');
    const log = await repo.log({ ref: 'main' });
    expect(log[0]).toMatchObject({ sha: c1, subject: 'Initial commit', filesChanged: 2, authorName: 'Test User' });
  });

  it('deletes files in a bare repository', async () => {
    const base = (await repo.resolve('main'))!;
    await repo.commitChanges({ branch: 'main', baseCommit: base, message: 'tmp', author, changes: [{ action: 'upsert', path: 'tmp/remove-me.txt', content: 'x' }] });
    const withFile = (await repo.resolve('main'))!;
    const after = await repo.commitChanges({ branch: 'main', baseCommit: withFile, message: 'Remove', author, changes: [{ action: 'delete', path: 'tmp/remove-me.txt' }] });
    expect((await repo.listFiles(after)).map((f) => f.path)).not.toContain('tmp/remove-me.txt');
  });

  it('rejects stale edits (compare-and-swap on the branch ref)', async () => {
    const base = (await repo.resolve('main'))!;
    await repo.commitChanges({ branch: 'main', baseCommit: base, message: 'Edit A', author, changes: [{ action: 'upsert', path: 'src/app.ts', content: 'export const x = 2;\n' }] });
    await expect(
      repo.commitChanges({ branch: 'main', baseCommit: base, message: 'Edit B', author, changes: [{ action: 'upsert', path: 'src/app.ts', content: 'export const x = 3;\n' }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('branches, diffs and merges (fast-forward and true merge)', async () => {
    const main = (await repo.resolve('main'))!;
    await repo.createBranch('feature/a', main);
    const fa = await repo.commitChanges({ branch: 'feature/a', baseCommit: main, message: 'Feature A', author, changes: [{ action: 'upsert', path: 'src/a.ts', content: 'a\n' }] });
    const stat = await repo.diffStat(main, fa);
    expect(stat).toEqual([{ path: 'src/a.ts', additions: 1, deletions: 0, binary: false }]);
    expect((await repo.diffPatch(main, fa)).patch).toContain('+a');
    const ff = await repo.merge({ source: 'feature/a', target: 'main', message: 'Merge', author });
    expect(ff.fastForward).toBe(true);

    const m2 = (await repo.resolve('main'))!;
    await repo.createBranch('feature/b', m2);
    await repo.commitChanges({ branch: 'feature/b', baseCommit: m2, message: 'B', author, changes: [{ action: 'upsert', path: 'b.txt', content: 'b\n' }] });
    const m3 = await repo.commitChanges({ branch: 'main', baseCommit: m2, message: 'Main moves', author, changes: [{ action: 'upsert', path: 'c.txt', content: 'c\n' }] });
    // Review diff of feature/b against main must only contain the branch's own change, not main's new commit reversed.
    const fb = (await repo.resolve('feature/b'))!;
    expect(await repo.mergeBase(m3, fb)).toBe(m2);
    expect((await repo.diffStat((await repo.mergeBase(m3, fb))!, fb)).map((s) => s.path)).toEqual(['b.txt']);
    const merged = await repo.merge({ source: 'feature/b', target: 'main', message: 'Merge feature/b', author });
    expect(merged.fastForward).toBe(false);
    const files = (await repo.listFiles(merged.sha)).map((f) => f.path).sort();
    expect(files).toEqual(['README.md', 'b.txt', 'c.txt', 'src/a.ts', 'src/app.ts']);
  });

  it('reports merge conflicts instead of resolving them', async () => {
    const main = (await repo.resolve('main'))!;
    await repo.createBranch('conflict', main);
    await repo.commitChanges({ branch: 'conflict', baseCommit: main, message: 'X', author, changes: [{ action: 'upsert', path: 'c.txt', content: 'from branch\n' }] });
    await repo.commitChanges({ branch: 'main', baseCommit: main, message: 'Y', author, changes: [{ action: 'upsert', path: 'c.txt', content: 'from main\n' }] });
    await expect(repo.merge({ source: 'conflict', target: 'main', message: 'M', author })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('exports a commit to a directory and commits a directory', async () => {
    const out = path.join(tmp, 'export');
    await fs.mkdir(out);
    await repo.exportTo('main', out);
    expect(await fs.readFile(path.join(out, 'src', 'a.ts'), 'utf8')).toBe('a\n');

    const other = await GitRepository.initBare(path.join(tmp, 'other.git'), 'main');
    const src = path.join(tmp, 'upload');
    await fs.mkdir(path.join(src, 'pages'), { recursive: true });
    await fs.writeFile(path.join(src, 'index.html'), '<h1>Merhaba</h1>');
    await fs.writeFile(path.join(src, 'pages', 'about.html'), '<p>Hakkımızda</p>');
    const sha = await other.commitDirectory({ dir: src, branch: 'main', message: 'Import', author });
    expect((await other.listFiles(sha)).map((f) => f.path).sort()).toEqual(['index.html', 'pages/about.html']);
    expect((await other.grep(sha, 'hakkımızda')).map((g) => g.path)).toEqual(['pages/about.html']);
  });

  it('rejects path traversal', () => {
    expect(() => normaliseRepoPath('../etc/passwd')).toThrow();
    expect(() => normaliseRepoPath('.git/config')).toThrow();
    expect(() => normaliseRepoPath('C:/x')).toThrow();
    expect(normaliseRepoPath('./src//a.ts')).toBe('src/a.ts');
  });
});
