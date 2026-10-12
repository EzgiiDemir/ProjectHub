import fs from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { durationToMinutes, type Manifest, type StepStatus } from '@projecthub/contracts';
import {
  audit,
  copyDir,
  DeferJobError,
  detectProject,
  dirSize,
  emitDomainEvent,
  enqueue,
  getOrgSettings,
  GitRepository,
  manifestFromDetection,
  MANIFEST_FILE,
  moveDir,
  parseManifest,
  PermanentJobError,
  previewSlug,
  publish,
  QUEUES,
  resolveEnvSecrets,
  SYSTEM_ACTOR,
  timeline,
  type JobContext,
} from '@projecthub/core';
import { artifacts, builds, buildSteps, previews, projectManifests, users, workerHeartbeats, type Executor } from '@projecthub/database';
import { commitSnapshot, loadProject, openRepo, type WorkerCtx } from '../context.js';
import { extractError } from '../runner/errors.js';
import {
  BuildLog,
  listManagedBuildContainers,
  removeManagedBuildContainer,
  runCommand,
  runContainerCommand,
  runtimeEnv,
  sanitizedEnv,
} from '../runner/process.js';
import { registerPeriodic } from './maintenance.js';
import { runSecurityScan } from './security.js';

type StepKey = 'checkout' | 'manifest' | 'install' | 'security' | 'build' | 'test' | 'artifact';
const STEP_NAMES: Record<StepKey, string> = {
  checkout: 'Kaynak kod (checkout)',
  manifest: 'Manifest okuma',
  install: 'Bağımlılık kurulumu',
  security: 'Güvenlik taraması',
  build: 'Build',
  test: 'Testler',
  artifact: 'Artifact',
};

/** The manifest that applies to a commit: projecthub.yml in that commit, else the stored one, else detected. */
export async function manifestAt(ctx: WorkerCtx, projectId: string, git: GitRepository, commit: string): Promise<{ manifest: Manifest; source: string }> {
  const file = await git.readFile(commit, MANIFEST_FILE);
  if (file) return { manifest: parseManifest(file.content.toString('utf8')), source: 'repository' };
  const stored = (await ctx.db.select().from(projectManifests).where(eq(projectManifests.projectId, projectId)).orderBy(desc(projectManifests.version)).limit(1))[0];
  if (stored) return { manifest: stored.content, source: stored.source };
  const project = await loadProject(ctx, projectId);
  const det = await detectProject(await commitSnapshot(git, commit), project.slug);
  return { manifest: manifestFromDetection({ ...det, name: project.name }, project.slug), source: 'detected' };
}

export async function executeBuild(ctx: WorkerCtx, { job, logger, signal }: JobContext) {
  const { buildId } = job.payload as { buildId: string };
  const db = ctx.db;
  const build = (await db.select().from(builds).where(eq(builds.id, buildId)))[0];
  if (!build) throw new PermanentJobError('build not found');
  if (build.status !== 'queued' && build.status !== 'running') return { skipped: build.status };
  const project = await loadProject(ctx, build.projectId);
  if ((project.settings as { executionTrust?: string }).executionTrust === 'untrusted') {
    const message = 'Güvenilmeyen proje için host üzerinde build komutu çalıştırılması engellendi';
    await db.transaction(async (tx) => {
      await tx.update(builds).set({ status: 'failed', error: { step: 'Güvenlik ilkesi', message }, finishedAt: new Date() }).where(eq(builds.id, build.id));
      await audit(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        actor: SYSTEM_ACTOR,
        action: 'build.blocked_untrusted_source',
        resourceType: 'build',
        resourceId: build.id,
        metadata: { executionTrust: 'untrusted' },
      });
      await timeline(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        kind: 'build',
        tone: 'bad',
        title: `Build #${build.number} güvenlik ilkesiyle engellendi`,
        description: message,
        refType: 'build',
        refId: build.id,
      });
    });
    await publish(db, { type: 'build.updated', organizationId: project.organizationId, projectId: project.id, id: build.id });
    return { status: 'failed', blocked: true };
  }
  const { git } = await openRepo(ctx, project.id);
  const settings = await getOrgSettings(db, project.organizationId);
  if (build.status === 'queued') {
    // Admin > Saklama ve kapasite: organization-wide cap on simultaneous builds (the 8 GB server guard).
    // The advisory lock makes "count running + claim" atomic across worker processes.
    const claimed = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`builds:${project.organizationId}`}))`);
      const running = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM builds WHERE organization_id = ${project.organizationId} AND status = 'running'`);
      if ((running.rows[0]?.n ?? 0) >= settings.retention.maxConcurrentBuilds) return false;
      await tx.update(builds).set({ status: 'running', startedAt: new Date() }).where(eq(builds.id, build.id));
      return true;
    });
    if (!claimed) throw new DeferJobError(`Eşzamanlı build sınırı (${settings.retention.maxConcurrentBuilds}) dolu; build sırada bekliyor`, 10_000);
  }

  const logKey = ctx.storage.buildLogKey(project.id, build.id);
  await ctx.storage.ensureDir(path.dirname(logKey));
  await fs.rm(ctx.storage.resolve(logKey), { force: true });
  const log = new BuildLog(ctx.storage.resolve(logKey));
  const workspaceKey = ctx.storage.workspaceKey('build', build.id);
  const workspace = ctx.storage.resolve(workspaceKey);
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.mkdir(workspace, { recursive: true });

  const started = new Date();
  await db.delete(buildSteps).where(eq(buildSteps.buildId, build.id));
  const order: StepKey[] = ['checkout', 'manifest', 'install', 'security', 'build', 'test', 'artifact'];
  const stepIds = new Map<StepKey, string>();
  for (const [i, key] of order.entries()) {
    const row = (await db.insert(buildSteps).values({ buildId: build.id, key, name: STEP_NAMES[key], seq: i }).returning({ id: buildSteps.id }))[0]!;
    stepIds.set(key, row.id);
  }
  await db.update(builds).set({ status: 'running', startedAt: started, logKey }).where(eq(builds.id, build.id));
  const notify = () => publish(db, { type: 'build.updated', organizationId: project.organizationId, projectId: project.id, id: build.id });
  await notify();

  const setStep = async (key: StepKey, status: StepStatus, extra: { summary?: string; exitCode?: number | null } = {}) => {
    const now = new Date();
    await db
      .update(buildSteps)
      .set({
        status,
        ...(status === 'running' ? { startedAt: now } : {}),
        ...(['passed', 'failed', 'skipped'].includes(status) ? { finishedAt: now } : {}),
        ...(extra.summary !== undefined ? { summary: extra.summary.slice(0, 2000) } : {}),
        ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
      })
      .where(eq(buildSteps.id, stepIds.get(key)!));
    await notify();
  };
  const isCancelled = async () => (await db.select({ s: builds.status }).from(builds).where(eq(builds.id, build.id)))[0]?.s === 'cancelled';

  let manifest: Manifest | null = null;
  let failure: { step: StepKey; file?: string; line?: number; message: string } | null = null;
  let cancelled = false;

  const run = async (key: StepKey, command: string, env: NodeJS.ProcessEnv, timeoutMs: number) => {
    await setStep(key, 'running');
    const containerized = ctx.config.BUILD_EXECUTOR === 'container';
    log.section(`${STEP_NAMES[key]}${containerized ? ' (ephemeral container)' : ''}: ${command}`);
    const common = { command, cwd: workspace, env, timeoutMs, onOutput: (t: string) => log.write(t), isCancelled, signal };
    const r = containerized
      ? await runContainerCommand({
          ...common,
          limits: {
            image: ctx.config.BUILD_CONTAINER_IMAGE,
            cpus: ctx.config.BUILD_CONTAINER_CPUS,
            memoryMb: ctx.config.BUILD_CONTAINER_MEMORY_MB,
            pids: ctx.config.BUILD_CONTAINER_PIDS,
            // Only dependency installation receives egress. Build/test code executes without a network.
            network: key === 'install' ? 'bridge' : 'none',
          },
          labels: {
            'com.projecthub.managed': 'build',
            'com.projecthub.worker': ctx.workerId,
            'com.projecthub.build': build.id,
          },
        })
      : await runCommand(common);
    log.flush();
    if (r.cancelled) {
      cancelled = true;
      log.line('[projecthub] build iptal edildi');
      await setStep(key, 'failed', { summary: 'İptal edildi', exitCode: r.exitCode });
      return false;
    }
    if (r.timedOut || r.exitCode !== 0) {
      const extracted = r.timedOut ? { message: `Zaman aşımı (${Math.round(timeoutMs / 60000)} dk)` } : extractError(log.lastLines(200));
      failure = { step: key, ...extracted };
      await setStep(key, 'failed', { summary: extracted.message, exitCode: r.exitCode });
      return false;
    }
    await setStep(key, 'passed', { summary: `${(r.durationMs / 1000).toFixed(1)} sn`, exitCode: 0 });
    return true;
  };

  try {
    // 1. checkout
    await setStep('checkout', 'running');
    log.section(`Checkout ${build.branch} @ ${build.commitSha}`);
    await git.exportTo(build.commitSha, workspace);
    await setStep('checkout', 'passed', { summary: `${build.commitSha.slice(0, 7)} · ${build.branch}` });

    // 2. manifest
    await setStep('manifest', 'running');
    const resolved = await manifestAt(ctx, project.id, git, build.commitSha);
    manifest = resolved.manifest;
    log.line(`[projecthub] manifest kaynağı: ${resolved.source}`);
    log.line(JSON.stringify(manifest, null, 2));
    await db.update(builds).set({ manifest }).where(eq(builds.id, build.id));
    await setStep('manifest', 'passed', { summary: `${manifest.runtime.type}${manifest.runtime.version ? ` ${manifest.runtime.version}` : ''} · kaynak: ${resolved.source}` });

    const secrets = await resolveEnvSecrets(db, ctx.config.encryptionKey, { organizationId: project.organizationId, projectId: project.id, environmentId: null, scope: 'build' });
    const env = sanitizedEnv({ ...runtimeEnv(manifest.runtime?.type), ...secrets, PROJECTHUB_BUILD: String(build.number), PROJECTHUB_COMMIT: build.commitSha, PROJECTHUB_BRANCH: build.branch });
    const timeoutMs = Math.min(manifest.build?.timeoutMinutes ?? 20, ctx.config.BUILD_TIMEOUT_MINUTES) * 60_000;

    // 3. install
    if (manifest.install?.command) {
      if (!(await run('install', manifest.install.command, env, timeoutMs))) throw new StepFailed();
    } else await setStep('install', 'skipped', { summary: 'Manifestte kurulum komutu yok' });

    // 4. security (source scan of this commit; findings feed the deploy policy)
    await setStep('security', 'running');
    log.section('Güvenlik taraması');
    const scanResult = await runSecurityScan(ctx, { projectId: project.id, buildId: build.id, commitSha: build.commitSha, branch: build.branch, trigger: 'build' }, logger);
    const s = scanResult.summary as { critical: number; high: number; medium: number } | null;
    const scanSummary = s ? `skor ${scanResult.score}/100 · ${s.critical} kritik, ${s.high} yüksek, ${s.medium} orta` : 'tamamlandı';
    log.line(`[projecthub] ${scanSummary}`);
    await setStep('security', 'passed', { summary: scanSummary });

    // 5. build
    if (manifest.build?.command) {
      if (!(await run('build', manifest.build.command, env, timeoutMs))) throw new StepFailed();
    } else await setStep('build', 'skipped', { summary: 'Manifestte build komutu yok' });

    // 6. tests
    if (manifest.test?.command) {
      if (!(await run('test', manifest.test.command, env, timeoutMs))) throw new StepFailed();
    } else await setStep('test', 'skipped', { summary: 'Manifestte test komutu yok' });

    // 7. artifact
    await setStep('artifact', 'running');
    log.section('Artifact');
    const artifactKey = ctx.storage.buildArtifactKey(project.id, build.id);
    const artifactDir = ctx.storage.resolve(artifactKey);
    await fs.rm(artifactDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(artifactDir), { recursive: true });
    const wantsProcess = manifest.preview.mode === 'process' || (!manifest.preview.mode && !manifest.build?.output && !!manifest.start?.command);
    let outputKind: 'static' | 'process';
    if (wantsProcess && manifest.start?.command) {
      // Server apps run from the complete workspace (dependencies included).
      // moveDir re-points links into the old workspace (Turbopack server externals) at the artifact.
      await moveDir(workspace, artifactDir);
      outputKind = 'process';
    } else {
      const out = manifest.build?.output ?? '.';
      const src = path.resolve(workspace, out);
      if (!src.startsWith(workspace)) throw new PermanentJobError('build.output depo dışını gösteremez');
      try {
        await fs.access(src);
      } catch {
        failure = { step: 'artifact', message: `Build çıktısı bulunamadı: ${out}. Manifestte build.output değerini kontrol edin.` };
        await setStep('artifact', 'failed', { summary: failure.message });
        throw new StepFailed();
      }
      await copyDir(src, artifactDir, (rel) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(rel));
      outputKind = 'static';
    }
    const size = await dirSize(artifactDir);
    const artifact = (
      await db
        .insert(artifacts)
        .values({
          organizationId: project.organizationId,
          projectId: project.id,
          buildId: build.id,
          type: 'build',
          storageKey: artifactKey,
          fileName: `build-${build.number}`,
          contentType: 'inode/directory',
          sizeBytes: size,
          retentionUntil: new Date(Date.now() + settings.retention.temporaryBuildDays * 86400_000),
        })
        .returning()
    )[0]!;
    log.line(`[projecthub] ${outputKind === 'static' ? 'statik çıktı' : 'çalıştırılabilir uygulama'} · ${(size / 1024 / 1024).toFixed(2)} MB`);
    await setStep('artifact', 'passed', { summary: `${outputKind === 'static' ? 'Statik çıktı' : 'Uygulama'} · ${(size / 1024 / 1024).toFixed(2)} MB` });

    const finished = new Date();
    await db.transaction(async (tx) => {
      await tx.update(builds).set({ status: 'passed', artifactId: artifact.id, outputKind, finishedAt: finished, durationMs: finished.getTime() - started.getTime() }).where(eq(builds.id, build.id));
      await timeline(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        kind: 'build',
        tone: 'ok',
        title: `Build #${build.number} başarılı`,
        description: `${build.branch} · ${build.commitSha.slice(0, 7)} · ${Math.round((finished.getTime() - started.getTime()) / 1000)} sn`,
        refType: 'build',
        refId: build.id,
      });
      await audit(tx, { organizationId: project.organizationId, projectId: project.id, actor: SYSTEM_ACTOR, action: 'build.passed', resourceType: 'build', resourceId: build.id });
      await emitDomainEvent(tx, { event: 'build.completed', organizationId: project.organizationId, projectId: project.id, data: { buildId: build.id, number: build.number, branch: build.branch, commitSha: build.commitSha } });
      if (build.createPreview && manifest!.preview.enabled) await createPreviewFor(tx, ctx, project, build, manifest!);
      await enqueue(tx, { queue: QUEUES.maintenance, type: 'project.health', projectId: project.id, organizationId: project.organizationId, dedupeKey: `health:${project.id}`, payload: { projectId: project.id } });
    });
    await notify();
    return { status: 'passed' };
  } catch (e) {
    if (!(e instanceof StepFailed) && !cancelled) {
      logger.error({ err: e }, 'build crashed');
      log.line(`[projecthub] beklenmeyen hata: ${(e as Error).message}`);
      failure ??= { step: 'checkout', message: (e as Error).message };
    }
    const finished = new Date();
    const status = cancelled ? 'cancelled' : 'failed';
    await db.transaction(async (tx) => {
      await tx
        .update(builds)
        .set({ status, error: failure ? { ...failure, step: STEP_NAMES[failure.step] } : null, finishedAt: finished, durationMs: finished.getTime() - started.getTime() })
        .where(eq(builds.id, build.id));
      // Remaining pending steps are marked skipped.
      await tx.update(buildSteps).set({ status: 'skipped' }).where(and(eq(buildSteps.buildId, build.id), eq(buildSteps.status, 'pending')));
      await timeline(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        kind: 'build',
        tone: cancelled ? 'idle' : 'bad',
        title: cancelled ? `Build #${build.number} iptal edildi` : `Build #${build.number} başarısız`,
        description: failure ? `${STEP_NAMES[failure.step]}: ${failure.message}${failure.file ? ` (${failure.file}${failure.line ? `:${failure.line}` : ''})` : ''}` : '',
        refType: 'build',
        refId: build.id,
      });
      if (!cancelled) {
        const triggeredBy = build.triggeredBy ? (await tx.select({ id: users.id }).from(users).where(eq(users.id, build.triggeredBy)))[0]?.id : null;
        await emitDomainEvent(tx, { event: 'build.failed', organizationId: project.organizationId, projectId: project.id, data: { buildId: build.id, number: build.number, triggeredBy: triggeredBy ?? null, error: failure?.message ?? '' } });
        await enqueue(tx, { queue: QUEUES.ai, type: 'ai.build_analysis', projectId: project.id, organizationId: project.organizationId, dedupeKey: `build-analysis:${build.id}`, maxAttempts: 2, payload: { buildId: build.id } });
      }
      await enqueue(tx, { queue: QUEUES.maintenance, type: 'project.health', projectId: project.id, organizationId: project.organizationId, dedupeKey: `health:${project.id}`, payload: { projectId: project.id } });
    });
    await notify();
    return { status };
  } finally {
    log.close();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

class StepFailed extends Error {}

registerPeriodic({
  name: 'reconcile-build-containers',
  everyMinutes: 1,
  run: async (ctx) => {
    if (ctx.config.BUILD_EXECUTOR !== 'container') return 0;
    const containers = await listManagedBuildContainers();
    if (!containers.length) return 0;
    const activeWorkerRows = await ctx.db
      .select({ id: workerHeartbeats.workerId })
      .from(workerHeartbeats)
      .where(and(inArray(workerHeartbeats.workerId, [...new Set(containers.map((item) => item.workerId))]), gt(workerHeartbeats.lastSeenAt, new Date(Date.now() - 45_000))));
    const buildRows = await ctx.db
      .select({ id: builds.id, status: builds.status })
      .from(builds)
      .where(inArray(builds.id, [...new Set(containers.map((item) => item.buildId))]));
    const activeWorkers = new Set(activeWorkerRows.map((row) => row.id));
    const runningBuilds = new Set(buildRows.filter((row) => row.status === 'running').map((row) => row.id));
    const orphaned = containers.filter((item) => !activeWorkers.has(item.workerId) || !runningBuilds.has(item.buildId));
    await Promise.all(orphaned.map((item) => removeManagedBuildContainer(item.id)));
    return orphaned.length;
  },
});

/** Creates a preview for a successful build (called inside the build's finishing transaction). */
export async function createPreviewFor(
  tx: Executor,
  ctx: WorkerCtx,
  project: { id: string; organizationId: string; slug: string },
  build: { id: string; number: number; branch: string; commitSha: string; triggeredBy: string | null },
  manifest: Manifest,
) {
  const ttlMinutes = Math.min(durationToMinutes(manifest.preview.ttl), 60 * 24 * 14);
  const slug = previewSlug(project.slug, build.number);
  const row = (
    await tx
      .insert(previews)
      .values({
        organizationId: project.organizationId,
        projectId: project.id,
        buildId: build.id,
        slug,
        kind: 'static',
        status: 'queued',
        spa: manifest.preview.spa,
        sourceBranch: build.branch,
        sourceCommit: build.commitSha,
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
        createdBy: build.triggeredBy,
      })
      .returning({ id: previews.id })
  )[0]!;
  await enqueue(tx, { queue: QUEUES.preview, type: 'preview.start', projectId: project.id, organizationId: project.organizationId, payload: { previewId: row.id } });
  return row.id;
}
