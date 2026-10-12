import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { and, count, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AiSettings, RetentionSettings } from '@projecthub/contracts';
import { ai, audit, dirSize, encryptToString, getOrgSettings, notFound, randomToken, type Actor } from '@projecthub/core';
import { aiActions, aiMemories, aiRuns, aiTasks, auditEvents, codeChunks, codeFiles, jobs, organizations, projects, users, webhookDeliveries, webhooks, workerHeartbeats } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { Paged } from '../../infra/http.js';

@Injectable()
export class SystemService {
  constructor(private readonly ctx: Ctx) {}

  async getSettings(auth: AuthInfo) {
    const s = await getOrgSettings(this.ctx.db, auth.organizationId);
    return {
      ...s,
      aiProviders: { ollama: !!this.ctx.config.OLLAMA_BASE_URL, openai: !!this.ctx.config.OPENAI_API_KEY, anthropic: !!this.ctx.config.ANTHROPIC_API_KEY },
    };
  }

  private async patchSettings(auth: AuthInfo, key: 'ai' | 'retention', value: unknown, actor: Actor) {
    await this.ctx.db
      .update(organizations)
      .set({ settings: sql`jsonb_set(${organizations.settings}, ${`{${key}}`}::text[], ${JSON.stringify(value)}::jsonb, true)` })
      .where(eq(organizations.id, auth.organizationId));
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: `settings.${key}_updated`, resourceType: 'organization', resourceId: auth.organizationId, metadata: { [key]: value } });
    return this.getSettings(auth);
  }

  updateAi(auth: AuthInfo, value: AiSettings, actor: Actor) {
    return this.patchSettings(auth, 'ai', value, actor);
  }
  updateRetention(auth: AuthInfo, value: RetentionSettings, actor: Actor) {
    return this.patchSettings(auth, 'retention', value, actor);
  }

  async auditLog(auth: AuthInfo, q: { actorType?: string; projectId?: string; action?: string; from?: string; to?: string; cursor?: string; limit: number }) {
    const conds: SQL[] = [eq(auditEvents.organizationId, auth.organizationId)];
    if (q.actorType) conds.push(eq(auditEvents.actorType, q.actorType as never));
    if (q.projectId) conds.push(eq(auditEvents.projectId, q.projectId));
    if (q.action) conds.push(or(ilike(auditEvents.action, `%${q.action}%`), ilike(auditEvents.actorLabel, `%${q.action}%`))!);
    if (q.from) conds.push(gte(auditEvents.createdAt, new Date(q.from)));
    if (q.to) conds.push(lt(auditEvents.createdAt, new Date(q.to)));
    if (q.cursor) {
      const [ts, id] = q.cursor.split('|');
      conds.push(sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${new Date(ts!)}, ${id}::uuid)`);
    }
    const rows = await this.ctx.db
      .select({ e: auditEvents, projectName: projects.name, projectSlug: projects.slug })
      .from(auditEvents)
      .leftJoin(projects, eq(projects.id, auditEvents.projectId))
      .where(and(...conds))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return new Paged(
      page.map((r) => ({ ...r.e, projectName: r.projectName, projectSlug: r.projectSlug })),
      { hasMore, nextCursor: hasMore && last ? `${last.e.createdAt.toISOString()}|${last.e.id}` : null },
    );
  }

  /** Infrastructure view: host resources, storage usage per category, workers and queues (spec §20–22, §108). */
  async systemStatus() {
    const usage = await storageUsage(this.ctx.storage.root);
    const root = this.ctx.storage.root;
    let disk: { total: number; free: number } | null = null;
    try {
      const s = await fs.statfs(root);
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      disk = null;
    }
    const dbSize = await this.ctx.db.execute<{ size: number }>(sql`SELECT pg_database_size(current_database())::bigint AS size`);
    // Workers that went silent more than 10 minutes ago are history (restarts); the maintenance job deletes them after an hour.
    const workers = await this.ctx.db.select().from(workerHeartbeats).where(gte(workerHeartbeats.lastSeenAt, new Date(Date.now() - 10 * 60_000))).orderBy(desc(workerHeartbeats.lastSeenAt));
    const queueStats = await this.ctx.db
      .select({ queue: jobs.queue, status: jobs.status, n: count() })
      .from(jobs)
      .where(sql`${jobs.status} IN ('queued','running') OR (${jobs.status} = 'failed' AND ${jobs.finishedAt} > now() - interval '24 hours')`)
      .groupBy(jobs.queue, jobs.status);
    const failedJobs = await this.ctx.db
      .select({ id: jobs.id, type: jobs.type, lastError: jobs.lastError, finishedAt: jobs.finishedAt, attempts: jobs.attempts })
      .from(jobs)
      .where(eq(jobs.status, 'failed'))
      .orderBy(desc(jobs.finishedAt))
      .limit(20);
    const now = Date.now();
    const localAi = await ai.getOllamaRuntimeStatus(this.ctx.config.OLLAMA_BASE_URL);
    return {
      host: {
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()}`,
        cpus: os.cpus().length,
        loadAverage: os.loadavg(),
        memory: { total: os.totalmem(), free: os.freemem() },
        uptimeSeconds: Math.round(os.uptime()),
        nodeVersion: process.version,
      },
      disk,
      storage: { ...usage, database: Number(dbSize.rows[0]?.size ?? 0) },
      workers: workers.map((w) => ({ ...w, healthy: now - w.lastSeenAt.getTime() < 60_000 })),
      queues: queueStats,
      failedJobs,
      services: {
        api: true,
        database: true,
        worker: workers.some((w) => now - w.lastSeenAt.getTime() < 60_000),
        ai: localAi.reachable || !!(this.ctx.config.OPENAI_API_KEY || this.ctx.config.ANTHROPIC_API_KEY),
        localAi,
        smtp: !!this.ctx.config.SMTP_HOST,
        dependencyDatabase: !!this.ctx.config.OSV_API_URL,
      },
    };
  }

  /** AI control center data: this month's usage by purpose, recent runs and policy-denied agent actions (spec §25–26). */
  async aiUsage(auth: AuthInfo) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const byPurpose = await this.ctx.db
      .select({
        purpose: aiRuns.purpose,
        runs: count(),
        failed: sql<number>`count(*) FILTER (WHERE ${aiRuns.status} = 'failed')::int`,
        tokens: sql<number>`coalesce(sum(${aiRuns.inputTokens} + ${aiRuns.outputTokens}), 0)::bigint`,
      })
      .from(aiRuns)
      .where(and(eq(aiRuns.organizationId, auth.organizationId), gte(aiRuns.startedAt, monthStart)))
      .groupBy(aiRuns.purpose);
    const recent = await this.ctx.db
      .select({ r: aiRuns, projectName: projects.name, projectSlug: projects.slug, userName: users.displayName })
      .from(aiRuns)
      .leftJoin(projects, eq(projects.id, aiRuns.projectId))
      .leftJoin(users, eq(users.id, aiRuns.userId))
      .where(eq(aiRuns.organizationId, auth.organizationId))
      .orderBy(desc(aiRuns.startedAt))
      .limit(50);
    const denied = await this.ctx.db
      .select({ a: aiActions })
      .from(aiActions)
      .innerJoin(aiRuns, eq(aiRuns.id, aiActions.runId))
      .where(and(eq(aiRuns.organizationId, auth.organizationId), eq(aiActions.decision, 'denied')))
      .orderBy(desc(aiActions.createdAt))
      .limit(20);
    return {
      byPurpose: byPurpose.map((p) => ({ ...p, tokens: Number(p.tokens) })),
      recent: recent.map((x) => ({ ...x.r, projectName: x.projectName, projectSlug: x.projectSlug, userName: x.userName })),
      denied: denied.map((d) => d.a),
    };
  }

  /**
   * AI operations view: tasks that are running or waiting for a human decision, the AI job queue, per-project index
   * and memory status, and host resources (CPU/RAM sampled here, GPU through nvidia-smi when the API host has one).
   */
  async aiOperations(auth: AuthInfo) {
    const org = auth.organizationId;
    const taskRows = await this.ctx.db
      .select({ t: aiTasks, projectName: projects.name, projectSlug: projects.slug, requestedBy: users.displayName })
      .from(aiTasks)
      .innerJoin(projects, eq(projects.id, aiTasks.projectId))
      .leftJoin(users, eq(users.id, aiTasks.requestedBy))
      .where(and(eq(aiTasks.organizationId, org), inArray(aiTasks.status, ['queued', 'running', 'awaiting_approval'])))
      .orderBy(desc(aiTasks.createdAt))
      .limit(100);
    const tasks = taskRows.map((r) => ({
      id: r.t.id,
      key: `AI-${r.t.number}`,
      type: r.t.type,
      title: r.t.title,
      status: r.t.status,
      autonomyLevel: r.t.autonomyLevel,
      startedAt: r.t.startedAt,
      createdAt: r.t.createdAt,
      projectName: r.projectName,
      projectSlug: r.projectSlug,
      requestedBy: r.requestedBy,
    }));
    const [queue] = await this.ctx.db
      .select({
        queued: sql<number>`count(*) FILTER (WHERE ${jobs.status} = 'queued')::int`,
        running: sql<number>`count(*) FILTER (WHERE ${jobs.status} = 'running')::int`,
        failed24h: sql<number>`count(*) FILTER (WHERE ${jobs.status} = 'failed' AND ${jobs.finishedAt} > now() - interval '24 hours')::int`,
      })
      .from(jobs)
      .where(and(eq(jobs.organizationId, org), eq(jobs.queue, 'ai')));
    const index = await this.ctx.db
      .select({
        projectId: projects.id,
        name: projects.name,
        slug: projects.slug,
        files: sql<number>`(SELECT count(*) FROM ${codeFiles} WHERE ${codeFiles.projectId} = ${projects.id})::int`,
        lastIndexedAt: sql<string | null>`(SELECT max(${codeFiles.updatedAt}) FROM ${codeFiles} WHERE ${codeFiles.projectId} = ${projects.id})`,
        chunks: sql<number>`(SELECT count(*) FROM ${codeChunks} WHERE ${codeChunks.projectId} = ${projects.id})::int`,
        embedded: sql<number>`(SELECT count(*) FROM ${codeChunks} WHERE ${codeChunks.projectId} = ${projects.id} AND ${codeChunks.embedding} IS NOT NULL)::int`,
        memories: sql<number>`(SELECT count(*) FROM ${aiMemories} WHERE ${aiMemories.projectId} = ${projects.id})::int`,
        verifiedMemories: sql<number>`(SELECT count(*) FROM ${aiMemories} WHERE ${aiMemories.projectId} = ${projects.id} AND ${aiMemories.verification} = 'verified')::int`,
      })
      .from(projects)
      .where(and(eq(projects.organizationId, org), sql`${projects.archivedAt} IS NULL`))
      .orderBy(projects.name);
    return {
      active: tasks.filter((t) => t.status !== 'awaiting_approval'),
      approvals: tasks.filter((t) => t.status === 'awaiting_approval'),
      queue: queue ?? { queued: 0, running: 0, failed24h: 0 },
      index,
      host: await hostResources(),
    };
  }

  async retryJob(id: string) {
    const r = await this.ctx.db
      .update(jobs)
      .set({ status: 'queued', attempts: 0, runAt: new Date(), lastError: null, finishedAt: null })
      .where(and(eq(jobs.id, id), eq(jobs.status, 'failed')))
      .returning({ id: jobs.id });
    if (!r.length) throw notFound('Başarısız iş');
  }

  /* ---------------- webhooks ---------------- */

  async listWebhooks(auth: AuthInfo) {
    const rows = await this.ctx.db.select().from(webhooks).where(eq(webhooks.organizationId, auth.organizationId)).orderBy(desc(webhooks.createdAt));
    return rows.map(({ secretCiphertext: _s, ...w }) => w);
  }

  async createWebhook(auth: AuthInfo, input: { url: string; events: string[]; projectId: string | null; active: boolean }, actor: Actor) {
    if (input.projectId) {
      const p = await this.ctx.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.organizationId, auth.organizationId)));
      if (!p.length) throw notFound('Proje');
    }
    const secret = `whsec_${randomToken(32)}`;
    const row = (
      await this.ctx.db
        .insert(webhooks)
        .values({ organizationId: auth.organizationId, projectId: input.projectId, url: input.url, events: input.events, active: input.active, secretCiphertext: encryptToString(this.ctx.config.encryptionKey, secret), createdBy: auth.user.id })
        .returning()
    )[0]!;
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'webhook.created', resourceType: 'webhook', resourceId: row.id, metadata: { url: input.url, events: input.events } });
    // The signing secret is shown once; receivers verify X-ProjectHub-Signature with it.
    return { id: row.id, url: row.url, events: row.events, signingSecret: secret };
  }

  async deleteWebhook(auth: AuthInfo, id: string, actor: Actor) {
    const r = await this.ctx.db.delete(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.organizationId, auth.organizationId))).returning();
    if (!r.length) throw notFound('Webhook');
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'webhook.deleted', resourceType: 'webhook', resourceId: id, metadata: { url: r[0]!.url } });
  }

  async webhookDeliveries(auth: AuthInfo, id: string) {
    const hook = await this.ctx.db.select({ id: webhooks.id }).from(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.organizationId, auth.organizationId)));
    if (!hook.length) throw notFound('Webhook');
    return this.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, id)).orderBy(desc(webhookDeliveries.createdAt)).limit(50);
  }
}

export interface GpuStat {
  name: string;
  utilization: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
}

let gpuCache: { at: number; value: GpuStat[] | null } = { at: 0, value: null };

/** CPU busy share over a short sample, memory, and GPUs (nvidia-smi, cached 10 s; null when unavailable). */
async function hostResources() {
  const sample = () => os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
  const a = sample();
  await new Promise((r) => setTimeout(r, 250));
  const b = sample();
  const cpuPercent = b.total > a.total ? Math.round((1 - (b.idle - a.idle) / (b.total - a.total)) * 100) : null;
  if (Date.now() - gpuCache.at > 10_000) {
    gpuCache = {
      at: Date.now(),
      value: await new Promise<GpuStat[] | null>((resolve) =>
        execFile('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 3000, windowsHide: true }, (err, out) => {
          if (err) return resolve(null);
          resolve(
            out
              .trim()
              .split(/\r?\n/)
              .filter(Boolean)
              .map((l) => {
                const [name, util, used, total] = l.split(',').map((x) => x.trim());
                return { name: name ?? 'GPU', utilization: Number(util), memoryUsedMb: Number(used), memoryTotalMb: Number(total) };
              }),
          );
        }),
      ),
    };
  }
  return { cpuCount: os.cpus().length, cpuPercent, memoryTotal: os.totalmem(), memoryFree: os.freemem(), gpus: gpuCache.value };
}

const STORAGE_CATEGORIES = ['repos', 'artifacts', 'workspaces', 'logs', 'backups', 'uploads'];
let storageCache: { at: number; value: Promise<Record<string, number>> } | null = null;

/**
 * Storage size per category. Walking build artifacts (node_modules included) takes seconds, so the result is shared by
 * concurrent requests and reused for 5 minutes; the page polls every 15 s and must not queue up full disk walks.
 */
function storageUsage(root: string): Promise<Record<string, number>> {
  if (!storageCache || Date.now() - storageCache.at > 5 * 60_000) {
    const value = (async () => {
      const usage: Record<string, number> = {};
      for (const c of STORAGE_CATEGORIES) usage[c] = await dirSize(`${root}/${c}`);
      return usage;
    })();
    storageCache = { at: Date.now(), value };
    value.catch(() => (storageCache = null));
  }
  return storageCache.value;
}
