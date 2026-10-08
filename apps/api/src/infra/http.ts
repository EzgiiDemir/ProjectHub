import {
  ArgumentsHost,
  Catch,
  createParamDecorator,
  ExceptionFilter,
  HttpException,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  type PipeTransform,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import type { z } from 'zod';
import type { ErrorCode, Permission } from '@projecthub/contracts';
import { AppError, GitError, invalid, randomToken, type Actor, type Logger } from '@projecthub/core';
import { actorOf, type AuthInfo } from './context.js';

/* ---------------- metadata decorators ---------------- */
export const IS_PUBLIC = 'ph:public';
export const REQUIRED_PERMISSION = 'ph:permission';
/** Route does not require an authenticated user (login, public review portal, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Organization-wide permission required for the route. Project permissions are checked in services. */
export const RequirePermission = (p: Permission) => SetMetadata(REQUIRED_PERMISSION, p);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthInfo => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Oturum açmanız gerekiyor');
  return req.auth;
});

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Oturum açmanız gerekiyor');
  return actorOf(req.auth, req);
});

/* ---------------- validation ---------------- */
export class ZodPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    return parse(this.schema, value);
  }
}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw invalid(
      r.error.issues[0]?.message ?? 'Geçersiz istek',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuid(v: string, what = 'Kayıt'): string {
  if (!uuidPattern.test(v)) throw new AppError('NOT_FOUND', `${what} bulunamadı`);
  return v;
}

/* ---------------- envelope ---------------- */
/** Return from a controller to send `{ data, meta }`. Anything else is wrapped as `{ data }`. */
export class Paged<T> {
  constructor(
    readonly data: T[],
    readonly meta: { nextCursor?: string | null; hasMore?: boolean; total?: number },
  ) {}
}

export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((value) => {
        if (value === undefined) return { data: null };
        if (value instanceof Paged) return { data: value.data, meta: value.meta };
        return { data: value };
      }),
    );
  }
}

/* ---------------- errors ---------------- */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const body = (code: ErrorCode, message: string, details?: unknown) => ({
      error: { code, message, requestId: req.requestId, ...(details === undefined ? {} : { details }) },
    });
    if (res.headersSent) {
      this.logger.warn({ err: exception, requestId: req.requestId }, 'error after headers were sent');
      res.end();
      return;
    }
    if (exception instanceof AppError) {
      res.status(exception.status).json(body(exception.code, exception.message, exception.details));
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code: ErrorCode =
        status === 404 ? 'NOT_FOUND' : status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 400 ? 'VALIDATION_ERROR' : status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'PERMISSION_DENIED' : 'INTERNAL_ERROR';
      res.status(status).json(body(code, status === 404 ? 'Adres bulunamadı' : exception.message));
      return;
    }
    const pgCode = (exception as { code?: string; cause?: { code?: string } }).cause?.code ?? (exception as { code?: string }).code;
    if (pgCode === '23505') {
      res.status(409).json(body('CONFLICT', 'Bu kayıt zaten mevcut'));
      return;
    }
    if (pgCode === '23503') {
      res.status(409).json(body('CONFLICT', 'Kayıt başka kayıtlar tarafından kullanılıyor'));
      return;
    }
    if (exception instanceof GitError) {
      this.logger.error({ err: exception, stderr: exception.stderr, requestId: req.requestId }, 'git operation failed');
      res.status(500).json(body('INTERNAL_ERROR', 'Repository işlemi başarısız oldu'));
      return;
    }
    this.logger.error({ err: exception, requestId: req.requestId, path: req.path }, 'unhandled error');
    res.status(500).json(body('INTERNAL_ERROR', 'Beklenmeyen bir hata oluştu. Hata kimliğiyle birlikte yöneticinize bildirin.'));
  }
}

/* ---------------- middleware ---------------- */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  req.requestId = typeof incoming === 'string' && /^[\w-]{6,64}$/.test(incoming) ? incoming : `req_${randomToken(16)}`;
  res.setHeader('x-request-id', req.requestId);
  next();
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('cache-control', 'no-store');
  next();
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** Simple fixed-window in-memory rate limiter (single API instance; adequate for the 1-server topology). */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.resetAt < now) this.hits.delete(k);
    }, windowMs).unref();
  }
  check(key: string): void {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || e.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    e.count++;
    if (e.count > this.limit) {
      throw new AppError('RATE_LIMITED', `Çok fazla deneme. ${Math.ceil((e.resetAt - now) / 60000)} dakika sonra tekrar deneyin.`);
    }
  }
}
