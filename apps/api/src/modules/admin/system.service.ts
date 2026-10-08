import { Injectable } from '@nestjs/common';
import fs from 'node:fs/promises';
import os from 'node:os';
import { and, count, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AiSettings, RetentionSettings } from '@projecthub/contracts';
import { audit, dirSize, encryptToString, getOrgSettings, notFound, randomToken, type Actor } from '@projecthub/core';
import { auditEvents, jobs, organizations, projects, webhookDeliveries, webhooks, workerHeartbeats } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { Paged } from '../../infra/http.js';

@Injectable()
export class SystemService {
  constructor(private readonly ctx: Ctx) {}

  async getSettings(auth: AuthInfo) {
    const s = await getOrgSettings(this.ctx.db, auth.organizationId);
    return {
      ...s,
      aiProviders: { openai: !!this.ctx.config.OPENAI_API_KEY, anthropic: !!this.ctx.config.ANTHROPIC_API_KEY },
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
    const root = this.ctx.storage.root;
    const categories = ['repos', 'artifacts', 'workspaces', 'logs', 'backups', 'uploads'];
    const usage: Record<string, number> = {};
    for (const c of categories) usage[c] = await dirSize(`${root}/${c}`);
    let disk: { total: number; free: number } | null = null;
    try {
      const s = await fs.statfs(root);
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      disk = null;
    }
    const dbSize = await this.ctx.db.execute<{ size: number }>(sql`SELECT pg_database_size(current_database())::bigint AS size`);
    const workers = await this.ctx.db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastSeenAt));
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
        ai: !!(this.ctx.config.OPENAI_API_KEY || this.ctx.config.ANTHROPIC_API_KEY),
        smtp: !!this.ctx.config.SMTP_HOST,
        dependencyDatabase: !!this.ctx.config.OSV_API_URL,
      },
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
