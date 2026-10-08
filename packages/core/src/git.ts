import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomToken } from './crypto.js';
import { AppError, conflict, invalid, precondition } from './errors.js';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const SHA_RE = /^[0-9a-f]{40}$/;

export interface GitRunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string | Buffer;
  timeoutMs?: number;
  maxBuffer?: number;
  allowExitCodes?: number[];
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface Author {
  name: string;
  email: string;
}

export interface BranchInfo {
  name: string;
  sha: string;
  date: string;
  author: string;
  subject: string;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'blob' | 'tree' | 'commit';
  mode: string;
  sha: string;
  size: number | null;
}

export interface CommitInfo {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
  body?: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface FileStat {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export type FileChange = { action: 'upsert'; path: string; content: string | Buffer } | { action: 'delete'; path: string };

/** Validates and normalises a repository relative path. Rejects traversal and .git internals. */
export function normaliseRepoPath(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
  if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n)) throw invalid(`Geçersiz dosya yolu: ${p}`);
  const parts = n.split('/');
  if (parts.some((s) => s === '..' || s === '.' || s === '' || s.toLowerCase() === '.git')) {
    throw invalid(`Geçersiz dosya yolu: ${p}`);
  }
  return n;
}

export function isSha(v: string): boolean {
  return SHA_RE.test(v);
}

/** Thin, safe wrapper around the git CLI for one bare repository. Arguments are never passed through a shell. */
export class GitRepository {
  constructor(
    readonly dir: string,
    private readonly gitBinary = 'git',
  ) {}

  async run(args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
    const fullArgs = ['-c', 'safe.directory=*', '-c', 'core.quotepath=off', '-c', 'core.autocrlf=false', `--git-dir=${this.dir}`, ...args];
    return runGit(this.gitBinary, fullArgs, opts);
  }

  async text(args: string[], opts: GitRunOptions = {}): Promise<string> {
    return (await this.run(args, opts)).stdout.toString('utf8');
  }

  static async initBare(dir: string, defaultBranch: string, gitBinary = 'git'): Promise<GitRepository> {
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await runGit(gitBinary, ['init', '--bare', `--initial-branch=${defaultBranch}`, dir]);
    const repo = new GitRepository(dir, gitBinary);
    await repo.configureServerDefaults();
    return repo;
  }

  /** Imports an external repository (all branches and tags). The token is sent as a header and never written to disk. */
  static async cloneBare(url: string, dir: string, opts: { token?: string; gitBinary?: string; timeoutMs?: number } = {}): Promise<GitRepository> {
    const gitBinary = opts.gitBinary ?? 'git';
    await fs.mkdir(path.dirname(dir), { recursive: true });
    const args = ['-c', 'safe.directory=*'];
    if (opts.token) args.push('-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${opts.token}`).toString('base64')}`);
    args.push('clone', '--bare', '--no-tags', url, dir);
    await runGit(gitBinary, args, { timeoutMs: opts.timeoutMs ?? 10 * 60_000, env: { GIT_TERMINAL_PROMPT: '0' } });
    const repo = new GitRepository(dir, gitBinary);
    await repo.run(['remote', 'remove', 'origin'], { allowExitCodes: [0, 2] });
    await repo.configureServerDefaults();
    await repo.fetchTags(url, opts.token);
    return repo;
  }

  private async configureServerDefaults(): Promise<void> {
    await this.run(['config', 'http.receivepack', 'true']);
    await this.run(['config', 'receive.denyDeleteCurrent', 'true']);
    await this.run(['config', 'uploadpack.allowFilter', 'true']);
    await this.run(['config', 'core.logAllRefUpdates', 'true']);
  }

  private async fetchTags(url: string, token?: string): Promise<void> {
    const args: string[] = [];
    if (token) args.push('-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`);
    args.push('fetch', '--tags', url);
    await this.run(args, { timeoutMs: 5 * 60_000, env: { GIT_TERMINAL_PROMPT: '0' }, allowExitCodes: [0, 1, 128] });
  }

  /** Re-synchronises all branches from the upstream the project was imported from. */
  async syncFromUpstream(url: string, token?: string): Promise<void> {
    const args: string[] = [];
    if (token) args.push('-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`);
    args.push('fetch', '--prune', url, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*');
    await this.run(args, { timeoutMs: 10 * 60_000, env: { GIT_TERMINAL_PROMPT: '0' } });
  }

  async isEmpty(): Promise<boolean> {
    const out = await this.text(['for-each-ref', '--count=1', 'refs/heads']);
    return out.trim() === '';
  }

  async resolve(ref: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowExitCodes: [0, 1, 128] });
    const sha = r.stdout.toString().trim();
    return r.code === 0 && isSha(sha) ? sha : null;
  }

  async resolveOrThrow(ref: string): Promise<string> {
    const sha = await this.resolve(ref);
    if (!sha) throw new AppError('NOT_FOUND', `Branch veya commit bulunamadı: ${ref}`);
    return sha;
  }

  async branches(): Promise<BranchInfo[]> {
    const out = await this.text([
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)%00%(authorname)%00%(subject)',
      'refs/heads',
    ]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, sha, date, author, subject] = l.split('\0');
        return { name: name!, sha: sha!, date: date!, author: author!, subject: subject ?? '' };
      });
  }

  async tags(): Promise<{ name: string; sha: string }[]> {
    const out = await this.text(['for-each-ref', '--format=%(refname:short)%00%(*objectname)%00%(objectname)', 'refs/tags']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, peeled, obj] = l.split('\0');
        return { name: name!, sha: peeled || obj! };
      });
  }

  async aheadBehind(base: string, head: string): Promise<{ ahead: number; behind: number }> {
    const out = await this.text(['rev-list', '--left-right', '--count', `${base}...${head}`]);
    const [behind, ahead] = out.trim().split(/\s+/).map(Number);
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  }

  async listTree(commit: string, dirPath = ''): Promise<TreeEntry[]> {
    const target = dirPath ? `${commit}:${normaliseRepoPath(dirPath)}` : `${commit}^{tree}`;
    const r = await this.run(['ls-tree', '-l', '-z', target], { allowExitCodes: [0, 128] });
    if (r.code !== 0) throw new AppError('NOT_FOUND', `Klasör bulunamadı: ${dirPath}`);
    return parseLsTree(r.stdout.toString('utf8'), dirPath).sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : 1,
    );
  }

  /** Every file in the commit (recursive). */
  async listFiles(commit: string): Promise<TreeEntry[]> {
    const r = await this.run(['ls-tree', '-r', '-l', '-z', '--full-tree', commit], { maxBuffer: 256 * 1024 * 1024 });
    return parseLsTree(r.stdout.toString('utf8'), '');
  }

  async readFile(commit: string, filePath: string, maxBytes = 5 * 1024 * 1024): Promise<{ content: Buffer; size: number; sha: string } | null> {
    const p = normaliseRepoPath(filePath);
    const info = await this.run(['cat-file', '-s', `${commit}:${p}`], { allowExitCodes: [0, 128] });
    if (info.code !== 0) return null;
    const size = Number(info.stdout.toString().trim());
    const sha = (await this.text(['rev-parse', `${commit}:${p}`])).trim();
    if (size > maxBytes) return { content: Buffer.alloc(0), size, sha };
    const blob = await this.run(['cat-file', 'blob', sha], { maxBuffer: maxBytes + 1024 });
    return { content: blob.stdout, size, sha };
  }

  /** Reads many blobs with a single `git cat-file --batch` process. */
  async readBlobs(shas: string[]): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    const unique = [...new Set(shas)];
    for (let i = 0; i < unique.length; i += 2000) {
      const slice = unique.slice(i, i + 2000);
      const r = await this.run(['cat-file', '--batch'], { input: `${slice.join('\n')}\n`, maxBuffer: 1024 * 1024 * 1024, timeoutMs: 5 * 60_000 });
      const buf = r.stdout;
      let pos = 0;
      while (pos < buf.length) {
        const nl = buf.indexOf(0x0a, pos);
        if (nl < 0) break;
        const header = buf.subarray(pos, nl).toString('utf8');
        const [sha, type, sizeStr] = header.split(' ');
        if (type === 'missing' || !sizeStr) {
          pos = nl + 1;
          continue;
        }
        const size = Number(sizeStr);
        out.set(sha!, buf.subarray(nl + 1, nl + 1 + size));
        pos = nl + 1 + size + 1;
      }
    }
    return out;
  }

  async readBlob(sha: string, maxBytes = 5 * 1024 * 1024): Promise<Buffer> {
    return (await this.run(['cat-file', 'blob', sha], { maxBuffer: maxBytes + 1024 })).stdout;
  }

  async log(opts: { ref: string; path?: string; limit?: number; skip?: number; grep?: string }): Promise<CommitInfo[]> {
    const args = [
      'log',
      `--max-count=${opts.limit ?? 30}`,
      `--skip=${opts.skip ?? 0}`,
      '--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s',
      '--shortstat',
    ];
    if (opts.grep) args.push('-i', `--grep=${opts.grep}`);
    args.push(opts.ref, '--');
    if (opts.path) args.push(normaliseRepoPath(opts.path));
    const r = await this.run(args, { allowExitCodes: [0, 128] });
    if (r.code !== 0) return [];
    return r.stdout
      .toString('utf8')
      .split('\x1e')
      .filter((c) => c.trim())
      .map((chunk) => {
        const [header, ...rest] = chunk.split('\n');
        const [sha, parents, authorName, authorEmail, date, subject] = header!.split('\x1f');
        const stat = rest.join(' ');
        return {
          sha: sha!,
          parents: parents ? parents.split(' ').filter(Boolean) : [],
          authorName: authorName!,
          authorEmail: authorEmail!,
          date: date!,
          subject: subject ?? '',
          filesChanged: Number(/(\d+) files? changed/.exec(stat)?.[1] ?? 0),
          additions: Number(/(\d+) insertions?\(\+\)/.exec(stat)?.[1] ?? 0),
          deletions: Number(/(\d+) deletions?\(-\)/.exec(stat)?.[1] ?? 0),
        };
      });
  }

  async commitInfo(sha: string): Promise<CommitInfo | null> {
    const r = await this.run(['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b', sha], { allowExitCodes: [0, 128] });
    if (r.code !== 0) return null;
    const [h, parents, authorName, authorEmail, date, subject, body] = r.stdout.toString('utf8').split('\x1f');
    const stats = await this.diffStat(parents?.split(' ').filter(Boolean)[0] ?? null, h!.trim());
    return {
      sha: h!.trim(),
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      authorName: authorName!,
      authorEmail: authorEmail!,
      date: date!,
      subject: subject ?? '',
      body: (body ?? '').trim(),
      filesChanged: stats.length,
      additions: stats.reduce((s, f) => s + f.additions, 0),
      deletions: stats.reduce((s, f) => s + f.deletions, 0),
    };
  }

  /** numstat between two commits (base null = against the empty tree). */
  async diffStat(base: string | null, head: string): Promise<FileStat[]> {
    const args = base ? ['diff', '--numstat', '-z', '-M', base, head] : ['diff-tree', '--root', '--numstat', '-z', '-r', '-M', head];
    const out = (await this.run(args, { maxBuffer: 64 * 1024 * 1024 })).stdout.toString('utf8');
    return parseNumstatZ(out);
  }

  /** Unified diff text between two commits, truncated to maxBytes. */
  async diffPatch(base: string | null, head: string, opts: { paths?: string[]; maxBytes?: number } = {}): Promise<{ patch: string; truncated: boolean }> {
    const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    const args = base ? ['diff', '-M', '--no-color', base, head] : ['show', '--format=', '--no-color', '-M', head];
    if (opts.paths?.length) args.push('--', ...opts.paths.map(normaliseRepoPath));
    const r = await this.run(args, { maxBuffer: 256 * 1024 * 1024 });
    const truncated = r.stdout.length > maxBytes;
    return { patch: r.stdout.subarray(0, maxBytes).toString('utf8'), truncated };
  }

  /** Best common ancestor of two commits (null when the histories are unrelated). */
  async mergeBase(a: string, b: string): Promise<string | null> {
    const r = await this.run(['merge-base', a, b], { allowExitCodes: [0, 1] });
    return r.code === 0 ? r.stdout.toString('utf8').trim() : null;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const r = await this.run(['merge-base', '--is-ancestor', ancestor, descendant], { allowExitCodes: [0, 1] });
    return r.code === 0;
  }

  /**
   * Creates a commit on `branch` from a set of file changes without any working copy.
   * The ref update is compare-and-swap against `baseCommit`, so concurrent edits are rejected instead of lost.
   */
  async commitChanges(input: {
    branch: string;
    baseCommit: string | null;
    message: string;
    author: Author;
    changes: FileChange[];
  }): Promise<string> {
    if (!input.changes.length) throw invalid('Değişiklik yok');
    const indexFile = path.join(os.tmpdir(), `ph-index-${randomToken(12)}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      if (input.baseCommit) await this.run(['read-tree', input.baseCommit], { env });
      else await this.run(['read-tree', '--empty'], { env });
      for (const change of input.changes) {
        const p = normaliseRepoPath(change.path);
        if (change.action === 'delete') {
          // Mode 0 + zero oid removes the entry; works without a working tree (bare repository).
          await this.run(['update-index', '--index-info'], { env, input: `0 ${ZERO_OID}\t${p}\n` });
        } else {
          const blob = (await this.text(['hash-object', '-w', '--stdin'], { input: change.content })).trim();
          await this.run(['update-index', '--add', '--cacheinfo', `100644,${blob},${p}`], { env });
        }
      }
      const tree = (await this.text(['write-tree'], { env })).trim();
      if (input.baseCommit) {
        const baseTree = (await this.text(['rev-parse', `${input.baseCommit}^{tree}`])).trim();
        if (baseTree === tree) throw invalid('Değişiklik yok: dosyalar zaten aynı içerikte');
      }
      const commit = await this.commitTree(tree, input.baseCommit ? [input.baseCommit] : [], input.message, input.author);
      await this.updateRef(input.branch, commit, input.baseCommit);
      return commit;
    } finally {
      await fs.rm(indexFile, { force: true });
    }
  }

  /** Initial (or follow-up) commit from a directory on disk, e.g. an uploaded project. */
  async commitDirectory(input: { dir: string; branch: string; message: string; author: Author }): Promise<string> {
    const indexFile = path.join(os.tmpdir(), `ph-index-${randomToken(12)}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      const parent = await this.resolve(`refs/heads/${input.branch}`);
      await this.run([`--work-tree=${input.dir}`, 'add', '--all', '--force', '.'], { env, cwd: input.dir, timeoutMs: 10 * 60_000 });
      const tree = (await this.text(['write-tree'], { env })).trim();
      const commit = await this.commitTree(tree, parent ? [parent] : [], input.message, input.author);
      await this.updateRef(input.branch, commit, parent);
      return commit;
    } finally {
      await fs.rm(indexFile, { force: true });
    }
  }

  private async commitTree(tree: string, parents: string[], message: string, author: Author): Promise<string> {
    const args = ['commit-tree', tree];
    for (const p of parents) args.push('-p', p);
    const env = {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    };
    return (await this.text(args, { env, input: message.endsWith('\n') ? message : `${message}\n` })).trim();
  }

  /** CAS ref update. expectedOld = null means "the branch must not exist yet". */
  async updateRef(branch: string, newSha: string, expectedOld: string | null): Promise<void> {
    const ref = `refs/heads/${branch}`;
    const r = await this.run(['update-ref', '-m', 'projecthub', ref, newSha, expectedOld ?? ZERO_OID], { allowExitCodes: [0, 1, 128] });
    if (r.code !== 0) {
      throw conflict(
        expectedOld
          ? `"${branch}" branch'i siz düzenlerken değişti. Son hali alıp tekrar deneyin.`
          : `"${branch}" adında bir branch zaten var.`,
        { branch },
      );
    }
  }

  async createBranch(name: string, fromSha: string): Promise<void> {
    await this.updateRef(name, fromSha, null);
  }

  async deleteBranch(name: string, expected: string): Promise<void> {
    const r = await this.run(['update-ref', '-d', `refs/heads/${name}`, expected], { allowExitCodes: [0, 1, 128] });
    if (r.code !== 0) throw conflict(`Branch silinemedi: ${name}`);
  }

  async createTag(name: string, sha: string, message: string, author: Author): Promise<void> {
    const env = { GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
    const r = await this.run(['tag', '-a', name, sha, '-m', message], { env, allowExitCodes: [0, 128] });
    if (r.code !== 0) throw conflict(`Etiket oluşturulamadı: ${name} (${r.stderr.trim()})`);
  }

  /**
   * Merges `source` into `target`. Fast-forwards when possible, otherwise creates a merge commit
   * with `git merge-tree --write-tree` (no working copy). Conflicts are reported, never auto-resolved.
   */
  async merge(input: { source: string; target: string; message: string; author: Author }): Promise<{ sha: string; fastForward: boolean }> {
    const sourceSha = await this.resolveOrThrow(`refs/heads/${input.source}`);
    const targetSha = await this.resolveOrThrow(`refs/heads/${input.target}`);
    if (sourceSha === targetSha || (await this.isAncestor(sourceSha, targetSha))) {
      throw precondition('Birleştirilecek yeni değişiklik yok');
    }
    if (await this.isAncestor(targetSha, sourceSha)) {
      await this.updateRef(input.target, sourceSha, targetSha);
      return { sha: sourceSha, fastForward: true };
    }
    const r = await this.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', targetSha, sourceSha], { allowExitCodes: [0, 1] });
    const lines = r.stdout.toString('utf8').split('\n').filter(Boolean);
    if (r.code === 1) {
      throw conflict('Birleştirme çakışması var. Çakışan dosyaları branch üzerinde düzeltin.', { files: lines.slice(1) });
    }
    const tree = lines[0]!.trim();
    const sha = await this.commitTree(tree, [targetSha, sourceSha], input.message, input.author);
    await this.updateRef(input.target, sha, targetSha);
    return { sha, fastForward: false };
  }

  /** Writes the files of `commit` into `destDir` (which must exist and should be empty). */
  async exportTo(commit: string, destDir: string): Promise<void> {
    const indexFile = path.join(os.tmpdir(), `ph-index-${randomToken(12)}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await this.run(['read-tree', commit], { env });
      await this.run([`--work-tree=${destDir}`, 'checkout-index', '--all', '--force'], { env, cwd: destDir, timeoutMs: 10 * 60_000 });
    } finally {
      await fs.rm(indexFile, { force: true });
    }
  }

  /** Fixed-string code search at a commit. */
  async grep(commit: string, needle: string, opts: { maxResults?: number; paths?: string[] } = {}): Promise<{ path: string; line: number; text: string }[]> {
    const args = ['grep', '-n', '-I', '-i', '-F', '--full-name', '--max-count=5', '-e', needle, commit, '--'];
    if (opts.paths?.length) args.push(...opts.paths);
    const r = await this.run(args, { allowExitCodes: [0, 1], maxBuffer: 32 * 1024 * 1024 });
    const results: { path: string; line: number; text: string }[] = [];
    for (const raw of r.stdout.toString('utf8').split('\n')) {
      if (!raw) continue;
      const withoutRev = raw.startsWith(`${commit}:`) ? raw.slice(commit.length + 1) : raw;
      const m = /^(.*?):(\d+):(.*)$/.exec(withoutRev);
      if (!m) continue;
      results.push({ path: m[1]!, line: Number(m[2]), text: m[3]!.slice(0, 300) });
      if (results.length >= (opts.maxResults ?? 50)) break;
    }
    return results;
  }

  async lastCommitDate(ref: string, filePath?: string): Promise<string | null> {
    const args = ['log', '-1', '--format=%aI', ref, '--'];
    if (filePath) args.push(normaliseRepoPath(filePath));
    const out = (await this.run(args, { allowExitCodes: [0, 128] })).stdout.toString().trim();
    return out || null;
  }

  async sizeBytes(): Promise<number> {
    const out = await this.text(['count-objects', '-v']);
    const kib = /size-pack: (\d+)/.exec(out)?.[1];
    const loose = /size: (\d+)/.exec(out)?.[1];
    return (Number(kib ?? 0) + Number(loose ?? 0)) * 1024;
  }

  /** Snapshot of all branch heads (used to detect what a push changed). */
  async refSnapshot(): Promise<Map<string, string>> {
    const out = await this.text(['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/tags']);
    return new Map(
      out
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('\0') as [string, string]),
    );
  }
}

function parseLsTree(out: string, base: string): TreeEntry[] {
  return out
    .split('\0')
    .filter(Boolean)
    .map((rec) => {
      const tab = rec.indexOf('\t');
      const [mode, type, sha, size] = rec.slice(0, tab).split(/\s+/);
      const name = rec.slice(tab + 1);
      const full = base ? `${base.replace(/\/$/, '')}/${name}` : name;
      return {
        name: name.split('/').pop()!,
        path: full,
        type: type as TreeEntry['type'],
        mode: mode!,
        sha: sha!,
        size: size === '-' || size === undefined ? null : Number(size),
      };
    });
}

function parseNumstatZ(out: string): FileStat[] {
  // Format with -z: "add\tdel\tpath\0" or for renames "add\tdel\t\0old\0new\0"
  const tokens = out.split('\0');
  const stats: FileStat[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(t.replace(/^\n/, ''));
    if (!m) continue;
    let p = m[3]!;
    if (p === '') {
      i += 2;
      p = tokens[i] ?? '';
    }
    stats.push({
      path: p,
      additions: m[1] === '-' ? 0 : Number(m[1]),
      deletions: m[2] === '-' ? 0 : Number(m[2]),
      binary: m[1] === '-',
    });
  }
  return stats;
}

export function runGit(gitBinary: string, args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBinary, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...opts.env } as NodeJS.ProcessEnv,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let outLen = 0;
    const err: Buffer[] = [];
    const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (d: Buffer) => {
      outLen += d.length;
      if (outLen <= maxBuffer) out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new GitError(`git could not be started: ${e.message}`, -1, ''));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8');
      const exit = code ?? -1;
      if (killed) return reject(new GitError(`git ${args.find((a) => !a.startsWith('-'))} timed out`, exit, stderr));
      const allowed = opts.allowExitCodes ?? [0];
      if (!allowed.includes(exit)) {
        return reject(new GitError(`git ${args.filter((a) => !a.startsWith('-c') && !a.startsWith('safe.') && !a.startsWith('core.')).slice(1, 3).join(' ')} failed (${exit}): ${stderr.trim().slice(0, 500)}`, exit, stderr));
      }
      resolve({ stdout: Buffer.concat(out), stderr, code: exit });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
