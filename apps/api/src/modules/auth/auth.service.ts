import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import {
  AppError,
  audit,
  hashPassword,
  invalid,
  notFound,
  randomToken,
  sha256,
  verifyPassword,
  type Actor,
} from '@projecthub/core';
import {
  apiTokens,
  organizationMembers,
  organizations,
  sessions,
  userTokens,
  users,
} from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { pickUser } from '../../infra/auth.guard.js';

const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;

@Injectable()
export class AuthService {
  constructor(private readonly ctx: Ctx) {}

  /** Verifies credentials and opens a session. Generic error message so account existence is not revealed. */
  async login(email: string, password: string, meta: { ip: string | null; userAgent: string | null }) {
    const db = this.ctx.db;
    const user = (await db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`))[0];
    const fail = new AppError('UNAUTHENTICATED', 'E-posta veya şifre hatalı');
    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new AppError('RATE_LIMITED', `Çok fazla hatalı deneme. Hesap ${LOCK_MINUTES} dakika kilitlendi.`);
    }
    const ok = await verifyPassword(user?.passwordHash, password);
    if (!user || !ok) {
      if (user) {
        const failed = user.failedLoginCount + 1;
        await db
          .update(users)
          .set({ failedLoginCount: failed, lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null })
          .where(eq(users.id, user.id));
      }
      throw fail;
    }
    if (user.status !== 'active') throw new AppError('UNAUTHENTICATED', 'Hesabınız aktif değil. Yöneticinizle iletişime geçin.');
    const membership = (
      await db
        .select({ organizationId: organizationMembers.organizationId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.userId, user.id), eq(organizationMembers.status, 'active')))
        .orderBy(organizationMembers.joinedAt)
    )[0];
    if (!membership) throw new AppError('UNAUTHENTICATED', 'Hesabınız bir organizasyona bağlı değil.');
    await db.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
    const session = await this.openSession(user.id, membership.organizationId, meta);
    await audit(db, {
      organizationId: membership.organizationId,
      actor: { type: 'user', id: user.id, label: user.displayName, ip: meta.ip, userAgent: meta.userAgent },
      action: 'auth.login',
      resourceType: 'session',
      resourceId: session.id,
    });
    return session;
  }

  async openSession(userId: string, organizationId: string, meta: { ip: string | null; userAgent: string | null }) {
    const raw = randomToken(43);
    const expiresAt = new Date(Date.now() + this.ctx.config.SESSION_TTL_HOURS * 3600_000);
    const row = (
      await this.ctx.db
        .insert(sessions)
        .values({ userId, organizationId, tokenHash: sha256(raw), ipAddress: meta.ip, userAgent: meta.userAgent?.slice(0, 500), expiresAt })
        .returning({ id: sessions.id })
    )[0]!;
    return { id: row.id, raw, expiresAt };
  }

  async logout(auth: AuthInfo, actor: Actor) {
    if (auth.sessionId) {
      await this.ctx.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, auth.sessionId));
      await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'auth.logout', resourceType: 'session', resourceId: auth.sessionId });
    }
  }

  async me(auth: AuthInfo) {
    const db = this.ctx.db;
    const orgs = await db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(and(eq(organizationMembers.userId, auth.user.id), eq(organizationMembers.status, 'active')));
    return {
      user: auth.user,
      organization: orgs.find((o) => o.id === auth.organizationId) ?? null,
      organizations: orgs,
      permissions: [...auth.orgPermissions].sort(),
      smtpEnabled: !!this.ctx.config.SMTP_HOST,
    };
  }

  async switchOrganization(auth: AuthInfo, organizationId: string, actor: Actor) {
    if (!auth.sessionId) throw invalid('Yalnızca tarayıcı oturumlarında organizasyon değiştirilebilir');
    const m = await this.ctx.db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.userId, auth.user.id), eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.status, 'active')));
    if (!m.length) throw notFound('Organizasyon');
    await this.ctx.db.update(sessions).set({ organizationId }).where(eq(sessions.id, auth.sessionId));
    await audit(this.ctx.db, { organizationId, actor, action: 'auth.switch_organization', resourceType: 'organization', resourceId: organizationId });
  }

  /* ---------------- one-time tokens (invitation / password reset) ---------------- */

  private async findValidToken(raw: string, purpose: 'invite' | 'password_reset') {
    const rows = await this.ctx.db
      .select({ token: userTokens, user: users, orgName: organizations.name })
      .from(userTokens)
      .innerJoin(users, eq(users.id, userTokens.userId))
      .innerJoin(organizations, eq(organizations.id, userTokens.organizationId))
      .where(and(eq(userTokens.tokenHash, sha256(raw)), eq(userTokens.purpose, purpose), isNull(userTokens.usedAt), gt(userTokens.expiresAt, sql`now()`)));
    const row = rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'Bağlantı geçersiz veya süresi dolmuş. Yöneticinizden yeni bir bağlantı isteyin.');
    return row;
  }

  async describeInvitation(raw: string) {
    const row = await this.findValidToken(raw, 'invite');
    return { email: row.user.email, displayName: row.user.displayName, organizationName: row.orgName };
  }

  async acceptInvitation(input: { token: string; password: string; displayName?: string }, meta: { ip: string | null; userAgent: string | null }) {
    const row = await this.findValidToken(input.token, 'invite');
    const passwordHash = await hashPassword(input.password);
    await this.ctx.db.transaction(async (tx) => {
      await tx.update(userTokens).set({ usedAt: new Date() }).where(eq(userTokens.id, row.token.id));
      await tx
        .update(users)
        .set({ passwordHash, status: 'active', emailVerifiedAt: new Date(), displayName: input.displayName ?? row.user.displayName })
        .where(eq(users.id, row.user.id));
      await tx
        .update(organizationMembers)
        .set({ status: 'active' })
        .where(and(eq(organizationMembers.userId, row.user.id), eq(organizationMembers.organizationId, row.token.organizationId)));
      await audit(tx, {
        organizationId: row.token.organizationId,
        actor: { type: 'user', id: row.user.id, label: row.user.displayName, ip: meta.ip, userAgent: meta.userAgent },
        action: 'user.invitation_accepted',
        resourceType: 'user',
        resourceId: row.user.id,
      });
    });
    return this.openSession(row.user.id, row.token.organizationId, meta);
  }

  /** Creates a one-time link. Used by admins (invite / reset) and by self-service reset when SMTP is configured. */
  async issueToken(userId: string, organizationId: string, purpose: 'invite' | 'password_reset', createdBy: string | null) {
    const raw = randomToken(40);
    const hours = purpose === 'invite' ? 72 : 2;
    await this.ctx.db
      .update(userTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(userTokens.userId, userId), eq(userTokens.purpose, purpose), isNull(userTokens.usedAt)));
    await this.ctx.db.insert(userTokens).values({
      userId,
      organizationId,
      purpose,
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + hours * 3600_000),
      createdBy,
    });
    const path = purpose === 'invite' ? 'invite' : 'reset-password';
    return { url: `${this.ctx.config.APP_URL}/${path}/${raw}`, expiresInHours: hours };
  }

  async requestPasswordReset(email: string): Promise<{ user: typeof users.$inferSelect; organizationId: string } | null> {
    const user = (await this.ctx.db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`))[0];
    if (!user || user.status !== 'active') return null;
    const m = (await this.ctx.db.select().from(organizationMembers).where(eq(organizationMembers.userId, user.id)))[0];
    return m ? { user, organizationId: m.organizationId } : null;
  }

  async resetPassword(input: { token: string; password: string }, meta: { ip: string | null; userAgent: string | null }) {
    const row = await this.findValidToken(input.token, 'password_reset');
    const passwordHash = await hashPassword(input.password);
    await this.ctx.db.transaction(async (tx) => {
      await tx.update(userTokens).set({ usedAt: new Date() }).where(eq(userTokens.id, row.token.id));
      await tx.update(users).set({ passwordHash, failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, row.user.id));
      // A reset invalidates every existing session.
      await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, row.user.id), isNull(sessions.revokedAt)));
      await audit(tx, {
        organizationId: row.token.organizationId,
        actor: { type: 'user', id: row.user.id, label: row.user.displayName, ip: meta.ip, userAgent: meta.userAgent },
        action: 'user.password_reset',
        resourceType: 'user',
        resourceId: row.user.id,
      });
    });
  }

  async changePassword(auth: AuthInfo, current: string, next: string, actor: Actor) {
    const user = (await this.ctx.db.select().from(users).where(eq(users.id, auth.user.id)))[0]!;
    if (!(await verifyPassword(user.passwordHash, current))) throw invalid('Mevcut şifre hatalı');
    await this.ctx.db.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, user.id));
    // Keep the current session, revoke all others.
    await this.ctx.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt), auth.sessionId ? ne(sessions.id, auth.sessionId) : sql`true`));
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'user.password_changed', resourceType: 'user', resourceId: user.id });
  }

  async updateProfile(auth: AuthInfo, input: { displayName?: string; title?: string }) {
    const row = (await this.ctx.db.update(users).set(input).where(eq(users.id, auth.user.id)).returning())[0]!;
    return pickUser(row);
  }

  async listSessions(auth: AuthInfo) {
    const rows = await this.ctx.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, auth.user.id), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`)))
      .orderBy(desc(sessions.lastSeenAt));
    return rows.map((s) => ({
      id: s.id,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      current: s.id === auth.sessionId,
    }));
  }

  async revokeSession(auth: AuthInfo, id: string, actor: Actor) {
    const r = await this.ctx.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, id), eq(sessions.userId, auth.user.id)))
      .returning({ id: sessions.id });
    if (!r.length) throw notFound('Oturum');
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'auth.session_revoked', resourceType: 'session', resourceId: id });
  }

  /* ---------------- personal access tokens ---------------- */

  async listTokens(auth: AuthInfo) {
    return this.ctx.db
      .select({ id: apiTokens.id, name: apiTokens.name, prefix: apiTokens.prefix, lastUsedAt: apiTokens.lastUsedAt, expiresAt: apiTokens.expiresAt, createdAt: apiTokens.createdAt })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, auth.user.id), eq(apiTokens.organizationId, auth.organizationId), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt));
  }

  async createToken(auth: AuthInfo, input: { name: string; expiresInDays: number | null }, actor: Actor) {
    const raw = `ph_${randomToken(40)}`;
    const row = (
      await this.ctx.db
        .insert(apiTokens)
        .values({
          userId: auth.user.id,
          organizationId: auth.organizationId,
          name: input.name,
          prefix: raw.slice(0, 10),
          tokenHash: sha256(raw),
          expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400_000) : null,
        })
        .returning()
    )[0]!;
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'auth.token_created', resourceType: 'api_token', resourceId: row.id, metadata: { name: input.name } });
    // The raw token is shown exactly once.
    return { id: row.id, name: row.name, token: raw, expiresAt: row.expiresAt };
  }

  async revokeToken(auth: AuthInfo, id: string, actor: Actor) {
    const r = await this.ctx.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, auth.user.id)))
      .returning({ id: apiTokens.id });
    if (!r.length) throw notFound('Token');
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'auth.token_revoked', resourceType: 'api_token', resourceId: id });
  }
}
