import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import type { DomainEvent, Permission } from '@projecthub/contracts';
import { decryptFromString, enqueue, hmacSha256, PermanentJobError, publish, QUEUES, usersWithProjectPermission, type JobContext } from '@projecthub/core';
import { notifications, projects, users, webhookDeliveries, webhooks } from '@projecthub/database';
import type { WorkerCtx } from '../context.js';

interface Envelope {
  eventId: string;
  eventType: DomainEvent;
  occurredAt: string;
  organizationId: string;
  projectId: string | null;
  actor: { type: string; id: string | null; label: string } | null;
  payload: Record<string, unknown>;
}

interface Rule {
  category: string;
  /** Permission holders inside the project who should be told. */
  permission?: Permission;
  /** Payload fields that contain user ids to notify directly. */
  userFields?: string[];
  email?: boolean;
  title: (e: Envelope, projectName: string) => string;
  link: (e: Envelope, slug: string) => string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

const RULES: Partial<Record<DomainEvent, Rule>> = {
  'pull_request.opened': {
    category: 'code',
    permission: 'repository.push',
    title: (e, p) => `${p}: PR #${String(e.payload.number)} incelemenizi bekliyor — ${str(e.payload.title)}`,
    link: (e, s) => `/projects/${s}/pull-requests/${String(e.payload.number)}`,
  },
  'pull_request.reviewed': {
    category: 'code',
    userFields: ['authorId'],
    title: (e, p) => `${p}: PR #${String(e.payload.number)} ${e.payload.decision === 'approved' ? 'onaylandı' : 'için değişiklik istendi'}`,
    link: (e, s) => `/projects/${s}/pull-requests/${String(e.payload.number)}`,
  },
  'pull_request.merged': {
    category: 'code',
    userFields: ['authorId'],
    title: (e, p) => `${p}: PR #${String(e.payload.number)} birleştirildi — ${str(e.payload.title)}`,
    link: (e, s) => `/projects/${s}/pull-requests/${String(e.payload.number)}`,
  },
  'feedback.created': {
    category: 'feedback',
    permission: 'feedback.manage',
    title: (e, p) => `${p}: yeni kullanıcı geri bildirimi — ${str(e.payload.title)}`,
    link: (e, s) => `/projects/${s}/feedback/${str(e.payload.feedbackId)}`,
  },
  'build.failed': {
    category: 'build',
    userFields: ['triggeredBy'],
    title: (e, p) => `${p}: build #${String(e.payload.number)} başarısız`,
    link: (e, s) => `/projects/${s}/builds/${str(e.payload.buildId)}`,
  },
  'preview.ready': {
    category: 'build',
    userFields: ['createdBy'],
    title: (e, p) => `${p}: ön izleme hazır`,
    link: (e, s) => `/projects/${s}/previews`,
  },
  'ai.task.awaiting_approval': {
    category: 'ai',
    permission: 'ai.approve',
    userFields: ['requestedBy'],
    title: (e, p) => `${p}: ${str(e.payload.key)} onayınızı bekliyor`,
    link: (e, s) => `/projects/${s}/ai/tasks/${str(e.payload.taskId)}`,
  },
  'ai.task.merged': {
    category: 'ai',
    userFields: ['requestedBy'],
    title: (e, p) => `${p}: ${str(e.payload.key)} birleştirildi`,
    link: (e, s) => `/projects/${s}/ai/tasks/${str(e.payload.taskId)}`,
  },
  'deployment.pending_approval': {
    category: 'deployment',
    permission: 'deployment.approve',
    email: true,
    title: (e, p) => `${p}: ${str(e.payload.environment)} deployment onayı bekleniyor (v${str(e.payload.version)})`,
    link: (e, s) => `/projects/${s}/deployments/${str(e.payload.deploymentId)}`,
  },
  'deployment.succeeded': {
    category: 'deployment',
    userFields: ['requestedBy'],
    title: (e, p) => `${p}: v${str(e.payload.version)} ${str(e.payload.environment)} ortamına yayınlandı`,
    link: (e, s) => `/projects/${s}/deployments/${str(e.payload.deploymentId)}`,
  },
  'deployment.failed': {
    category: 'deployment',
    permission: 'environment.manage',
    userFields: ['requestedBy'],
    email: true,
    title: (e, p) => `${p}: ${str(e.payload.environment)} deployment başarısız`,
    link: (e, s) => `/projects/${s}/deployments/${str(e.payload.deploymentId)}`,
  },
  'deployment.rolled_back': {
    category: 'deployment',
    permission: 'environment.manage',
    userFields: ['requestedBy'],
    email: true,
    title: (e, p) => `${p}: ${str(e.payload.environment)} önceki sürüme geri alındı`,
    link: (e, s) => `/projects/${s}/deployments/${str(e.payload.deploymentId)}`,
  },
  'security.finding.critical': {
    category: 'security',
    permission: 'security.manage',
    email: true,
    title: (e, p) => `${p}: kritik güvenlik bulgusu — ${str(e.payload.title)}`,
    link: (_e, s) => `/projects/${s}/security`,
  },
  'incident.opened': {
    category: 'incident',
    permission: 'environment.manage',
    email: true,
    title: (e, p) => `${p}: olay açıldı — ${str(e.payload.title)}`,
    link: (e, s) => `/projects/${s}/incidents?open=${str(e.payload.incidentId)}`,
  },
  'incident.resolved': {
    category: 'incident',
    permission: 'environment.manage',
    title: (e, p) => `${p}: olay çözüldü — ${str(e.payload.title)}`,
    link: (e, s) => `/projects/${s}/incidents?open=${str(e.payload.incidentId)}`,
  },
  'task.assigned': {
    category: 'team',
    userFields: ['assigneeId'],
    email: true,
    title: (e, p) => `${p}: ${str(e.payload.key)} size atandı — ${str(e.payload.title)}`,
    link: (e) => `/team?task=${str(e.payload.taskId)}`,
  },
  'task.commented': {
    category: 'team',
    userFields: ['userId'],
    title: (e, p) => `${p}: ${str(e.payload.key)} yorumlandı — ${str(e.payload.title)}`,
    link: (e) => `/team?task=${str(e.payload.taskId)}`,
  },
  'project.mentioned': {
    category: 'team',
    userFields: ['userId'],
    email: true,
    title: (e, p) => `${p} tartışmasında sizden bahsedildi: “${str(e.payload.excerpt)}”`,
    link: (_e, s) => `/projects/${s}/discussion`,
  },
};

let transporter: nodemailer.Transporter | null | undefined;
function mailer(ctx: WorkerCtx) {
  if (transporter !== undefined) return transporter;
  const c = ctx.config;
  transporter = c.SMTP_HOST
    ? nodemailer.createTransport({ host: c.SMTP_HOST, port: c.SMTP_PORT, secure: c.SMTP_PORT === 465, auth: c.SMTP_USER ? { user: c.SMTP_USER, pass: c.SMTP_PASSWORD } : undefined })
    : null;
  return transporter;
}

/** Fans a domain event out to in-app notifications, e-mail (critical categories) and webhooks. */
export async function dispatchEvent(ctx: WorkerCtx, { job }: JobContext) {
  const e = job.payload as unknown as Envelope;
  const db = ctx.db;

  // Webhooks: one delivery job per endpoint so retries are independent.
  const hooks = await db
    .select({ id: webhooks.id, events: webhooks.events })
    .from(webhooks)
    .where(and(eq(webhooks.organizationId, e.organizationId), eq(webhooks.active, true), e.projectId ? or(isNull(webhooks.projectId), eq(webhooks.projectId, e.projectId)) : isNull(webhooks.projectId)));
  for (const h of hooks.filter((x) => x.events.includes(e.eventType))) {
    await enqueue(db, { queue: QUEUES.notification, type: 'webhook.deliver', organizationId: e.organizationId, maxAttempts: 5, payload: { webhookId: h.id, envelope: e } as never });
  }

  const rule = RULES[e.eventType];
  if (!rule || !e.projectId) return { webhooks: hooks.length, notified: 0 };
  const project = (await db.select({ name: projects.name, slug: projects.slug }).from(projects).where(eq(projects.id, e.projectId)))[0];
  if (!project) return { skipped: 'project deleted' };
  const recipients = new Set<string>();
  if (rule.permission) for (const id of await usersWithProjectPermission(db, e.organizationId, e.projectId, rule.permission)) recipients.add(id);
  for (const f of rule.userFields ?? []) {
    const v = e.payload[f];
    if (typeof v === 'string') recipients.add(v);
  }
  if (e.actor?.type === 'user' && e.actor.id) recipients.delete(e.actor.id);
  if (!recipients.size) return { webhooks: hooks.length, notified: 0 };
  const people = await db.select({ id: users.id, email: users.email, prefs: users.notificationPreferences }).from(users).where(and(inArray(users.id, [...recipients]), eq(users.status, 'active')));
  // Per-user preferences (Hesabım > Bildirimler): in-app defaults to on, e-mail to the rule's default.
  const active = people.filter((u) => u.prefs[rule.category]?.inApp ?? true);
  const emailTo = people.filter((u) => u.prefs[rule.category]?.email ?? rule.email ?? false);
  const title = rule.title(e, project.name).slice(0, 300);
  const link = rule.link(e, project.slug);
  const body = e.actor ? `${e.actor.label}` : '';
  if (active.length) {
    await db.insert(notifications).values(active.map((u) => ({ organizationId: e.organizationId, userId: u.id, projectId: e.projectId, category: rule.category, title, body, link })));
    for (const u of active) await publish(db, { type: 'notification', organizationId: e.organizationId, data: { userId: u.id, title } });
  }
  const t = emailTo.length ? mailer(ctx) : null;
  if (t) {
    for (const u of emailTo) {
      try {
        await t.sendMail({ from: ctx.config.SMTP_FROM, to: u.email, subject: title, text: `${title}\n\n${ctx.config.APP_URL}${link}\n` });
      } catch (err) {
        ctx.logger.warn({ err, to: u.email }, 'notification e-mail failed');
      }
    }
  }
  return { webhooks: hooks.length, notified: active.length };
}

export async function deliverWebhook(ctx: WorkerCtx, { job }: JobContext) {
  const { webhookId, envelope } = job.payload as { webhookId: string; envelope: Envelope };
  const hook = (await ctx.db.select().from(webhooks).where(eq(webhooks.id, webhookId)))[0];
  if (!hook || !hook.active) return { skipped: true };
  const url = new URL(hook.url);
  if (/^169\.254\./.test(url.hostname) || url.hostname === 'metadata.google.internal') throw new PermanentJobError('Bu adrese webhook gönderilemez');
  const body = JSON.stringify(envelope);
  const secret = decryptFromString(ctx.config.encryptionKey, hook.secretCiphertext);
  const started = Date.now();
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'ProjectHub-Webhook/1.0',
        'x-projecthub-event': envelope.eventType,
        'x-projecthub-delivery': envelope.eventId,
        'x-projecthub-signature': `sha256=${hmacSha256(secret, body)}`,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = (e as Error).message;
  }
  await ctx.db.insert(webhookDeliveries).values({ webhookId, eventType: envelope.eventType, payload: envelope, status: error ? 'failed' : 'delivered', responseCode: status, error, durationMs: Date.now() - started });
  await ctx.db.update(webhooks).set({ lastStatus: status, lastDeliveryAt: new Date() }).where(eq(webhooks.id, webhookId));
  if (error) throw new Error(`webhook delivery failed: ${error}`);
  return { status };
}

