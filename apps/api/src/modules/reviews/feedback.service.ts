import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { OPEN_FEEDBACK_STATUSES, type FeedbackStatus, type FeedbackType, type Priority, type TaskStatus } from '@projecthub/contracts';
import {
  audit,
  emitDomainEvent,
  enqueue,
  forbidden,
  invalid,
  nextNumber,
  notFound,
  publish,
  QUEUES,
  slugify,
  timeline,
  type Actor,
} from '@projecthub/core';
import {
  artifacts,
  feedback,
  feedbackAttachments,
  feedbackComments,
  organizationMembers,
  reviewSessions,
  reviewVisitors,
  tasks,
  users,
  type Executor,
} from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';
import { Repos } from '../../infra/repos.js';

const STATUS_LABEL: Record<FeedbackStatus, string> = {
  open: 'Açık',
  triaged: 'İncelendi',
  planned: 'Planlandı',
  in_progress: 'Üzerinde çalışılıyor',
  ready_for_review: 'Onayınıza hazır',
  resolved: 'Çözüldü',
  rejected: 'Reddedildi',
};

export interface NewFeedback {
  organizationId: string;
  projectId: string;
  reviewSessionId: string | null;
  type: FeedbackType;
  title: string;
  body: string;
  pageUrl: string;
  viewport: { width: number; height: number };
  scrollY: number;
  coordinates?: { x: number; y: number };
  domSelector?: string;
  deviceKey?: string;
  browser: string;
  operatingSystem: string;
  userAgent: string;
  versionLabel: string | null;
  buildId: string | null;
  previewId: string | null;
  reporter: { type: 'customer'; visitorId: string; label: string } | { type: 'user'; userId: string; label: string };
  captureScreenshot: boolean;
}

/** Shared by the public portal and the internal UI: creates feedback with full automatic context (spec §61). */
export async function insertFeedback(tx: Executor, input: NewFeedback, actor: Actor) {
  const number = await nextNumber(tx, input.organizationId, 'feedback');
  const row = (
    await tx
      .insert(feedback)
      .values({
        organizationId: input.organizationId,
        projectId: input.projectId,
        reviewSessionId: input.reviewSessionId,
        number,
        type: input.type,
        title: input.title,
        body: input.body,
        priority: input.type === 'bug' ? 'high' : 'medium',
        pageUrl: input.pageUrl,
        viewportWidth: input.viewport.width,
        viewportHeight: input.viewport.height,
        scrollY: input.scrollY,
        x: input.coordinates ? Math.round(input.coordinates.x) : null,
        y: input.coordinates ? Math.round(input.coordinates.y) : null,
        domSelector: input.domSelector ?? null,
        deviceKey: input.deviceKey ?? null,
        browser: input.browser,
        operatingSystem: input.operatingSystem,
        userAgent: input.userAgent.slice(0, 500),
        versionLabel: input.versionLabel,
        buildId: input.buildId,
        previewId: input.previewId,
        reporterType: input.reporter.type,
        reporterVisitorId: input.reporter.type === 'customer' ? input.reporter.visitorId : null,
        reporterUserId: input.reporter.type === 'user' ? input.reporter.userId : null,
      })
      .returning()
  )[0]!;
  const base = { organizationId: input.organizationId, projectId: input.projectId };
  if (input.captureScreenshot && input.previewId) {
    await enqueue(tx, { ...base, queue: QUEUES.browser, type: 'feedback.screenshot', maxAttempts: 2, payload: { feedbackId: row.id } });
  }
  await enqueue(tx, { ...base, queue: QUEUES.ai, type: 'feedback.relate', maxAttempts: 2, payload: { feedbackId: row.id } });
  await audit(tx, { ...base, actor, action: 'feedback.created', resourceType: 'feedback', resourceId: row.id, metadata: { number, title: input.title, page: input.pageUrl } });
  await timeline(tx, {
    ...base,
    kind: 'feedback',
    tone: input.type === 'bug' ? 'bad' : 'warn',
    title: `FB-${number} geldi — ${input.reporter.label}`,
    description: input.title,
    refType: 'feedback',
    refId: row.id,
    actorLabel: input.reporter.label,
  });
  await emitDomainEvent(tx, { event: 'feedback.created', ...base, actor, data: { feedbackId: row.id, number, title: input.title, reporter: input.reporter.label } });
  await publish(tx, { type: 'feedback.updated', ...base, id: row.id, data: { reviewSessionId: input.reviewSessionId } });
  return row;
}

@Injectable()
export class FeedbackService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
    private readonly repos: Repos,
  ) {}

  async list(auth: AuthInfo, idOrSlug: string, q: { status?: string; reviewId?: string; assignee?: string; open?: boolean }) {
    const scope = await this.access.require(auth, idOrSlug);
    const conds: SQL[] = [eq(feedback.projectId, scope.project.id)];
    if (q.status) conds.push(eq(feedback.status, q.status as FeedbackStatus));
    if (q.open) conds.push(inArray(feedback.status, OPEN_FEEDBACK_STATUSES));
    if (q.reviewId) conds.push(eq(feedback.reviewSessionId, q.reviewId));
    if (q.assignee === 'me') conds.push(eq(feedback.assignedUserId, auth.user.id));
    const rows = await this.ctx.db
      .select({ f: feedback, v: reviewVisitors, reporterUser: users.displayName, reviewNumber: reviewSessions.number, taskNumber: tasks.number })
      .from(feedback)
      .leftJoin(reviewVisitors, eq(reviewVisitors.id, feedback.reporterVisitorId))
      .leftJoin(users, eq(users.id, feedback.reporterUserId))
      .leftJoin(reviewSessions, eq(reviewSessions.id, feedback.reviewSessionId))
      .leftJoin(tasks, eq(tasks.id, feedback.taskId))
      .where(and(...conds))
      .orderBy(desc(feedback.createdAt))
      .limit(500);
    const assignees = await this.userNames(rows.map((r) => r.f.assignedUserId).filter((x): x is string => !!x));
    return rows.map((r) => this.present(r.f, r.v, r.reporterUser, r.reviewNumber, r.taskNumber, assignees));
  }

  private async userNames(ids: string[]) {
    if (!ids.length) return new Map<string, { displayName: string; avatarColor: string }>();
    const rows = await this.ctx.db.select({ id: users.id, displayName: users.displayName, avatarColor: users.avatarColor }).from(users).where(inArray(users.id, [...new Set(ids)]));
    return new Map(rows.map((r) => [r.id, r]));
  }

  present(
    f: typeof feedback.$inferSelect,
    v: typeof reviewVisitors.$inferSelect | null,
    reporterUser: string | null,
    reviewNumber: number | null,
    taskNumber: number | null,
    assignees: Map<string, { displayName: string; avatarColor: string }>,
  ) {
    return {
      id: f.id,
      key: `FB-${f.number}`,
      number: f.number,
      projectId: f.projectId,
      type: f.type,
      title: f.title,
      body: f.body,
      status: f.status,
      statusLabel: STATUS_LABEL[f.status],
      priority: f.priority,
      category: f.category,
      pageUrl: f.pageUrl,
      viewport: f.viewportWidth ? { width: f.viewportWidth, height: f.viewportHeight } : null,
      scrollY: f.scrollY,
      x: f.x,
      y: f.y,
      domSelector: f.domSelector,
      deviceKey: f.deviceKey,
      browser: f.browser,
      operatingSystem: f.operatingSystem,
      versionLabel: f.versionLabel,
      buildId: f.buildId,
      previewId: f.previewId,
      reviewSessionId: f.reviewSessionId,
      reviewKey: reviewNumber ? `RV-${reviewNumber}` : null,
      reporter:
        f.reporterType === 'customer'
          ? { type: 'customer', name: `${v?.firstName ?? ''} ${v?.lastName ?? ''}`.trim(), department: v?.department ?? '', company: v?.company ?? '', email: v?.email ?? '' }
          : { type: 'user', name: reporterUser ?? '', department: 'Ekip', company: '', email: '' },
      assignee: f.assignedUserId ? { id: f.assignedUserId, ...(assignees.get(f.assignedUserId) ?? { displayName: '—', avatarColor: '#888' }) } : null,
      taskId: f.taskId,
      taskKey: taskNumber ? `PH-${taskNumber}` : null,
      triage: f.triage,
      relatedFiles: f.relatedFiles,
      resolvedAt: f.resolvedAt,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    };
  }

  async load(auth: AuthInfo, feedbackId: string) {
    const f = (await this.ctx.db.select().from(feedback).where(and(eq(feedback.id, feedbackId), eq(feedback.organizationId, auth.organizationId))))[0];
    if (!f) throw notFound('Geri bildirim');
    const scope = await this.access.require(auth, f.projectId);
    return { f, scope };
  }

  async get(auth: AuthInfo, feedbackId: string) {
    const { f } = await this.load(auth, feedbackId);
    const v = f.reporterVisitorId ? (await this.ctx.db.select().from(reviewVisitors).where(eq(reviewVisitors.id, f.reporterVisitorId)))[0] ?? null : null;
    const ru = f.reporterUserId ? (await this.ctx.db.select({ n: users.displayName }).from(users).where(eq(users.id, f.reporterUserId)))[0]?.n ?? null : null;
    const rv = f.reviewSessionId ? (await this.ctx.db.select({ n: reviewSessions.number }).from(reviewSessions).where(eq(reviewSessions.id, f.reviewSessionId)))[0]?.n ?? null : null;
    const tk = f.taskId ? (await this.ctx.db.select({ n: tasks.number }).from(tasks).where(eq(tasks.id, f.taskId)))[0]?.n ?? null : null;
    const assignees = await this.userNames(f.assignedUserId ? [f.assignedUserId] : []);
    const comments = await this.comments(f.id);
    const attachments = await this.ctx.db
      .select({ id: feedbackAttachments.id, kind: feedbackAttachments.kind, artifactId: artifacts.id, contentType: artifacts.contentType, createdAt: feedbackAttachments.createdAt })
      .from(feedbackAttachments)
      .innerJoin(artifacts, eq(artifacts.id, feedbackAttachments.artifactId))
      .where(eq(feedbackAttachments.feedbackId, f.id));
    return { ...this.present(f, v, ru, rv, tk, assignees), userAgent: f.userAgent, comments, attachments };
  }

  async comments(feedbackId: string) {
    const rows = await this.ctx.db
      .select({ c: feedbackComments, u: users.displayName, v: reviewVisitors })
      .from(feedbackComments)
      .leftJoin(users, eq(users.id, feedbackComments.authorUserId))
      .leftJoin(reviewVisitors, eq(reviewVisitors.id, feedbackComments.authorVisitorId))
      .where(eq(feedbackComments.feedbackId, feedbackId))
      .orderBy(asc(feedbackComments.createdAt));
    return rows.map((r) => ({
      id: r.c.id,
      authorType: r.c.authorType,
      author: r.c.authorType === 'customer' ? `${r.v?.firstName ?? ''} ${r.v?.lastName ?? ''}`.trim() : r.c.authorType === 'ai' ? 'AI Asistan' : r.c.authorType === 'system' ? 'Sistem' : (r.u ?? ''),
      body: r.c.body,
      createdAt: r.c.createdAt,
    }));
  }

  async update(auth: AuthInfo, feedbackId: string, input: { status?: FeedbackStatus; priority?: Priority; category?: string; assignedUserId?: string | null }, actor: Actor) {
    const { f, scope } = await this.load(auth, feedbackId);
    if (!scope.can('feedback.manage')) throw forbidden();
    if (input.assignedUserId) {
      const m = await this.ctx.db.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, auth.organizationId), eq(organizationMembers.userId, input.assignedUserId)));
      if (!m.length) throw notFound('Kullanıcı');
    }
    const patch: Partial<typeof feedback.$inferInsert> = { ...input };
    if (input.status === 'resolved' || input.status === 'rejected') patch.resolvedAt = new Date();
    else if (input.status) patch.resolvedAt = null;
    await this.ctx.db.transaction(async (tx) => {
      await tx.update(feedback).set(patch).where(eq(feedback.id, f.id));
      if (input.status && input.status !== f.status) {
        await tx.insert(feedbackComments).values({ feedbackId: f.id, authorType: 'system', body: `Durum: ${STATUS_LABEL[f.status]} → ${STATUS_LABEL[input.status]} (${actor.label})` });
        await timeline(tx, {
          organizationId: auth.organizationId,
          projectId: f.projectId,
          kind: 'feedback',
          tone: input.status === 'resolved' ? 'ok' : 'idle',
          title: `FB-${f.number}: ${STATUS_LABEL[input.status]}`,
          description: f.title,
          actorLabel: actor.label,
          refType: 'feedback',
          refId: f.id,
        });
        await emitDomainEvent(tx, { event: 'feedback.status_changed', organizationId: auth.organizationId, projectId: f.projectId, actor, data: { feedbackId: f.id, from: f.status, to: input.status } });
      }
      await audit(tx, { organizationId: auth.organizationId, projectId: f.projectId, actor, action: 'feedback.updated', resourceType: 'feedback', resourceId: f.id, metadata: input });
      await publish(tx, { type: 'feedback.updated', organizationId: auth.organizationId, projectId: f.projectId, id: f.id, data: { reviewSessionId: f.reviewSessionId } });
    });
    return this.get(auth, feedbackId);
  }

  async comment(auth: AuthInfo, feedbackId: string, body: string, actor: Actor) {
    const { f } = await this.load(auth, feedbackId);
    await this.ctx.db.insert(feedbackComments).values({ feedbackId: f.id, authorType: 'user', authorUserId: auth.user.id, body });
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: f.projectId, actor, action: 'feedback.commented', resourceType: 'feedback', resourceId: f.id });
    await publish(this.ctx.db, { type: 'feedback.updated', organizationId: auth.organizationId, projectId: f.projectId, id: f.id, data: { reviewSessionId: f.reviewSessionId } });
    return this.comments(f.id);
  }

  /** Spec §64 + §103: turn feedback into a task; hotfix tasks also get their own branch off the default branch. */
  async toTask(auth: AuthInfo, feedbackId: string, input: { title?: string; assigneeId?: string | null; hotfix: boolean }, actor: Actor) {
    const { f, scope } = await this.load(auth, feedbackId);
    if (!scope.can('feedback.manage')) throw forbidden();
    if (f.taskId) throw invalid('Bu geri bildirim zaten bir göreve bağlı');
    const result = await this.ctx.db.transaction(async (tx) => {
      const number = await nextNumber(tx, auth.organizationId, 'task');
      const branch = input.hotfix ? `hotfix/PH-${number}-${slugify(input.title ?? f.title).slice(0, 40)}` : null;
      const t = (
        await tx
          .insert(tasks)
          .values({
            organizationId: auth.organizationId,
            projectId: f.projectId,
            number,
            title: input.title ?? f.title,
            description: [f.body, '', `Kaynak: FB-${f.number} · ${f.pageUrl}${f.domSelector ? ` · ${f.domSelector}` : ''}`, f.viewportWidth ? `Ekran: ${f.viewportWidth}×${f.viewportHeight} · ${f.browser ?? ''}` : ''].filter(Boolean).join('\n'),
            priority: f.priority,
            isHotfix: input.hotfix,
            assigneeId: input.assigneeId ?? f.assignedUserId,
            sourceType: 'feedback',
            sourceId: f.id,
            branch,
            createdBy: auth.user.id,
          })
          .returning()
      )[0]!;
      await tx.update(feedback).set({ taskId: t.id, status: f.status === 'open' || f.status === 'triaged' ? 'planned' : f.status, assignedUserId: t.assigneeId }).where(eq(feedback.id, f.id));
      await tx.insert(feedbackComments).values({ feedbackId: f.id, authorType: 'system', body: `PH-${number} görevi oluşturuldu${branch ? ` · branch: ${branch}` : ''}` });
      await audit(tx, { organizationId: auth.organizationId, projectId: f.projectId, actor, action: 'task.created_from_feedback', resourceType: 'task', resourceId: t.id, metadata: { feedback: f.number, hotfix: input.hotfix } });
      await timeline(tx, { organizationId: auth.organizationId, projectId: f.projectId, kind: 'task', tone: 'run', title: `${input.hotfix ? 'Hotfix görevi' : 'Görev'} PH-${number}: ${t.title}`, description: `FB-${f.number} üzerinden${branch ? ` · ${branch}` : ''}`, actorLabel: actor.label, refType: 'task', refId: t.id });
      await publish(tx, { type: 'feedback.updated', organizationId: auth.organizationId, projectId: f.projectId, id: f.id, data: { reviewSessionId: f.reviewSessionId } });
      return { task: t, branch };
    });
    if (result.branch && scope.can('repository.push')) {
      try {
        const { git } = await this.repos.forProject(f.projectId);
        const head = await git.resolve(`refs/heads/${scope.project.defaultBranch}`);
        if (head) await git.createBranch(result.branch, head);
      } catch (e) {
        this.ctx.logger.warn({ err: e }, 'hotfix branch could not be created');
      }
    }
    return { id: result.task.id, key: `PH-${result.task.number}`, branch: result.branch };
  }

  /* ---------------- tasks ---------------- */

  async listTasks(auth: AuthInfo, idOrSlug: string, q: { status?: string }) {
    const scope = await this.access.require(auth, idOrSlug);
    const conds: SQL[] = [eq(tasks.projectId, scope.project.id)];
    if (q.status) conds.push(eq(tasks.status, q.status as TaskStatus));
    const rows = await this.ctx.db.select().from(tasks).where(and(...conds)).orderBy(desc(tasks.createdAt)).limit(300);
    const names = await this.userNames(rows.map((r) => r.assigneeId).filter((x): x is string => !!x));
    return rows.map((t) => ({ ...t, key: `PH-${t.number}`, assignee: t.assigneeId ? { id: t.assigneeId, ...(names.get(t.assigneeId) ?? { displayName: '—', avatarColor: '#888' }) } : null }));
  }

  async createTask(auth: AuthInfo, idOrSlug: string, input: { title: string; description: string; priority: Priority; assigneeId: string | null }, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'feedback.manage');
    const t = await this.ctx.db.transaction(async (tx) => {
      const number = await nextNumber(tx, auth.organizationId, 'task');
      const row = (await tx.insert(tasks).values({ organizationId: auth.organizationId, projectId: scope.project.id, number, ...input, sourceType: 'manual', createdBy: auth.user.id }).returning())[0]!;
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'task.created', resourceType: 'task', resourceId: row.id });
      await timeline(tx, { organizationId: auth.organizationId, projectId: scope.project.id, kind: 'task', title: `Görev PH-${number}: ${row.title}`, actorLabel: actor.label, refType: 'task', refId: row.id });
      return row;
    });
    return { ...t, key: `PH-${t.number}` };
  }

  async updateTask(auth: AuthInfo, taskId: string, input: { title?: string; description?: string; status?: TaskStatus; priority?: Priority; assigneeId?: string | null; branch?: string | null }, actor: Actor) {
    const t = (await this.ctx.db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.organizationId, auth.organizationId))))[0];
    if (!t) throw notFound('Görev');
    await this.access.requireWritable(auth, t.projectId, 'feedback.manage');
    const row = await this.ctx.db.transaction(async (tx) => {
      const r = (await tx.update(tasks).set({ ...input, completedAt: input.status === 'done' ? new Date() : input.status ? null : t.completedAt }).where(eq(tasks.id, t.id)).returning())[0]!;
      // Keep the source feedback in step with its task.
      if (input.status && t.sourceType === 'feedback' && t.sourceId) {
        const next: FeedbackStatus | null = input.status === 'in_progress' ? 'in_progress' : input.status === 'in_review' ? 'ready_for_review' : null;
        if (next) await tx.update(feedback).set({ status: next }).where(eq(feedback.id, t.sourceId));
      }
      await audit(tx, { organizationId: auth.organizationId, projectId: t.projectId, actor, action: 'task.updated', resourceType: 'task', resourceId: t.id, metadata: input });
      if (input.status && input.status !== t.status) {
        await timeline(tx, { organizationId: auth.organizationId, projectId: t.projectId, kind: 'task', tone: input.status === 'done' ? 'ok' : 'idle', title: `PH-${t.number}: ${input.status}`, description: t.title, actorLabel: actor.label, refType: 'task', refId: t.id });
      }
      await publish(tx, { type: 'task.updated', organizationId: auth.organizationId, projectId: t.projectId, id: t.id });
      return r;
    });
    return { ...row, key: `PH-${row.number}` };
  }
}
