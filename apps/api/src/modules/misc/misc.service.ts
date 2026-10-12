import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, inArray, isNull, or, sql, type AnyColumn } from 'drizzle-orm';
import { OPEN_FEEDBACK_STATUSES } from '@projecthub/contracts';
import { ai, audit, emitDomainEvent, enqueue, getOrgSettings, nextNumber, notFound, precondition, publish, QUEUES, timeline, type Actor } from '@projecthub/core';
import {
  aiRemediations,
  aiTasks,
  builds,
  deploymentApprovals,
  deployments,
  environments,
  feedback,
  healthChecks,
  incidents,
  notifications,
  previews,
  projectEvents,
  projects,
  reviewSessions,
  securityFindings,
  tasks,
  users,
  versions,
} from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';

@Injectable()
export class MiscService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
  ) {}

  /** Project ids the user can see (members, or everything with project.read.all). */
  async visibleProjectIds(auth: AuthInfo): Promise<string[]> {
    const rows = auth.orgPermissions.has('project.read.all')
      ? await this.ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.organizationId, auth.organizationId))
      : await this.ctx.db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.organizationId, auth.organizationId), sql`${projects.id} IN (SELECT project_id FROM project_members WHERE user_id = ${auth.user.id})`));
    return rows.map((r) => r.id);
  }

  /* ---------------- notifications ---------------- */

  async notifications(auth: AuthInfo) {
    const items = await this.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, auth.user.id), eq(notifications.organizationId, auth.organizationId)))
      .orderBy(desc(notifications.createdAt))
      .limit(50);
    const unread = await this.ctx.db.select({ n: count() }).from(notifications).where(and(eq(notifications.userId, auth.user.id), isNull(notifications.readAt)));
    return { items, unread: unread[0]?.n ?? 0 };
  }

  async markRead(auth: AuthInfo, ids: string[] | null) {
    const conds = [eq(notifications.userId, auth.user.id), isNull(notifications.readAt)];
    if (ids?.length) conds.push(inArray(notifications.id, ids));
    await this.ctx.db.update(notifications).set({ readAt: new Date() }).where(and(...conds));
  }

  /* ---------------- home dashboard ---------------- */

  /** Personal home (spec §137–139): KPIs, "needs your attention", project health, recent deployments. */
  async home(auth: AuthInfo) {
    const db = this.ctx.db;
    const ids = await this.visibleProjectIds(auth);
    const none = ids.length === 0;
    const inIds = (col: AnyColumn) => (none ? sql`false` : inArray(col, ids));
    const since24h = new Date(Date.now() - 86400_000);
    const [failedBuilds] = await db.select({ n: count() }).from(builds).where(and(inIds(builds.projectId), eq(builds.status, 'failed'), gte(builds.createdAt, since24h)));
    const [runningPreviews] = await db.select({ n: count() }).from(previews).where(and(inIds(previews.projectId), eq(previews.status, 'ready')));
    const [criticalFindings] = await db.select({ n: count() }).from(securityFindings).where(and(inIds(securityFindings.projectId), eq(securityFindings.status, 'open'), eq(securityFindings.severity, 'critical')));
    const [openFeedback] = await db.select({ n: count() }).from(feedback).where(and(inIds(feedback.projectId), inArray(feedback.status, OPEN_FEEDBACK_STATUSES)));
    const [activeReviews] = await db.select({ n: count() }).from(reviewSessions).where(and(inIds(reviewSessions.projectId), isNull(reviewSessions.revokedAt), gte(reviewSessions.expiresAt, new Date())));
    const [activeProjects] = await db.select({ n: count() }).from(projects).where(and(inIds(projects.id), sql`${projects.status} <> 'archived'`));

    const attention: { kind: string; title: string; detail: string; link: string; tone: 'bad' | 'warn' | 'run' }[] = [];
    if (!none) {
      const myFeedback = await db
        .select({ f: feedback, slug: projects.slug, pname: projects.name })
        .from(feedback)
        .innerJoin(projects, eq(projects.id, feedback.projectId))
        .where(and(inIds(feedback.projectId), eq(feedback.assignedUserId, auth.user.id), inArray(feedback.status, OPEN_FEEDBACK_STATUSES)))
        .orderBy(desc(feedback.createdAt))
        .limit(10);
      for (const r of myFeedback) attention.push({ kind: 'feedback', title: `FB-${r.f.number}: ${r.f.title}`, detail: `${r.pname} · size atanmış`, link: `/projects/${r.slug}/feedback/${r.f.id}`, tone: r.f.priority === 'high' || r.f.priority === 'critical' ? 'bad' : 'warn' });
      const unassigned = await db
        .select({ n: count(), slug: projects.slug, pname: projects.name })
        .from(feedback)
        .innerJoin(projects, eq(projects.id, feedback.projectId))
        .where(and(inIds(feedback.projectId), isNull(feedback.assignedUserId), inArray(feedback.status, ['open', 'triaged'])))
        .groupBy(projects.slug, projects.name);
      for (const u of unassigned) attention.push({ kind: 'feedback', title: `${u.n} kullanıcı geri bildirimi atanmayı bekliyor`, detail: u.pname, link: `/projects/${u.slug}/feedback`, tone: 'warn' });
      const pendingDeploys = await db
        .select({ d: deployments, env: environments.name, envType: environments.type, slug: projects.slug, pname: projects.name, v: versions.version })
        .from(deployments)
        .innerJoin(environments, eq(environments.id, deployments.environmentId))
        .innerJoin(projects, eq(projects.id, deployments.projectId))
        .innerJoin(versions, eq(versions.id, deployments.versionId))
        .where(and(inIds(deployments.projectId), eq(deployments.status, 'pending_approval')));
      for (const r of pendingDeploys) {
        if (r.d.requestedBy === auth.user.id) continue;
        const already = await db.select({ id: deploymentApprovals.id }).from(deploymentApprovals).where(and(eq(deploymentApprovals.deploymentId, r.d.id), eq(deploymentApprovals.userId, auth.user.id)));
        if (already.length) continue;
        try {
          const scope = await this.access.require(auth, r.d.projectId);
          if (!scope.can('deployment.approve')) continue;
        } catch {
          continue;
        }
        attention.push({ kind: 'deployment', title: `D-${r.d.number} onayınızı bekliyor`, detail: `${r.pname} · v${r.v} → ${r.env}`, link: `/projects/${r.slug}/deployments/${r.d.id}`, tone: r.envType === 'production' ? 'bad' : 'warn' });
      }
      const aiWaiting = await db
        .select({ t: aiTasks, slug: projects.slug, pname: projects.name })
        .from(aiTasks)
        .innerJoin(projects, eq(projects.id, aiTasks.projectId))
        .where(and(inIds(aiTasks.projectId), eq(aiTasks.status, 'awaiting_approval')))
        .limit(10);
      for (const r of aiWaiting) attention.push({ kind: 'ai', title: `AI-${r.t.number} onay bekliyor`, detail: `${r.pname} · ${r.t.title}`, link: `/projects/${r.slug}/ai/tasks/${r.t.id}`, tone: 'run' });
      const myFailed = await db
        .select({ b: builds, slug: projects.slug, pname: projects.name })
        .from(builds)
        .innerJoin(projects, eq(projects.id, builds.projectId))
        .where(and(inIds(builds.projectId), eq(builds.status, 'failed'), eq(builds.triggeredBy, auth.user.id), gte(builds.createdAt, since24h)))
        .orderBy(desc(builds.createdAt))
        .limit(5);
      for (const r of myFailed) attention.push({ kind: 'build', title: `Build #${r.b.number} başarısız`, detail: `${r.pname} · ${r.b.error?.message ?? ''}`.slice(0, 160), link: `/projects/${r.slug}/builds/${r.b.id}`, tone: 'bad' });
      const crit = await db
        .select({ f: securityFindings, slug: projects.slug, pname: projects.name })
        .from(securityFindings)
        .innerJoin(projects, eq(projects.id, securityFindings.projectId))
        .where(and(inIds(securityFindings.projectId), eq(securityFindings.status, 'open'), eq(securityFindings.severity, 'critical')))
        .limit(5);
      for (const r of crit) attention.push({ kind: 'security', title: `SEC-${r.f.number} kritik: ${r.f.title}`, detail: `${r.pname}${r.f.filePath ? ` · ${r.f.filePath}` : ''}`, link: `/projects/${r.slug}/security`, tone: 'bad' });
      const myTasks = await db
        .select({ t: tasks, slug: projects.slug, pname: projects.name })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(inIds(tasks.projectId), eq(tasks.assigneeId, auth.user.id), inArray(tasks.status, ['todo', 'in_progress'])))
        .limit(10);
      for (const r of myTasks) attention.push({ kind: 'task', title: `PH-${r.t.number}: ${r.t.title}`, detail: `${r.pname}${r.t.isHotfix ? ' · hotfix' : ''}`, link: `/projects/${r.slug}/tasks`, tone: r.t.isHotfix ? 'bad' : 'run' });
    }

    const projectRows = none
      ? []
      : await db
          .select({ p: projects })
          .from(projects)
          .where(and(inIds(projects.id), sql`${projects.status} <> 'archived'`))
          .orderBy(desc(projects.updatedAt))
          .limit(30);
    const lastBuildStatus = none
      ? []
      : (await db.execute<{ project_id: string; status: string }>(sql`SELECT DISTINCT ON (project_id) project_id, status FROM builds WHERE project_id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) ORDER BY project_id, created_at DESC`)).rows;
    const prodStatus = none ? [] : await db.select({ projectId: environments.projectId, status: environments.status }).from(environments).where(and(inIds(environments.projectId), eq(environments.type, 'production')));
    const recentDeployments = none
      ? []
      : await db
          .select({ d: deployments, env: environments.name, v: versions.version, slug: projects.slug, pname: projects.name, by: users.displayName })
          .from(deployments)
          .innerJoin(environments, eq(environments.id, deployments.environmentId))
          .innerJoin(versions, eq(versions.id, deployments.versionId))
          .innerJoin(projects, eq(projects.id, deployments.projectId))
          .leftJoin(users, eq(users.id, deployments.requestedBy))
          .where(inIds(deployments.projectId))
          .orderBy(desc(deployments.createdAt))
          .limit(6);
    return {
      kpis: {
        activeProjects: activeProjects?.n ?? 0,
        runningPreviews: runningPreviews?.n ?? 0,
        failedBuilds24h: failedBuilds?.n ?? 0,
        criticalFindings: criticalFindings?.n ?? 0,
        openFeedback: openFeedback?.n ?? 0,
        activeReviews: activeReviews?.n ?? 0,
      },
      attention,
      projects: projectRows.map(({ p }) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        color: p.color,
        status: p.status,
        healthScore: p.healthScore,
        securityScore: p.securityScore,
        currentVersion: p.currentVersion,
        lastBuildStatus: lastBuildStatus.find((b) => b.project_id === p.id)?.status ?? null,
        productionStatus: prodStatus.find((e) => e.projectId === p.id)?.status ?? null,
      })),
      recentDeployments: recentDeployments.map((r) => ({ id: r.d.id, key: `D-${r.d.number}`, status: r.d.status, createdAt: r.d.createdAt, environment: r.env, version: r.v, projectSlug: r.slug, projectName: r.pname, by: r.d.requestedByType === 'ai' ? 'AI Asistan' : r.by })),
    };
  }

  /* ---------------- universal search (spec §40, §136) ---------------- */

  async search(auth: AuthInfo, q: string, limit: number) {
    const db = this.ctx.db;
    const ids = await this.visibleProjectIds(auth);
    if (!ids.length) return { projects: [], feedback: [], code: [], builds: [], deployments: [], tasks: [], findings: [] };
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const terms = q.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length >= 2).slice(0, 6);
    const tsq = terms.map((t) => `${t}:*`).join(' & ');
    const projectRows = await db
      .select({ id: projects.id, name: projects.name, slug: projects.slug, color: projects.color, status: projects.status, customerName: projects.customerName })
      .from(projects)
      .where(and(inArray(projects.id, ids), or(sql`${projects.name} ILIKE ${like}`, sql`${projects.customerName} ILIKE ${like}`, sql`${projects.description} ILIKE ${like}`, sql`${projects.technologies}::text ILIKE ${like}`)))
      .limit(limit);
    const slugOf = new Map((await db.select({ id: projects.id, slug: projects.slug, name: projects.name }).from(projects).where(inArray(projects.id, ids))).map((p) => [p.id, p]));
    const fb = await db
      .select({ id: feedback.id, number: feedback.number, title: feedback.title, status: feedback.status, projectId: feedback.projectId })
      .from(feedback)
      .where(and(inArray(feedback.projectId, ids), or(sql`${feedback.title} ILIKE ${like}`, tsq ? sql`to_tsvector('simple', ${feedback.title} || ' ' || ${feedback.body}) @@ to_tsquery('simple', ${tsq})` : sql`false`, /^fb-\d+$/i.test(q) ? eq(feedback.number, Number(q.slice(3))) : sql`false`)))
      .orderBy(desc(feedback.createdAt))
      .limit(limit);
    const code = tsq
      ? (
          await db.execute<{ project_id: string; path: string; start_line: number; content: string }>(sql`
            SELECT project_id, path, start_line, content FROM code_chunks
            WHERE project_id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) AND search_vector @@ to_tsquery('simple', ${tsq})
            ORDER BY ts_rank_cd(search_vector, to_tsquery('simple', ${tsq})) DESC LIMIT ${limit}`)
        ).rows.map((r) => {
          const lines = r.content.split('\n');
          const i = Math.max(0, lines.findIndex((l) => terms.some((t) => l.toLowerCase().includes(t))));
          return { projectId: r.project_id, projectSlug: slugOf.get(r.project_id)?.slug, projectName: slugOf.get(r.project_id)?.name, path: r.path, line: r.start_line + i, snippet: (lines[i] ?? '').trim().slice(0, 200) };
        })
      : [];
    const buildRows = await db
      .select({ id: builds.id, number: builds.number, branch: builds.branch, status: builds.status, commitMessage: builds.commitMessage, projectId: builds.projectId })
      .from(builds)
      .where(and(inArray(builds.projectId, ids), or(sql`${builds.branch} ILIKE ${like}`, sql`${builds.commitMessage} ILIKE ${like}`, sql`${builds.commitSha} ILIKE ${`${q}%`}`)))
      .orderBy(desc(builds.createdAt))
      .limit(limit);
    const dep = await db
      .select({ id: deployments.id, number: deployments.number, status: deployments.status, projectId: deployments.projectId, version: versions.version, env: environments.name })
      .from(deployments)
      .innerJoin(versions, eq(versions.id, deployments.versionId))
      .innerJoin(environments, eq(environments.id, deployments.environmentId))
      .where(and(inArray(deployments.projectId, ids), or(sql`${versions.version} ILIKE ${like}`, sql`${environments.name} ILIKE ${like}`, /^d-\d+$/i.test(q) ? eq(deployments.number, Number(q.slice(2))) : sql`false`)))
      .orderBy(desc(deployments.createdAt))
      .limit(limit);
    const taskRows = await db
      .select({ id: tasks.id, number: tasks.number, title: tasks.title, status: tasks.status, projectId: tasks.projectId })
      .from(tasks)
      .where(and(inArray(tasks.projectId, ids), or(sql`${tasks.title} ILIKE ${like}`, /^ph-\d+$/i.test(q) ? eq(tasks.number, Number(q.slice(3))) : sql`false`)))
      .limit(limit);
    const findingRows = await db
      .select({ id: securityFindings.id, number: securityFindings.number, title: securityFindings.title, severity: securityFindings.severity, status: securityFindings.status, projectId: securityFindings.projectId })
      .from(securityFindings)
      .where(and(inArray(securityFindings.projectId, ids), or(sql`${securityFindings.title} ILIKE ${like}`, sql`${securityFindings.packageName} ILIKE ${like}`, /^sec-\d+$/i.test(q) ? eq(securityFindings.number, Number(q.slice(4))) : sql`false`)))
      .limit(limit);
    const withProject = <T extends { projectId: string }>(rows: T[]) => rows.map((r) => ({ ...r, projectSlug: slugOf.get(r.projectId)?.slug, projectName: slugOf.get(r.projectId)?.name }));
    return {
      projects: projectRows,
      feedback: withProject(fb).map((f) => ({ ...f, key: `FB-${f.number}` })),
      code,
      builds: withProject(buildRows),
      deployments: withProject(dep).map((d) => ({ ...d, key: `D-${d.number}` })),
      tasks: withProject(taskRows).map((t) => ({ ...t, key: `PH-${t.number}` })),
      findings: withProject(findingRows).map((f) => ({ ...f, key: `SEC-${f.number}` })),
    };
  }

  /* ---------------- incidents & health ---------------- */

  async incidents(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    return this.ctx.db
      .select({ i: incidents, env: environments.name })
      .from(incidents)
      .leftJoin(environments, eq(environments.id, incidents.environmentId))
      .where(eq(incidents.projectId, scope.project.id))
      .orderBy(desc(incidents.startedAt))
      .limit(100)
      .then((r) => r.map((x) => ({ ...x.i, key: `INC-${x.i.number}`, environmentName: x.env })));
  }

  async incident(auth: AuthInfo, incidentId: string) {
    const i = (await this.ctx.db.select().from(incidents).where(and(eq(incidents.id, incidentId), eq(incidents.organizationId, auth.organizationId))))[0];
    if (!i) throw notFound('Olay');
    await this.access.require(auth, i.projectId);
    const events = await this.ctx.db
      .select()
      .from(projectEvents)
      .where(and(eq(projectEvents.projectId, i.projectId), gte(projectEvents.createdAt, new Date(i.startedAt.getTime() - 3600_000)), i.resolvedAt ? sql`${projectEvents.createdAt} <= ${new Date(i.resolvedAt.getTime() + 600_000)}` : sql`true`))
      .orderBy(projectEvents.createdAt)
      .limit(200);
    const checks = i.environmentId
      ? await this.ctx.db.select().from(healthChecks).where(and(eq(healthChecks.environmentId, i.environmentId), gte(healthChecks.checkedAt, new Date(i.startedAt.getTime() - 3600_000)))).orderBy(desc(healthChecks.checkedAt)).limit(120)
      : [];
    const remediations = await this.ctx.db.select().from(aiRemediations).where(eq(aiRemediations.incidentId, i.id)).orderBy(desc(aiRemediations.createdAt)).limit(50);
    return { ...i, key: `INC-${i.number}`, timeline: events, healthChecks: checks, remediations };
  }

  async requestRemediation(auth: AuthInfo, incidentId: string, actor: Actor) {
    const i = (await this.ctx.db.select().from(incidents).where(and(eq(incidents.id, incidentId), eq(incidents.organizationId, auth.organizationId))))[0];
    if (!i) throw notFound('Olay');
    await this.access.requireWritable(auth, i.projectId, 'environment.manage');
    await this.access.require(auth, i.projectId, 'ai.execute');
    if (i.status !== 'open' || i.source !== 'monitor' || !i.environmentId) throw precondition('Yalnızca açık izleme olaylarında sağlık kontrolü tekrarlanabilir');
    const { ai: settings } = await getOrgSettings(this.ctx.db, auth.organizationId);
    if (!settings.selfHealing.enabled) throw precondition('Kontrollü kendini iyileştirme organizasyon ayarlarında kapalı');
    if (settings.selfHealing.emergencyStop) throw precondition('Kendini iyileştirme acil durdurması etkin');
    const [recent] = await this.ctx.db.select({ n: count() }).from(aiRemediations).where(and(eq(aiRemediations.organizationId, auth.organizationId), gte(aiRemediations.createdAt, new Date(Date.now() - 3600_000))));
    if ((recent?.n ?? 0) >= settings.selfHealing.maxAttemptsPerHour) throw precondition(`Saatlik iyileştirme sınırı doldu (${settings.selfHealing.maxAttemptsPerHour})`);
    const row = await this.ctx.db.transaction(async (tx) => {
      const attempt = (await tx.select({ n: count() }).from(aiRemediations).where(eq(aiRemediations.incidentId, i.id)))[0]?.n ?? 0;
      const remediation = (
        await tx
          .insert(aiRemediations)
          .values({ organizationId: auth.organizationId, projectId: i.projectId, incidentId: i.id, action: 'recheck_health', riskLevel: 'low', trigger: 'manual', diagnosis: 'İzleme olayı için değişiklik yapmadan HTTP sağlık kontrolünü tekrar çalıştır.', attempt: attempt + 1, requestedBy: auth.user.id })
          .returning()
      )[0]!;
      await enqueue(tx, { queue: QUEUES.ai, type: 'ai.remediation.run', organizationId: auth.organizationId, projectId: i.projectId, maxAttempts: 1, dedupeKey: `remediation:${remediation.id}`, payload: { remediationId: remediation.id } });
      await audit(tx, { organizationId: auth.organizationId, projectId: i.projectId, actor, action: 'ai.remediation.requested', resourceType: 'ai_remediation', resourceId: remediation.id, metadata: { incidentId: i.id, action: remediation.action, risk: remediation.riskLevel } });
      return remediation;
    });
    return row;
  }

  async openIncident(auth: AuthInfo, idOrSlug: string, input: { title: string; severity: 'critical' | 'high' | 'medium' | 'low'; environmentId?: string | null }, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'environment.manage');
    const row = await this.ctx.db.transaction(async (tx) => {
      const number = await nextNumber(tx, auth.organizationId, 'incident');
      const i = (await tx.insert(incidents).values({ organizationId: auth.organizationId, projectId: scope.project.id, environmentId: input.environmentId ?? null, number, title: input.title, severity: input.severity, source: 'manual' }).returning())[0]!;
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'incident.opened', resourceType: 'incident', resourceId: i.id });
      await timeline(tx, { organizationId: auth.organizationId, projectId: scope.project.id, kind: 'incident', tone: 'bad', title: `INC-${number} açıldı: ${input.title}`, actorLabel: actor.label, refType: 'incident', refId: i.id });
      await emitDomainEvent(tx, { event: 'incident.opened', organizationId: auth.organizationId, projectId: scope.project.id, actor, data: { incidentId: i.id, title: input.title } });
      return i;
    });
    return { ...row, key: `INC-${row.number}` };
  }

  async updateIncident(auth: AuthInfo, incidentId: string, input: { status?: 'open' | 'resolved'; rootCause?: string; postmortem?: string }, actor: Actor) {
    const i = (await this.ctx.db.select().from(incidents).where(and(eq(incidents.id, incidentId), eq(incidents.organizationId, auth.organizationId))))[0];
    if (!i) throw notFound('Olay');
    await this.access.requireWritable(auth, i.projectId, 'environment.manage');
    const resolving = input.status === 'resolved' && i.status !== 'resolved';
    await this.ctx.db.transaction(async (tx) => {
      await tx.update(incidents).set({ ...input, resolvedAt: resolving ? new Date() : input.status === 'open' ? null : i.resolvedAt }).where(eq(incidents.id, i.id));
      await audit(tx, { organizationId: auth.organizationId, projectId: i.projectId, actor, action: resolving ? 'incident.resolved' : 'incident.updated', resourceType: 'incident', resourceId: i.id });
      if (resolving) {
        await timeline(tx, { organizationId: auth.organizationId, projectId: i.projectId, kind: 'incident', tone: 'ok', title: `INC-${i.number} çözüldü`, description: input.rootCause ?? '', actorLabel: actor.label, refType: 'incident', refId: i.id });
        await emitDomainEvent(tx, { event: 'incident.resolved', organizationId: auth.organizationId, projectId: i.projectId, actor, data: { incidentId: i.id, title: i.title } });
      }
      await publish(tx, { type: 'incident.updated', organizationId: auth.organizationId, projectId: i.projectId, id: i.id });
    });
    return this.incident(auth, incidentId);
  }

  /** Spec §87: AI drafts the postmortem from the incident timeline; a human edits and saves it. */
  async draftPostmortem(auth: AuthInfo, incidentId: string) {
    const detail = await this.incident(auth, incidentId);
    await this.access.require(auth, detail.projectId, 'ai.execute');
    const resolved = await ai.resolveAi(this.ctx.db, this.ctx.config, auth.organizationId, { minLevel: 'L1', projectId: detail.projectId });
    await ai.assertBudget(this.ctx.db, auth.organizationId, resolved.settings);
    const run = await ai.startRun(this.ctx.db, { organizationId: auth.organizationId, projectId: detail.projectId, purpose: 'postmortem', provider: resolved.provider, userId: auth.user.id });
    try {
      const res = await resolved.provider.complete({
        system: 'Write a blameless incident postmortem in Turkish markdown with these sections: Ne oldu, Etki, Kök neden, Çözüm, Önleme, Takip görevleri. Use only facts from the given timeline and health checks; mark assumptions explicitly.',
        messages: [
          {
            role: 'user',
            content: `Olay ${detail.key}: ${detail.title} (önem: ${detail.severity})\nBaşlangıç: ${detail.startedAt.toISOString()} · Bitiş: ${detail.resolvedAt?.toISOString() ?? 'devam ediyor'}\nKök neden notu: ${detail.rootCause ?? '-'}\n\nZaman akışı:\n${detail.timeline.map((e) => `- ${e.createdAt.toISOString()} [${e.kind}] ${e.title} ${e.description}`).join('\n')}\n\nSağlık kontrolleri (en yeni önce):\n${detail.healthChecks.slice(0, 40).map((h) => `- ${h.checkedAt.toISOString()} ${h.ok ? 'OK' : 'HATA'} ${h.httpStatus ?? ''} ${h.latencyMs ?? ''}ms ${h.error ?? ''}`).join('\n')}`,
          },
        ],
        maxTokens: 6000,
      });
      await run.finish(res.usage);
      if (res.refused) throw precondition('AI bu taslağı oluşturamadı');
      return { draft: res.text };
    } catch (e) {
      await run.finish({ inputTokens: 0, outputTokens: 0 }, (e as Error).message);
      throw e;
    }
  }

  async healthChecks(auth: AuthInfo, idOrSlug: string, environmentId: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const env = (await this.ctx.db.select().from(environments).where(and(eq(environments.id, environmentId), eq(environments.projectId, scope.project.id))))[0];
    if (!env) throw notFound('Ortam');
    return this.ctx.db.select().from(healthChecks).where(eq(healthChecks.environmentId, env.id)).orderBy(desc(healthChecks.checkedAt)).limit(288);
  }
}
