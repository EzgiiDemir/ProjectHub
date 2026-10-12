/// <reference lib="dom" />
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { Page } from 'playwright';
import { ai, PermanentJobError, publish, timeline, type JobContext, type Logger } from '@projecthub/core';
import { artifacts, environments, organizations, previews, projects, users, versions } from '@projecthub/database';
import type { WorkerCtx } from '../context.js';
import { getBrowser, previewContext } from './browser.js';

export interface GuidePayload {
  projectId: string;
  previewId: string;
  requestedBy: string | null;
}

/** What a visitor sees on one page, collected from the running preview. */
interface PageInfo {
  path: string;
  name: string;
  heading: string;
  /** First explanatory paragraph on the page. */
  intro: string;
  sections: string[];
  buttons: string[];
  fields: string[];
  links: string[];
  /** Labels of the site's own navigation (header/nav links). */
  menu: string[];
  shot: string; // data URL (JPEG)
}

interface PageText {
  summary: string;
  steps: string[];
}

const MAX_PAGES = 8;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 80);

/** Reads headings, buttons, form fields and in-site links of the current page. */
async function describePage(page: Page): Promise<Omit<PageInfo, 'path' | 'shot'>> {
  return page.evaluate(() => {
    const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const uniq = (xs: string[]) => [...new Set(xs.filter((x) => x && x.length < 80))];
    const label = (el: Element) => {
      const id = el.getAttribute('id');
      const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      return text(byFor) || text(el.closest('label')) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
    };
    return {
      name: text(document.querySelector('h1')) || document.title.split(/\s[·|–—-]\s/)[0] || location.pathname,
      intro: ([...document.querySelectorAll('main p, p')].map(text).find((t) => t.length > 12) ?? '').slice(0, 220),
      heading: text(document.querySelector('h1')),
      sections: uniq([...document.querySelectorAll('h2, h3')].filter(visible).map(text)).slice(0, 8),
      buttons: uniq([...document.querySelectorAll('button, input[type=submit], [role=button], a[class*=btn], a[class*=button], a[class*=cta]')].filter(visible).map((b) => text(b) || (b as HTMLInputElement).value || '')).slice(0, 8),
      menu: uniq([...document.querySelectorAll('nav a, header a')].filter(visible).map(text)).slice(0, 8),
      fields: uniq([...document.querySelectorAll('input:not([type=hidden]):not([type=submit]), select, textarea')].filter(visible).map(label)).slice(0, 10),
      links: uniq(
        [...document.querySelectorAll('nav a, header a, a')]
          .map((a) => (a as HTMLAnchorElement).href)
          .filter((h) => {
            try {
              const u = new URL(h);
              return u.origin === location.origin && !/\.(pdf|zip|png|jpe?g|svg)$/i.test(u.pathname) && !/logout|cikis|signout/i.test(u.pathname);
            } catch {
              return false;
            }
          })
          .map((h) => new URL(h).pathname),
      ),
    };
  });
}

/** Visits the home page and the pages linked from it (same origin, up to MAX_PAGES). */
async function crawl(ctx: WorkerCtx, pv: typeof previews.$inferSelect, log: Logger): Promise<{ pages: PageInfo[]; mobile: string | null }> {
  const { context, base } = await previewContext(ctx, pv, { width: 1280, height: 800, scaleFactor: 1, isMobile: false, userAgent: null });
  const pages: PageInfo[] = [];
  try {
    const page = await context.newPage();
    const queue = ['/'];
    const seen = new Set<string>();
    while (queue.length && pages.length < MAX_PAGES) {
      const p = queue.shift()!;
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        const res = await page.goto(`${base}${p}`, { waitUntil: 'load', timeout: 30_000 });
        if (!res || res.status() >= 400) continue;
        await page.waitForTimeout(600);
        const info = await describePage(page);
        // The same page under two addresses (/ and /index.html) is described once.
        if (pages.some((x) => x.name === clean(info.name) && x.heading === clean(info.heading) && x.sections.join('|') === info.sections.join('|'))) continue;
        const shot = await page.screenshot({ type: 'jpeg', quality: 78 });
        pages.push({ ...info, path: p, name: clean(info.name), heading: clean(info.heading), shot: `data:image/jpeg;base64,${shot.toString('base64')}` });
        for (const l of info.links) if (!seen.has(l) && !queue.includes(l)) queue.push(l);
      } catch (e) {
        log.warn({ err: e, path: p }, 'guide page skipped');
      }
    }
  } finally {
    await context.close();
  }
  // One phone-sized view of the home page for the "on your phone" slide.
  let mobile: string | null = null;
  try {
    const m = await previewContext(ctx, pv, { width: 390, height: 844, scaleFactor: 2, isMobile: true, userAgent: null });
    const page = await m.context.newPage();
    await page.goto(`${m.base}/`, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(500);
    mobile = `data:image/jpeg;base64,${(await page.screenshot({ type: 'jpeg', quality: 78 })).toString('base64')}`;
    await m.context.close();
  } catch {
    mobile = null;
  }
  return { pages, mobile };
}

/** Plain-language text from the page structure (used when AI is not available, and as AI's fallback). */
function ruleText(p: PageInfo, navName: string): PageText {
  const summary = [
    p.heading ? `Bu sayfa “${p.heading}” başlığıyla açılır.` : `Bu, “${navName}” sayfasıdır.`,
    p.intro ? `Sayfada şu bilgi yer alır: “${p.intro}”` : '',
    p.sections.length ? `Sayfada şu bölümleri görürsünüz: ${p.sections.slice(0, 5).join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const steps: string[] = [];
  if (p.path !== '/') steps.push(`Üst menüden veya ana sayfadaki bağlantıdan “${navName}” sayfasına geçin.`);
  else {
    steps.push('Size verilen adresi tarayıcınızda açın; ilk bu sayfa görünür.');
    if (p.menu.length) steps.push(`Sayfanın üstündeki menüden diğer bölümlere geçebilirsiniz: ${p.menu.map((m) => `“${m}”`).join(', ')}.`);
  }
  if (p.fields.length) {
    steps.push(`Şu alanları doldurun: ${p.fields.slice(0, 6).join(', ')}.`);
    const submit = p.buttons.find((b) => /gönder|kaydet|giriş|devam|ara|başvur|send|submit|save|login|search/i.test(b)) ?? p.buttons[0];
    if (submit) steps.push(`Bilgileri kontrol edip “${submit}” düğmesine basın.`);
  } else if (p.buttons.length) {
    steps.push(p.buttons.length === 1 ? `“${p.buttons[0]}” düğmesine basarak devam edebilirsiniz.` : `İşlem yapmak için ${p.buttons.slice(0, 3).map((b) => `“${b}”`).join(', ')} düğmelerini kullanabilirsiniz.`);
  }
  if (p.sections.length > 2) steps.push('Sayfayı aşağı kaydırarak diğer bölümleri görebilirsiniz.');
  return { summary, steps };
}

/** Asks the configured AI to rewrite the page descriptions for non-technical readers; null when unavailable. */
async function aiText(ctx: WorkerCtx, organizationId: string, projectId: string, projectName: string, pages: PageInfo[], log: Logger): Promise<PageText[] | null> {
  try {
    const r = await ai.resolveAi(ctx.db, ctx.config, organizationId, { minLevel: 'L1', projectId });
    if (r.provider.name === 'ollama') {
      const rt = await ai.getOllamaRuntimeStatus(ctx.config.OLLAMA_BASE_URL);
      if (!rt.reachable || !rt.models.some((m) => m.name === r.provider.model || m.name.split(':')[0] === r.provider.model)) return null;
    }
    const facts = pages.map((p, i) => ({ i, sayfa: p.name, adres: p.path, baslik: p.heading, aciklama: p.intro, bolumler: p.sections, menu: p.menu, dugmeler: p.buttons, alanlar: p.fields }));
    const out = await r.provider.complete({
      system:
        'Sen teknik bilgisi olmayan kullanıcılar için kullanım kılavuzu yazan bir yazarsın. Yalnızca verilen sayfa bilgilerini kullan, olmayan özellik uydurma. Türkçe, kısa ve sade cümleler kur; teknik terim kullanma. ' +
        'Yanıtın yalnızca JSON olsun: [{"i":0,"summary":"…","steps":["…","…"]}] (her sayfa için 1-2 cümlelik özet ve en fazla 4 adım).',
      messages: [{ role: 'user', content: `Uygulama: ${projectName}\nSayfalar: ${JSON.stringify(facts)}` }],
      maxTokens: 2500,
      signal: AbortSignal.timeout(150_000),
    });
    const json = /\[[\s\S]*\]/.exec(out.text)?.[0];
    if (!json) return null;
    const parsed = JSON.parse(json) as { i: number; summary?: string; steps?: string[] }[];
    return pages.map((_, i) => {
      const x = parsed.find((p) => p.i === i);
      return x?.summary ? { summary: String(x.summary).slice(0, 600), steps: (x.steps ?? []).map((s) => String(s).slice(0, 300)).slice(0, 5) } : null;
    }) as PageText[];
  } catch (e) {
    log.warn({ err: e }, 'guide AI text unavailable, using plain-language rules');
    return null;
  }
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Segoe UI', Arial, sans-serif; color: #17212b; }
  h1, h2, h3 { margin: 0; font-weight: 700; }
  .muted { color: #5b6772; }
  .shot { width: 100%; border: 1px solid #d2d7cf; border-radius: 10px; display: block; }
  ol { margin: 8px 0 0; padding-left: 22px; } li { margin: 6px 0; line-height: 1.5; }
`;

function guideHtml(d: { project: string; version: string | null; date: string; logo: string | null; owner: string | null; url: string | null; pages: PageInfo[]; texts: PageText[]; aiWritten: boolean }) {
  const brand = d.logo ? `<img src="${d.logo}" style="max-height:56px;max-width:220px">` : '';
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><style>${BASE_CSS}
    @page { size: A4; margin: 18mm 16mm; }
    .cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }
    .cover h1 { font-size: 34px; margin: 22px 0 8px; } .cover .kind { font-size: 15px; letter-spacing: .12em; text-transform: uppercase; color: #1f4e8c; font-weight: 700; }
    .box { background: #f2f4f1; border-radius: 10px; padding: 14px 16px; margin: 14px 0; line-height: 1.55; font-size: 13.5px; }
    .page { page-break-before: always; } .page h2 { font-size: 22px; margin-bottom: 4px; } .page .path { font-size: 12px; margin-bottom: 12px; }
    .page p { font-size: 14px; line-height: 1.6; margin: 12px 0; } .page h3 { font-size: 15px; margin-top: 16px; }
    .toc li { font-size: 14px; } footer { font-size: 11px; }
  </style></head><body>
  <section class="cover">${brand}
    <div class="kind" style="margin-top:28px">Kullanım kılavuzu</div><h1>${esc(d.project)}</h1>
    <div class="muted">${d.version ? `Sürüm ${esc(d.version)} · ` : ''}${esc(d.date)}</div>
    <div class="box" style="margin-top:36px"><b>Bu kılavuz kimin için?</b><br>Uygulamayı ilk kez kullanacak herkes için. Her sayfanın ne işe yaradığını ve nasıl kullanılacağını adım adım, ekran görüntüleriyle anlatır.</div>
  </section>
  <section><h2 style="font-size:22px">Başlarken</h2>
    <div class="box">${d.url ? `Uygulamayı açmak için tarayıcınıza şu adresi yazın: <b>${esc(d.url)}</b><br>` : ''}Uygulama bilgisayarda, tablette ve telefonda çalışır. Herhangi bir kurulum gerekmez.</div>
    <h3>Bu kılavuzdaki sayfalar</h3><ol class="toc">${d.pages.map((p) => `<li>${esc(p.name)}</li>`).join('')}</ol>
  </section>
  ${d.pages
    .map(
      (p, i) => `<section class="page"><h2>${i + 1}. ${esc(p.name)}</h2><div class="path muted">Adres: ${esc(p.path)}</div>
      <img class="shot" src="${p.shot}">
      <p>${esc(d.texts[i]!.summary)}</p>
      ${d.texts[i]!.steps.length ? `<h3>Nasıl kullanılır?</h3><ol>${d.texts[i]!.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
    </section>`,
    )
    .join('')}
  <section class="page"><h2>Yardım</h2>
    <p><b>Bir şey beklediğiniz gibi çalışmazsa</b> ne yaptığınızı, hangi sayfada olduğunuzu ve gördüğünüz mesajı not alın; mümkünse ekran görüntüsü ekleyin.</p>
    ${d.owner ? `<p>Proje sorumlusu: <b>${esc(d.owner)}</b></p>` : ''}
    <footer class="muted" style="margin-top:40px">Bu kılavuz Project Hub tarafından uygulamanın çalışan sürümünden otomatik hazırlandı${d.aiWritten ? ' (metinler yapay zekâ yardımıyla sadeleştirildi)' : ''}. Veri Sistemleri Birimi.</footer>
  </section></body></html>`;
}

function slidesHtml(d: { project: string; version: string | null; date: string; logo: string | null; pages: PageInfo[]; texts: PageText[]; mobile: string | null }) {
  const slide = (inner: string, extra = '') => `<section class="slide ${extra}">${inner}</section>`;
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><style>${BASE_CSS}
    @page { size: 1280px 720px; margin: 0; }
    .slide { width: 1280px; height: 720px; padding: 56px 72px; page-break-after: always; display: flex; flex-direction: column; overflow: hidden; }
    .title { background: linear-gradient(135deg, #17212b, #1f4e8c); color: #fff; justify-content: center; }
    .title h1 { font-size: 56px; margin: 18px 0 10px; } .title .muted { color: #c9d4df; font-size: 22px; }
    .slide h2 { font-size: 34px; margin-bottom: 18px; }
    .two { display: grid; grid-template-columns: 1.55fr 1fr; gap: 40px; flex: 1; min-height: 0; align-items: start; }
    .two .shot { max-height: 520px; object-fit: cover; object-position: top; }
    .two p { font-size: 20px; line-height: 1.5; margin: 0 0 14px; } .two li { font-size: 18px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; }
    .grid div { background: #f2f4f1; border-radius: 12px; padding: 18px; font-size: 18px; font-weight: 600; }
    .logo { background: #fff; border-radius: 10px; padding: 10px 14px; display: inline-block; align-self: flex-start; }
  </style></head><body>
  ${slide(`${d.logo ? `<span class="logo"><img src="${d.logo}" style="max-height:48px"></span>` : ''}<h1>${esc(d.project)}</h1><div class="muted">Uygulama tanıtımı${d.version ? ` · Sürüm ${esc(d.version)}` : ''} · ${esc(d.date)}</div>`, 'title')}
  ${slide(`<h2>Uygulamada neler var?</h2><div class="grid">${d.pages.map((p, i) => `<div><span class="muted" style="font-size:14px">${i + 1}</span><br>${esc(p.name)}</div>`).join('')}</div>`)}
  ${d.pages
    .map((p, i) =>
      slide(
        `<h2>${esc(p.name)}</h2><div class="two"><img class="shot" src="${p.shot}"><div><p>${esc(d.texts[i]!.summary)}</p>${d.texts[i]!.steps.length ? `<ol>${d.texts[i]!.steps.slice(0, 4).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}</div></div>`,
      ),
    )
    .join('')}
  ${d.mobile ? slide(`<h2>Telefonda da çalışır</h2><div class="two" style="grid-template-columns: 360px 1fr"><img class="shot" src="${d.mobile}" style="max-height:560px;width:auto"><div><p>Aynı adresi telefonun tarayıcısında açmanız yeterli. Ekran telefona göre kendini düzenler.</p></div></div>`) : ''}
  ${slide(`<h1 style="font-size:48px;margin-top:180px">Teşekkürler</h1><p class="muted" style="font-size:22px">Sorularınız için proje ekibine ulaşabilirsiniz.</p>`, 'title')}
  </body></html>`;
}

async function pdf(html: string, opts: { width?: string; height?: string; format?: 'A4' }): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await (await browser.newContext()).newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ ...opts, printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.context().close();
  }
}

/** Builds the user guide (A4) and presentation (16:9) PDFs of a project from its running preview. */
export async function generateGuide(ctx: WorkerCtx, { job, logger }: JobContext) {
  const p = job.payload as unknown as GuidePayload;
  const project = (await ctx.db.select().from(projects).where(eq(projects.id, p.projectId)))[0];
  if (!project) throw new PermanentJobError('project not found');
  const pv = (await ctx.db.select().from(previews).where(eq(previews.id, p.previewId)))[0];
  if (!pv || pv.projectId !== project.id || pv.status !== 'ready') throw new PermanentJobError('Ön izleme çalışmıyor; önce bir ön izleme başlatın');

  const { pages, mobile } = await crawl(ctx, pv, logger);
  if (!pages.length) throw new PermanentJobError('Ön izlemeden hiçbir sayfa okunamadı');
  const navNames = pages.map((x) => x.name);
  const aiTexts = await aiText(ctx, project.organizationId, project.id, project.name, pages, logger);
  const texts = pages.map((x, i) => aiTexts?.[i] ?? ruleText(x, navNames[i]!));

  const org = (await ctx.db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, project.organizationId)))[0];
  const branding = (org?.settings.branding ?? {}) as { logo?: string | null };
  const projectBranding = (project.settings.branding ?? {}) as { logo?: string | null };
  const logo = projectBranding.logo ?? branding.logo ?? null;
  const version = (await ctx.db.select({ version: versions.version }).from(versions).where(eq(versions.projectId, project.id)).orderBy(desc(versions.createdAt)).limit(1))[0]?.version ?? null;
  const owner = project.ownerId ? ((await ctx.db.select({ name: users.displayName }).from(users).where(eq(users.id, project.ownerId)))[0]?.name ?? null) : null;
  const date = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'long' }).format(new Date());
  const productionUrl = (await ctx.db.select({ url: environments.url }).from(environments).where(and(eq(environments.projectId, project.id), eq(environments.type, 'production'))))[0]?.url || null;

  const guide = await pdf(guideHtml({ project: project.name, version, date, logo, owner, url: productionUrl, pages, texts, aiWritten: !!aiTexts }), { format: 'A4' });
  const slides = await pdf(slidesHtml({ project: project.name, version, date, logo, pages, texts, mobile }), { width: '1280px', height: '720px' });

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const saved: { id: string; kind: string; fileName: string }[] = [];
  for (const [kind, data, fileName] of [
    ['guide', guide, `${project.slug}-kullanim-kilavuzu.pdf`],
    ['slides', slides, `${project.slug}-sunum.pdf`],
  ] as const) {
    const key = ctx.storage.reportKey(project.id, `${stamp}-${fileName}`);
    await fs.mkdir(path.dirname(ctx.storage.resolve(key)), { recursive: true });
    await fs.writeFile(ctx.storage.resolve(key), data);
    const row = (await ctx.db.insert(artifacts).values({ organizationId: project.organizationId, projectId: project.id, type: 'report', storageKey: key, fileName, contentType: 'application/pdf', sizeBytes: data.length, retentionUntil: null }).returning({ id: artifacts.id }))[0]!;
    saved.push({ id: row.id, kind, fileName });
  }
  await timeline(ctx.db, { organizationId: project.organizationId, projectId: project.id, kind: 'docs', tone: 'ok', title: 'Kullanım kılavuzu ve sunum hazırlandı', description: `${pages.length} sayfa · ${aiTexts ? 'AI ile sadeleştirildi' : 'otomatik metin'}`, refType: 'preview', refId: pv.id });
  await publish(ctx.db, { type: 'guide.updated', organizationId: project.organizationId, projectId: project.id });
  return { pages: pages.length, ai: !!aiTexts, documents: saved };
}
