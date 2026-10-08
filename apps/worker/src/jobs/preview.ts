import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { and, asc, eq, inArray, lt, ne } from 'drizzle-orm';
import {
  emitDomainEvent,
  enqueue,
  getOrgSettings,
  PermanentJobError,
  previewUrl,
  publish,
  QUEUES,
  resolveEnvSecrets,
  timeline,
  type JobContext,
} from '@projecthub/core';
import { artifacts, builds, previews } from '@projecthub/database';
import { loadProject, type WorkerCtx } from '../context.js';
import { registerLifecycle } from '../lifecycle.js';
import { registerPeriodic } from './maintenance.js';
import { expandPort, isPortFree, killTree, sanitizedEnv, startService } from '../runner/process.js';

/** Processes started by this worker instance (previewId → child). */
const running = new Map<string, ChildProcess>();

async function allocatePort(ctx: WorkerCtx): Promise<number> {
  const used = new Set(
    (await ctx.db.select({ port: previews.internalPort }).from(previews).where(inArray(previews.status, ['starting', 'ready']))).map((r) => r.port),
  );
  const { from, to } = ctx.config.PREVIEW_PORT_RANGE;
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = from + Math.floor(Math.random() * (to - from + 1));
    if (!used.has(port) && (await isPortFree(port))) return port;
  }
  throw new Error('Boş ön izleme portu bulunamadı');
}

async function waitHealthy(port: number, healthPath: string, timeoutMs: number, child: ChildProcess): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { ok: false, detail: `Süreç kapandı (çıkış kodu ${child.exitCode})` };
    try {
      const res = await fetch(`http://127.0.0.1:${port}${healthPath}`, { signal: AbortSignal.timeout(3_000), redirect: 'manual' });
      if (res.status < 500) return { ok: true, detail: `HTTP ${res.status}` };
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return { ok: false, detail: `Sağlık kontrolü zaman aşımı (${last})` };
}

export async function startPreview(ctx: WorkerCtx, { job, logger }: JobContext) {
  const { previewId } = job.payload as { previewId: string };
  const db = ctx.db;
  const pv = (await db.select().from(previews).where(eq(previews.id, previewId)))[0];
  if (!pv) throw new PermanentJobError('preview not found');
  if (['stopped', 'expired'].includes(pv.status)) return { skipped: pv.status };
  const project = await loadProject(ctx, pv.projectId);
  const build = (await db.select().from(builds).where(eq(builds.id, pv.buildId)))[0];
  const artifact = build?.artifactId ? (await db.select().from(artifacts).where(eq(artifacts.id, build.artifactId)))[0] : undefined;
  const url = previewUrl(ctx.config.PREVIEW_PUBLIC_URL_TEMPLATE, pv.slug);
  const fail = async (message: string) => {
    await db.update(previews).set({ status: 'failed', error: message }).where(eq(previews.id, pv.id));
    await timeline(db, { organizationId: project.organizationId, projectId: project.id, kind: 'preview', tone: 'bad', title: 'Ön izleme başlatılamadı', description: message, refType: 'preview', refId: pv.id });
    await publish(db, { type: 'preview.updated', organizationId: project.organizationId, projectId: project.id, id: pv.id });
  };
  if (!build || build.status !== 'passed' || !artifact) return fail('Build artifact\'ı bulunamadı (build başarılı değil veya artifact silinmiş)');
  if (!(await ctx.storage.exists(artifact.storageKey))) return fail('Artifact dosyaları saklama politikası gereği silinmiş; yeniden build alın');
  // Keep the artifact while a preview uses it.
  await db.update(artifacts).set({ retentionUntil: pv.expiresAt }).where(and(eq(artifacts.id, artifact.id), lt(artifacts.retentionUntil, pv.expiresAt)));

  if (build.outputKind !== 'process') {
    await db.update(previews).set({ kind: 'static', status: 'ready', rootKey: artifact.storageKey, error: null }).where(eq(previews.id, pv.id));
  } else {
    const manifest = build.manifest;
    if (!manifest?.start?.command) return fail('Manifestte start.command tanımlı değil');
    await enforcePreviewLimit(ctx, project.organizationId, pv.id);
    const port = await allocatePort(ctx);
    await db.update(previews).set({ kind: 'process', status: 'starting', rootKey: artifact.storageKey, internalPort: port, runnerId: ctx.workerId, error: null }).where(eq(previews.id, pv.id));
    await publish(db, { type: 'preview.updated', organizationId: project.organizationId, projectId: project.id, id: pv.id });
    const secrets = await resolveEnvSecrets(db, ctx.config.encryptionKey, { organizationId: project.organizationId, projectId: project.id, environmentId: null, scope: 'runtime' });
    const logKey = ctx.storage.previewLogKey(project.id, pv.id);
    await ctx.storage.ensureDir(path.dirname(logKey));
    const child = startService({
      command: expandPort(manifest.start.command, port),
      cwd: ctx.storage.resolve(artifact.storageKey),
      env: sanitizedEnv({ ...secrets, PORT: String(port), HOST: '127.0.0.1', HOSTNAME: '127.0.0.1', NODE_ENV: 'production', PROJECTHUB_PREVIEW_URL: url }),
      logFile: ctx.storage.resolve(logKey),
    });
    running.set(pv.id, child);
    child.on('exit', (code) => {
      running.delete(pv.id);
      void onProcessExit(ctx, pv.id, code);
    });
    const health = await waitHealthy(port, manifest.health.path, 90_000, child);
    if (!health.ok) {
      killTree(child);
      running.delete(pv.id);
      const tail = await fs.readFile(ctx.storage.resolve(logKey), 'utf8').then((t) => t.split('\n').slice(-15).join('\n')).catch(() => '');
      return fail(`${health.detail}${tail ? `\n${tail}` : ''}`);
    }
    await db.update(previews).set({ status: 'ready', processId: child.pid ?? null }).where(eq(previews.id, pv.id));
  }
  await db.transaction(async (tx) => {
    await timeline(tx, {
      organizationId: project.organizationId,
      projectId: project.id,
      kind: 'preview',
      tone: 'ok',
      title: `Ön izleme hazır: ${pv.slug}`,
      description: `Build #${build.number} · ${pv.sourceBranch} · ${new Date(pv.expiresAt).toLocaleString('tr-TR')} tarihine kadar`,
      refType: 'preview',
      refId: pv.id,
    });
    await emitDomainEvent(tx, { event: 'preview.ready', organizationId: project.organizationId, projectId: project.id, data: { previewId: pv.id, url, createdBy: pv.createdBy } });
    await publish(tx, { type: 'preview.updated', organizationId: project.organizationId, projectId: project.id, id: pv.id });
  });
  logger.info({ previewId: pv.id, kind: build.outputKind }, 'preview ready');
  return { url };
}

async function onProcessExit(ctx: WorkerCtx, previewId: string, code: number | null) {
  const pv = (await ctx.db.select().from(previews).where(eq(previews.id, previewId)))[0];
  if (!pv || pv.status !== 'ready') return;
  await ctx.db.update(previews).set({ status: 'failed', error: `Uygulama süreci beklenmedik şekilde kapandı (kod ${code})`, processId: null }).where(eq(previews.id, previewId));
  await publish(ctx.db, { type: 'preview.updated', organizationId: pv.organizationId, projectId: pv.projectId, id: previewId });
}

/** Spec §109–110: cap concurrently running server previews; the oldest is stopped first. */
async function enforcePreviewLimit(ctx: WorkerCtx, organizationId: string, exceptId: string) {
  const { retention } = await getOrgSettings(ctx.db, organizationId);
  const active = await ctx.db
    .select({ id: previews.id })
    .from(previews)
    .where(and(eq(previews.kind, 'process'), inArray(previews.status, ['starting', 'ready']), ne(previews.id, exceptId)))
    .orderBy(asc(previews.createdAt));
  const excess = active.length - (retention.maxRunningPreviews - 1);
  for (const p of active.slice(0, Math.max(0, excess))) {
    await stopPreviewNow(ctx, p.id, 'stopped', 'Eşzamanlı ön izleme sınırı nedeniyle durduruldu');
  }
}

export async function stopPreviewNow(ctx: WorkerCtx, previewId: string, status: 'stopped' | 'expired', reason?: string) {
  const pv = (await ctx.db.select().from(previews).where(eq(previews.id, previewId)))[0];
  if (!pv || ['stopped', 'expired'].includes(pv.status)) return;
  const child = running.get(previewId);
  running.delete(previewId);
  if (child) killTree(child);
  else if (pv.processId && pv.runnerId === ctx.workerId) killTree(pv.processId);
  await ctx.db.update(previews).set({ status, stoppedAt: new Date(), processId: null, error: reason ?? null }).where(eq(previews.id, previewId));
  await timeline(ctx.db, {
    organizationId: pv.organizationId,
    projectId: pv.projectId,
    kind: 'preview',
    tone: 'idle',
    title: status === 'expired' ? `Ön izleme süresi doldu: ${pv.slug}` : `Ön izleme durduruldu: ${pv.slug}`,
    description: reason ?? '',
    refType: 'preview',
    refId: pv.id,
  });
  await publish(ctx.db, { type: 'preview.updated', organizationId: pv.organizationId, projectId: pv.projectId, id: pv.id });
}

export async function stopPreview(ctx: WorkerCtx, { job }: JobContext) {
  const { previewId, reason } = job.payload as { previewId: string; reason?: string };
  await stopPreviewNow(ctx, previewId, reason === 'expired' ? 'expired' : 'stopped', reason === 'archived' ? 'Proje arşivlendi' : undefined);
  return { ok: true };
}

/* Previews survive worker restarts: server previews owned by a previous worker process are restarted. */
registerLifecycle({
  start: async (ctx) => {
    const orphaned = await ctx.db
      .select({ id: previews.id, organizationId: previews.organizationId, projectId: previews.projectId, processId: previews.processId })
      .from(previews)
      .where(and(eq(previews.kind, 'process'), inArray(previews.status, ['starting', 'ready'])));
    for (const p of orphaned) {
      if (p.processId) killTree(p.processId);
      await ctx.db.update(previews).set({ status: 'queued', processId: null }).where(eq(previews.id, p.id));
      await enqueue(ctx.db, { queue: QUEUES.preview, type: 'preview.start', projectId: p.projectId, organizationId: p.organizationId, payload: { previewId: p.id }, dedupeKey: `preview-start:${p.id}` });
    }
    if (orphaned.length) ctx.logger.info({ count: orphaned.length }, 'restarting server previews after worker restart');
  },
  stop: async () => {
    for (const child of running.values()) killTree(child);
  },
});

registerPeriodic({
  name: 'expire-previews',
  everyMinutes: 1,
  run: async (ctx) => {
    const due = await ctx.db
      .select({ id: previews.id })
      .from(previews)
      .where(and(inArray(previews.status, ['queued', 'starting', 'ready', 'failed']), lt(previews.expiresAt, new Date())));
    for (const p of due) await stopPreviewNow(ctx, p.id, 'expired');
    return due.length;
  },
});
