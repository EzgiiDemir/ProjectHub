import fs from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { builds, deployments, environments, previews } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';

export type LogSource = 'build' | 'deployment' | 'preview';
export type LogLevel = 'error' | 'warn' | 'info';

export interface LogQuery {
  q?: string;
  source?: LogSource;
  environmentId?: string;
  level?: 'error' | 'warn';
  from?: Date;
  to?: Date;
  limit: number;
}

const ERROR = /\b(error|errors?:|fatal|exception|traceback|failed|failure|panic|critical|ERR!|EADDRINUSE|ECONNREFUSED)\b/i;
const WARN = /\b(warn|warning|deprecated|deprecation)\b/i;
const NO_ERRORS = /\b(0|no) (errors?|failures?)\b/i;
/** Step headers written by the build and deployment runners: "━━ Install ━━ 2026-10-08T11:55:43.377Z". */
const HEADER = /━━ (.+?) ━━ (\d{4}-\d\d-\d\dT[\d:.]+Z)/;
const MAX_DOCS = { build: 100, deployment: 100, preview: 30 } as const;
const MAX_BYTES = 2 * 1024 * 1024;

export function lineLevel(text: string): LogLevel {
  if (ERROR.test(text) && !NO_ERRORS.test(text)) return 'error';
  if (WARN.test(text)) return 'warn';
  return 'info';
}

interface Doc {
  source: LogSource;
  refId: string;
  label: string;
  link: string;
  environment: string | null;
  startedAt: Date;
  key: string;
}

/**
 * Log search (spec §82–83) over what the hub itself records: build, deployment and preview process logs.
 * Lines are matched in the stored files (tail of each, newest documents first); levels are inferred from the text.
 */
@Injectable()
export class LogsService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
  ) {}

  async search(auth: AuthInfo, idOrSlug: string, query: LogQuery) {
    const scope = await this.access.require(auth, idOrSlug);
    const pid = scope.project.id;
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - 24 * 3600_000);
    const envs = await this.ctx.db.select({ id: environments.id, name: environments.name }).from(environments).where(eq(environments.projectId, pid));
    const envName = new Map(envs.map((e) => [e.id, e.name]));
    const docs: Doc[] = [];
    const want = (s: LogSource) => !query.source || query.source === s;

    if (want('build') && !query.environmentId) {
      const rows = await this.ctx.db
        .select({ id: builds.id, number: builds.number, branch: builds.branch, logKey: builds.logKey, at: builds.createdAt })
        .from(builds)
        .where(and(eq(builds.projectId, pid), gte(builds.createdAt, from), lte(builds.createdAt, to)))
        .orderBy(desc(builds.createdAt))
        .limit(MAX_DOCS.build);
      for (const b of rows) if (b.logKey) docs.push({ source: 'build', refId: b.id, label: `Build #${b.number} · ${b.branch}`, link: `/projects/${scope.project.slug}/builds/${b.id}`, environment: null, startedAt: b.at, key: b.logKey });
    }
    if (want('deployment')) {
      const conds = [eq(deployments.projectId, pid), gte(deployments.createdAt, from), lte(deployments.createdAt, to)];
      if (query.environmentId) conds.push(eq(deployments.environmentId, query.environmentId));
      const rows = await this.ctx.db
        .select({ id: deployments.id, number: deployments.number, environmentId: deployments.environmentId, at: deployments.createdAt })
        .from(deployments)
        .where(and(...conds))
        .orderBy(desc(deployments.createdAt))
        .limit(MAX_DOCS.deployment);
      for (const d of rows) {
        docs.push({
          source: 'deployment',
          refId: d.id,
          label: `Deployment #${d.number}`,
          link: `/projects/${scope.project.slug}/deployments/${d.id}`,
          environment: envName.get(d.environmentId) ?? null,
          startedAt: d.at,
          key: this.ctx.storage.deploymentLogKey(pid, d.id),
        });
      }
    }
    if (want('preview') && !query.environmentId) {
      const rows = await this.ctx.db
        .select({ id: previews.id, slug: previews.slug, branch: previews.sourceBranch, at: previews.createdAt, kind: previews.kind })
        .from(previews)
        .where(and(eq(previews.projectId, pid), inArray(previews.kind, ['process']), lte(previews.createdAt, to)))
        .orderBy(desc(previews.createdAt))
        .limit(MAX_DOCS.preview);
      for (const p of rows) docs.push({ source: 'preview', refId: p.id, label: `Ön izleme ${p.slug} · ${p.branch}`, link: `/projects/${scope.project.slug}/previews`, environment: null, startedAt: p.at, key: this.ctx.storage.previewLogKey(pid, p.id) });
    }

    const needle = query.q?.trim().toLowerCase() ?? '';
    const stats = { error: 0, warn: 0, lines: 0 };
    const bySource: Record<LogSource, { documents: number; error: number; warn: number }> = { build: { documents: 0, error: 0, warn: 0 }, deployment: { documents: 0, error: 0, warn: 0 }, preview: { documents: 0, error: 0, warn: 0 } };
    const matches: { source: LogSource; refId: string; label: string; link: string; environment: string | null; step: string | null; at: string; approximateTime: boolean; line: number; level: LogLevel; text: string }[] = [];
    let total = 0;
    for (const doc of docs) {
      const file = await readTail(this.ctx.storage.resolve(doc.key));
      if (!file) continue;
      const { text, modifiedAt } = file;
      // Process logs (previews) carry no per-line time: their lines are dated by the file's last write and flagged
      // as approximate, so a long-running preview's recent errors still show up in short windows.
      const approximateTime = doc.source === 'preview';
      if (approximateTime && (modifiedAt < from || doc.startedAt > to)) continue;
      bySource[doc.source].documents++;
      let at = (approximateTime ? modifiedAt : doc.startedAt).toISOString();
      let step: string | null = null;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]!;
        const h = HEADER.exec(raw);
        if (h) {
          step = h[1]!.trim();
          at = h[2]!;
          continue;
        }
        if (!raw.trim()) continue;
        const t = new Date(at);
        if (t < from || t > to) continue;
        stats.lines++;
        const level = lineLevel(raw);
        if (level !== 'info') {
          stats[level]++;
          bySource[doc.source][level]++;
        }
        if (query.level && level !== query.level && !(query.level === 'warn' && level === 'error')) continue;
        if (needle && !raw.toLowerCase().includes(needle)) continue;
        total++;
        if (matches.length < query.limit) matches.push({ source: doc.source, refId: doc.refId, label: doc.label, link: doc.link, environment: doc.environment, step, at, approximateTime, line: i + 1, level, text: raw.slice(0, 1000) });
      }
    }
    matches.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.line - b.line));
    return { from: from.toISOString(), to: to.toISOString(), documents: docs.length, stats, bySource, total, truncated: total > matches.length, matches };
  }
}

/** Last MAX_BYTES of a log file with its last write time, or null when it does not exist. */
async function readTail(file: string): Promise<{ text: string; modifiedAt: Date } | null> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(file, 'r');
    const { size, mtime } = await fh.stat();
    const start = Math.max(0, size - MAX_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return { text: start > 0 ? text.slice(text.indexOf('\n') + 1) : text, modifiedAt: mtime };
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
