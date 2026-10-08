import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { GitRepository, PermanentJobError, type AppConfig, type Logger, type Storage } from '@projecthub/core';
import { projects, repositories, type Database } from '@projecthub/database';

export interface WorkerCtx {
  config: AppConfig;
  db: Database;
  pool: pg.Pool;
  storage: Storage;
  logger: Logger;
  workerId: string;
}

export async function loadProject(ctx: WorkerCtx, projectId: string) {
  const p = (await ctx.db.select().from(projects).where(eq(projects.id, projectId)))[0];
  if (!p) throw new PermanentJobError(`project ${projectId} not found`);
  return p;
}

export async function openRepo(ctx: WorkerCtx, projectId: string) {
  const repo = (await ctx.db.select().from(repositories).where(eq(repositories.projectId, projectId)))[0];
  if (!repo) throw new PermanentJobError(`repository for ${projectId} not found`);
  return { repo, git: new GitRepository(ctx.storage.resolve(repo.storageKey), ctx.config.GIT_BINARY) };
}

const MAX_TEXT = 1024 * 1024;

/**
 * File reader over one commit, used by detection, scanners and the indexer.
 * `preload` fetches many blobs with one git process; `read` falls back to single reads.
 */
export async function commitSnapshot(git: GitRepository, commit: string) {
  const files = await git.listFiles(commit);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const cache = new Map<string, string | null>();
  const decode = (buf: Buffer) => (buf.includes(0) ? null : buf.toString('utf8'));
  return {
    files: files.map((f) => ({ path: f.path, size: f.size })),
    paths: files.map((f) => f.path),
    entries: files,
    async preload(paths: string[]): Promise<void> {
      const wanted = paths.map((p) => byPath.get(p)).filter((f): f is NonNullable<typeof f> => !!f && (f.size ?? 0) <= MAX_TEXT && !cache.has(f.path));
      const blobs = await git.readBlobs(wanted.map((f) => f.sha));
      for (const f of wanted) {
        const b = blobs.get(f.sha);
        cache.set(f.path, b ? decode(b) : null);
      }
    },
    async read(p: string): Promise<string | null> {
      if (cache.has(p)) return cache.get(p)!;
      const f = byPath.get(p);
      if (!f || (f.size ?? 0) > MAX_TEXT) return null;
      const text = decode(await git.readBlob(f.sha, MAX_TEXT));
      cache.set(p, text);
      return text;
    },
  };
}
