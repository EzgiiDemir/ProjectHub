import fs from 'node:fs/promises';
import path from 'node:path';
import { invalid } from './errors.js';

/**
 * Filesystem layout under STORAGE_DIR. Everything the hub persists outside PostgreSQL lives here,
 * so backing up the system = pg_dump + this directory.
 */
export class Storage {
  constructor(readonly root: string) {}

  async init(): Promise<void> {
    for (const d of ['repos', 'artifacts', 'workspaces', 'logs', 'backups', 'uploads', 'tmp', 'deploy-local']) {
      await fs.mkdir(path.join(this.root, d), { recursive: true });
    }
  }

  /** Resolves a key below root and refuses anything that would escape it. */
  resolve(key: string): string {
    const full = path.resolve(this.root, key);
    const rel = path.relative(this.root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw invalid('Geçersiz depolama yolu');
    return full;
  }

  repoKey(projectId: string): string {
    return `repos/${projectId}.git`;
  }
  workspaceKey(kind: 'build' | 'ai' | 'deploy', id: string): string {
    return `workspaces/${kind}-${id}`;
  }
  buildArtifactKey(projectId: string, buildId: string): string {
    return `artifacts/${projectId}/builds/${buildId}`;
  }
  buildLogKey(projectId: string, buildId: string): string {
    return `logs/${projectId}/build-${buildId}.log`;
  }
  deploymentLogKey(projectId: string, deploymentId: string): string {
    return `logs/${projectId}/deploy-${deploymentId}.log`;
  }
  previewLogKey(projectId: string, previewId: string): string {
    return `logs/${projectId}/preview-${previewId}.log`;
  }
  screenshotKey(projectId: string, name: string): string {
    return `artifacts/${projectId}/screenshots/${name}`;
  }
  backupKey(projectId: string, name: string): string {
    return `backups/${projectId}/${name}`;
  }
  /** Generated documents (user guide and presentation PDFs). */
  reportKey(projectId: string, name: string): string {
    return `artifacts/${projectId}/reports/${name}`;
  }
  uploadKey(uploadId: string): string {
    return `uploads/${uploadId}`;
  }

  async ensureDir(key: string): Promise<string> {
    const p = this.resolve(key);
    await fs.mkdir(p, { recursive: true });
    return p;
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async sizeOf(key: string): Promise<number> {
    return dirSize(this.resolve(key));
  }
}

export async function dirSize(p: string): Promise<number> {
  let total = 0;
  let stat;
  try {
    stat = await fs.lstat(p);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  const stack = [p];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try {
          total += (await fs.stat(full)).size;
        } catch {
          /* file vanished */
        }
      }
    }
  }
  return total;
}

/** Recursively lists files below `dir` as forward-slash relative paths, skipping the given directory names. */
export async function walkFiles(dir: string, skip: (rel: string, isDir: boolean) => boolean = () => false): Promise<string[]> {
  const out: string[] = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skip(r, true)) stack.push(r);
      } else if (e.isFile() && !skip(r, false)) out.push(r);
    }
  }
  return out.sort();
}

/**
 * Copies a directory tree (build workspace → artifact, artifact → deployment workspace).
 *
 * Links are recreated by us instead of `fs.cp`: Turbopack externalises server packages through links such as
 * `.next/node_modules/pg-<hash>` (a relative symlink on Linux, an absolute junction on Windows). `fs.cp` either
 * resolves them to absolute paths into `src` — which break as soon as the temporary build workspace is deleted —
 * or fails with EPERM on Windows without the symlink privilege. A link that points inside `src` is re-pointed at the
 * same place inside `dest`; links pointing elsewhere are kept as written.
 */
export async function copyDir(src: string, dest: string, filter?: (rel: string) => boolean): Promise<void> {
  const root = path.resolve(src);
  const links: string[] = [];
  await fs.cp(root, dest, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: async (s) => {
      const rel = path.relative(root, s).replace(/\\/g, '/');
      if (rel && filter && !filter(rel)) return false;
      if (rel && (await fs.lstat(s)).isSymbolicLink()) {
        links.push(rel);
        return false;
      }
      return true;
    },
  });
  for (const rel of links) await copyLink(root, path.resolve(dest), rel);
}

/**
 * Moves a directory tree (build workspace → artifact). A rename keeps link targets as written, so links that pointed
 * inside the old location (Windows junctions are always absolute) are re-pointed at the new one. Falls back to a copy
 * when the rename is not possible (e.g. across volumes).
 */
export async function moveDir(src: string, dest: string): Promise<void> {
  const from = path.resolve(src);
  const to = path.resolve(dest);
  try {
    await fs.rename(from, to);
  } catch {
    await copyDir(from, to);
    return;
  }
  await relinkMoved(from, to);
}

/** After a tree was renamed from `oldRoot` to `newRoot`, re-points links that still point into `oldRoot`. */
export async function relinkMoved(oldRoot: string, newRoot: string): Promise<void> {
  const from = path.resolve(oldRoot);
  const to = path.resolve(newRoot);
  const stack = [to];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        const absolute = path.resolve(dir, (await fs.readlink(p)).replace(/^\\\\\?\\/, ''));
        const inside = path.relative(from, absolute);
        if (!inside.startsWith('..') && !path.isAbsolute(inside)) await writeLink(p, path.join(to, inside), to);
      } else if (e.isDirectory()) stack.push(p);
    }
  }
}

async function copyLink(srcRoot: string, destRoot: string, rel: string): Promise<void> {
  const from = path.join(srcRoot, rel);
  const raw = (await fs.readlink(from)).replace(/^\\\\\?\\/, '');
  const absolute = path.resolve(path.dirname(from), raw);
  const inside = path.relative(srcRoot, absolute);
  const internal = !inside.startsWith('..') && !path.isAbsolute(inside);
  await writeLink(path.join(destRoot, rel), internal ? path.join(destRoot, inside) : absolute, internal ? destRoot : null, internal ? null : raw);
}

/**
 * (Re)creates the link `at` → `target`. Windows: junctions (no privilege needed, always absolute) for directories,
 * a copy for files. POSIX: links inside `tree` stay relative so the tree remains valid wherever it is moved.
 */
async function writeLink(at: string, target: string, tree: string | null, verbatim: string | null = null): Promise<void> {
  const isDir = (await fs.stat(target).catch(() => null))?.isDirectory() ?? false;
  await fs.mkdir(path.dirname(at), { recursive: true });
  await fs.rm(at, { force: true, recursive: false }).catch(() => undefined);
  if (process.platform === 'win32') {
    if (isDir) await fs.symlink(target, at, 'junction');
    else if (await fs.stat(target).catch(() => null)) await fs.copyFile(target, at);
    return;
  }
  await fs.symlink(verbatim ?? (tree ? path.relative(path.dirname(at), target) : target), at);
}
