/// <reference lib="dom" />
import fs from 'node:fs/promises';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import {
  getOrgSettings,
  PermanentJobError,
  previewUrl,
  publish,
  signPreviewTicket,
  timeline,
  type JobContext,
} from '@projecthub/core';
import {
  artifacts,
  deviceProfiles,
  feedback,
  feedbackAttachments,
  previews,
  responsiveTestResults,
  responsiveTests,
  type ResponsiveIssue,
} from '@projecthub/database';
import type { WorkerCtx } from '../context.js';
import { registerLifecycle } from '../lifecycle.js';

let browser: Browser | null = null;
let idleTimer: NodeJS.Timeout | null = null;

/** One shared headless Chromium, closed after 5 idle minutes to give the RAM back on the 8 GB server. */
async function getBrowser(): Promise<Browser> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void browser?.close();
    browser = null;
  }, 5 * 60_000);
  if (!browser || !browser.isConnected()) browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  return browser;
}
registerLifecycle({ stop: async () => void (await browser?.close()) });

type Device = { width: number; height: number; scaleFactor: number; isMobile: boolean; userAgent: string | null };

async function previewContext(ctx: WorkerCtx, pv: typeof previews.$inferSelect, device: Device): Promise<{ context: BrowserContext; base: string }> {
  if (!ctx.config.BROWSER_AUTOMATION) throw new PermanentJobError('Tarayıcı otomasyonu kapalı (BROWSER_AUTOMATION=false)');
  const b = await getBrowser();
  const context = await b.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: Math.min(device.scaleFactor, 2),
    isMobile: device.isMobile,
    hasTouch: device.isMobile,
    userAgent: device.userAgent ?? undefined,
    locale: 'tr-TR',
  });
  const base = previewUrl(ctx.config.PREVIEW_PUBLIC_URL_TEMPLATE, pv.slug);
  const ticket = signPreviewTicket(ctx.config.encryptionKey, { previewId: pv.id, subject: 'system', ttlSeconds: 1800 });
  const page = await context.newPage();
  await page.goto(`${base}/__ph/auth?ticket=${encodeURIComponent(ticket)}&next=/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.close();
  return { context, base };
}

async function saveScreenshot(ctx: WorkerCtx, projectId: string, organizationId: string, name: string, data: Buffer, retentionDays: number) {
  const key = ctx.storage.screenshotKey(projectId, name);
  await fs.mkdir(path.dirname(ctx.storage.resolve(key)), { recursive: true });
  await fs.writeFile(ctx.storage.resolve(key), data);
  const row = (
    await ctx.db
      .insert(artifacts)
      .values({ organizationId, projectId, type: 'screenshot', storageKey: key, fileName: name, contentType: 'image/png', sizeBytes: data.length, retentionUntil: new Date(Date.now() + retentionDays * 86400_000) })
      .returning({ id: artifacts.id })
  )[0]!;
  return row.id;
}

/** Spec §61/§94: capture what the customer saw, at their viewport and scroll position, with the click marked. */
export async function feedbackScreenshot(ctx: WorkerCtx, { job, logger }: JobContext) {
  const { feedbackId } = job.payload as { feedbackId: string };
  const f = (await ctx.db.select().from(feedback).where(eq(feedback.id, feedbackId)))[0];
  if (!f?.previewId) return { skipped: 'no preview' };
  const pv = (await ctx.db.select().from(previews).where(eq(previews.id, f.previewId)))[0];
  if (!pv || pv.status !== 'ready') return { skipped: 'preview not running' };
  const dev = f.deviceKey ? (await ctx.db.select().from(deviceProfiles).where(eq(deviceProfiles.key, f.deviceKey)))[0] : undefined;
  const device: Device = dev ?? { width: f.viewportWidth ?? 1366, height: f.viewportHeight ?? 768, scaleFactor: 1, isMobile: (f.viewportWidth ?? 1366) < 768, userAgent: null };
  const { context, base } = await previewContext(ctx, pv, device);
  try {
    const page = await context.newPage();
    await page.goto(`${base}${f.pageUrl.startsWith('/') ? f.pageUrl : '/'}`, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    await page.evaluate((y) => window.scrollTo(0, y), f.scrollY);
    if (f.x !== null && f.y !== null) {
      await page.evaluate(
        ({ x, y, label }) => {
          const pin = document.createElement('div');
          pin.style.cssText = `position:absolute;left:${x - 14}px;top:${y - 14}px;width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#C27F0E;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);z-index:2147483647`;
          const t = document.createElement('span');
          t.textContent = label;
          t.style.cssText = 'display:block;transform:rotate(45deg);color:#fff;font:700 11px system-ui;text-align:center;line-height:24px';
          pin.appendChild(t);
          document.body.appendChild(pin);
        },
        { x: f.x, y: f.y, label: String(f.number % 100) },
      );
    }
    const png = await page.screenshot({ type: 'png' });
    const { retention } = await getOrgSettings(ctx.db, f.organizationId);
    const artifactId = await saveScreenshot(ctx, f.projectId, f.organizationId, `feedback-${f.number}.png`, png, retention.screenshotDays);
    await ctx.db.insert(feedbackAttachments).values({ feedbackId: f.id, artifactId, kind: 'screenshot' });
    await publish(ctx.db, { type: 'feedback.updated', organizationId: f.organizationId, projectId: f.projectId, id: f.id, data: { reviewSessionId: f.reviewSessionId } });
    logger.info({ feedbackId }, 'feedback screenshot captured');
    return { artifactId };
  } finally {
    await context.close();
  }
}

/** Spec §41 "Test All Devices": loads each path on each device profile and reports layout/runtime problems. */
export async function responsiveTest(ctx: WorkerCtx, { job, logger }: JobContext) {
  const { testId, deviceKeys } = job.payload as { testId: string; deviceKeys?: string[] };
  const test = (await ctx.db.select().from(responsiveTests).where(eq(responsiveTests.id, testId)))[0];
  if (!test) throw new PermanentJobError('test not found');
  const pv = (await ctx.db.select().from(previews).where(eq(previews.id, test.previewId)))[0];
  const fail = async (msg: string) => {
    await ctx.db.update(responsiveTests).set({ status: 'failed', error: msg, finishedAt: new Date() }).where(eq(responsiveTests.id, testId));
    await publish(ctx.db, { type: 'responsive.updated', organizationId: test.organizationId, projectId: test.projectId, id: testId });
  };
  if (!pv || pv.status !== 'ready') return fail('Ön izleme çalışmıyor; testi başlatmadan önce ön izlemeyi açın');
  await ctx.db.update(responsiveTests).set({ status: 'running' }).where(eq(responsiveTests.id, testId));
  await ctx.db.delete(responsiveTestResults).where(eq(responsiveTestResults.testId, testId));
  await publish(ctx.db, { type: 'responsive.updated', organizationId: test.organizationId, projectId: test.projectId, id: testId });
  const all = await ctx.db.select().from(deviceProfiles).where(eq(deviceProfiles.isActive, true)).orderBy(asc(deviceProfiles.sort));
  const devices = deviceKeys?.length ? all.filter((d) => deviceKeys.includes(d.key)) : all;
  const baseline = test.baselineTestId ? await ctx.db.select().from(responsiveTestResults).where(eq(responsiveTestResults.testId, test.baselineTestId)) : [];
  const { retention } = await getOrgSettings(ctx.db, test.organizationId);
  const tally = { passed: 0, warning: 0, failed: 0, total: 0 };

  try {
    for (const d of devices) {
      const { context, base } = await previewContext(ctx, pv, d);
      try {
        for (const p of test.paths) {
          const issues: ResponsiveIssue[] = [];
          const page = await context.newPage();
          page.on('console', (m) => {
            if (m.type() === 'error' && issues.filter((i) => i.code === 'console_error').length < 5) issues.push({ code: 'console_error', message: m.text().slice(0, 300) });
          });
          page.on('pageerror', (e) => issues.push({ code: 'page_error', message: e.message.slice(0, 300) }));
          page.on('requestfailed', (r) => {
            if (!r.url().includes('/__ph/')) issues.push({ code: 'failed_request', message: `${r.method()} ${new URL(r.url()).pathname} — ${r.failure()?.errorText ?? 'başarısız'}` });
          });
          page.on('response', (r) => {
            if (r.status() >= 400 && !r.url().includes('/__ph/') && issues.filter((i) => i.code === 'failed_request').length < 5) {
              issues.push({ code: 'failed_request', message: `${r.request().method()} ${new URL(r.url()).pathname} — HTTP ${r.status()}` });
            }
          });
          const started = Date.now();
          let loaded = true;
          try {
            await page.goto(`${base}${p}`, { waitUntil: 'load', timeout: 30_000 });
            await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
          } catch (e) {
            loaded = false;
            issues.push({ code: 'load_failed', message: (e as Error).message.split('\n')[0]!.slice(0, 300) });
          }
          const loadMs = Date.now() - started;
          if (loaded) {
            const layout = await page.evaluate(() => {
              const vw = document.documentElement.clientWidth;
              const overflow = document.documentElement.scrollWidth - vw;
              const offscreen: string[] = [];
              for (const el of Array.from(document.querySelectorAll('button, a.btn, [role="button"], input[type="submit"]'))) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) offscreen.push(((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 40));
              }
              return { overflow, offscreen: offscreen.slice(0, 3) };
            });
            if (layout.overflow > 1) issues.push({ code: 'horizontal_overflow', message: `Yatay taşma: sayfa ${layout.overflow}px genişliğe taşıyor` });
            for (const o of layout.offscreen) issues.push({ code: 'offscreen_cta', message: `Buton görünür alanın dışında: "${o}"` });
          }
          let screenshotArtifactId: string | null = null;
          let diffArtifactId: string | null = null;
          let diffRatio: number | null = null;
          if (loaded) {
            const shot = await page.screenshot({ type: 'png' });
            const name = `rt-${testId.slice(-8)}-${d.key}-${p.replace(/[^a-z0-9]+/gi, '_') || 'root'}.png`;
            screenshotArtifactId = await saveScreenshot(ctx, test.projectId, test.organizationId, name, shot, retention.screenshotDays);
            const base0 = baseline.find((b) => b.deviceKey === d.key && b.path === p && b.screenshotArtifactId);
            if (base0) {
              const prevArt = (await ctx.db.select().from(artifacts).where(eq(artifacts.id, base0.screenshotArtifactId!)))[0];
              const prevBuf = prevArt ? await fs.readFile(ctx.storage.resolve(prevArt.storageKey)).catch(() => null) : null;
              if (prevBuf) {
                const a = PNG.sync.read(prevBuf);
                const b = PNG.sync.read(shot);
                if (a.width === b.width && a.height === b.height) {
                  const diff = new PNG({ width: a.width, height: a.height });
                  const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
                  diffRatio = changed / (a.width * a.height);
                  if (changed > 0) diffArtifactId = await saveScreenshot(ctx, test.projectId, test.organizationId, `diff-${name}`, PNG.sync.write(diff), retention.screenshotDays);
                } else diffRatio = 1;
              }
            }
          }
          await page.close();
          const status = !loaded || issues.some((i) => i.code === 'page_error') ? 'failed' : issues.length ? 'warning' : 'passed';
          tally[status]++;
          tally.total++;
          await ctx.db.insert(responsiveTestResults).values({
            testId,
            deviceKey: d.key,
            deviceName: d.name,
            width: d.width,
            height: d.height,
            path: p,
            status,
            issues: issues.slice(0, 20),
            screenshotArtifactId,
            diffArtifactId,
            diffRatio,
            loadMs,
          });
          await publish(ctx.db, { type: 'responsive.updated', organizationId: test.organizationId, projectId: test.projectId, id: testId });
        }
      } finally {
        await context.close();
      }
    }
  } catch (e) {
    logger.error({ err: e }, 'responsive test crashed');
    return fail((e as Error).message.slice(0, 500));
  }
  await ctx.db.update(responsiveTests).set({ status: 'completed', summary: tally, finishedAt: new Date() }).where(eq(responsiveTests.id, testId));
  await timeline(ctx.db, {
    organizationId: test.organizationId,
    projectId: test.projectId,
    kind: 'preview',
    tone: tally.failed ? 'bad' : tally.warning ? 'warn' : 'ok',
    title: `Cihaz testi: ${tally.total} senaryo · ${tally.passed} başarılı`,
    description: `${tally.warning} uyarı, ${tally.failed} hata · ${devices.length} cihaz × ${test.paths.length} sayfa`,
    refType: 'responsive_test',
    refId: testId,
  });
  await publish(ctx.db, { type: 'responsive.updated', organizationId: test.organizationId, projectId: test.projectId, id: testId });
  return tally;
}

