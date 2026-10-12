import { and, count, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { ai, enqueue, latestManifest, publish, QUEUES, scan, type JobContext } from '@projecthub/core';
import { aiMemories, builds, codeChunks, codeFiles, deployments, incidents, projects, securityFindings, securityScans } from '@projecthub/database';
import { commitSnapshot, loadProject, openRepo, type WorkerCtx } from '../context.js';

/**
 * Incremental code index for the AI Project Brain and code search: only files whose blob changed are
 * re-chunked. Also collects technical-debt signals for the project overview.
 */
export async function indexCode(ctx: WorkerCtx, { job, logger, signal }: JobContext) {
  const { projectId } = job.payload as { projectId: string };
  const project = await loadProject(ctx, projectId);
  const { git } = await openRepo(ctx, projectId);
  const head = await git.resolve(`refs/heads/${project.defaultBranch}`);
  if (!head) return { skipped: 'empty repository' };
  const snap = await commitSnapshot(git, head);
  // projecthub.yml `ai.indexing: false` (confidential code): keep no code in the AI context index.
  const aiIndexing = (await latestManifest(ctx.db, projectId))?.ai.indexing !== false;
  if (!aiIndexing) {
    await ctx.db.delete(codeChunks).where(eq(codeChunks.projectId, projectId));
    await ctx.db.delete(codeFiles).where(eq(codeFiles.projectId, projectId));
    await ctx.db.delete(aiMemories).where(and(eq(aiMemories.projectId, projectId), eq(aiMemories.sourceType, 'repository_index')));
  }
  const indexable = snap.entries.filter((f) => scan.isIndexable(f.path, f.size));
  const existing = new Map((await ctx.db.select({ path: codeFiles.path, blobSha: codeFiles.blobSha }).from(codeFiles).where(eq(codeFiles.projectId, projectId))).map((r) => [r.path, r.blobSha]));
  const changed = aiIndexing ? indexable.filter((f) => existing.get(f.path) !== f.sha) : [];
  const keep = new Set(indexable.map((f) => f.path));
  const removed = [...existing.keys()].filter((p) => !keep.has(p));

  await snap.preload(indexable.map((f) => f.path));
  const stats = scan.emptyStats();
  const sourceTexts = new Map<string, string>();
  for (const f of indexable) {
    const text = await snap.read(f.path);
    if (text !== null) {
      scan.accumulateStats(stats, f.path, text);
      if (aiIndexing) sourceTexts.set(f.path, text);
    }
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

  // Semantic indexing is optional and local-only. Missing/unavailable models leave the lexical index usable.
  const embedder = ai.localEmbedding(ctx.config);
  let embedded = 0;
  if (aiIndexing && embedder) {
    const pending = await ctx.db
      .select({ id: codeChunks.id, content: codeChunks.content })
      .from(codeChunks)
      .where(
        and(
          eq(codeChunks.projectId, projectId),
          or(isNull(codeChunks.embedding), isNull(codeChunks.embeddingModel), ne(codeChunks.embeddingModel, embedder.model)),
        ),
      );
    try {
      for (let i = 0; i < pending.length; i += 24) {
        const batch = pending.slice(i, i + 24);
        const vectors = await embedder.embed(batch.map((chunk) => chunk.content), signal);
        for (let j = 0; j < batch.length; j++) {
          await ctx.db
            .update(codeChunks)
            .set({ embedding: vectors[j]!, embeddingModel: embedder.model })
            .where(eq(codeChunks.id, batch[j]!.id));
          embedded += 1;
        }
      }
    } catch (error) {
      logger.warn({ projectId, model: embedder.model, err: error }, 'semantic indexing unavailable; lexical index retained');
    }
  }

  const techDebt = {
    ...stats,
    level: stats.todo + stats.longFunctions * 3 + stats.largeFiles * 2 > 60 ? 'high' : stats.todo + stats.longFunctions * 3 + stats.largeFiles * 2 > 20 ? 'medium' : 'low',
    commit: head,
    computedAt: new Date().toISOString(),
  };
  const languageCounts = indexable.reduce<Record<string, number>>((counts, file) => {
    const language = scan.languageOf(file.path);
    counts[language] = (counts[language] ?? 0) + 1;
    return counts;
  }, {});
  const languageSummary = Object.entries(languageCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([language, files]) => `${language}: ${files}`)
    .join(', ');
  const architecture = scan.analyseArchitecture(sourceTexts);
  if (aiIndexing) {
    await ctx.db
      .insert(aiMemories)
      .values({
        organizationId: project.organizationId,
        projectId,
        category: 'architecture',
        title: `Repository architecture snapshot ${head.slice(0, 7)}`,
        content: [
          `Indexed commit: ${head}`,
          `Project type: ${project.projectType}`,
          `Technologies: ${project.technologies.join(', ') || 'unknown'}`,
          `Indexable files: ${indexable.length}`,
          `Languages: ${languageSummary || 'unknown'}`,
          `Source files: ${stats.sourceFiles}; test files: ${stats.testFiles}; TODO markers: ${stats.todo}`,
          `README: ${stats.hasReadme ? 'present' : 'missing'}; technical debt level: ${techDebt.level}`,
          `Top modules: ${architecture.modules.slice(0, 10).map((item) => `${item.name} (${item.files})`).join(', ') || 'none detected'}`,
          `Entry points: ${architecture.entryPoints.slice(0, 10).map((item) => item.path).join(', ') || 'none detected'}`,
          `Test frameworks: ${architecture.testFrameworks.join(', ') || 'none detected'}`,
          `Module relationships: ${architecture.relationships.length}; circular dependency groups: ${architecture.circularDependencies.length}; duplicate block groups: ${architecture.duplicates.length}`,
          `High coupling: ${architecture.highCoupling.slice(0, 10).map((item) => `${item.path} (in ${item.incoming}/out ${item.outgoing})`).join(', ') || 'none detected'}`,
          `Cycles: ${architecture.circularDependencies.slice(0, 10).map((cycle) => cycle.join(' → ')).join('; ') || 'none detected'}`,
          `Configuration files: ${architecture.configFiles.join(', ') || 'none detected'}`,
          `Migration files: ${architecture.migrationFiles.length}`,
        ].join('\n'),
        verification: 'verified',
        sourceType: 'repository_index',
        sourceRef: head,
        sourceLabel: `${project.defaultBranch}@${head.slice(0, 7)}`,
        createdByType: 'system',
      })
      .onConflictDoUpdate({
        target: [aiMemories.projectId, aiMemories.sourceType, aiMemories.sourceRef],
        set: { content: sql`excluded.content`, title: sql`excluded.title`, updatedAt: new Date() },
      });
  }
  await ctx.db
    .update(projects)
    .set({ settings: aiIndexing ? sql`jsonb_set(jsonb_set(${projects.settings}, '{techDebt}', ${JSON.stringify(techDebt)}::jsonb, true), '{architecture}', ${JSON.stringify(architecture)}::jsonb, true)` : sql`jsonb_set(${projects.settings} - 'architecture', '{techDebt}', ${JSON.stringify(techDebt)}::jsonb, true)` })
    .where(eq(projects.id, projectId));
  await enqueue(ctx.db, { queue: QUEUES.maintenance, type: 'project.health', projectId, organizationId: project.organizationId, dedupeKey: `health:${projectId}`, payload: { projectId } });
  logger.info({ projectId, indexed: changed.length, embedded, removed: removed.length, total: indexable.length }, 'code index updated');
  return { indexed: changed.length, embedded, removed: removed.length, total: indexable.length };
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
