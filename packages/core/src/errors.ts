import type { ErrorCode } from '@projecthub/contracts';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  POLICY_DENIED: 403,
  RATE_LIMITED: 429,
  AI_NOT_CONFIGURED: 503,
  AI_BUDGET_EXCEEDED: 429,
  PRECONDITION_FAILED: 412,
  REVIEW_EXPIRED: 410,
  REVIEW_PASSWORD_REQUIRED: 401,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_ERROR: 500,
};

/** A failure that is safe to show to the user. Anything else is reported as INTERNAL_ERROR. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} bulunamadı`);
export const forbidden = (message = 'Bu işlem için yetkiniz yok') => new AppError('PERMISSION_DENIED', message);
export const conflict = (message: string, details?: unknown) => new AppError('CONFLICT', message, details);
export const invalid = (message: string, details?: unknown) => new AppError('VALIDATION_ERROR', message, details);
export const policyDenied = (message: string, details?: unknown) => new AppError('POLICY_DENIED', message, details);
export const precondition = (message: string, details?: unknown) => new AppError('PRECONDITION_FAILED', message, details);
