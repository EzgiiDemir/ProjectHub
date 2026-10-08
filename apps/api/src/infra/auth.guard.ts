import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import type { Permission } from '@projecthub/contracts';
import { AppError, forbidden, getOrgPermissions, sha256 } from '@projecthub/core';
import { apiTokens, organizationMembers, sessions, users } from '@projecthub/database';
import { Ctx, type AuthInfo } from './context.js';
import { IS_PUBLIC, parseCookies, REQUIRED_PERMISSION } from './http.js';

export const SESSION_COOKIE = 'ph_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard. Authenticates by session cookie (browser) or `Authorization: Bearer ph_…` (API token),
 * enforces CSRF protection for cookie based writes, and checks route level organization permissions.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly ctx: Ctx,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handlers = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, handlers);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const auth = await this.authenticate(req, res);
    if (!auth) throw new AppError('UNAUTHENTICATED', 'Oturum açmanız gerekiyor');
    if (auth.via === 'session' && !SAFE_METHODS.has(req.method)) this.checkCsrf(req);
    req.auth = auth;
    const perm = this.reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION, handlers);
    if (perm && !auth.orgPermissions.has(perm)) throw forbidden();
    return true;
  }

  /** Browsers cannot send this custom header cross-site without a CORS preflight, which the API never grants. */
  private checkCsrf(req: Request): void {
    if (req.headers['x-requested-with'] !== 'projecthub') {
      throw new AppError('PERMISSION_DENIED', 'İstek doğrulanamadı (CSRF koruması)');
    }
    const origin = req.headers.origin;
    if (origin && origin !== new URL(this.ctx.config.APP_URL).origin) {
      throw new AppError('PERMISSION_DENIED', 'İstek kaynağı reddedildi');
    }
  }

  async authenticate(req: Request, res?: Response): Promise<AuthInfo | null> {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) return this.fromToken(header.slice(7).trim());
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return null;
    return this.fromSession(raw, res);
  }

  async fromSession(raw: string, res?: Response): Promise<AuthInfo | null> {
    const db = this.ctx.db;
    const rows = await db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256(raw)), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`)));
    const row = rows[0];
    if (!row || row.user.status !== 'active') return null;
    const member = await db
      .select({ status: organizationMembers.status })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, row.session.organizationId), eq(organizationMembers.userId, row.user.id)));
    if (member[0]?.status !== 'active') return null;

    // Sliding expiration, throttled to one write per minute.
    const now = Date.now();
    if (now - row.session.lastSeenAt.getTime() > 60_000) {
      const ttl = this.ctx.config.SESSION_TTL_HOURS * 3600_000;
      const extend = row.session.expiresAt.getTime() - now < ttl / 2;
      const expiresAt = extend ? new Date(now + ttl) : row.session.expiresAt;
      await db.update(sessions).set({ lastSeenAt: new Date(), expiresAt }).where(eq(sessions.id, row.session.id));
      await db.update(users).set({ lastActivityAt: new Date() }).where(eq(users.id, row.user.id));
      if (extend && res) res.cookie(SESSION_COOKIE, raw, this.cookieOptions(expiresAt));
    }
    return {
      user: pickUser(row.user),
      organizationId: row.session.organizationId,
      via: 'session',
      sessionId: row.session.id,
      orgPermissions: await getOrgPermissions(db, row.session.organizationId, row.user.id),
    };
  }

  private async fromToken(raw: string): Promise<AuthInfo | null> {
    if (!raw.startsWith('ph_')) return null;
    const db = this.ctx.db;
    const rows = await db
      .select({ token: apiTokens, user: users })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(and(eq(apiTokens.tokenHash, sha256(raw)), isNull(apiTokens.revokedAt)));
    const row = rows[0];
    if (!row || row.user.status !== 'active') return null;
    if (row.token.expiresAt && row.token.expiresAt.getTime() < Date.now()) return null;
    if (!row.token.lastUsedAt || Date.now() - row.token.lastUsedAt.getTime() > 60_000) {
      await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.token.id));
    }
    return {
      user: pickUser(row.user),
      organizationId: row.token.organizationId,
      via: 'token',
      sessionId: null,
      orgPermissions: await getOrgPermissions(db, row.token.organizationId, row.user.id),
    };
  }

  cookieOptions(expires: Date) {
    return { httpOnly: true, sameSite: 'lax' as const, secure: this.ctx.config.COOKIE_SECURE, path: '/', expires };
  }
}

export function pickUser(u: typeof users.$inferSelect) {
  return { id: u.id, email: u.email, displayName: u.displayName, title: u.title, avatarColor: u.avatarColor };
}
