import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { enqueue, publish, QUEUES, scan, type JobContext } from '@projecthub/core';
import { builds, codeChunks, codeFiles, deployments, incidents, projects, securityFindings, securityScans } from '@projecthub/database';
import { commitSnapshot, loadProject, openRepo, type WorkerCtx } from '../context.js';

/**
 * Incremental code index for the AI Project Brain and code search: only files whose blob changed are
 * re-chunked. Also collects technical-debt signals for the project overview.
 */
export async function indexCode(ctx: WorkerCtx, { job, logger }: JobContext) {
  const { projectId } = job.payload as { projectId: string };
  const project = await loadProject(ctx, projectId);
  const { git } = await openRepo(ctx, projectId);
  const head = await git.resolve(`refs/heads/${project.defaultBranch}`);
  if (!head) return { skipped: 'empty repository' };
  const snap = await commitSnapshot(git, head);
  const indexable = snap.entries.filter((f) => scan.isIndexable(f.path, f.size));
  const existing = new Map((await ctx.db.select({ path: codeFiles.path, blobSha: codeFiles.blobSha }).from(codeFiles).where(eq(codeFiles.projectId, projectId))).map((r) => [r.path, r.blobSha]));
  const changed = indexable.filter((f) => existing.get(f.path) !== f.sha);
  const keep = new Set(indexable.map((f) => f.path));
  const removed = [...existing.keys()].filter((p) => !keep.has(p));

  await snap.preload(indexable.map((f) => f.path));
  const stats = scan.emptyStats();
  for (const f of indexable) {
    const text = await snap.read(f.path);
    if (text !== null) scan.accumulateStats(stats, f.path, text);
  }
  if (snap.paths.some((p) => /^readme(\.|$)/i.test(p))) stats.hasReadme = true;

  for (let i = 0; i < changed.length; i += 100) {
    const batch = changed.slice(i, i + 100);
    await ctx.db.transaction(async (tx) => {
      await tx.delete(codeChunks).where(and(eq(codeChunks.projectId, projectId), inArray(codeChunks.path, batch.map((b) => b.path))));
      const chunkRows: (typeof codeChunks.$inferInsert)[] = [];
      for (const f of batch) {
        const text = await snap.read(f.path);
        if (text === null) continue;
        for (const c of scan.chunkFile(text)) chunkRows.push({ projectId, path: f.path, startLine: c.startLine, endLine: c.endLine, content: c.content.replace(/\u0000/g, '') });
        await tx
          .insert(codeFiles)
          .values({ projectId, path: f.path, blobSha: f.sha, language: scan.languageOf(f.path), lines: text.split('\n').length, symbols: scan.extractSymbols(text), indexedCommit: head })
          .onConflictDoUpdate({
            target: [codeFiles.projectId, codeFiles.path],
            set: { blobSha: f.sha, language: scan.languageOf(f.path), lines: text.split('\n').length, symbols: scan.extractSymbols(text), indexedCommit: head },
          });
      }
      for (let j = 0; j < chunkRows.length; j += 500) await tx.insert(codeChunks).values(chunkRows.slice(j, j + 500));
    });
  }
  if (removed.length) {
    await ctx.db.delete(codeChunks).where(and(eq(codeChunks.projectId, projectId), inArray(codeChunks.path, removed)));
    await ctx.db.delete(codeFiles).where(and(eq(codeFiles.projectId, projectId), inArray(codeFiles.path, removed)));
  }
  await ctx.db.update(codeFiles).set({ indexedCommit: head }).where(eq(codeFiles.projectId, projectId));

  const techDebt = {
    ...stats,
    level: stats.todo + stats.longFunctions * 3 + stats.largeFiles * 2 > 60 ? 'high' : stats.todo + stats.longFunctions * 3 + stats.largeFiles * 2 > 20 ? 'medium' : 'low',
    commit: head,
    computedAt: new Date().toISOString(),
  };
  await ctx.db
    .update(projects)
    .set({ settings: sql`jsonb_set(${projects.settings}, '{techDebt}', ${JSON.stringify(techDebt)}::jsonb, true)` })
    .where(eq(projects.id, projectId));
  await enqueue(ctx.db, { queue: QUEUES.maintenance, type: 'project.health', projectId, organizationId: project.organizationId, dedupeKey: `health:${projectId}`, payload: { projectId } });
  logger.info({ projectId, indexed: changed.length, removed: removed.length, total: indexable.length }, 'code index updated');
  return { indexed: changed.length, removed: removed.length, total: indexable.length };
}

/** Recomputes the project health score shown on dashboards (a management signal, not a measurement). */
export async function recomputeHealth(ctx: WorkerCtx, { job }: JobContext) {
  const { projectId } = job.payload as { projectId: string };
  const project = await loadProject(ctx, projectId);
  const db = ctx.db;
  const lastScan = (await db.select().from(securityScans).where(and(eq(securityScans.projectId, projectId), eq(securityScans.status, 'completed'))).orderBy(desc(securityScans.createdAt)).limit(1))[0];
  const recentBuilds = await db.select({ status: builds.status }).from(builds).where(and(eq(builds.projectId, projectId), inArray(builds.status, ['passed', 'failed']))).orderBy(desc(builds.createdAt)).limit(20);
  const recentDeploys = await db.select({ status: deployments.status }).from(deployments).where(and(eq(deployments.projectId, projectId), inArray(deployments.status, ['succeeded', 'failed', 'rolled_back']))).orderBy(desc(deployments.createdAt)).limit(20);
  const [openIncidents] = await db.select({ n: count() }).from(incidents).where(and(eq(incidents.projectId, projectId), eq(incidents.status, 'open')));
  const [outdated] = await db.select({ n: count() }).from(securityFindings).where(and(eq(securityFindings.projectId, projectId), eq(securityFindings.ruleId, 'dependency/outdated-major'), eq(securityFindings.status, 'open')));
  const td = (project.settings as { techDebt?: { testFiles: number; sourceFiles: number; hasReadme: boolean; todo: number } }).techDebt;
  const health = scan.projectHealth({
    securityScore: lastScan?.score ?? null,
    lastBuildPassed: recentBuilds[0] ? recentBuilds[0].status === 'passed' : null,
    recentBuildSuccessRate: recentBuilds.length ? recentBuilds.filter((b) => b.status === 'passed').length / recentBuilds.length : null,
    testFiles: td?.testFiles ?? 0,
    sourceFiles: td?.sourceFiles ?? 0,
    hasReadme: td?.hasReadme ?? false,
    todo: td?.todo ?? 0,
    deploySuccessRate: recentDeploys.length ? recentDeploys.filter((d) => d.status === 'succeeded').length / recentDeploys.length : null,
    openIncidents: openIncidents?.n ?? 0,
    outdatedMajor: outdated?.n ?? 0,
  });
  await db
    .update(projects)
    .set({
      healthScore: health.score,
      securityScore: lastScan?.score ?? project.securityScore,
      settings: sql`jsonb_set(${projects.settings}, '{health}', ${JSON.stringify({ ...health, computedAt: new Date().toISOString() })}::jsonb, true)`,
    })
    .where(eq(projects.id, projectId));
  await publish(db, { type: 'project.updated', organizationId: project.organizationId, projectId });
  return health;
}
