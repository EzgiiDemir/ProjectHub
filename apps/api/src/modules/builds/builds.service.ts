import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  audit,
  enqueue,
  forbidden,
  invalid,
  nextNumber,
  notFound,
  precondition,
  previewSlug,
  previewUrl,
  publish,
  QUEUES,
  signPreviewTicket,
  timeline,
  type Actor,
} from '@projecthub/core';
import { durationToMinutes } from '@projecthub/contracts';
import { artifacts, builds, buildSteps, deviceProfiles, previews, projectManifests, responsiveTestResults, responsiveTests, users } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { Paged } from '../../infra/http.js';
import { ProjectAccess } from '../../infra/project-access.js';
import { Repos } from '../../infra/repos.js';

@Injectable()
export class BuildsService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
    private readonly repos: Repos,
  ) {}

  async list(auth: AuthInfo, idOrSlug: string, q: { cursor?: number; limit: number; branch?: string }) {
    const scope = await this.access.require(auth, idOrSlug);
    const conds = [eq(builds.projectId, scope.project.id)];
    if (q.cursor) conds.push(lt(builds.number, q.cursor));
    if (q.branch) conds.push(eq(builds.branch, q.branch));
    const rows = await this.ctx.db
      .select({ b: builds, by: users.displayName })
      .from(builds)
      .leftJoin(users, eq(users.id, builds.triggeredBy))
      .where(and(...conds))
      .orderBy(desc(builds.number))
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit).map((r) => ({ ...publicBuild(r.b), triggeredByName: r.b.triggeredByType === 'ai' ? 'AI Agent' : r.by }));
    return new Paged(page, { hasMore, nextCursor: hasMore ? String(page.at(-1)!.number) : null });
  }

  /** Queues a build of a branch head (or a specific commit). Long work happens in the worker; returns immediately. */
  async create(auth: AuthInfo, idOrSlug: string, input: { branch?: string; commitSha?: string; createPreview: boolean }, actor: Actor, trigger = 'manual') {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'build.create');
    if (input.createPreview && !scope.can('preview.create')) throw forbidden('Ön izleme oluşturma yetkiniz yok');
    const { git } = await this.repos.forProject(scope.project.id);
    const branch = input.branch ?? scope.project.defaultBranch;
    const sha = input.commitSha ?? (await git.resolve(`refs/heads/${branch}`));
    if (!sha) throw notFound(`"${branch}" branch'i`);
    if (input.commitSha && !(await git.resolve(input.commitSha))) throw notFound('Commit');
    const info = await git.commitInfo(sha);
    return this.ctx.db.transaction(async (tx) => {
      const number = await nextNumber(tx, scope.project.id, 'build');
      const b = (
        await tx
          .insert(builds)
          .values({
            organizationId: auth.organizationId,
            projectId: scope.project.id,
            number,
            branch,
            commitSha: sha,
            commitMessage: info?.subject ?? '',
            trigger,
            triggeredByType: actor.type === 'ai' ? 'ai' : 'user',
            triggeredBy: actor.type === 'user' ? auth.user.id : null,
            createPreview: input.createPreview,
          })
          .returning()
      )[0]!;
      await enqueue(tx, { queue: QUEUES.build, type: 'build.execute', organizationId: auth.organizationId, projectId: scope.project.id, maxAttempts: 1, payload: { buildId: b.id } });
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'build.created', resourceType: 'build', resourceId: b.id, metadata: { number, branch, sha } });
      await timeline(tx, {
        organizationId: auth.organizationId,
        projectId: scope.project.id,
        kind: 'build',
        tone: 'run',
        title: `Build #${number} kuyruğa alındı`,
        description: `${branch} · ${sha.slice(0, 7)} ${info?.subject ?? ''}`,
        refType: 'build',
        refId: b.id,
        actorLabel: actor.label,
      });
      await publish(tx, { type: 'build.updated', organizationId: auth.organizationId, projectId: scope.project.id, id: b.id });
      return publicBuild(b);
    });
  }

  private async loadBuild(auth: AuthInfo, buildId: string) {
    const b = (await this.ctx.db.select().from(builds).where(and(eq(builds.id, buildId), eq(builds.organizationId, auth.organizationId))))[0];
    if (!b) throw notFound('Build');
    const scope = await this.access.require(auth, b.projectId);
    return { b, scope };
  }

  async get(auth: AuthInfo, buildId: string) {
    const { b, scope } = await this.loadBuild(auth, buildId);
    const steps = await this.ctx.db.select().from(buildSteps).where(eq(buildSteps.buildId, b.id)).orderBy(asc(buildSteps.seq));
    const artifact = b.artifactId ? (await this.ctx.db.select().from(artifacts).where(eq(artifacts.id, b.artifactId)))[0] : null;
    const pvs = await this.ctx.db.select().from(previews).where(eq(previews.buildId, b.id)).orderBy(desc(previews.createdAt));
    const by = b.triggeredBy ? (await this.ctx.db.select({ n: users.displayName }).from(users).where(eq(users.id, b.triggeredBy)))[0]?.n : null;
    return {
      ...publicBuild(b),
      manifest: b.manifest,
      aiAnalysis: b.aiAnalysis,
      triggeredByName: b.triggeredByType === 'ai' ? 'AI Agent' : by ?? null,
      project: { id: scope.project.id, slug: scope.project.slug, name: scope.project.name },
      steps,
      artifact: artifact ? { id: artifact.id, sizeBytes: artifact.sizeBytes, retentionUntil: artifact.retentionUntil, available: await this.ctx.storage.exists(artifact.storageKey) } : null,
      previews: pvs.map((p) => this.publicPreview(p)),
    };
  }

  /** Returns log text from `offset` (bytes) so clients can tail incrementally. */
  async log(auth: AuthInfo, buildId: string, offset: number) {
    const { b } = await this.loadBuild(auth, buildId);
    if (!b.logKey) return { text: '', offset: 0, done: !['queued', 'running'].includes(b.status) };
    const file = this.ctx.storage.resolve(b.logKey);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return { text: '', offset: 0, done: !['queued', 'running'].includes(b.status) };
    }
    const start = Math.min(offset, size);
    const len = Math.min(size - start, 512 * 1024);
    const buf = Buffer.alloc(len);
    if (len > 0) {
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, len, start);
      fs.closeSync(fd);
    }
    return { text: buf.toString('utf8'), offset: start + len, size, done: !['queued', 'running'].includes(b.status) };
  }

  async cancel(auth: AuthInfo, buildId: string, actor: Actor) {
    const { b, scope } = await this.loadBuild(auth, buildId);
    if (!scope.can('build.create')) throw forbidden('Build iptal etme yetkiniz yok');
    if (!['queued', 'running'].includes(b.status)) throw precondition('Build zaten tamamlanmış');
    await this.ctx.db.update(builds).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(builds.id, b.id));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: b.projectId, actor, action: 'build.cancelled', resourceType: 'build', resourceId: b.id });
    await publish(this.ctx.db, { type: 'build.updated', organizationId: auth.organizationId, projectId: b.projectId, id: b.id });
  }

  async retry(auth: AuthInfo, buildId: string, actor: Actor) {
    const { b } = await this.loadBuild(auth, buildId);
    return this.create(auth, b.projectId, { branch: b.branch, commitSha: b.commitSha, createPreview: b.createPreview }, actor, 'retry');
  }

  /* ---------------- previews ---------------- */

  publicPreview(p: typeof previews.$inferSelect) {
    return {
      id: p.id,
      projectId: p.projectId,
      buildId: p.buildId,
      slug: p.slug,
      kind: p.kind,
      status: p.status,
      sourceBranch: p.sourceBranch,
      sourceCommit: p.sourceCommit,
      error: p.error,
      expiresAt: p.expiresAt,
      stoppedAt: p.stoppedAt,
      createdAt: p.createdAt,
      createdBy: p.createdBy,
      url: previewUrl(this.ctx.config.PREVIEW_PUBLIC_URL_TEMPLATE, p.slug),
    };
  }

  async listPreviews(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const rows = await this.ctx.db
      .select({ p: previews, buildNumber: builds.number, by: users.displayName })
      .from(previews)
      .innerJoin(builds, eq(builds.id, previews.buildId))
      .leftJoin(users, eq(users.id, previews.createdBy))
      .where(eq(previews.projectId, scope.project.id))
      .orderBy(desc(previews.createdAt))
      .limit(100);
    return rows.map((r) => ({ ...this.publicPreview(r.p), buildNumber: r.buildNumber, createdByName: r.by }));
  }

  async createPreview(auth: AuthInfo, idOrSlug: string, input: { buildId: string; ttlMinutes?: number }, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'preview.create');
    const b = (await this.ctx.db.select().from(builds).where(and(eq(builds.id, input.buildId), eq(builds.projectId, scope.project.id))))[0];
    if (!b) throw notFound('Build');
    if (b.status !== 'passed') throw precondition('Yalnızca başarılı build\'lerden ön izleme oluşturulabilir');
    const manifest = b.manifest ?? (await this.ctx.db.select().from(projectManifests).where(eq(projectManifests.projectId, scope.project.id)).orderBy(desc(projectManifests.version)).limit(1))[0]?.content;
    const ttl = input.ttlMinutes ?? (manifest ? durationToMinutes(manifest.preview.ttl) : 1440);
    return this.ctx.db.transaction(async (tx) => {
      const row = (
        await tx
          .insert(previews)
          .values({
            organizationId: auth.organizationId,
            projectId: scope.project.id,
            buildId: b.id,
            slug: previewSlug(scope.project.slug, b.number),
            kind: b.outputKind === 'process' ? 'process' : 'static',
            spa: manifest?.preview.spa ?? false,
            sourceBranch: b.branch,
            sourceCommit: b.commitSha,
            expiresAt: new Date(Date.now() + ttl * 60_000),
            createdBy: auth.user.id,
          })
          .returning()
      )[0]!;
      await enqueue(tx, { queue: QUEUES.preview, type: 'preview.start', organizationId: auth.organizationId, projectId: scope.project.id, payload: { previewId: row.id } });
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'preview.created', resourceType: 'preview', resourceId: row.id, metadata: { buildId: b.id, ttlMinutes: ttl } });
      await publish(tx, { type: 'preview.updated', organizationId: auth.organizationId, projectId: scope.project.id, id: row.id });
      return this.publicPreview(row);
    });
  }

  private async loadPreview(auth: AuthInfo, previewId: string) {
    const p = (await this.ctx.db.select().from(previews).where(and(eq(previews.id, previewId), eq(previews.organizationId, auth.organizationId))))[0];
    if (!p) throw notFound('Ön izleme');
    const scope = await this.access.require(auth, p.projectId);
    return { p, scope };
  }

  async getPreview(auth: AuthInfo, previewId: string) {
    const { p } = await this.loadPreview(auth, previewId);
    return this.publicPreview(p);
  }

  async stopPreview(auth: AuthInfo, previewId: string, actor: Actor) {
    const { p, scope } = await this.loadPreview(auth, previewId);
    if (!scope.can('preview.delete')) throw forbidden('Ön izleme durdurma yetkiniz yok');
    if (['stopped', 'expired'].includes(p.status)) return this.publicPreview(p);
    await enqueue(this.ctx.db, { queue: QUEUES.preview, type: 'preview.stop', organizationId: auth.organizationId, projectId: p.projectId, payload: { previewId: p.id } });
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: p.projectId, actor, action: 'preview.stop_requested', resourceType: 'preview', resourceId: p.id });
    return this.publicPreview(p);
  }

  async extendPreview(auth: AuthInfo, previewId: string, hours: number, actor: Actor) {
    const { p, scope } = await this.loadPreview(auth, previewId);
    if (!scope.can('preview.create')) throw forbidden();
    if (!['ready', 'starting', 'queued'].includes(p.status)) throw precondition('Yalnızca çalışan ön izlemelerin süresi uzatılabilir');
    const expiresAt = new Date(Math.max(Date.now(), p.expiresAt.getTime()) + hours * 3600_000);
    await this.ctx.db.update(previews).set({ expiresAt }).where(eq(previews.id, p.id));
    if (p.buildId) {
      const b = (await this.ctx.db.select({ a: builds.artifactId }).from(builds).where(eq(builds.id, p.buildId)))[0];
      if (b?.a) await this.ctx.db.update(artifacts).set({ retentionUntil: expiresAt }).where(and(eq(artifacts.id, b.a), lt(artifacts.retentionUntil, expiresAt)));
    }
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: p.projectId, actor, action: 'preview.extended', resourceType: 'preview', resourceId: p.id, metadata: { expiresAt } });
    return { expiresAt };
  }

  /** Signed link that opens the preview in a browser (sets an access cookie on the preview host). */
  async accessUrl(auth: AuthInfo, previewId: string, path = '/') {
    const { p } = await this.loadPreview(auth, previewId);
    if (p.status !== 'ready') throw precondition('Ön izleme hazır değil');
    const ticket = signPreviewTicket(this.ctx.config.encryptionKey, { previewId: p.id, subject: `user:${auth.user.id}`, ttlSeconds: 12 * 3600 });
    const base = previewUrl(this.ctx.config.PREVIEW_PUBLIC_URL_TEMPLATE, p.slug);
    return { url: `${base}/__ph/auth?ticket=${encodeURIComponent(ticket)}&next=${encodeURIComponent(path.startsWith('/') ? path : '/')}`, expiresInSeconds: 12 * 3600 };
  }

  async previewLogs(auth: AuthInfo, previewId: string) {
    const { p } = await this.loadPreview(auth, previewId);
    const key = this.ctx.storage.previewLogKey(p.projectId, p.id);
    try {
      const text = fs.readFileSync(this.ctx.storage.resolve(key), 'utf8');
      return { text: text.slice(-200_000) };
    } catch {
      return { text: '' };
    }
  }

  /* ---------------- responsive tests (simulator "Test all devices") ---------------- */

  async createResponsiveTest(auth: AuthInfo, idOrSlug: string, input: { previewId: string; deviceKeys?: string[]; paths: string[]; baselineTestId?: string }, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'preview.create');
    const pv = (await this.ctx.db.select().from(previews).where(and(eq(previews.id, input.previewId), eq(previews.projectId, scope.project.id))))[0];
    if (!pv) throw notFound('Ön izleme');
    if (pv.status !== 'ready') throw precondition('Test için ön izleme çalışıyor olmalı');
    if (input.baselineTestId) {
      const b = (await this.ctx.db.select().from(responsiveTests).where(and(eq(responsiveTests.id, input.baselineTestId), eq(responsiveTests.projectId, scope.project.id))))[0];
      if (!b) throw notFound('Karşılaştırma testi');
    }
    return this.ctx.db.transaction(async (tx) => {
      const t = (
        await tx
          .insert(responsiveTests)
          .values({ organizationId: auth.organizationId, projectId: scope.project.id, previewId: pv.id, baselineTestId: input.baselineTestId ?? null, paths: input.paths, createdBy: auth.user.id })
          .returning()
      )[0]!;
      await enqueue(tx, { queue: QUEUES.browser, type: 'responsive.test', organizationId: auth.organizationId, projectId: scope.project.id, maxAttempts: 1, payload: { testId: t.id, deviceKeys: input.deviceKeys ?? null } });
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'responsive_test.created', resourceType: 'responsive_test', resourceId: t.id });
      await publish(tx, { type: 'responsive.updated', organizationId: auth.organizationId, projectId: scope.project.id, id: t.id });
      return t;
    });
  }

  async listResponsiveTests(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    return this.ctx.db
      .select({ t: responsiveTests, previewSlug: previews.slug, buildNumber: builds.number })
      .from(responsiveTests)
      .innerJoin(previews, eq(previews.id, responsiveTests.previewId))
      .innerJoin(builds, eq(builds.id, previews.buildId))
      .where(eq(responsiveTests.projectId, scope.project.id))
      .orderBy(desc(responsiveTests.createdAt))
      .limit(50)
      .then((rows) => rows.map((r) => ({ ...r.t, previewSlug: r.previewSlug, buildNumber: r.buildNumber })));
  }

  async getResponsiveTest(auth: AuthInfo, testId: string) {
    const t = (await this.ctx.db.select().from(responsiveTests).where(and(eq(responsiveTests.id, testId), eq(responsiveTests.organizationId, auth.organizationId))))[0];
    if (!t) throw notFound('Test');
    await this.access.require(auth, t.projectId);
    const results = await this.ctx.db.select().from(responsiveTestResults).where(eq(responsiveTestResults.testId, t.id)).orderBy(asc(responsiveTestResults.createdAt));
    return { ...t, results };
  }

  async deviceProfiles() {
    return this.ctx.db.select().from(deviceProfiles).where(eq(deviceProfiles.isActive, true)).orderBy(asc(deviceProfiles.sort));
  }

  async runningCounts(organizationId: string) {
    const r = await this.ctx.db
      .select({ status: previews.status, n: sql<number>`count(*)::int` })
      .from(previews)
      .where(and(eq(previews.organizationId, organizationId), inArray(previews.status, ['ready', 'starting'])))
      .groupBy(previews.status);
    return r;
  }
}

export function publicBuild(b: typeof builds.$inferSelect) {
  return {
    id: b.id,
    projectId: b.projectId,
    number: b.number,
    branch: b.branch,
    commitSha: b.commitSha,
    commitMessage: b.commitMessage,
    trigger: b.trigger,
    triggeredByType: b.triggeredByType,
    triggeredBy: b.triggeredBy,
    status: b.status,
    error: b.error,
    outputKind: b.outputKind,
    createPreview: b.createPreview,
    startedAt: b.startedAt,
    finishedAt: b.finishedAt,
    durationMs: b.durationMs,
    createdAt: b.createdAt,
  };
}
