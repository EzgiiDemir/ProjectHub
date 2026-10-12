import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { FindingType } from '@projecthub/contracts';
import { audit, emitDomainEvent, enqueue, nextNumber, publish, QUEUES, scan, SYSTEM_ACTOR, timeline, type JobContext, type Logger } from '@projecthub/core';
import { projectManifests, projects, securityFindings, securityScans } from '@projecthub/database';
import { commitSnapshot, loadProject, openRepo, type WorkerCtx } from '../context.js';

export interface ScanPayload {
  projectId: string;
  scanId?: string;
  branch?: string;
  commitSha?: string;
  buildId?: string;
  trigger?: string;
  requestedBy?: string;
}

export async function securityScan(ctx: WorkerCtx, { job, logger }: JobContext) {
  return runSecurityScan(ctx, job.payload as unknown as ScanPayload, logger);
}

/** Scans one commit and reconciles findings. Used by the scan job and by the build pipeline's security step. */
export async function runSecurityScan(ctx: WorkerCtx, p: ScanPayload, logger: Logger) {
  const project = await loadProject(ctx, p.projectId);
  const { git } = await openRepo(ctx, p.projectId);
  const branch = p.branch ?? project.defaultBranch;
  const commit = p.commitSha ?? (await git.resolve(`refs/heads/${branch}`));
  const db = ctx.db;
  let scanId = p.scanId;
  if (!scanId) {
    scanId = (
      await db
        .insert(securityScans)
        .values({ organizationId: project.organizationId, projectId: project.id, buildId: p.buildId ?? null, branch, commitSha: commit, status: 'running', startedAt: new Date(), createdBy: p.requestedBy ?? null })
        .returning({ id: securityScans.id })
    )[0]!.id;
  } else {
    await db.update(securityScans).set({ status: 'running', startedAt: new Date(), commitSha: commit, branch }).where(eq(securityScans.id, scanId));
  }
  await publish(db, { type: 'security.scan', organizationId: project.organizationId, projectId: project.id, id: scanId });
  if (!commit) {
    await db.update(securityScans).set({ status: 'failed', error: 'Repository boş', finishedAt: new Date() }).where(eq(securityScans.id, scanId));
    return { skipped: 'empty' };
  }

  try {
    const manifest = (await db.select({ content: projectManifests.content }).from(projectManifests).where(eq(projectManifests.projectId, project.id)).orderBy(desc(projectManifests.version)).limit(1))[0]?.content;
    const opts = { secretScan: manifest?.security.secretScan ?? true, dependencyScan: manifest?.security.dependencyScan ?? true };
    const snap = await commitSnapshot(git, commit);
    await snap.preload(snap.entries.filter((f) => scan.isScannable(f.path, f.size) || /(^|\/)(Dockerfile[^/]*|\.gitignore|\.env(\.[a-z]+)?)$/i.test(f.path)).map((f) => f.path));
    const result = await scan.scanRepository(snap, {
      ...opts,
      osvUrl: ctx.config.OSV_API_URL,
      registries: { npm: ctx.config.NPM_REGISTRY_URL, pypi: ctx.config.PYPI_URL, packagist: ctx.config.PACKAGIST_URL },
    });
    const dependencyCovered = opts.dependencyScan && !result.notes.some((n) => n.includes('ulaşılamadı') || n.includes('kapalı'));
    const covered: FindingType[] = ['code', 'config', ...(opts.secretScan ? (['secret'] as const) : []), ...(dependencyCovered ? (['dependency'] as const) : [])];

    const now = new Date();
    const newCritical: string[] = [];
    await db.transaction(async (tx) => {
      const existing = await tx.select().from(securityFindings).where(eq(securityFindings.projectId, project.id));
      const byFp = new Map(existing.map((f) => [f.fingerprint, f]));
      for (const f of result.findings) {
        const prev = byFp.get(f.fingerprint);
        const fields = {
          severity: f.severity,
          type: f.type,
          ruleId: f.ruleId,
          title: f.title.slice(0, 300),
          description: f.description,
          filePath: f.filePath ?? null,
          line: f.line ?? null,
          packageName: f.packageName ?? null,
          packageVersion: f.packageVersion ?? null,
          fixedVersion: f.fixedVersion ?? null,
          advisoryId: f.advisoryId ?? null,
          references: f.references ?? [],
          lastScanId: scanId!,
          lastSeenAt: now,
        };
        if (prev) {
          const reopen = prev.status === 'resolved';
          await tx
            .update(securityFindings)
            .set({ ...fields, ...(reopen ? { status: 'open' as const, resolvedAt: null } : {}) })
            .where(eq(securityFindings.id, prev.id));
        } else {
          const number = await nextNumber(tx, project.organizationId, 'finding');
          await tx.insert(securityFindings).values({ ...fields, organizationId: project.organizationId, projectId: project.id, number, fingerprint: f.fingerprint, firstSeenAt: now });
          if (f.severity === 'critical') newCritical.push(`SEC-${number} ${f.title}`);
        }
      }
      // Findings that disappeared from a scanner that actually ran are resolved automatically.
      const seen = result.findings.map((f) => f.fingerprint);
      await tx
        .update(securityFindings)
        .set({ status: 'resolved', resolvedAt: now })
        .where(
          and(
            eq(securityFindings.projectId, project.id),
            eq(securityFindings.status, 'open'),
            inArray(securityFindings.type, covered),
            seen.length ? notInArray(securityFindings.fingerprint, seen) : sql`true`,
          ),
        );
      const open = await tx
        .select({ severity: securityFindings.severity, type: securityFindings.type })
        .from(securityFindings)
        .where(and(eq(securityFindings.projectId, project.id), eq(securityFindings.status, 'open')));
      const { score, breakdown } = scan.securityScore(open);
      const tally = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      const byType: Record<string, number> = {};
      for (const f of open) {
        tally[f.severity]++;
        byType[f.type] = (byType[f.type] ?? 0) + 1;
      }
      await tx
        .update(securityScans)
        .set({
          status: 'completed',
          score,
          finishedAt: new Date(),
          summary: { ...tally, byType, packagesScanned: result.packagesScanned, filesScanned: result.filesScanned, breakdown, notes: result.notes },
        })
        .where(eq(securityScans.id, scanId!));
      const dependencyInventory = result.dependencies.filter((item) => item.direct).slice(0, 1000);
      await tx
        .update(projects)
        .set({ securityScore: score, settings: sql`jsonb_set(${projects.settings}, '{dependencyInventory}', ${JSON.stringify(dependencyInventory)}::jsonb, true)` })
        .where(eq(projects.id, project.id));
      await audit(tx, { organizationId: project.organizationId, projectId: project.id, actor: SYSTEM_ACTOR, action: 'security.scan_completed', resourceType: 'security_scan', resourceId: scanId!, metadata: { score, ...tally } });
      await timeline(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        kind: 'security',
        tone: tally.critical ? 'bad' : tally.high ? 'warn' : 'ok',
        title: `Güvenlik taraması tamamlandı · skor ${score}/100`,
        description: `${tally.critical} kritik, ${tally.high} yüksek, ${tally.medium} orta · ${result.filesScanned} dosya, ${result.packagesScanned} paket`,
        refType: 'security_scan',
        refId: scanId!,
      });
      for (const c of newCritical) {
        await emitDomainEvent(tx, { event: 'security.finding.critical', organizationId: project.organizationId, projectId: project.id, data: { title: c, projectName: project.name } });
      }
      await enqueue(tx, { queue: QUEUES.maintenance, type: 'project.health', projectId: project.id, organizationId: project.organizationId, dedupeKey: `health:${project.id}`, payload: { projectId: project.id } });
      await publish(tx, { type: 'security.scan', organizationId: project.organizationId, projectId: project.id, id: scanId });
    });
    logger.info({ projectId: project.id, findings: result.findings.length }, 'security scan completed');
    const summary = (await db.select({ summary: securityScans.summary, score: securityScans.score }).from(securityScans).where(eq(securityScans.id, scanId)))[0];
    return { scanId, findings: result.findings.length, score: summary?.score ?? null, summary: summary?.summary ?? null };
  } catch (e) {
    await db.update(securityScans).set({ status: 'failed', error: (e as Error).message.slice(0, 1000), finishedAt: new Date() }).where(eq(securityScans.id, scanId));
    await publish(db, { type: 'security.scan', organizationId: project.organizationId, projectId: project.id, id: scanId });
    throw e;
  }
}
