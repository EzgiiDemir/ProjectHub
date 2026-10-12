import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import {
  aiTasks,
  builds,
  environments,
  feedback,
  projectEvents,
  projects,
  pullRequestReviews,
  pullRequests,
  reviewSessions,
  securityFindings,
  securityScans,
  tasks,
  users,
  versions,
} from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { MiscService } from '../misc/misc.service.js';

const OUTDATED_RULE = 'dependency/outdated-major';
/** Days on the dashboard are calendar days in this time zone (the product is used in Türkiye). */
const DASHBOARD_TZ = 'Europe/Istanbul';

/**
 * Role-based home sections (spec §137–139). Each section is computed only for people whose permissions make it
 * relevant: developers (repository.push), managers (project.update) and security (security.manage).
 */
@Injectable()
export class HomeService {
  constructor(
    private readonly ctx: Ctx,
    private readonly misc: MiscService,
  ) {}

  async sections(auth: AuthInfo) {
    const ids = await this.misc.visibleProjectIds(auth);
    const can = (p: Parameters<typeof auth.orgPermissions.has>[0]) => auth.orgPermissions.has(p);
    if (!ids.length) return { work: null, management: null, security: null };
    return {
      work: can('repository.push') ? await this.work(auth, ids) : null,
      management: can('project.update') ? await this.management(ids) : null,
      security: can('security.manage') ? await this.security(ids) : null,
    };
  }

  /**
   * Dashboard insights from real activity in the projects the caller can see: daily series for the last 14 days,
   * delivery statistics for the last 30 days, environment and task status, top contributors and the activity feed.
   */
  async insights(auth: AuthInfo) {
    const ids = await this.misc.visibleProjectIds(auth);
    const days = 14;
    const tz = DASHBOARD_TZ;
    const dayList = (
      await this.ctx.db.execute<{ day: string }>(
        sql`SELECT to_char(d, 'YYYY-MM-DD') AS day FROM generate_series((now() AT TIME ZONE ${tz})::date - ${days - 1}::int, (now() AT TIME ZONE ${tz})::date, interval '1 day') AS d`,
      )
    ).rows.map((r) => r.day);
    const empty = { days: dayList, builds: [], deployments: [], commits: [], feedbackOpened: [], feedbackResolved: [] };
    if (!ids.length) {
      return { series: empty, delivery: null, environments: {}, tasks: {}, contributors: [], activity: [], security: { averageScore: null, open: {} } };
    }
    const idList = sql.join(
      ids.map((i) => sql`${i}::uuid`),
      sql`, `,
    );
    const since = sql`(now() AT TIME ZONE ${tz})::date - ${days - 1}::int`;
    const perDay = async (table: string, column: string, extra: ReturnType<typeof sql> = sql`true`, group: ReturnType<typeof sql> = sql`'all'`) =>
      (
        await this.ctx.db.execute<{ day: string; k: string; n: number }>(
          sql`SELECT to_char((${sql.raw(column)} AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day, ${group} AS k, count(*)::int AS n
              FROM ${sql.raw(table)} WHERE project_id IN (${idList}) AND (${sql.raw(column)} AT TIME ZONE ${tz})::date >= ${since} AND ${extra}
              GROUP BY 1, 2`,
        )
      ).rows;
    const builds = await perDay('builds', 'created_at', sql`true`, sql`CASE WHEN status = 'passed' THEN 'passed' WHEN status = 'failed' THEN 'failed' ELSE 'other' END`);
    const deploys = await perDay('deployments', 'created_at', sql`true`, sql`CASE WHEN status = 'succeeded' THEN 'succeeded' WHEN status IN ('failed', 'rolled_back') THEN 'failed' ELSE 'other' END`);
    const commits = await perDay('project_events', 'created_at', sql`kind = 'commit'`);
    const fbOpened = await perDay('feedback', 'created_at');
    const fbResolved = await perDay('feedback', 'resolved_at', sql`resolved_at IS NOT NULL`);

    const [delivery] = (
      await this.ctx.db.execute<{ builds: number; passed: number; failed: number; avg_ms: number | null; deploys: number; deploys_ok: number; prod_deploys: number }>(sql`
        SELECT
          (SELECT count(*)::int FROM builds WHERE project_id IN (${idList}) AND created_at >= now() - interval '30 days') AS builds,
          (SELECT count(*)::int FROM builds WHERE project_id IN (${idList}) AND created_at >= now() - interval '30 days' AND status = 'passed') AS passed,
          (SELECT count(*)::int FROM builds WHERE project_id IN (${idList}) AND created_at >= now() - interval '30 days' AND status = 'failed') AS failed,
          (SELECT round(avg(duration_ms))::int FROM builds WHERE project_id IN (${idList}) AND created_at >= now() - interval '30 days' AND status = 'passed') AS avg_ms,
          (SELECT count(*)::int FROM deployments WHERE project_id IN (${idList}) AND created_at >= now() - interval '30 days') AS deploys,
          (SELECT count(*)::int FROM deployments WHERE project_id IN (${idList}) AND created_at >= now() - interval '30 days' AND status = 'succeeded') AS deploys_ok,
          (SELECT count(*)::int FROM deployments d JOIN environments e ON e.id = d.environment_id WHERE d.project_id IN (${idList}) AND d.created_at >= now() - interval '30 days' AND d.status = 'succeeded' AND e.type = 'production') AS prod_deploys`)
    ).rows;
    const envRows = await this.ctx.db
      .select({ status: environments.status, n: count() })
      .from(environments)
      .where(and(inArray(environments.projectId, ids), eq(environments.type, 'production')))
      .groupBy(environments.status);
    const taskRows = await this.ctx.db.select({ status: tasks.status, n: count() }).from(tasks).where(inArray(tasks.projectId, ids)).groupBy(tasks.status);
    const contributors = (
      await this.ctx.db.execute<{ name: string; events: number; commits: number; builds: number; deploys: number }>(sql`
        SELECT actor_label AS name, count(*)::int AS events,
               count(*) FILTER (WHERE kind = 'commit')::int AS commits,
               count(*) FILTER (WHERE kind = 'build')::int AS builds,
               count(*) FILTER (WHERE kind = 'deploy')::int AS deploys
        FROM project_events
        WHERE project_id IN (${idList}) AND created_at >= now() - interval '30 days'
          AND actor_label NOT IN ('System', 'Sistem') AND actor_label NOT LIKE '%·%'
        GROUP BY actor_label ORDER BY count(*) DESC LIMIT 6`)
    ).rows;
    const activity = await this.ctx.db
      .select({ id: projectEvents.id, kind: projectEvents.kind, tone: projectEvents.tone, title: projectEvents.title, description: projectEvents.description, actor: projectEvents.actorLabel, at: projectEvents.createdAt, slug: projects.slug, project: projects.name, color: projects.color })
      .from(projectEvents)
      .innerJoin(projects, eq(projects.id, projectEvents.projectId))
      .where(inArray(projectEvents.projectId, ids))
      .orderBy(desc(projectEvents.createdAt))
      .limit(14);
    const [score] = await this.ctx.db.select({ avg: sql<number | null>`round(avg(${projects.securityScore}))::int` }).from(projects).where(and(inArray(projects.id, ids), eq(projects.status, 'active')));
    const openFindings = await this.ctx.db
      .select({ severity: securityFindings.severity, n: count() })
      .from(securityFindings)
      .where(and(inArray(securityFindings.projectId, ids), eq(securityFindings.status, 'open')))
      .groupBy(securityFindings.severity);

    const series = (rows: { day: string; k: string; n: number }[], keys: string[]) => Object.fromEntries(keys.map((k) => [k, dayList.map((d) => rows.find((r) => r.day === d && r.k === k)?.n ?? 0)]));
    const total = (rows: { day: string; n: number }[]) => dayList.map((d) => rows.filter((r) => r.day === d).reduce((a, r) => a + r.n, 0));
    return {
      series: {
        days: dayList,
        builds: series(builds, ['passed', 'failed', 'other']),
        deployments: series(deploys, ['succeeded', 'failed', 'other']),
        commits: total(commits),
        feedbackOpened: total(fbOpened),
        feedbackResolved: total(fbResolved),
      },
      delivery: delivery
        ? {
            builds: delivery.builds,
            buildSuccessRate: delivery.passed + delivery.failed ? Math.round((delivery.passed / (delivery.passed + delivery.failed)) * 100) : null,
            averageBuildMs: delivery.avg_ms,
            deployments: delivery.deploys,
            deploymentSuccessRate: delivery.deploys ? Math.round((delivery.deploys_ok / delivery.deploys) * 100) : null,
            productionReleases: delivery.prod_deploys,
          }
        : null,
      environments: Object.fromEntries(envRows.map((r) => [r.status, r.n])),
      tasks: Object.fromEntries(taskRows.map((r) => [r.status, r.n])),
      contributors,
      activity,
      security: { averageScore: score?.avg ?? null, open: Object.fromEntries(openFindings.map((r) => [r.severity, r.n])) },
    };
  }

  /** Developer: own pull requests, reviews waiting for them, and their recent builds and AI tasks. */
  private async work(auth: AuthInfo, ids: string[]) {
    const db = this.ctx.db;
    const me = auth.user.id;
    const myPrs = await db
      .select({ number: pullRequests.number, title: pullRequests.title, status: pullRequests.status, slug: projects.slug, project: projects.name, updatedAt: pullRequests.updatedAt })
      .from(pullRequests)
      .innerJoin(projects, eq(projects.id, pullRequests.projectId))
      .where(and(inArray(pullRequests.projectId, ids), eq(pullRequests.authorId, me), eq(pullRequests.status, 'open')))
      .orderBy(desc(pullRequests.updatedAt))
      .limit(5);
    const toReview = await db
      .select({ number: pullRequests.number, title: pullRequests.title, slug: projects.slug, project: projects.name, author: users.displayName, createdAt: pullRequests.createdAt })
      .from(pullRequests)
      .innerJoin(projects, eq(projects.id, pullRequests.projectId))
      .leftJoin(users, eq(users.id, pullRequests.authorId))
      .where(
        and(
          inArray(pullRequests.projectId, ids),
          eq(pullRequests.status, 'open'),
          sql`${pullRequests.authorId} IS DISTINCT FROM ${me}`,
          sql`NOT EXISTS (SELECT 1 FROM ${pullRequestReviews} r WHERE r.pull_request_id = ${pullRequests.id} AND r.user_id = ${me})`,
        ),
      )
      .orderBy(pullRequests.createdAt)
      .limit(5);
    const myBuilds = await db
      .select({ id: builds.id, number: builds.number, status: builds.status, branch: builds.branch, slug: projects.slug, project: projects.name, createdAt: builds.createdAt })
      .from(builds)
      .innerJoin(projects, eq(projects.id, builds.projectId))
      .where(and(inArray(builds.projectId, ids), eq(builds.triggeredBy, me), gte(builds.createdAt, new Date(Date.now() - 7 * 86400_000))))
      .orderBy(desc(builds.createdAt))
      .limit(5);
    const myAiTasks = await db
      .select({ id: aiTasks.id, number: aiTasks.number, title: aiTasks.title, status: aiTasks.status, slug: projects.slug, project: projects.name, createdAt: aiTasks.createdAt })
      .from(aiTasks)
      .innerJoin(projects, eq(projects.id, aiTasks.projectId))
      .where(and(inArray(aiTasks.projectId, ids), eq(aiTasks.requestedBy, me)))
      .orderBy(desc(aiTasks.createdAt))
      .limit(5);
    return { myPullRequests: myPrs, reviewRequests: toReview, recentBuilds: myBuilds, recentAiTasks: myAiTasks };
  }

  /** Project manager: projects at risk, releases not yet in production, open customer reviews. */
  private async management(ids: string[]) {
    const db = this.ctx.db;
    const rows = await db
      .select({ id: projects.id, name: projects.name, slug: projects.slug, healthScore: projects.healthScore })
      .from(projects)
      .where(and(inArray(projects.id, ids), eq(projects.status, 'active')));
    const lastBuild = (
      await db.execute<{ project_id: string; status: string }>(
        sql`SELECT DISTINCT ON (project_id) project_id, status FROM builds WHERE project_id IN (${sql.join(
          ids.map((i) => sql`${i}::uuid`),
          sql`, `,
        )}) ORDER BY project_id, created_at DESC`,
      )
    ).rows;
    const prodDown = await db
      .select({ projectId: environments.projectId, status: environments.status })
      .from(environments)
      .where(and(inArray(environments.projectId, ids), eq(environments.type, 'production'), inArray(environments.status, ['down', 'degraded'])));
    const critical = await db
      .select({ projectId: securityFindings.projectId, n: count() })
      .from(securityFindings)
      .where(and(inArray(securityFindings.projectId, ids), eq(securityFindings.status, 'open'), eq(securityFindings.severity, 'critical')))
      .groupBy(securityFindings.projectId);
    const atRisk = rows
      .map((p) => {
        const reasons: string[] = [];
        const down = prodDown.find((e) => e.projectId === p.id);
        if (down) reasons.push(down.status === 'down' ? 'Production erişilemiyor' : 'Production yavaş / sorunlu');
        const crit = critical.find((c) => c.projectId === p.id)?.n ?? 0;
        if (crit) reasons.push(`${crit} kritik güvenlik bulgusu`);
        if (lastBuild.find((b) => b.project_id === p.id)?.status === 'failed') reasons.push("Son build başarısız");
        if (p.healthScore !== null && p.healthScore < 70) reasons.push(`Sağlık skoru ${p.healthScore}`);
        return { ...p, reasons, weight: (down?.status === 'down' ? 100 : down ? 40 : 0) + crit * 30 + reasons.length * 10 + (100 - (p.healthScore ?? 100)) };
      })
      .filter((p) => p.reasons.length)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 6)
      .map(({ weight: _w, ...p }) => p);
    // Draft versions newer than what production runs.
    const upcoming = await db
      .select({ id: versions.id, version: versions.version, slug: projects.slug, project: projects.name, createdAt: versions.createdAt, migrations: versions.migrations })
      .from(versions)
      .innerJoin(projects, eq(projects.id, versions.projectId))
      .where(
        and(
          inArray(versions.projectId, ids),
          eq(versions.status, 'draft'),
          gte(versions.createdAt, new Date(Date.now() - 60 * 86400_000)),
          sql`${versions.createdAt} > COALESCE((SELECT v2.created_at FROM environments e JOIN versions v2 ON v2.id = e.current_version_id WHERE e.project_id = ${versions.projectId} AND e.type = 'production' LIMIT 1), '-infinity')`,
        ),
      )
      .orderBy(desc(versions.createdAt))
      .limit(6);
    const reviews = await db
      .select({ id: reviewSessions.id, name: reviewSessions.name, versionLabel: reviewSessions.versionLabel, slug: projects.slug, project: projects.name, expiresAt: reviewSessions.expiresAt, lastAccessAt: reviewSessions.lastAccessAt, openFeedback: sql<number>`(SELECT count(*)::int FROM ${feedback} f WHERE f.review_session_id = ${reviewSessions.id} AND f.status NOT IN ('resolved', 'rejected'))` })
      .from(reviewSessions)
      .innerJoin(projects, eq(projects.id, reviewSessions.projectId))
      .where(and(inArray(reviewSessions.projectId, ids), isNull(reviewSessions.revokedAt), gte(reviewSessions.expiresAt, new Date())))
      .orderBy(desc(reviewSessions.createdAt))
      .limit(6);
    return { projectsAtRisk: atRisk, upcomingReleases: upcoming.map(({ migrations, ...v }) => ({ ...v, migrations: migrations.length, highRiskMigrations: migrations.filter((m) => m.risk === 'high').length })), customerReviews: reviews };
  }

  /** Security: new secrets, dependency risk per project, accepted-risk exceptions and the score trend. */
  private async security(ids: string[]) {
    const db = this.ctx.db;
    const week = new Date(Date.now() - 7 * 86400_000);
    const newSecrets = await db
      .select({ id: securityFindings.id, number: securityFindings.number, title: securityFindings.title, filePath: securityFindings.filePath, slug: projects.slug, project: projects.name, firstSeenAt: securityFindings.firstSeenAt })
      .from(securityFindings)
      .innerJoin(projects, eq(projects.id, securityFindings.projectId))
      .where(and(inArray(securityFindings.projectId, ids), eq(securityFindings.type, 'secret'), eq(securityFindings.status, 'open'), gte(securityFindings.firstSeenAt, week)))
      .orderBy(desc(securityFindings.firstSeenAt))
      .limit(6);
    const dependencyRisk = await db
      .select({
        slug: projects.slug,
        project: projects.name,
        critical: sql<number>`count(*) FILTER (WHERE ${securityFindings.severity} = 'critical')::int`,
        high: sql<number>`count(*) FILTER (WHERE ${securityFindings.severity} = 'high')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(securityFindings)
      .innerJoin(projects, eq(projects.id, securityFindings.projectId))
      .where(and(inArray(securityFindings.projectId, ids), eq(securityFindings.type, 'dependency'), eq(securityFindings.status, 'open'), ne(securityFindings.ruleId, OUTDATED_RULE)))
      .groupBy(projects.slug, projects.name)
      .orderBy(sql`count(*) FILTER (WHERE ${securityFindings.severity} = 'critical') DESC`, sql`count(*) DESC`)
      .limit(6);
    // Accepted risks and false positives are exceptions a security owner should re-check periodically.
    const exceptions = await db
      .select({ id: securityFindings.id, number: securityFindings.number, title: securityFindings.title, status: securityFindings.status, severity: securityFindings.severity, reason: securityFindings.statusReason, by: users.displayName, slug: projects.slug, project: projects.name, updatedAt: securityFindings.updatedAt })
      .from(securityFindings)
      .innerJoin(projects, eq(projects.id, securityFindings.projectId))
      .leftJoin(users, eq(users.id, securityFindings.statusChangedBy))
      .where(and(inArray(securityFindings.projectId, ids), inArray(securityFindings.status, ['accepted', 'false_positive']), notInArray(securityFindings.severity, ['info', 'low'])))
      .orderBy(desc(securityFindings.updatedAt))
      .limit(6);
    // Average score of each project's last scan per ISO week, last 8 weeks.
    const trend = (
      await db.execute<{ week: string; score: number; scans: number }>(sql`
        SELECT to_char(date_trunc('week', finished_at), 'YYYY-MM-DD') AS week, round(avg(score))::int AS score, count(*)::int AS scans
        FROM ${securityScans}
        WHERE project_id IN (${sql.join(
          ids.map((i) => sql`${i}::uuid`),
          sql`, `,
        )}) AND status = 'completed' AND score IS NOT NULL AND finished_at >= now() - interval '8 weeks'
        GROUP BY 1 ORDER BY 1`)
    ).rows;
    const [openCritical] = await db.select({ n: count() }).from(securityFindings).where(and(inArray(securityFindings.projectId, ids), eq(securityFindings.status, 'open'), eq(securityFindings.severity, 'critical')));
    const [staleScans] = await db
      .select({ n: count() })
      .from(projects)
      .where(and(inArray(projects.id, ids), eq(projects.status, 'active'), sql`NOT EXISTS (SELECT 1 FROM ${securityScans} s WHERE s.project_id = ${projects.id} AND s.status = 'completed' AND s.finished_at >= ${week})`));
    return { openCritical: openCritical?.n ?? 0, projectsWithoutRecentScan: staleScans?.n ?? 0, newSecrets, dependencyRisk, exceptions, trend };
  }
}
