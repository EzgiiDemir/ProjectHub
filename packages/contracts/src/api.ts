/** API envelope types shared by server and client. */
export interface ApiSuccess<T> {
  data: T;
  meta?: { nextCursor?: string | null; hasMore?: boolean; total?: number };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

/** Machine-readable error codes returned by the API. */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'CONFLICT',
  'POLICY_DENIED',
  'RATE_LIMITED',
  'AI_NOT_CONFIGURED',
  'AI_BUDGET_EXCEEDED',
  'PRECONDITION_FAILED',
  'REVIEW_EXPIRED',
  'REVIEW_PASSWORD_REQUIRED',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Events pushed over SSE (GET /api/v1/stream). */
export interface RealtimeEvent {
  type: string;
  organizationId?: string;
  projectId?: string;
  id?: string;
  data?: Record<string, unknown>;
}
