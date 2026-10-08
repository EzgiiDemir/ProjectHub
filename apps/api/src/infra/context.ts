import type pg from 'pg';
import type { Permission } from '@projecthub/contracts';
import type { Actor, AppConfig, Logger, Storage } from '@projecthub/core';
import type { Database } from '@projecthub/database';

/** Process-wide dependencies, provided once and injected everywhere by class token. */
export class Ctx {
  constructor(
    readonly config: AppConfig,
    readonly db: Database,
    readonly pool: pg.Pool,
    readonly storage: Storage,
    readonly logger: Logger,
  ) {}
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  title: string;
  avatarColor: string;
}

export interface AuthInfo {
  user: AuthUser;
  organizationId: string;
  via: 'session' | 'token';
  sessionId: string | null;
  orgPermissions: Set<Permission>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthInfo;
    }
  }
}

export function actorOf(auth: AuthInfo, req: { ip?: string; headers: Record<string, unknown> }): Actor {
  return {
    type: 'user',
    id: auth.user.id,
    label: auth.user.displayName,
    ip: clientIp(req),
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 500) : null,
  };
}

export function clientIp(req: { ip?: string; headers: Record<string, unknown> }): string | null {
  const ip = req.ip ?? null;
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
