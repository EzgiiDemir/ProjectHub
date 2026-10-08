/** Browser API client. Same-origin requests; the session cookie is HttpOnly and sent automatically. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request(path: string, opts: { method?: Method; body?: unknown; signal?: AbortSignal; raw?: BodyInit; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'x-requested-with': 'projecthub', ...opts.headers };
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method: opts.method ?? 'GET', headers, body, signal: opts.signal, credentials: 'same-origin' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Sunucuya ulaşılamıyor. Bağlantınızı kontrol edip tekrar deneyin.');
  }
  const json = (await res.json().catch(() => null)) as { data?: unknown; meta?: unknown; error?: { code: string; message: string; details?: unknown; requestId?: string } } | null;
  if (!res.ok) {
    const err = json?.error;
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/') && !path.startsWith('/public/')) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    }
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `İstek başarısız (${res.status})`, err?.details, err?.requestId);
  }
  return json ?? { data: null };
}

export async function api<T>(path: string, opts: Parameters<typeof request>[1] = {}): Promise<T> {
  return (await request(path, opts)).data as T;
}

export async function apiPaged<T>(path: string): Promise<{ data: T[]; meta: { nextCursor?: string | null; hasMore?: boolean } }> {
  const r = await request(path);
  return { data: r.data as T[], meta: (r.meta ?? {}) as { nextCursor?: string | null; hasMore?: boolean } };
}

/** Reads a POST endpoint that answers with Server-Sent Events (used for streamed AI answers). */
export async function postStream(path: string, body: unknown, onEvent: (event: string, data: unknown) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'projecthub', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    throw new ApiError(res.status, json?.error?.code ?? 'HTTP_ERROR', json?.error?.message ?? 'İstek başarısız');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Beklenmeyen bir hata oluştu';
}
