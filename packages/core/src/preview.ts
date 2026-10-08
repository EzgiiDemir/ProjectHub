import crypto from 'node:crypto';

/** DNS-safe preview host label: <project>-b<build>-<random>. */
export function previewSlug(projectSlug: string, buildNumber: number): string {
  const rand = crypto.randomBytes(3).toString('hex').slice(0, 5);
  return `${projectSlug.slice(0, 40)}-b${buildNumber}-${rand}`.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
}

export function previewUrl(template: string, slug: string): string {
  return template.replace('{slug}', slug).replace(/\/$/, '');
}

export type PreviewSubject = `user:${string}` | `review:${string}` | 'system';

export interface PreviewTicket {
  previewId: string;
  subject: PreviewSubject;
  exp: number;
}

function ticketKey(encryptionKey: Buffer): Buffer {
  return crypto.createHash('sha256').update('projecthub-preview-ticket').update(encryptionKey).digest();
}

/**
 * Short-lived signed grant for one preview. Handed to the browser inside the preview URL; the gateway
 * exchanges it for a cookie on the preview host. Review grants are re-checked against the review session
 * on every request, so revoking a review link closes access immediately.
 */
export function signPreviewTicket(encryptionKey: Buffer, input: { previewId: string; subject: PreviewSubject; ttlSeconds: number }): string {
  const payload: PreviewTicket = { previewId: input.previewId, subject: input.subject, exp: Math.floor(Date.now() / 1000) + input.ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', ticketKey(encryptionKey)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyPreviewTicket(encryptionKey: Buffer, token: string | undefined | null): PreviewTicket | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', ticketKey(encryptionKey)).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PreviewTicket;
    if (typeof t.exp !== 'number' || t.exp < Math.floor(Date.now() / 1000)) return null;
    return t;
  } catch {
    return null;
  }
}
