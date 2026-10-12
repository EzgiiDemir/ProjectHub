import dns from 'node:dns/promises';
import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, ne } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { INTEGRATION_CATALOG, integrationEnvName, integrationProvider, type IntegrationInput, type IntegrationProviderInfo } from '@projecthub/contracts';
import { audit, conflict, invalid, notFound, putSecret, readSecret, type Actor } from '@projecthub/core';
import { projectIntegrations, secrets } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';

/** Disabled integrations keep their values but are hidden from builds/deployments by this marker. */
const DISABLED = 'integration-disabled';
const TIMEOUT = 10_000;

type Row = typeof projectIntegrations.$inferSelect;
interface CheckResult {
  ok: boolean;
  message: string;
  details: string[];
}

/**
 * Project integrations (Microsoft Entra ID, WordPress / WP Forms, SMTP …). Every field is written as an encrypted
 * project secret named after its environment variable, so builds and deployments receive it without extra setup.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
  ) {}

  catalog() {
    return INTEGRATION_CATALOG;
  }

  private envNames(p: IntegrationProviderInfo, prefix: string | null) {
    return Object.fromEntries(p.fields.map((f) => [f.key, integrationEnvName(f, prefix)]));
  }

  private present(r: Row) {
    const p = integrationProvider(r.provider)!;
    const prefix = r.config.__prefix ?? null;
    return {
      id: r.id,
      provider: r.provider,
      providerName: p.name,
      name: r.name,
      prefix,
      enabled: r.enabled,
      // Non-secret values are shown; secret fields only say whether a value is stored.
      fields: p.fields.map((f) => ({ key: f.key, label: f.label, env: integrationEnvName(f, prefix), secret: !!f.secret, value: f.secret ? null : (r.config[f.key] ?? ''), stored: f.secret ? r.secretKeys.includes(integrationEnvName(f, prefix)) : !!r.config[f.key] })),
      lastCheckedAt: r.lastCheckedAt,
      lastCheckOk: r.lastCheckOk,
      lastCheckMessage: r.lastCheckMessage,
      createdAt: r.createdAt,
    };
  }

  async list(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const rows = await this.ctx.db.select().from(projectIntegrations).where(eq(projectIntegrations.projectId, scope.project.id)).orderBy(projectIntegrations.createdAt);
    return { items: rows.map((r) => this.present(r)), canManage: scope.can('secret.manage') && scope.project.status !== 'archived' };
  }

  private async rowOf(auth: AuthInfo, idOrSlug: string, integrationId: string) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'secret.manage');
    const r = (await this.ctx.db.select().from(projectIntegrations).where(and(eq(projectIntegrations.id, integrationId), eq(projectIntegrations.projectId, scope.project.id))))[0];
    if (!r) throw notFound('Entegrasyon');
    return { scope, r };
  }

  async save(auth: AuthInfo, idOrSlug: string, integrationId: string | null, input: IntegrationInput, actor: Actor) {
    const p = integrationProvider(input.provider);
    if (!p) throw invalid('Bilinmeyen entegrasyon türü');
    const scope = await this.access.requireWritable(auth, idOrSlug, 'secret.manage');
    const existing = integrationId ? (await this.rowOf(auth, idOrSlug, integrationId)).r : null;
    if (existing && existing.provider !== p.id) throw invalid('Entegrasyon türü değiştirilemez');
    const prefix = p.prefixed ? (input.prefix ?? existing?.config.__prefix ?? null) : null;
    if (p.prefixed && !prefix) throw invalid('Bu entegrasyon için ortam değişkeni öneki gerekli (ör. KARGO)');
    const env = this.envNames(p, prefix);

    // Required fields; secrets may stay empty on update (keeps the stored value).
    for (const f of p.fields) {
      const v = input.values[f.key]?.trim() ?? '';
      const stored = existing && (f.secret ? existing.secretKeys.includes(env[f.key]!) : !!existing.config[f.key]);
      if (f.required && !v && !stored) throw invalid(`${f.label} gerekli`);
    }
    const validation = validate(p.id, input.values);
    if (validation) throw invalid(validation);

    // Another integration (or a manual secret managed elsewhere) must not own the same variables.
    const others = await this.ctx.db.select().from(projectIntegrations).where(and(eq(projectIntegrations.projectId, scope.project.id), existing ? ne(projectIntegrations.id, existing.id) : undefined));
    const clash = others.find((o) => {
      const op = integrationProvider(o.provider)!;
      const names = Object.values(this.envNames(op, o.config.__prefix ?? null));
      return Object.values(env).some((n) => names.includes(n));
    });
    if (clash) throw conflict(`“${clash.name}” aynı ortam değişkenlerini kullanıyor${p.prefixed ? '; farklı bir önek seçin' : ''}`);

    const config: Record<string, string> = { ...(existing?.config ?? {}) };
    if (prefix) config.__prefix = prefix;
    const secretKeys = new Set(existing?.secretKeys ?? []);
    const row = await this.ctx.db.transaction(async (tx) => {
      for (const f of p.fields) {
        const v = input.values[f.key]?.trim();
        if (v === undefined || (f.secret && v === '')) continue;
        if (!f.secret) config[f.key] = v;
        const name = env[f.key]!;
        if (v === '') {
          await tx.delete(secrets).where(and(eq(secrets.projectId, scope.project.id), eq(secrets.name, name)));
          secretKeys.delete(name);
          continue;
        }
        await putSecret(tx, this.ctx.config.encryptionKey, { organizationId: auth.organizationId, projectId: scope.project.id, environmentId: null, name, value: v, kind: 'env', scope: 'all', system: input.enabled ? null : DISABLED, createdBy: auth.user.id });
        secretKeys.add(name);
      }
      // Enable / disable: disabled values stay stored but are not given to builds and deployments.
      if (secretKeys.size) await tx.update(secrets).set({ system: input.enabled ? null : DISABLED }).where(and(eq(secrets.projectId, scope.project.id), inArray(secrets.name, [...secretKeys])));
      const values = { name: input.name, config, secretKeys: [...secretKeys], enabled: input.enabled, updatedAt: new Date() };
      const saved = existing
        ? (await tx.update(projectIntegrations).set(values).where(eq(projectIntegrations.id, existing.id)).returning())[0]!
        : (await tx.insert(projectIntegrations).values({ ...values, organizationId: auth.organizationId, projectId: scope.project.id, provider: p.id as Row['provider'], createdBy: auth.user.id }).returning())[0]!;
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: existing ? 'integration.updated' : 'integration.created', resourceType: 'integration', resourceId: saved.id, metadata: { provider: p.id, name: input.name, enabled: input.enabled, variables: [...secretKeys] } });
      return saved;
    }).catch((e: unknown) => {
      if ((e as { code?: string }).code === '23505') throw conflict('Bu projede aynı adda bir entegrasyon var');
      throw e;
    });
    return this.present(row);
  }

  async remove(auth: AuthInfo, idOrSlug: string, integrationId: string, actor: Actor) {
    const { scope, r } = await this.rowOf(auth, idOrSlug, integrationId);
    await this.ctx.db.transaction(async (tx) => {
      if (r.secretKeys.length) await tx.delete(secrets).where(and(eq(secrets.projectId, scope.project.id), inArray(secrets.name, r.secretKeys)));
      await tx.delete(projectIntegrations).where(eq(projectIntegrations.id, r.id));
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'integration.deleted', resourceType: 'integration', resourceId: r.id, metadata: { provider: r.provider, name: r.name, variables: r.secretKeys } });
    });
    return { ok: true };
  }

  /** Real connection test against the provider; the result is stored and shown on the card. */
  async test(auth: AuthInfo, idOrSlug: string, integrationId: string, actor: Actor) {
    const { scope, r } = await this.rowOf(auth, idOrSlug, integrationId);
    const p = integrationProvider(r.provider)!;
    const env = this.envNames(p, r.config.__prefix ?? null);
    const values: Record<string, string> = {};
    for (const f of p.fields) {
      if (!f.secret) values[f.key] = r.config[f.key] ?? '';
      else if (r.secretKeys.includes(env[f.key]!)) {
        const s = (await this.ctx.db.select({ id: secrets.id }).from(secrets).where(and(eq(secrets.projectId, scope.project.id), eq(secrets.name, env[f.key]!))))[0];
        values[f.key] = s ? await readSecret(this.ctx.db, this.ctx.config.encryptionKey, s.id) : '';
      }
    }
    let result: CheckResult;
    try {
      result = await check(p.id, values, r.config.__prefix ?? null);
    } catch (e) {
      result = { ok: false, message: (e as Error).message.slice(0, 300), details: [] };
    }
    const message = [result.message, ...result.details].join(' · ').slice(0, 1000);
    await this.ctx.db.update(projectIntegrations).set({ lastCheckedAt: new Date(), lastCheckOk: result.ok, lastCheckMessage: message }).where(eq(projectIntegrations.id, r.id));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'integration.tested', resourceType: 'integration', resourceId: r.id, metadata: { ok: result.ok } });
    return { ...result, checkedAt: new Date() };
  }
}

function validate(provider: string, v: Record<string, string>): string | null {
  const url = (s: string | undefined) => {
    if (!s) return true;
    try {
      const u = new URL(s);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  };
  if (provider === 'microsoft-entra' && v.tenantId && !/^([0-9a-f-]{36}|[a-z0-9.-]+\.[a-z]{2,})$/i.test(v.tenantId.trim())) return 'Kiracı ID bir GUID veya alan adı (ör. sirket.onmicrosoft.com) olmalı';
  if (provider === 'google-analytics' && v.measurementId && !/^G-[A-Z0-9]{4,}$/.test(v.measurementId.trim())) return 'Ölçüm kimliği G-XXXXXXXX biçiminde olmalı';
  if (provider === 'smtp' && v.port && !/^\d{2,5}$/.test(v.port.trim())) return 'Port bir sayı olmalı';
  for (const k of ['siteUrl', 'redirectUri', 'url', 'baseUrl', 'webhookUrl']) if (!url(v[k]?.trim())) return 'Adres http:// veya https:// ile başlamalı';
  return null;
}

/** Refuses cloud metadata endpoints (same rule as webhook delivery); internal company servers stay reachable. */
async function assertReachable(target: string) {
  const host = new URL(target).hostname;
  if (host === 'metadata.google.internal') throw new Error('Bu adrese bağlantı testi yapılamaz');
  const addrs = await dns.lookup(host, { all: true }).catch(() => []);
  if (addrs.some((a) => /^169\.254\./.test(a.address) || a.address === 'fd00:ec2::254')) throw new Error('Bu adrese bağlantı testi yapılamaz');
}

async function http(url: string, init: RequestInit = {}) {
  await assertReachable(url);
  return fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': 'ProjectHub-IntegrationCheck/1.0', ...(init.headers ?? {}) } });
}

async function check(provider: string, v: Record<string, string>, prefix: string | null): Promise<CheckResult> {
  switch (provider) {
    case 'microsoft-entra': {
      const tenant = encodeURIComponent(v.tenantId!.trim());
      const meta = await http(`https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`);
      if (!meta.ok) return { ok: false, message: 'Kiracı bulunamadı', details: [`Entra yanıtı HTTP ${meta.status}; kiracı ID'sini kontrol edin`] };
      const token = await http(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: v.clientId!.trim(), client_secret: v.clientSecret ?? '', grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }),
      });
      if (token.ok) return { ok: true, message: 'Kiracı ve uygulama kimlik bilgileri geçerli', details: ['Entra bir erişim tokeni verdi'] };
      const err = (await token.json().catch(() => ({}))) as { error?: string; error_description?: string };
      const code = /AADSTS\d+/.exec(err.error_description ?? '')?.[0];
      const hint = code === 'AADSTS7000215' ? 'Client secret hatalı (secret “Değer” alanı girilmeli, kimliği değil)' : code === 'AADSTS700016' ? 'Bu kiracıda bu Client ID ile bir uygulama yok' : code === 'AADSTS7000222' ? 'Client secret süresi dolmuş; yenisini oluşturun' : (err.error_description ?? err.error ?? `HTTP ${token.status}`).split('\r\n')[0]!;
      return { ok: false, message: 'Kimlik bilgileri reddedildi', details: [hint] };
    }
    case 'wordpress': {
      const site = v.siteUrl!.trim().replace(/\/$/, '');
      const root = await http(`${site}/wp-json/`);
      if (!root.ok) return { ok: false, message: 'WordPress REST API yanıt vermedi', details: [`${site}/wp-json/ → HTTP ${root.status}. Kalıcı bağlantılar ve REST API açık olmalı`] };
      const info = (await root.json().catch(() => ({}))) as { name?: string; namespaces?: string[] };
      const wpforms = (info.namespaces ?? []).some((n) => n.startsWith('wpforms'));
      const me = await http(`${site}/wp-json/wp/v2/users/me?context=edit`, { headers: { authorization: `Basic ${Buffer.from(`${v.username ?? ''}:${(v.appPassword ?? '').replace(/\s+/g, '')}`).toString('base64')}` } });
      if (!me.ok) return { ok: false, message: 'Giriş başarısız', details: [`Kullanıcı adı veya uygulama şifresi hatalı (HTTP ${me.status})`, `Site: ${info.name ?? site}`] };
      const user = (await me.json().catch(() => ({}))) as { name?: string; roles?: string[] };
      return {
        ok: true,
        message: `${info.name ?? site} sitesine bağlanıldı`,
        details: [`Kullanıcı: ${user.name ?? v.username}${user.roles?.length ? ` (${user.roles.join(', ')})` : ''}`, wpforms ? 'WP Forms REST uç noktası bulundu' : 'WP Forms REST uç noktası bulunamadı (WP Forms Lite REST sunmaz; form kayıtları için Pro sürümü gerekir)'],
      };
    }
    case 'google-analytics':
      return { ok: true, message: 'Ölçüm kimliği geçerli biçimde', details: ['Google Analytics anahtar gerektirmez; veriler sayfa ziyaretleriyle akmaya başlar'] };
    case 'smtp': {
      const port = Number(v.port);
      const transport = nodemailer.createTransport({ host: v.host!.trim(), port, secure: port === 465, auth: v.user ? { user: v.user, pass: v.password ?? '' } : undefined, connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT });
      await transport.verify();
      return { ok: true, message: `${v.host}:${port} sunucusuna ${v.user ? 'giriş yapıldı' : 'bağlanıldı'}`, details: [] };
    }
    case 'slack': {
      const res = await http(v.webhookUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Project Hub bağlantı testi ✅' }) });
      return res.ok ? { ok: true, message: 'Kanala test mesajı gönderildi', details: [] } : { ok: false, message: 'Slack mesajı kabul etmedi', details: [`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`] };
    }
    case 'webhook': {
      const body = JSON.stringify({ event: 'projecthub.test', sentAt: new Date().toISOString() });
      const sig = v.secret ? { 'x-projecthub-signature': `sha256=${createHmac('sha256', v.secret).update(body).digest('hex')}` } : {};
      const res = await http(v.url!, { method: 'POST', headers: { 'content-type': 'application/json', ...sig }, body });
      return { ok: res.status < 400, message: res.status < 400 ? 'Webhook test olayını kabul etti' : 'Webhook test olayını reddetti', details: [`HTTP ${res.status}`] };
    }
    case 'rest-api': {
      const header = v.authHeader?.trim() || 'Authorization';
      const value = header.toLowerCase() === 'authorization' ? `Bearer ${v.apiKey ?? ''}` : (v.apiKey ?? '');
      const res = await http(v.baseUrl!, { headers: v.apiKey ? { [header]: value } : {} });
      const ok = res.status < 500 && res.status !== 401 && res.status !== 403;
      return { ok, message: ok ? 'Servis yanıt verdi' : res.status === 401 || res.status === 403 ? 'Servis kimliği reddetti' : 'Servis hata verdi', details: [`${prefix}_BASE_URL → HTTP ${res.status}`] };
    }
    default:
      return { ok: false, message: 'Bu tür için test yok', details: [] };
  }
}
