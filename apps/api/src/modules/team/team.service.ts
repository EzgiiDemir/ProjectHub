import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { TaskStatus } from '@projecthub/contracts';
import { emitDomainEvent, forbidden, invalid, notFound, publish, timeline, type Actor } from '@projecthub/core';
import {
  organizationMembers,
  projectComments,
  projectEvents,
  projectMembers,
  projects,
  pullRequests,
  roles,
  taskComments,
  taskEvents,
  tasks,
  users,
} from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';
import { Repos } from '../../infra/repos.js';
import { MiscService } from '../misc/misc.service.js';

const BOARD_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done'];

/**
 * Team work (Takım çalışması): a Kanban board across projects, task history and comments with linked commits and
 * pull requests, the team's activity stream, workload per person and project discussions with @mentions.
 */
@Injectable()
export class TeamService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
    private readonly repos: Repos,
    private readonly misc: MiscService,
  ) {}

  private async userMap(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return new Map<string, { id: string; displayName: string; avatarColor: string }>();
    const rows = await this.ctx.db.select({ id: users.id, displayName: users.displayName, avatarColor: users.avatarColor }).from(users).where(inArray(users.id, unique));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Board: open work plus what was finished in the last 14 days, across every project the caller can see. */
  async board(auth: AuthInfo, q: { projectId?: string; assigneeId?: string; mine?: boolean; search?: string }) {
    const visible = await this.misc.visibleProjectIds(auth);
    const ids = q.projectId ? visible.filter((id) => id === q.projectId) : visible;
    if (!ids.length) return { tasks: [], projects: [], people: [] };
    const conds: SQL[] = [inArray(tasks.projectId, ids), inArray(tasks.status, BOARD_STATUSES), or(ne(tasks.status, 'done'), gte(tasks.completedAt, sql`now() - interval '14 days'`))!];
    if (q.mine) conds.push(eq(tasks.assigneeId, auth.user.id));
    else if (q.assigneeId === 'none') conds.push(isNull(tasks.assigneeId));
    else if (q.assigneeId) conds.push(eq(tasks.assigneeId, q.assigneeId));
    if (q.search) conds.push(sql`(${tasks.title} ILIKE ${`%${q.search}%`} OR ('PH-' || ${tasks.number}) ILIKE ${`%${q.search}%`})`);
    const rows = await this.ctx.db
      .select({ t: tasks, slug: projects.slug, project: projects.name, color: projects.color, comments: sql<number>`(SELECT count(*)::int FROM ${taskComments} c WHERE c.task_id = ${tasks.id})` })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(...conds))
      .orderBy(sql`CASE ${tasks.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`, sql`${tasks.dueDate} ASC NULLS LAST`, desc(tasks.updatedAt))
      .limit(500);
    const people = await this.userMap(rows.map((r) => r.t.assigneeId));
    const projectList = await this.ctx.db.select({ id: projects.id, name: projects.name, slug: projects.slug, color: projects.color, status: projects.status }).from(projects).where(inArray(projects.id, visible)).orderBy(projects.name);
    return {
      tasks: rows.map((r) => ({
        ...r.t,
        key: `PH-${r.t.number}`,
        project: { id: r.t.projectId, slug: r.slug, name: r.project, color: r.color },
        assignee: r.t.assigneeId ? (people.get(r.t.assigneeId) ?? null) : null,
        comments: r.comments,
        overdue: !!r.t.dueDate && r.t.status !== 'done' && r.t.dueDate < new Date().toISOString().slice(0, 10),
      })),
      projects: projectList.filter((p) => p.status !== 'archived'),
      people: await this.assignablePeople(auth),
    };
  }

  /** Active organization members, for assignee pickers and mentions. */
  async assignablePeople(auth: AuthInfo) {
    return this.ctx.db
      .select({ id: users.id, displayName: users.displayName, title: users.title, avatarColor: users.avatarColor })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.organizationId, auth.organizationId), eq(organizationMembers.status, 'active'), eq(users.status, 'active')))
      .orderBy(users.displayName);
  }

  private async taskOf(auth: AuthInfo, taskId: string) {
    const t = (await this.ctx.db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.organizationId, auth.organizationId))))[0];
    if (!t) throw notFound('Görev');
    const scope = await this.access.require(auth, t.projectId);
    return { t, scope };
  }

  /** Task page: details, history, comments, commits on its branch or mentioning its key, and its pull request. */
  async task(auth: AuthInfo, taskId: string) {
    const { t, scope } = await this.taskOf(auth, taskId);
    const key = `PH-${t.number}`;
    const events = await this.ctx.db.select().from(taskEvents).where(eq(taskEvents.taskId, t.id)).orderBy(asc(taskEvents.createdAt));
    const comments = await this.ctx.db.select().from(taskComments).where(eq(taskComments.taskId, t.id)).orderBy(asc(taskComments.createdAt));
    const people = await this.userMap([t.assigneeId, t.createdBy, ...comments.map((c) => c.authorId), ...events.filter((e) => e.kind === 'assigned').flatMap((e) => [e.fromValue, e.toValue])]);
    let commits: { sha: string; subject: string; authorName: string; date: string; additions: number; deletions: number; source: 'branch' | 'mention' }[] = [];
    try {
      const { git } = await this.repos.forProject(t.projectId);
      const seen = new Set<string>();
      if (t.branch && (await git.resolve(`refs/heads/${t.branch}`))) {
        for (const c of await git.log({ ref: `refs/heads/${t.branch}`, limit: 30 })) {
          seen.add(c.sha);
          commits.push({ sha: c.sha, subject: c.subject, authorName: c.authorName, date: c.date, additions: c.additions, deletions: c.deletions, source: 'branch' });
        }
      }
      if (await git.resolve(`refs/heads/${scope.project.defaultBranch}`)) {
        for (const c of await git.log({ ref: `refs/heads/${scope.project.defaultBranch}`, limit: 20, grep: key })) {
          if (!seen.has(c.sha) && new RegExp(`\\b${key}\\b`).test(`${c.subject}\n${c.body ?? ''}`)) commits.push({ sha: c.sha, subject: c.subject, authorName: c.authorName, date: c.date, additions: c.additions, deletions: c.deletions, source: 'mention' });
        }
      }
    } catch {
      commits = []; // repository still provisioning
    }
    const pr = t.branch
      ? ((await this.ctx.db.select({ number: pullRequests.number, title: pullRequests.title, status: pullRequests.status }).from(pullRequests).where(and(eq(pullRequests.projectId, t.projectId), eq(pullRequests.sourceBranch, t.branch))).orderBy(desc(pullRequests.createdAt)).limit(1))[0] ?? null)
      : null;
    const name = (id: string | null) => (id ? (people.get(id)?.displayName ?? 'Silinmiş kullanıcı') : null);
    return {
      ...t,
      key,
      project: { id: scope.project.id, slug: scope.project.slug, name: scope.project.name, defaultBranch: scope.project.defaultBranch },
      assignee: t.assigneeId ? (people.get(t.assigneeId) ?? null) : null,
      createdByName: name(t.createdBy),
      canEdit: scope.can('feedback.manage') && scope.project.status !== 'archived',
      canComment: scope.project.status !== 'archived',
      events: events.map((e) => ({ id: e.id, kind: e.kind, actor: e.actorLabel, at: e.createdAt, from: e.kind === 'assigned' ? name(e.fromValue) : e.fromValue, to: e.kind === 'assigned' ? name(e.toValue) : e.toValue })),
      comments: comments.map((c) => ({ id: c.id, body: c.body, at: c.createdAt, editedAt: c.editedAt, author: c.authorId ? (people.get(c.authorId) ?? null) : null, mine: c.authorId === auth.user.id })),
      commits,
      pullRequest: pr,
    };
  }

  async comment(auth: AuthInfo, taskId: string, body: string, actor: Actor) {
    const { t, scope } = await this.taskOf(auth, taskId);
    if (scope.project.status === 'archived') throw forbidden('Proje arşivde');
    const c = await this.ctx.db.transaction(async (tx) => {
      const row = (await tx.insert(taskComments).values({ organizationId: auth.organizationId, taskId: t.id, authorId: auth.user.id, body }).returning())[0]!;
      await tx.insert(taskEvents).values({ organizationId: auth.organizationId, taskId: t.id, actorId: auth.user.id, actorLabel: actor.label, kind: 'comment' });
      await tx.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, t.id));
      await timeline(tx, { organizationId: auth.organizationId, projectId: t.projectId, kind: 'task', title: `PH-${t.number} yorumlandı`, description: body.slice(0, 200), actorLabel: actor.label, refType: 'task', refId: t.id });
      for (const userId of new Set([t.assigneeId, t.createdBy].filter((x): x is string => !!x && x !== auth.user.id))) {
        await emitDomainEvent(tx, { event: 'task.commented', organizationId: auth.organizationId, projectId: t.projectId, actor, data: { taskId: t.id, key: `PH-${t.number}`, title: t.title, userId } });
      }
      await publish(tx, { type: 'task.updated', organizationId: auth.organizationId, projectId: t.projectId, id: t.id });
      return row;
    });
    return c;
  }

  async deleteComment(auth: AuthInfo, commentId: string) {
    const c = (await this.ctx.db.select().from(taskComments).where(and(eq(taskComments.id, commentId), eq(taskComments.organizationId, auth.organizationId))))[0];
    if (!c) throw notFound('Yorum');
    const { scope } = await this.taskOf(auth, c.taskId);
    if (c.authorId !== auth.user.id && !scope.can('project.update')) throw forbidden('Yalnızca kendi yorumunuzu silebilirsiniz');
    await this.ctx.db.delete(taskComments).where(eq(taskComments.id, c.id));
    return { ok: true };
  }

  /** The team's activity stream (commits, pull requests, builds, deployments, tasks, comments …), newest first. */
  async activity(auth: AuthInfo, q: { projectId?: string; kind?: string; before?: Date }) {
    const visible = await this.misc.visibleProjectIds(auth);
    const ids = q.projectId ? visible.filter((id) => id === q.projectId) : visible;
    if (!ids.length) return { items: [], next: null };
    const conds: SQL[] = [inArray(projectEvents.projectId, ids)];
    if (q.kind) conds.push(eq(projectEvents.kind, q.kind as never));
    if (q.before) conds.push(lt(projectEvents.createdAt, q.before));
    const rows = await this.ctx.db
      .select({ e: projectEvents, slug: projects.slug, project: projects.name, color: projects.color })
      .from(projectEvents)
      .innerJoin(projects, eq(projects.id, projectEvents.projectId))
      .where(and(...conds))
      .orderBy(desc(projectEvents.createdAt))
      .limit(51);
    const items = rows.slice(0, 50).map((r) => ({ ...r.e, project: { slug: r.slug, name: r.project, color: r.color } }));
    return { items, next: rows.length > 50 ? items.at(-1)!.createdAt : null };
  }

  /** People, their project assignments (with role) and their open work by status. */
  async members(auth: AuthInfo) {
    const people = await this.assignablePeople(auth);
    const visible = await this.misc.visibleProjectIds(auth);
    const memberships = visible.length
      ? await this.ctx.db
          .select({ userId: projectMembers.userId, projectId: projectMembers.projectId, slug: projects.slug, name: projects.name, color: projects.color, role: roles.name })
          .from(projectMembers)
          .innerJoin(projects, eq(projects.id, projectMembers.projectId))
          .leftJoin(roles, eq(roles.id, projectMembers.roleId))
          .where(and(inArray(projectMembers.projectId, visible), ne(projects.status, 'archived')))
      : [];
    const load = visible.length
      ? await this.ctx.db
          .select({ userId: tasks.assigneeId, status: tasks.status, n: count() })
          .from(tasks)
          .where(and(inArray(tasks.projectId, visible), inArray(tasks.status, ['todo', 'in_progress', 'in_review'])))
          .groupBy(tasks.assigneeId, tasks.status)
      : [];
    const overdue = visible.length
      ? await this.ctx.db
          .select({ userId: tasks.assigneeId, n: count() })
          .from(tasks)
          .where(and(inArray(tasks.projectId, visible), inArray(tasks.status, ['todo', 'in_progress', 'in_review']), lt(tasks.dueDate, sql`CURRENT_DATE`)))
          .groupBy(tasks.assigneeId)
      : [];
    return {
      people: people.map((p) => ({
        ...p,
        projects: memberships.filter((m) => m.userId === p.id).map((m) => ({ id: m.projectId, slug: m.slug, name: m.name, color: m.color, role: m.role })),
        open: Object.fromEntries(load.filter((l) => l.userId === p.id).map((l) => [l.status, l.n])),
        overdue: overdue.find((o) => o.userId === p.id)?.n ?? 0,
      })),
      unassigned: load.filter((l) => !l.userId).reduce((a, l) => a + l.n, 0),
      canManageMembers: auth.orgPermissions.has('project.members.manage'),
    };
  }

  /* ---------------- project discussion ---------------- */

  async discussion(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const rows = await this.ctx.db.select().from(projectComments).where(eq(projectComments.projectId, scope.project.id)).orderBy(asc(projectComments.createdAt)).limit(500);
    const people = await this.userMap([...rows.map((r) => r.authorId), ...rows.flatMap((r) => r.mentions)]);
    const present = (r: (typeof rows)[number]) => ({
      id: r.id,
      body: r.body,
      at: r.createdAt,
      editedAt: r.editedAt,
      pinned: r.pinned,
      author: r.authorId ? (people.get(r.authorId) ?? null) : null,
      mentions: r.mentions.map((id) => people.get(id)).filter(Boolean),
      mine: r.authorId === auth.user.id,
    });
    const roots = rows.filter((r) => !r.parentId);
    return {
      threads: roots
        .map((r) => ({ ...present(r), replies: rows.filter((x) => x.parentId === r.id).map(present) }))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || +new Date(b.at) - +new Date(a.at)),
      canPost: scope.project.status !== 'archived',
      canModerate: scope.can('project.update'),
      people: await this.assignablePeople(auth),
    };
  }

  async postComment(auth: AuthInfo, idOrSlug: string, input: { body: string; parentId?: string; mentions: string[] }, actor: Actor) {
    const scope = await this.access.require(auth, idOrSlug);
    if (scope.project.status === 'archived') throw forbidden('Proje arşivde');
    if (input.parentId) {
      const parent = (await this.ctx.db.select().from(projectComments).where(and(eq(projectComments.id, input.parentId), eq(projectComments.projectId, scope.project.id))))[0];
      if (!parent) throw notFound('Yorum');
      if (parent.parentId) throw invalid('Yanıtlara yanıt verilemez; ana yoruma yanıt verin');
    }
    // Only people who can see the project can be mentioned (and notified).
    const mentions: string[] = [];
    for (const id of new Set(input.mentions)) if (id !== auth.user.id && (await this.access.userCanSee(auth.organizationId, scope.project.id, id))) mentions.push(id);
    const row = await this.ctx.db.transaction(async (tx) => {
      const c = (await tx.insert(projectComments).values({ organizationId: auth.organizationId, projectId: scope.project.id, parentId: input.parentId ?? null, authorId: auth.user.id, body: input.body, mentions }).returning())[0]!;
      await timeline(tx, { organizationId: auth.organizationId, projectId: scope.project.id, kind: 'project', title: input.parentId ? 'Tartışmaya yanıt yazıldı' : 'Tartışma başlatıldı', description: input.body.slice(0, 200), actorLabel: actor.label });
      for (const userId of mentions) {
        await emitDomainEvent(tx, { event: 'project.mentioned', organizationId: auth.organizationId, projectId: scope.project.id, actor, data: { commentId: c.id, userId, excerpt: input.body.slice(0, 140) } });
      }
      await publish(tx, { type: 'project.discussion', organizationId: auth.organizationId, projectId: scope.project.id, id: c.id });
      return c;
    });
    return row;
  }

  async moderateComment(auth: AuthInfo, commentId: string, action: 'delete' | 'pin' | 'unpin') {
    const c = (await this.ctx.db.select().from(projectComments).where(and(eq(projectComments.id, commentId), eq(projectComments.organizationId, auth.organizationId))))[0];
    if (!c) throw notFound('Yorum');
    const scope = await this.access.require(auth, c.projectId);
    if (action === 'delete') {
      if (c.authorId !== auth.user.id && !scope.can('project.update')) throw forbidden('Yalnızca kendi yorumunuzu silebilirsiniz');
      await this.ctx.db.delete(projectComments).where(eq(projectComments.id, c.id));
    } else {
      if (!scope.can('project.update')) throw forbidden('Sabitleme için proje yönetim yetkisi gerekir');
      if (c.parentId) throw invalid('Yalnızca ana yorumlar sabitlenebilir');
      await this.ctx.db.update(projectComments).set({ pinned: action === 'pin' }).where(eq(projectComments.id, c.id));
    }
    await publish(this.ctx.db, { type: 'project.discussion', organizationId: auth.organizationId, projectId: c.projectId, id: c.id });
    return { ok: true };
  }
}
