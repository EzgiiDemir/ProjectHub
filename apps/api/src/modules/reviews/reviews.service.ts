import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { ReviewCapabilities } from '@projecthub/contracts';
import {
  audit,
  decryptFromString,
  emitDomainEvent,
  encryptToString,
  forbidden,
  hashPassword,
  nextNumber,
  notFound,
  precondition,
  publish,
  randomToken,
  sha256,
  timeline,
  type Actor,
  retainPreviewArtifact,
} from '@projecthub/core';
import { artifacts, builds, feedback, previews, reviewMessages, reviewSessions, reviewVisitors, users, type Executor } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';

export type ReviewRow = typeof reviewSessions.$inferSelect;

export function reviewStatus(r: ReviewRow): 'active' | 'expired' | 'revoked' {
  if (r.revokedAt) return 'revoked';
  if (r.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'active';
}

@Injectable()
export class ReviewsService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
  ) {}

  reviewUrl(r: ReviewRow): string {
    const token = decryptFromString(this.ctx.config.encryptionKey, r.tokenEncrypted);
    return `${this.ctx.config.REVIEW_BASE_URL.replace(/\/$/, '')}/${token}`;
  }

  private present(r: ReviewRow, canShare: boolean, extra: Record<string, unknown> = {}) {
    return {
      id: r.id,
      key: `RV-${r.number}`,
      number: r.number,
      projectId: r.projectId,
      previewId: r.previewId,
      name: r.name,
      versionLabel: r.versionLabel,
      capabilities: r.capabilities,
      passwordProtected: !!r.passwordHash,
      status: reviewStatus(r),
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      lastAccessAt: r.lastAccessAt,
      accessCount: r.accessCount,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
      url: canShare ? this.reviewUrl(r) : null,
      ...extra,
    };
  }

  async list(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const rows = await this.ctx.db.select().from(reviewSessions).where(eq(reviewSessions.projectId, scope.project.id)).orderBy(desc(reviewSessions.createdAt));
    const ids = rows.map((r) => r.id);
    const fb = ids.length ? await this.ctx.db.select({ id: feedback.reviewSessionId, n: count() }).from(feedback).where(inArray(feedback.reviewSessionId, ids)).groupBy(feedback.reviewSessionId) : [];
    const vis = ids.length ? await this.ctx.db.select({ id: reviewVisitors.reviewSessionId, n: count() }).from(reviewVisitors).where(inArray(reviewVisitors.reviewSessionId, ids)).groupBy(reviewVisitors.reviewSessionId) : [];
    return rows.map((r) =>
      this.present(r, scope.can('review.create'), { feedbackCount: fb.find((x) => x.id === r.id)?.n ?? 0, visitorCount: vis.find((x) => x.id === r.id)?.n ?? 0 }),
    );
  }

  /** Spec §56–57: temporary, unguessable link; customers need no account. Token stored hashed (+ encrypted for re-sharing). */
  async create(
    auth: AuthInfo,
    idOrSlug: string,
    input: { previewId: string; name: string; expiresInMinutes?: number; expiresAt?: string; password?: string; capabilities: ReviewCapabilities },
    actor: Actor,
  ) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'review.create');
    const pv = (await this.ctx.db.select().from(previews).where(and(eq(previews.id, input.previewId), eq(previews.projectId, scope.project.id))))[0];
    if (!pv) throw notFound('Ön izleme');
    if (pv.status !== 'ready') throw precondition('Kullanıcı linki yalnızca hazır (çalışan) bir ön izleme için oluşturulabilir');
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(Date.now() + input.expiresInMinutes! * 60_000);
    if (expiresAt.getTime() <= Date.now() + 5 * 60_000) throw precondition('Bitiş zamanı en az 5 dakika sonrası olmalı');
    const build = (await this.ctx.db.select().from(builds).where(eq(builds.id, pv.buildId)))[0];
    const token = randomToken(24);
    const passwordHash = input.password ? await hashPassword(input.password) : null;
    const row = await this.ctx.db.transaction(async (tx) => {
      const number = await nextNumber(tx, auth.organizationId, 'review');
      const r = (
        await tx
          .insert(reviewSessions)
          .values({
            organizationId: auth.organizationId,
            projectId: scope.project.id,
            previewId: pv.id,
            number,
            name: input.name,
            versionLabel: scope.project.currentVersion ? `v${scope.project.currentVersion}` : build ? `build #${build.number}` : '',
            tokenHash: sha256(token),
            tokenEncrypted: encryptToString(this.ctx.config.encryptionKey, token),
            passwordHash,
            capabilities: input.capabilities,
            expiresAt,
            createdBy: auth.user.id,
          })
          .returning()
      )[0]!;
      await this.keepPreviewAlive(tx, pv.id, pv.buildId, expiresAt);
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'review.created', resourceType: 'review', resourceId: r.id, metadata: { name: r.name, expiresAt, password: !!passwordHash } });
      await timeline(tx, {
        organizationId: auth.organizationId,
        projectId: scope.project.id,
        kind: 'review',
        tone: 'run',
        title: `Kullanıcı linki oluşturuldu: RV-${number}`,
        description: `${r.name} · ${expiresAt.toLocaleString('tr-TR')} tarihine kadar`,
        refType: 'review',
        refId: r.id,
        actorLabel: actor.label,
      });
      await emitDomainEvent(tx, { event: 'review.created', organizationId: auth.organizationId, projectId: scope.project.id, actor, data: { reviewId: r.id, name: r.name } });
      return r;
    });
    return this.present(row, true);
  }

  /** The preview (and its artifact) must live at least as long as the review link. */
  private async keepPreviewAlive(tx: Executor, previewId: string, buildId: string, until: Date) {
    await tx.update(previews).set({ expiresAt: until }).where(and(eq(previews.id, previewId), lt(previews.expiresAt, until)));
    const b = (await tx.select({ a: builds.artifactId, org: builds.organizationId }).from(builds).where(eq(builds.id, buildId)))[0];
    if (b?.a) await retainPreviewArtifact(tx, b.org, b.a, until);
  }

  private async load(auth: AuthInfo, reviewId: string) {
    const r = (await this.ctx.db.select().from(reviewSessions).where(and(eq(reviewSessions.id, reviewId), eq(reviewSessions.organizationId, auth.organizationId))))[0];
    if (!r) throw notFound('Kullanıcı linki');
    const scope = await this.access.require(auth, r.projectId);
    return { r, scope };
  }

  async get(auth: AuthInfo, reviewId: string) {
    const { r, scope } = await this.load(auth, reviewId);
    const visitors = await this.ctx.db.select().from(reviewVisitors).where(eq(reviewVisitors.reviewSessionId, r.id)).orderBy(desc(reviewVisitors.lastSeenAt));
    const pv = (await this.ctx.db.select().from(previews).where(eq(previews.id, r.previewId)))[0];
    return this.present(r, scope.can('review.create'), {
      visitors: visitors.map((v) => ({ id: v.id, firstName: v.firstName, lastName: v.lastName, department: v.department, company: v.company, email: v.email, lastSeenAt: v.lastSeenAt, createdAt: v.createdAt })),
      preview: pv ? { id: pv.id, slug: pv.slug, status: pv.status, expiresAt: pv.expiresAt, sourceBranch: pv.sourceBranch } : null,
    });
  }

  async revoke(auth: AuthInfo, reviewId: string, actor: Actor) {
    const { r, scope } = await this.load(auth, reviewId);
    if (!scope.can('review.create')) throw forbidden();
    if (r.revokedAt) return this.present(r, true);
    const row = (await this.ctx.db.update(reviewSessions).set({ revokedAt: new Date(), revokedBy: auth.user.id }).where(eq(reviewSessions.id, r.id)).returning())[0]!;
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: r.projectId, actor, action: 'review.revoked', resourceType: 'review', resourceId: r.id });
    await timeline(this.ctx.db, { organizationId: auth.organizationId, projectId: r.projectId, kind: 'review', title: `Kullanıcı linki kapatıldı: RV-${r.number}`, actorLabel: actor.label, refType: 'review', refId: r.id });
    await publish(this.ctx.db, { type: 'review.updated', organizationId: auth.organizationId, projectId: r.projectId, id: r.id, data: { reviewSessionId: r.id } });
    return this.present(row, true);
  }

  async extend(auth: AuthInfo, reviewId: string, hours: number, actor: Actor) {
    const { r, scope } = await this.load(auth, reviewId);
    if (!scope.can('review.create')) throw forbidden();
    if (r.revokedAt) throw precondition('Kapatılmış bağlantının süresi uzatılamaz');
    const expiresAt = new Date(Math.max(Date.now(), r.expiresAt.getTime()) + hours * 3600_000);
    await this.ctx.db.transaction(async (tx) => {
      await tx.update(reviewSessions).set({ expiresAt }).where(eq(reviewSessions.id, r.id));
      const pv = (await tx.select().from(previews).where(eq(previews.id, r.previewId)))[0];
      if (pv) await this.keepPreviewAlive(tx, pv.id, pv.buildId, expiresAt);
      await audit(tx, { organizationId: auth.organizationId, projectId: r.projectId, actor, action: 'review.extended', resourceType: 'review', resourceId: r.id, metadata: { expiresAt } });
    });
    return { expiresAt };
  }

  /** Spec §67: re-review in the same session — point the link at a newer preview ("Yeni sürüm hazır"). */
  async switchPreview(auth: AuthInfo, reviewId: string, previewId: string, actor: Actor) {
    const { r, scope } = await this.load(auth, reviewId);
    if (!scope.can('review.create')) throw forbidden();
    const pv = (await this.ctx.db.select().from(previews).where(and(eq(previews.id, previewId), eq(previews.projectId, r.projectId))))[0];
    if (!pv || pv.status !== 'ready') throw precondition('Seçilen ön izleme hazır değil');
    const b = (await this.ctx.db.select().from(builds).where(eq(builds.id, pv.buildId)))[0];
    const label = scope.project.currentVersion ? `v${scope.project.currentVersion} · build #${b?.number}` : `build #${b?.number}`;
    await this.ctx.db.transaction(async (tx) => {
      await tx.update(reviewSessions).set({ previewId: pv.id, versionLabel: label }).where(eq(reviewSessions.id, r.id));
      await this.keepPreviewAlive(tx, pv.id, pv.buildId, r.expiresAt);
      await audit(tx, { organizationId: auth.organizationId, projectId: r.projectId, actor, action: 'review.preview_switched', resourceType: 'review', resourceId: r.id, metadata: { previewId } });
      await timeline(tx, { organizationId: auth.organizationId, projectId: r.projectId, kind: 'review', tone: 'run', title: `RV-${r.number}: kullanıcıya yeni sürüm sunuldu`, description: label, actorLabel: actor.label, refType: 'review', refId: r.id });
      await publish(tx, { type: 'review.updated', organizationId: auth.organizationId, projectId: r.projectId, id: r.id, data: { reviewSessionId: r.id, newVersion: true } });
    });
    return this.get(auth, reviewId);
  }

  /* ---------------- live support chat (team side) ---------------- */

  async messages(auth: AuthInfo, reviewId: string) {
    const { r } = await this.load(auth, reviewId);
    return this.listMessages(r.id);
  }

  async listMessages(reviewSessionId: string) {
    const rows = await this.ctx.db
      .select({ m: reviewMessages, v: reviewVisitors, u: users.displayName })
      .from(reviewMessages)
      .leftJoin(reviewVisitors, eq(reviewVisitors.id, reviewMessages.visitorId))
      .leftJoin(users, eq(users.id, reviewMessages.userId))
      .where(eq(reviewMessages.reviewSessionId, reviewSessionId))
      .orderBy(reviewMessages.createdAt)
      .limit(500);
    return rows.map((x) => ({
      id: x.m.id,
      authorType: x.m.authorType,
      author: x.m.authorType === 'customer' ? `${x.v?.firstName ?? ''} ${x.v?.lastName ?? ''}`.trim() : (x.u ?? 'Ekip'),
      department: x.v?.department ?? null,
      body: x.m.body,
      createdAt: x.m.createdAt,
    }));
  }

  async reply(auth: AuthInfo, reviewId: string, body: string, actor: Actor) {
    const { r, scope } = await this.load(auth, reviewId);
    if (!scope.can('review.create') && !scope.can('feedback.manage')) throw forbidden();
    if (reviewStatus(r) !== 'active') throw precondition('Bağlantı aktif değil; kullanıcı mesajı göremez');
    await this.ctx.db.insert(reviewMessages).values({ reviewSessionId: r.id, authorType: 'user', userId: auth.user.id, body });
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: r.projectId, actor, action: 'review.message_sent', resourceType: 'review', resourceId: r.id });
    await publish(this.ctx.db, { type: 'review.message', organizationId: auth.organizationId, projectId: r.projectId, id: r.id, data: { reviewSessionId: r.id } });
    return this.listMessages(r.id);
  }

  async unreadCustomerMessages(projectId: string) {
    const r = await this.ctx.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM review_messages m JOIN review_sessions s ON s.id = m.review_session_id
      WHERE s.project_id = ${projectId} AND m.author_type = 'customer' AND m.created_at > now() - interval '7 days'`);
    return r.rows[0]?.n ?? 0;
  }
}
