import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { signPreviewTicket, verifyPreviewTicket, type PreviewTicket } from '@projecthub/core';
import { previews, reviewSessions } from '@projecthub/database';
import type { Ctx } from '../../infra/context.js';
import { parseCookies } from '../../infra/http.js';
import { bridgeScript } from './bridge.js';

const COOKIE = 'ph_pv';
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
};

type PreviewRow = typeof previews.$inferSelect;

/**
 * Preview gateway: serves every preview on its own host (<slug>.<PREVIEW_BASE_DOMAIN>).
 * Static previews are served from the build artifact; server previews are reverse-proxied to their
 * process. Access requires a signed grant (team member, review link or system); review grants are
 * re-validated against the review session so revoked/expired links stop working immediately.
 */
export function createPreviewGateway(ctx: Ctx): http.Server {
  const appOrigin = new URL(ctx.config.APP_URL).origin;
  const bridge = bridgeScript(appOrigin);
  const suffix = `.${ctx.config.PREVIEW_BASE_DOMAIN.toLowerCase()}`;
  const cache = new Map<string, { row: PreviewRow | null; at: number }>();
  const reviewCache = new Map<string, { ok: boolean; at: number }>();

  async function previewBySlug(slug: string): Promise<PreviewRow | null> {
    const hit = cache.get(slug);
    if (hit && Date.now() - hit.at < 3_000) return hit.row;
    const row = (await ctx.db.select().from(previews).where(eq(previews.slug, slug)))[0] ?? null;
    cache.set(slug, { row, at: Date.now() });
    if (cache.size > 2_000) cache.clear();
    return row;
  }

  async function grantValid(t: PreviewTicket, pv: PreviewRow): Promise<boolean> {
    if (t.previewId !== pv.id) return false;
    if (!t.subject.startsWith('review:')) return true;
    const reviewId = t.subject.slice('review:'.length);
    const hit = reviewCache.get(reviewId);
    if (hit && Date.now() - hit.at < 5_000) return hit.ok;
    const r = (await ctx.db.select().from(reviewSessions).where(and(eq(reviewSessions.id, reviewId), eq(reviewSessions.previewId, pv.id))))[0];
    const ok = !!r && !r.revokedAt && r.expiresAt.getTime() > Date.now();
    reviewCache.set(reviewId, { ok, at: Date.now() });
    return ok;
  }

  function slugOf(req: http.IncomingMessage): string | null {
    const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!host.endsWith(suffix)) return null;
    const slug = host.slice(0, -suffix.length);
    return /^[a-z0-9-]{1,63}$/.test(slug) ? slug : null;
  }

  function page(res: http.ServerResponse, status: number, title: string, message: string, refresh = false) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': `frame-ancestors 'self' ${appOrigin}` });
    res.end(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="3">' : ''}<title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f5f2;color:#22303c;padding:24px;box-sizing:border-box}main{max-width:460px}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#4a5864}</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`);
  }

  const securityHeaders = (res: http.ServerResponse) => {
    res.setHeader('content-security-policy', `frame-ancestors 'self' ${appOrigin}`);
    res.removeHeader('x-frame-options');
    res.setHeader('x-robots-tag', 'noindex, nofollow');
  };

  function inject(html: string): string {
    const tag = `<script src="/__ph/bridge.js" defer></script>`;
    if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}</head>`);
    if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => `${m}${tag}`);
    return tag + html;
  }

  async function serveStatic(pv: PreviewRow, req: http.IncomingMessage, res: http.ServerResponse) {
    const root = ctx.storage.resolve(pv.rootKey!);
    let rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (rel.includes('\0')) return page(res, 400, 'Geçersiz istek', '');
    let file = path.resolve(root, `.${rel}`);
    if (!file.startsWith(root)) return page(res, 403, 'Erişim reddedildi', '');
    let stat = await fs.promises.stat(file).catch(() => null);
    if (stat?.isDirectory()) {
      const index = path.join(file, 'index.html');
      stat = await fs.promises.stat(index).catch(() => null);
      if (stat) file = index;
      else if (rel === '/' || rel === '') {
        // A single-page upload without index.html: serve its only HTML file at "/".
        const htmls = (await fs.promises.readdir(root)).filter((f) => /\.html?$/i.test(f));
        if (htmls.length === 1) {
          file = path.join(root, htmls[0]!);
          stat = await fs.promises.stat(file).catch(() => null);
        }
      }
    }
    if (!stat && !path.extname(rel) && (await fs.promises.stat(`${file}.html`).catch(() => null))) {
      file = `${file}.html`;
      stat = await fs.promises.stat(file);
    }
    if ((!stat || stat.isDirectory()) && pv.spa) {
      file = path.join(root, 'index.html');
      stat = await fs.promises.stat(file).catch(() => null);
    }
    if (!stat || stat.isDirectory()) {
      rel = rel.replace(/[<>&"]/g, '');
      return page(res, 404, 'Sayfa bulunamadı', `Bu ön izlemede <code>${rel}</code> adresi yok.`);
    }
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    securityHeaders(res);
    if (type.startsWith('text/html')) {
      const html = inject(await fs.promises.readFile(file, 'utf8'));
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  function proxy(pv: PreviewRow, req: http.IncomingMessage, res: http.ServerResponse) {
    const headers = { ...req.headers };
    const cookies = parseCookies(req.headers.cookie);
    delete cookies[COOKIE];
    headers.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    if (!headers.cookie) delete headers.cookie;
    headers['x-forwarded-host'] = req.headers.host;
    headers['x-forwarded-proto'] = 'http';
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    if (wantsHtml) headers['accept-encoding'] = 'identity';
    const upstream = http.request({ host: '127.0.0.1', port: pv.internalPort!, method: req.method, path: req.url, headers }, (up) => {
      const isHtml = (up.headers['content-type'] ?? '').includes('text/html') && !up.headers['content-encoding'];
      const outHeaders = { ...up.headers };
      delete outHeaders['x-frame-options'];
      delete outHeaders['content-security-policy'];
      if (!isHtml) {
        securityHeaders(res);
        res.writeHead(up.statusCode ?? 502, outHeaders);
        up.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      up.on('data', (c: Buffer) => {
        size += c.length;
        chunks.push(c);
      });
      up.on('end', () => {
        const body = size > 8 * 1024 * 1024 ? Buffer.concat(chunks) : Buffer.from(inject(Buffer.concat(chunks).toString('utf8')));
        delete outHeaders['content-length'];
        securityHeaders(res);
        res.writeHead(up.statusCode ?? 200, { ...outHeaders, 'content-length': body.length });
        res.end(body);
      });
    });
    upstream.on('error', () => page(res, 502, 'Uygulamaya ulaşılamıyor', 'Ön izleme süreci yanıt vermiyor. Proje sayfasından ön izlemeyi yeniden başlatın.'));
    req.pipe(upstream);
  }

  async function authorize(req: http.IncomingMessage, pv: PreviewRow): Promise<boolean> {
    const t = verifyPreviewTicket(ctx.config.encryptionKey, parseCookies(req.headers.cookie)[COOKIE]);
    return !!t && (await grantValid(t, pv));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const slug = slugOf(req);
      if (!slug) return page(res, 404, 'Ön izleme bulunamadı', 'Adres geçerli bir ön izlemeye ait değil.');
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/__ph/bridge.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=300' });
        return res.end(bridge);
      }
      const pv = await previewBySlug(slug);
      if (!pv) return page(res, 404, 'Ön izleme bulunamadı', 'Bu ön izleme silinmiş veya hiç oluşturulmamış.');
      if (url.pathname === '/__ph/auth') {
        const t = verifyPreviewTicket(ctx.config.encryptionKey, url.searchParams.get('ticket'));
        if (!t || !(await grantValid(t, pv))) return page(res, 403, 'Bağlantı geçersiz', 'Bu bağlantının süresi dolmuş veya erişim kapatılmış. Project Hub üzerinden yeniden açın.');
        const next = url.searchParams.get('next') ?? '/';
        const cookieValue = signPreviewTicket(ctx.config.encryptionKey, { previewId: t.previewId, subject: t.subject, ttlSeconds: Math.max(60, t.exp - Math.floor(Date.now() / 1000)) });
        // SameSite=None + Partitioned lets the cookie work inside the Project Hub iframe (CHIPS).
        res.writeHead(302, {
          location: next.startsWith('/') && !next.startsWith('//') ? next : '/',
          'set-cookie': `${COOKIE}=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${Math.max(60, t.exp - Math.floor(Date.now() / 1000))}`,
          'cache-control': 'no-store',
        });
        return res.end();
      }
      if (!(await authorize(req, pv))) {
        return page(res, 401, 'Erişim gerekli', 'Bu ön izleme yalnızca Project Hub üzerinden veya size gönderilen inceleme bağlantısıyla açılabilir.');
      }
      if (pv.status === 'expired' || pv.status === 'stopped') return page(res, 410, 'Ön izleme kapalı', 'Bu ön izlemenin süresi doldu veya durduruldu. Proje ekibinden yeni bir bağlantı isteyin.');
      if (pv.status === 'failed') return page(res, 503, 'Ön izleme başlatılamadı', 'Uygulama başlatılırken hata oluştu. Ayrıntılar Project Hub\'daki ön izleme kaydında.');
      if (pv.status !== 'ready') return page(res, 503, 'Ön izleme hazırlanıyor…', 'Uygulama başlatılıyor; sayfa birkaç saniye içinde kendiliğinden yenilenecek.', true);
      if (pv.kind === 'static') return await serveStatic(pv, req, res);
      return proxy(pv, req, res);
    } catch (e) {
      ctx.logger.error({ err: e }, 'preview gateway error');
      if (!res.headersSent) page(res, 500, 'Beklenmeyen hata', 'Ön izleme sunulurken bir hata oluştu.');
      else res.end();
    }
  });

  // WebSocket / upgrade passthrough for server previews (live updates, sockets).
  server.on('upgrade', async (req, socket, head) => {
    try {
      const slug = slugOf(req);
      const pv = slug ? await previewBySlug(slug) : null;
      if (!pv || pv.kind !== 'process' || pv.status !== 'ready' || !(await authorize(req, pv))) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const up = net.connect(pv.internalPort!, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    } catch {
      socket.destroy();
    }
  });
  return server;
}
