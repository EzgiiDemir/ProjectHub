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

export async function copyDir(src: string, dest: string, filter?: (rel: string) => boolean): Promise<void> {
  await fs.cp(src, dest, {
    recursive: true,
    force: true,
    filter: filter ? (s) => filter(path.relative(src, s).replace(/\\/g, '/')) : undefined,
  });
}
