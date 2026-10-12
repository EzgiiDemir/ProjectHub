import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Request } from 'express';
import {
  AppError,
  audit,
  emitDomainEvent,
  forbidden,
  notFound,
  precondition,
  previewUrl,
  publish,
  randomToken,
  sha256,
  signPreviewTicket,
  timeline,
  verifyPassword,
  type Actor,
} from '@projecthub/core';
import {
  artifacts,
  builds,
  deviceProfiles,
  feedback,
  feedbackAttachments,
  feedbackComments,
  previews,
  projects,
  reviewMessages,
  reviewSessions,
  reviewVisitors,
  users,
  versions,
} from '@projecthub/database';
import { Ctx, clientIp } from '../../infra/context.js';
import { parseCookies } from '../../infra/http.js';
import { insertFeedback } from '../reviews/feedback.service.js';
import { ReviewsService, reviewStatus, type ReviewRow } from '../reviews/reviews.service.js';
import { describeUserAgent } from '../reviews/ua.js';
import { organizationLogo, projectBrandingOf } from '../branding/branding.service.js';

export const visitorCookie = (r: ReviewRow) => `ph_rv_${r.id.replace(/-/g, '').slice(-12)}`;

@Injectable()
export class PublicReviewService {
  constructor(
    private readonly ctx: Ctx,
    private readonly reviews: ReviewsService,
  ) {}

  async session(token: string): Promise<ReviewRow> {
    if (!/^[A-Za-z0-9]{16,64}$/.test(token)) throw notFound('İnceleme bağlantısı');
    const r = (await this.ctx.db.select().from(reviewSessions).where(eq(reviewSessions.tokenHash, sha256(token))))[0];
    if (!r) throw notFound('İnceleme bağlantısı');
    return r;
  }

  private async active(token: string): Promise<ReviewRow> {
    const r = await this.session(token);
    const status = reviewStatus(r);
    if (status !== 'active') {
      throw new AppError('REVIEW_EXPIRED', status === 'revoked' ? 'Bu inceleme bağlantısı proje ekibi tarafından kapatıldı.' : 'Bu inceleme bağlantısının süresi doldu.');
    }
    return r;
  }

  async visitor(req: Request, r: ReviewRow) {
    const raw = parseCookies(req.headers.cookie)[visitorCookie(r)];
    if (!raw) return null;
    const v = (await this.ctx.db.select().from(reviewVisitors).where(and(eq(reviewVisitors.tokenHash, sha256(raw)), eq(reviewVisitors.reviewSessionId, r.id))))[0];
    if (v && Date.now() - v.lastSeenAt.getTime() > 60_000) {
      await this.ctx.db.update(reviewVisitors).set({ lastSeenAt: new Date() }).where(eq(reviewVisitors.id, v.id));
    }
    return v ?? null;
  }

  private async requireVisitor(req: Request, token: string) {
    const r = await this.active(token);
    const v = await this.visitor(req, r);
    if (!v) throw new AppError('UNAUTHENTICATED', 'Devam etmek için adınızı ve biriminizi girin');
    return { r, v, actor: { type: 'customer', id: null, label: `${v.firstName} ${v.lastName} · ${v.department}`, ip: clientIp(req), userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500) } as Actor };
  }

  /** Landing information. Expired/revoked links still answer (with the team contact), never the preview. */
  async describe(req: Request, token: string) {
    const r = await this.session(token);
    const p = (await this.ctx.db.select().from(projects).where(eq(projects.id, r.projectId)))[0]!;
    const creator = r.createdBy ? (await this.ctx.db.select({ displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, r.createdBy)))[0] : null;
    const status = reviewStatus(r);
    const v = status === 'active' ? await this.visitor(req, r) : null;
    const brand = projectBrandingOf(p.settings);
    return {
      status,
      project: { name: p.name, customerName: p.customerName, color: p.color, short: p.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() },
      branding: { companyLogo: await organizationLogo(this.ctx.db, r.organizationId), projectLogo: brand.logo, customerLogo: brand.customerLogo, accent: brand.accent },
      review: { name: r.name, versionLabel: r.versionLabel, expiresAt: r.expiresAt, capabilities: r.capabilities, passwordRequired: !!r.passwordHash },
      contact: creator ? { name: creator.displayName, email: creator.email } : null,
      visitor: v ? { firstName: v.firstName, lastName: v.lastName, department: v.department, company: v.company, email: v.email } : null,
    };
  }

  async identify(req: Request, token: string, input: { firstName: string; lastName: string; department: string; company: string; email: string; password?: string }) {
    const r = await this.active(token);
    if (r.passwordHash && !(await verifyPassword(r.passwordHash, input.password ?? ''))) {
      throw new AppError('REVIEW_PASSWORD_REQUIRED', 'Şifre hatalı');
    }
    const raw = randomToken(40);
    const v = (
      await this.ctx.db
        .insert(reviewVisitors)
        .values({
          reviewSessionId: r.id,
          firstName: input.firstName,
          lastName: input.lastName,
          department: input.department,
          company: input.company,
          email: input.email,
          tokenHash: sha256(raw),
          ipAddress: clientIp(req),
          userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500),
        })
        .returning()
    )[0]!;
    await this.ctx.db.update(reviewSessions).set({ accessCount: sql`${reviewSessions.accessCount} + 1`, lastAccessAt: new Date() }).where(eq(reviewSessions.id, r.id));
    const actor: Actor = { type: 'customer', id: null, label: `${v.firstName} ${v.lastName} · ${v.department}`, ip: clientIp(req) };
    await audit(this.ctx.db, { organizationId: r.organizationId, projectId: r.projectId, actor, action: 'review.visitor_joined', resourceType: 'review', resourceId: r.id, metadata: { company: v.company } });
    await timeline(this.ctx.db, { organizationId: r.organizationId, projectId: r.projectId, kind: 'review', title: `RV-${r.number} açıldı — ${v.firstName} ${v.lastName} (${v.department})`, actorLabel: actor.label, refType: 'review', refId: r.id });
    return { cookieName: visitorCookie(r), cookieValue: raw, expires: r.expiresAt };
  }

  /** Everything the portal needs to render: signed preview URL, devices, and whether a newer version is up. */
  async workspace(req: Request, token: string) {
    const { r } = await this.requireVisitor(req, token);
    const pv = (await this.ctx.db.select().from(previews).where(eq(previews.id, r.previewId)))[0];
    if (!pv) throw precondition('Ön izleme bulunamadı');
    await this.ctx.db.update(reviewSessions).set({ lastAccessAt: new Date(), accessCount: sql`${reviewSessions.accessCount} + 1` }).where(eq(reviewSessions.id, r.id));
    const ttl = Math.max(60, Math.floor((r.expiresAt.getTime() - Date.now()) / 1000));
    const ticket = signPreviewTicket(this.ctx.config.encryptionKey, { previewId: pv.id, subject: `review:${r.id}`, ttlSeconds: Math.min(ttl, 12 * 3600) });
    const base = previewUrl(this.ctx.config.PREVIEW_PUBLIC_URL_TEMPLATE, pv.slug);
    const devices = r.capabilities.deviceSwitch ? await this.ctx.db.select().from(deviceProfiles).where(eq(deviceProfiles.isActive, true)).orderBy(asc(deviceProfiles.sort)) : [];
    return {
      preview: { status: pv.status, previewOrigin: base, entryUrl: `${base}/__ph/auth?ticket=${encodeURIComponent(ticket)}&next=/` },
      versionLabel: r.versionLabel,
      devices: devices.map((d) => ({ key: d.key, name: d.name, category: d.category, width: d.width, height: d.height })),
      appOrigin: new URL(this.ctx.config.APP_URL).origin,
    };
  }

  async listFeedback(req: Request, token: string) {
    const { r, v } = await this.requireVisitor(req, token);
    const rows = await this.ctx.db
      .select({ f: feedback, rv: reviewVisitors })
      .from(feedback)
      .leftJoin(reviewVisitors, eq(reviewVisitors.id, feedback.reporterVisitorId))
      .where(eq(feedback.reviewSessionId, r.id))
      .orderBy(asc(feedback.createdAt));
    const ids = rows.map((x) => x.f.id);
    const comments = ids.length
      ? await this.ctx.db
          .select({ c: feedbackComments, u: users.displayName, cv: reviewVisitors })
          .from(feedbackComments)
          .leftJoin(users, eq(users.id, feedbackComments.authorUserId))
          .leftJoin(reviewVisitors, eq(reviewVisitors.id, feedbackComments.authorVisitorId))
          .where(and(inArray(feedbackComments.feedbackId, ids), inArray(feedbackComments.authorType, ['user', 'customer'])))
          .orderBy(asc(feedbackComments.createdAt))
      : [];
    const shots = ids.length
      ? await this.ctx.db.select({ feedbackId: feedbackAttachments.feedbackId, artifactId: feedbackAttachments.artifactId }).from(feedbackAttachments).where(inArray(feedbackAttachments.feedbackId, ids))
      : [];
    return rows.map(({ f, rv }) => ({
      id: f.id,
      key: `FB-${f.number}`,
      type: f.type,
      title: f.title,
      body: f.body,
      status: f.status,
      pageUrl: f.pageUrl,
      viewport: f.viewportWidth ? { width: f.viewportWidth, height: f.viewportHeight } : null,
      x: f.x,
      y: f.y,
      deviceKey: f.deviceKey,
      reporter: rv ? { name: `${rv.firstName} ${rv.lastName}`, department: rv.department } : { name: 'Proje ekibi', department: '' },
      mine: f.reporterVisitorId === v.id || (!!v.email && rv?.email === v.email),
      createdAt: f.createdAt,
      screenshots: shots.filter((s) => s.feedbackId === f.id).map((s) => s.artifactId),
      comments: comments
        .filter((c) => c.c.feedbackId === f.id)
        .map((c) => ({ author: c.c.authorType === 'customer' ? `${c.cv?.firstName ?? ''} ${c.cv?.lastName ?? ''}`.trim() : `${c.u ?? 'Ekip'} (ekip)`, body: c.c.body, createdAt: c.c.createdAt })),
    }));
  }

  async createFeedback(
    req: Request,
    token: string,
    input: { type: 'comment' | 'bug' | 'change_request'; title: string; body: string; pageUrl: string; viewport: { width: number; height: number }; scrollY: number; coordinates?: { x: number; y: number }; domSelector?: string; deviceKey?: string; captureScreenshot: boolean },
  ) {
    const { r, v, actor } = await this.requireVisitor(req, token);
    if (!r.capabilities.feedback) throw forbidden('Bu bağlantıda geri bildirim kapalı');
    const pv = (await this.ctx.db.select().from(previews).where(eq(previews.id, r.previewId)))[0];
    const b = pv ? (await this.ctx.db.select().from(builds).where(eq(builds.id, pv.buildId)))[0] : undefined;
    const ua = String(req.headers['user-agent'] ?? '');
    const { browser, os } = describeUserAgent(ua);
    const pageUrl = input.pageUrl.startsWith('/') ? input.pageUrl : (() => {
      try {
        const u = new URL(input.pageUrl);
        return u.pathname + u.search;
      } catch {
        return '/';
      }
    })();
    const row = await this.ctx.db.transaction((tx) =>
      insertFeedback(
        tx,
        {
          organizationId: r.organizationId,
          projectId: r.projectId,
          reviewSessionId: r.id,
          type: input.type,
          title: input.title,
          body: input.body,
          pageUrl,
          viewport: input.viewport,
          scrollY: input.scrollY,
          coordinates: input.coordinates,
          domSelector: input.domSelector,
          deviceKey: input.deviceKey,
          browser,
          operatingSystem: os,
          userAgent: ua,
          versionLabel: r.versionLabel || null,
          buildId: b?.id ?? null,
          previewId: pv?.id ?? null,
          reporter: { type: 'customer', visitorId: v.id, label: actor.label },
          captureScreenshot: input.captureScreenshot && r.capabilities.screenshots,
        },
        actor,
      ),
    );
    return { id: row.id, key: `FB-${row.number}` };
  }

  async comment(req: Request, token: string, feedbackId: string, body: string) {
    const { r, v, actor } = await this.requireVisitor(req, token);
    const f = (await this.ctx.db.select().from(feedback).where(and(eq(feedback.id, feedbackId), eq(feedback.reviewSessionId, r.id))))[0];
    if (!f) throw notFound('Geri bildirim');
    await this.ctx.db.insert(feedbackComments).values({ feedbackId: f.id, authorType: 'customer', authorVisitorId: v.id, body });
    await audit(this.ctx.db, { organizationId: r.organizationId, projectId: r.projectId, actor, action: 'feedback.customer_commented', resourceType: 'feedback', resourceId: f.id });
    await publish(this.ctx.db, { type: 'feedback.updated', organizationId: r.organizationId, projectId: r.projectId, id: f.id, data: { reviewSessionId: r.id } });
    return { ok: true };
  }

  /** Spec §67: customer approves a fix ("Onaylıyorum") or sends it back ("Hâlâ düzeltilmeli"). */
  async decide(req: Request, token: string, feedbackId: string, decision: 'approve' | 'reject', comment?: string) {
    const { r, v, actor } = await this.requireVisitor(req, token);
    const f = (await this.ctx.db.select().from(feedback).where(and(eq(feedback.id, feedbackId), eq(feedback.reviewSessionId, r.id))))[0];
    if (!f) throw notFound('Geri bildirim');
    if (f.status !== 'ready_for_review') throw precondition('Bu geri bildirim henüz onayınıza sunulmadı');
    const next = decision === 'approve' ? 'resolved' : 'in_progress';
    await this.ctx.db.transaction(async (tx) => {
      await tx.update(feedback).set({ status: next, resolvedAt: decision === 'approve' ? new Date() : null }).where(eq(feedback.id, f.id));
      await tx.insert(feedbackComments).values({
        feedbackId: f.id,
        authorType: 'customer',
        authorVisitorId: v.id,
        body: decision === 'approve' ? `Onaylandı.${comment ? ` ${comment}` : ''}` : `Hâlâ düzeltilmeli.${comment ? ` ${comment}` : ''}`,
      });
      await audit(tx, { organizationId: r.organizationId, projectId: r.projectId, actor, action: decision === 'approve' ? 'feedback.customer_approved' : 'feedback.customer_rejected', resourceType: 'feedback', resourceId: f.id });
      await timeline(tx, {
        organizationId: r.organizationId,
        projectId: r.projectId,
        kind: 'feedback',
        tone: decision === 'approve' ? 'ok' : 'warn',
        title: `FB-${f.number}: kullanıcı ${decision === 'approve' ? 'onayladı' : 'yeniden düzeltme istedi'}`,
        description: f.title,
        actorLabel: actor.label,
        refType: 'feedback',
        refId: f.id,
      });
      await emitDomainEvent(tx, { event: 'feedback.status_changed', organizationId: r.organizationId, projectId: r.projectId, actor, data: { feedbackId: f.id, from: f.status, to: next } });
      await publish(tx, { type: 'feedback.updated', organizationId: r.organizationId, projectId: r.projectId, id: f.id, data: { reviewSessionId: r.id } });
    });
    return { status: next };
  }

  async messages(req: Request, token: string) {
    const { r } = await this.requireVisitor(req, token);
    if (!r.capabilities.chat) throw forbidden('Bu bağlantıda canlı destek kapalı');
    return this.reviews.listMessages(r.id);
  }

  async sendMessage(req: Request, token: string, body: string) {
    const { r, v, actor } = await this.requireVisitor(req, token);
    if (!r.capabilities.chat) throw forbidden('Bu bağlantıda canlı destek kapalı');
    await this.ctx.db.insert(reviewMessages).values({ reviewSessionId: r.id, authorType: 'customer', visitorId: v.id, body });
    await audit(this.ctx.db, { organizationId: r.organizationId, projectId: r.projectId, actor, action: 'review.customer_message', resourceType: 'review', resourceId: r.id });
    await publish(this.ctx.db, { type: 'review.message', organizationId: r.organizationId, projectId: r.projectId, id: r.id, data: { reviewSessionId: r.id } });
    return this.reviews.listMessages(r.id);
  }

  /** Customer-facing documentation (spec: plain-language release notes, not developer docs). */
  async docs(req: Request, token: string) {
    const { r } = await this.requireVisitor(req, token);
    if (!r.capabilities.docs) throw forbidden('Bu bağlantıda doküman kapalı');
    const p = (await this.ctx.db.select().from(projects).where(eq(projects.id, r.projectId)))[0]!;
    const released = await this.ctx.db
      .select({ version: versions.version, notes: versions.releaseNotes, releasedAt: versions.releasedAt, createdAt: versions.createdAt })
      .from(versions)
      .where(eq(versions.projectId, r.projectId))
      .orderBy(desc(versions.createdAt))
      .limit(5);
    return { name: p.name, description: p.description, customerName: p.customerName, versions: released };
  }

  /** Screenshot of feedback that belongs to this review session. */
  async attachment(req: Request, token: string, artifactId: string) {
    const { r } = await this.requireVisitor(req, token);
    const row = (
      await this.ctx.db
        .select({ a: artifacts })
        .from(feedbackAttachments)
        .innerJoin(artifacts, eq(artifacts.id, feedbackAttachments.artifactId))
        .innerJoin(feedback, eq(feedback.id, feedbackAttachments.feedbackId))
        .where(and(eq(artifacts.id, artifactId), eq(feedback.reviewSessionId, r.id)))
    )[0];
    if (!row) throw notFound('Dosya');
    return row.a;
  }

  async assertVisitor(req: Request, token: string) {
    return this.requireVisitor(req, token);
  }
}
