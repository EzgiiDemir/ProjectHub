import YAML from 'yaml';
import type { RawFinding } from './types.js';

/**
 * Infrastructure-as-code checks: Docker Compose, Kubernetes manifests and Terraform. Deterministic rules only — the
 * AI explains findings, it never decides them. Each rule targets a misconfiguration that widens the blast radius of a
 * compromised container or exposes a service/secret, not style.
 */
export function scanInfrastructure(path: string, content: string): RawFinding[] {
  if (/\.tf$/i.test(path)) return scanTerraform(path, content);
  if (!/\.ya?ml$/i.test(path)) return [];
  let docs: unknown[];
  try {
    docs = YAML.parseAllDocuments(content, { uniqueKeys: false }).map((d) => d.toJS({ maxAliasCount: 50 }) as unknown);
  } catch {
    return [];
  }
  if (/(^|\/)(docker-)?compose[^/]*\.ya?ml$/i.test(path)) {
    const doc = docs[0];
    return isObject(doc) && isObject(doc.services) ? scanCompose(path, content, doc.services) : [];
  }
  const out: RawFinding[] = [];
  for (const doc of docs) if (isObject(doc) && typeof doc.apiVersion === 'string' && typeof doc.kind === 'string') out.push(...scanKubernetes(path, content, doc));
  return out;
}

const DATASTORE_PORTS = new Set([5432, 3306, 1433, 27017, 6379, 9200, 5672, 11434, 2375, 2376]);
const SECRET_KEY = /(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)/i;
const DANGEROUS_CAPS = new Set(['ALL', 'SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'DAC_READ_SEARCH']);

function scanCompose(path: string, content: string, services: Record<string, unknown>): RawFinding[] {
  const out: RawFinding[] = [];
  const add = (svc: string, rule: string, severity: RawFinding['severity'], title: string, description: string, needle: RegExp) =>
    out.push({ type: 'config', severity, ruleId: `iac/${rule}`, title, description: `${path} → "${svc}": ${description}`, filePath: path, line: lineOf(content, needle), identity: `${rule}|${path}|${svc}` });

  for (const [name, raw] of Object.entries(services)) {
    if (!isObject(raw)) continue;
    const s = raw;
    if (s.privileged === true) add(name, 'compose-privileged', 'high', 'Ayrıcalıklı (privileged) container', 'privileged: true container\'a host çekirdeği üzerinde neredeyse tam yetki verir. Gerekli yetkiyi cap_add ile tek tek verin.', /privileged:\s*true/);
    for (const v of asArray(s.volumes)) {
      const src = typeof v === 'string' ? v.split(':')[0] : isObject(v) ? String(v.source ?? '') : '';
      if (/docker\.sock$/.test(src ?? '')) add(name, 'compose-docker-socket', 'high', 'Docker soketi container\'a bağlanmış', 'docker.sock erişimi host üzerinde root yetkisine eşdeğerdir. Yalnızca güvenilen altyapı servislerinde ve salt okunur kullanın.', /docker\.sock/);
    }
    if (s.network_mode === 'host') add(name, 'compose-host-network', 'medium', 'Host ağı kullanılıyor', 'network_mode: host ağ izolasyonunu kaldırır; container host üzerindeki tüm portlara erişebilir.', /network_mode:\s*['"]?host/);
    if (s.pid === 'host' || s.ipc === 'host') add(name, 'compose-host-namespace', 'medium', 'Host süreç/IPC alanı paylaşılıyor', 'pid/ipc: host container\'ın host süreçlerini görmesine ve etkilemesine izin verir.', /(pid|ipc):\s*['"]?host/);
    const caps = asArray(s.cap_add).map((c) => String(c).toUpperCase().replace(/^CAP_/, ''));
    const bad = caps.filter((c) => DANGEROUS_CAPS.has(c));
    if (bad.length) add(name, 'compose-dangerous-capability', 'medium', 'Tehlikeli Linux yetkisi ekleniyor', `cap_add: ${bad.join(', ')} container kaçışını kolaylaştırır.`, new RegExp(bad[0]!));
    if (asArray(s.security_opt).some((o) => /(seccomp|apparmor)[:=]unconfined/.test(String(o)))) add(name, 'compose-unconfined', 'medium', 'Güvenlik profili kapatılmış', 'seccomp/apparmor unconfined çekirdek korumalarını devre dışı bırakır.', /unconfined/);
    for (const p of asArray(s.ports)) {
      const { host, target, published } = parsePort(p);
      if (published && DATASTORE_PORTS.has(target) && !/^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(host ?? '')) {
        add(name, 'compose-exposed-datastore', 'medium', 'Veritabanı/iç servis portu dışarı açık', `${target} portu tüm ağ arayüzlerine yayınlanıyor. Gerekmiyorsa ports'u kaldırın ya da 127.0.0.1:${published}:${target} biçiminde bağlayın.`, new RegExp(String(target)));
      }
    }
    for (const [key, value] of envEntries(s.environment)) {
      if (SECRET_KEY.test(key) && value && !/^\$\{?[A-Z_]/.test(value) && !/^(changeme|change-me|example|xxx+)$/i.test(value)) {
        add(name, 'compose-inline-secret', 'high', 'Compose dosyasında açık secret', `${key} değeri dosyaya yazılmış. Değeri .env dosyasından \${${key}} ile ya da Docker secrets ile verin; anahtarı yenileyin.`, new RegExp(`${key}\\s*[:=]`));
      }
    }
  }
  return out;
}

function scanKubernetes(path: string, content: string, doc: Record<string, unknown>): RawFinding[] {
  const out: RawFinding[] = [];
  const kind = String(doc.kind);
  const name = isObject(doc.metadata) ? String(doc.metadata.name ?? kind) : kind;
  const add = (rule: string, severity: RawFinding['severity'], title: string, description: string, needle: RegExp, extra = '') =>
    out.push({ type: 'config', severity, ruleId: `iac/${rule}`, title, description: `${path} → ${kind}/${name}: ${description}`, filePath: path, line: lineOf(content, needle), identity: `${rule}|${path}|${kind}/${name}${extra}` });

  const spec = podSpec(doc);
  if (!spec) return out;
  if (spec.hostNetwork === true || spec.hostPID === true || spec.hostIPC === true) add('k8s-host-namespace', 'medium', 'Pod host ad alanlarını paylaşıyor', 'hostNetwork/hostPID/hostIPC pod izolasyonunu kaldırır.', /host(Network|PID|IPC):\s*true/);
  for (const v of asArray(spec.volumes)) if (isObject(v) && isObject(v.hostPath)) add('k8s-host-path', 'medium', 'hostPath volume kullanılıyor', `"${String(v.hostPath.path ?? '')}" host dosya sistemi pod'a bağlanıyor.`, /hostPath:/, `|${String(v.name)}`);
  const podSec = isObject(spec.securityContext) ? spec.securityContext : {};
  for (const c of [...asArray(spec.containers), ...asArray(spec.initContainers)]) {
    if (!isObject(c)) continue;
    const cname = String(c.name ?? '?');
    const sec = isObject(c.securityContext) ? c.securityContext : {};
    if (sec.privileged === true) add('k8s-privileged', 'high', 'Ayrıcalıklı container', `"${cname}" privileged: true ile çalışıyor.`, /privileged:\s*true/, `|${cname}`);
    if (sec.allowPrivilegeEscalation === true) add('k8s-privilege-escalation', 'medium', 'Yetki yükseltmeye izin veriliyor', `"${cname}" için allowPrivilegeEscalation: false ayarlayın.`, /allowPrivilegeEscalation:\s*true/, `|${cname}`);
    const runAsUser = sec.runAsUser ?? podSec.runAsUser;
    const nonRoot = sec.runAsNonRoot ?? podSec.runAsNonRoot;
    if (runAsUser === 0 || (nonRoot !== true && runAsUser === undefined)) add('k8s-root-user', runAsUser === 0 ? 'medium' : 'low', 'Container root olarak çalışabilir', `"${cname}" için runAsNonRoot: true ve root olmayan runAsUser tanımlayın.`, new RegExp(`name:\\s*['"]?${escapeRe(cname)}`), `|${cname}`);
    const image = String(c.image ?? '');
    if (image && !image.includes('@sha256') && (!/:[^/]+$/.test(image) || image.endsWith(':latest'))) add('k8s-unpinned-image', 'low', 'Sabitlenmemiş image', `"${image}" etiket/sürüm içermiyor; dağıtımlar tekrarlanabilir olmaz.`, new RegExp(escapeRe(image)), `|${cname}`);
    if (!isObject(c.resources) || !isObject(c.resources.limits)) add('k8s-no-limits', 'low', 'Kaynak sınırı yok', `"${cname}" için resources.limits (cpu/memory) tanımlanmamış; tek pod düğümü tüketebilir.`, new RegExp(`name:\\s*['"]?${escapeRe(cname)}`), `|${cname}`);
  }
  return out;
}

function scanTerraform(path: string, content: string): RawFinding[] {
  const out: RawFinding[] = [];
  const lines = content.split(/\r?\n/);
  const add = (rule: string, severity: RawFinding['severity'], title: string, description: string, line: number) =>
    out.push({ type: 'config', severity, ruleId: `iac/${rule}`, title, description: `${path}:${line}: ${description}`, filePath: path, line, identity: `${rule}|${path}|${line}` });

  // Ingress blocks open to the whole internet; admin/database ports are high.
  const ingress = /ingress\s*\{([\s\S]*?)\n\s*\}/g;
  for (let m = ingress.exec(content); m; m = ingress.exec(content)) {
    const body = m[1] ?? '';
    if (!/0\.0\.0\.0\/0|::\/0/.test(body)) continue;
    const from = Number(/from_port\s*=\s*(\d+)/.exec(body)?.[1] ?? -1);
    const to = Number(/to_port\s*=\s*(\d+)/.exec(body)?.[1] ?? from);
    const sensitive = [22, 3389, 5432, 3306, 1433, 27017, 6379].some((p) => p >= from && p <= to) || from === 0;
    add(sensitive ? 'tf-open-admin-port' : 'tf-open-ingress', sensitive ? 'high' : 'medium', sensitive ? 'Yönetim/veritabanı portu internete açık' : 'Güvenlik grubu tüm internete açık', `${from === to ? from : `${from}-${to}`} portu 0.0.0.0/0 kaynağından erişime açık. Kaynağı ofis/VPN IP aralıklarıyla sınırlayın.`, content.slice(0, m.index).split('\n').length);
  }
  lines.forEach((l, i) => {
    const t = l.trim();
    if (/^acl\s*=\s*"public-read(-write)?"/.test(t)) add('tf-public-bucket', 'high', 'Depolama alanı herkese açık', 'Bucket ACL herkese okuma izni veriyor. Erişimi kaldırın ve public access block açın.', i + 1);
    if (/^publicly_accessible\s*=\s*true/.test(t)) add('tf-public-database', 'high', 'Veritabanı internetten erişilebilir', 'publicly_accessible = true veritabanını internete açar.', i + 1);
    if (/^(storage_)?encrypted\s*=\s*false/.test(t)) add('tf-unencrypted-storage', 'medium', 'Şifrelenmemiş depolama', 'Disk/veritabanı şifrelemesi kapalı. encrypted = true ayarlayın.', i + 1);
    const secret = /^([a-z_]*(password|secret|token|access_key)[a-z_]*)\s*=\s*"([^"$]{4,})"/i.exec(t);
    if (secret) add('tf-inline-secret', 'high', 'Terraform dosyasında açık secret', `${secret[1]} değeri dosyaya yazılmış. Değişken (sensitive = true) veya secret yöneticisi kullanın.`, i + 1);
  });
  return out;
}

function podSpec(doc: Record<string, unknown>): Record<string, unknown> | null {
  const spec = isObject(doc.spec) ? doc.spec : null;
  if (!spec) return null;
  if (doc.kind === 'Pod') return spec;
  if (doc.kind === 'CronJob') {
    const job = isObject(spec.jobTemplate) && isObject(spec.jobTemplate.spec) ? spec.jobTemplate.spec : null;
    return job && isObject(job.template) && isObject(job.template.spec) ? job.template.spec : null;
  }
  return isObject(spec.template) && isObject(spec.template.spec) ? spec.template.spec : null;
}

function parsePort(p: unknown): { host?: string; target: number; published: string | null } {
  if (isObject(p)) return { host: p.host_ip ? String(p.host_ip) : undefined, target: Number(p.target), published: p.published != null ? String(p.published) : null };
  const parts = String(p).replace(/\/(tcp|udp)$/, '').split(':');
  if (parts.length === 1) return { target: Number(parts[0]), published: null };
  const target = Number(parts.at(-1));
  const published = parts.at(-2) ?? null;
  const host = parts.length > 2 ? parts.slice(0, -2).join(':') : undefined;
  return { host, target, published };
}

function envEntries(env: unknown): [string, string][] {
  if (Array.isArray(env)) return env.map((e) => String(e).split(/=(.*)/s).slice(0, 2) as [string, string]).filter(([, v]) => v !== undefined);
  if (isObject(env)) return Object.entries(env).map(([k, v]) => [k, v == null ? '' : String(v)]);
  return [];
}

function lineOf(content: string, needle: RegExp): number | undefined {
  const idx = content.split(/\r?\n/).findIndex((l) => needle.test(l));
  return idx >= 0 ? idx + 1 : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
