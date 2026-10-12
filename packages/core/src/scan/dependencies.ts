import YAML from 'yaml';
import type { Severity } from '@projecthub/contracts';
import type { RawFinding } from './types.js';

export type Ecosystem = 'npm' | 'Packagist' | 'PyPI' | 'Go' | 'crates.io';

export interface Dependency {
  name: string;
  version: string;
  ecosystem: Ecosystem;
  /** Lock/manifest file the version came from. */
  source: string;
  /** True when the version comes from a range in a manifest (no lockfile). */
  approximate: boolean;
  direct: boolean;
}

/* ------------------------------------------------------------------ parsing */

export function parseDependencies(files: Map<string, string>): Dependency[] {
  const out = new Map<string, Dependency>();
  const add = (d: Dependency) => {
    const k = `${d.ecosystem}|${d.name}|${d.version}`;
    const prev = out.get(k);
    if (!prev || (prev.approximate && !d.approximate)) out.set(k, { ...d, direct: d.direct || !!prev?.direct });
  };
  const directNpm = new Set<string>();
  const pkgJson = files.get('package.json');
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const n of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) directNpm.add(n);
    } catch {
      /* invalid json reported by detection */
    }
  }

  const npmLock = files.get('package-lock.json');
  const pnpmLock = files.get('pnpm-lock.yaml');
  const yarnLock = files.get('yarn.lock');
  if (npmLock) parseNpmLock(npmLock, directNpm).forEach(add);
  else if (pnpmLock) parsePnpmLock(pnpmLock, directNpm).forEach(add);
  else if (yarnLock) parseYarnLock(yarnLock, directNpm).forEach(add);
  else if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
        const v = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(range)?.[1] ?? /(\d+\.\d+)/.exec(range)?.[1]?.concat('.0');
        if (v && !/^(file|link|workspace|git|https?):/.test(range)) {
          add({ name, version: v, ecosystem: 'npm', source: 'package.json', approximate: true, direct: true });
        }
      }
    } catch {
      /* ignore */
    }
  }

  const composerLock = files.get('composer.lock');
  if (composerLock) {
    const directComposer = new Set<string>();
    try {
      const cj = JSON.parse(files.get('composer.json') ?? '{}') as { require?: Record<string, string>; 'require-dev'?: Record<string, string> };
      for (const n of [...Object.keys(cj.require ?? {}), ...Object.keys(cj['require-dev'] ?? {})]) directComposer.add(n.toLowerCase());
    } catch {
      /* ignore */
    }
    try {
      const c = JSON.parse(composerLock) as { packages?: { name: string; version: string }[]; 'packages-dev'?: { name: string; version: string }[] };
      for (const p of [...(c.packages ?? []), ...(c['packages-dev'] ?? [])]) {
        add({ name: p.name, version: p.version.replace(/^v/, ''), ecosystem: 'Packagist', source: 'composer.lock', approximate: false, direct: directComposer.has(p.name.toLowerCase()) });
      }
    } catch {
      /* ignore */
    }
  }

  const req = files.get('requirements.txt');
  if (req) {
    for (const line of req.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_.-]+)(\[[^\]]+\])?\s*==\s*([0-9][^\s;#]*)/.exec(line);
      if (m) add({ name: m[1]!.toLowerCase(), version: m[3]!, ecosystem: 'PyPI', source: 'requirements.txt', approximate: false, direct: true });
    }
  }

  const goMod = files.get('go.mod');
  if (goMod) {
    const re = /^\s*(?:require\s+)?([a-zA-Z0-9.\-_/]+\.[a-z]{2,}[a-zA-Z0-9.\-_/]*)\s+(v\d+\.\d+\.\d+[^\s]*)/gm;
    for (const m of goMod.matchAll(re)) {
      add({ name: m[1]!, version: m[2]!, ecosystem: 'Go', source: 'go.mod', approximate: false, direct: !/\/\/ indirect/.test(m[0]) });
    }
  }

  const cargo = files.get('Cargo.lock');
  if (cargo) {
    for (const m of cargo.matchAll(/\[\[package\]\]\s*\nname = "([^"]+)"\s*\nversion = "([^"]+)"/g)) {
      add({ name: m[1]!, version: m[2]!, ecosystem: 'crates.io', source: 'Cargo.lock', approximate: false, direct: false });
    }
  }
  return [...out.values()];
}

function parseNpmLock(text: string, direct: Set<string>): Dependency[] {
  const deps: Dependency[] = [];
  let lock: { packages?: Record<string, { version?: string; link?: boolean }>; dependencies?: Record<string, unknown> };
  try {
    lock = JSON.parse(text);
  } catch {
    return deps;
  }
  if (lock.packages) {
    for (const [key, v] of Object.entries(lock.packages)) {
      if (!key || v.link || !v.version) continue;
      const idx = key.lastIndexOf('node_modules/');
      if (idx < 0) continue;
      const name = key.slice(idx + 'node_modules/'.length);
      deps.push({ name, version: v.version, ecosystem: 'npm', source: 'package-lock.json', approximate: false, direct: direct.has(name) });
    }
  } else if (lock.dependencies) {
    const walk = (tree: Record<string, unknown>) => {
      for (const [name, raw] of Object.entries(tree)) {
        const v = raw as { version?: string; dependencies?: Record<string, unknown> };
        if (v.version && !v.version.startsWith('file:')) {
          deps.push({ name, version: v.version, ecosystem: 'npm', source: 'package-lock.json', approximate: false, direct: direct.has(name) });
        }
        if (v.dependencies) walk(v.dependencies);
      }
    };
    walk(lock.dependencies);
  }
  return deps;
}

function parsePnpmLock(text: string, direct: Set<string>): Dependency[] {
  const deps: Dependency[] = [];
  let lock: { packages?: Record<string, unknown> };
  try {
    lock = YAML.parse(text) as { packages?: Record<string, unknown> };
  } catch {
    return deps;
  }
  for (const rawKey of Object.keys(lock.packages ?? {})) {
    const key = rawKey.replace(/^\//, '').replace(/\(.*$/, '');
    let name: string;
    let version: string;
    const at = key.lastIndexOf('@');
    if (at > 0) {
      name = key.slice(0, at);
      version = key.slice(at + 1);
    } else {
      // pnpm v5: /name/1.2.3
      const slash = key.lastIndexOf('/');
      name = key.slice(0, slash);
      version = key.slice(slash + 1);
    }
    if (!/^\d/.test(version)) continue;
    deps.push({ name, version, ecosystem: 'npm', source: 'pnpm-lock.yaml', approximate: false, direct: direct.has(name) });
  }
  return deps;
}

function parseYarnLock(text: string, direct: Set<string>): Dependency[] {
  const deps: Dependency[] = [];
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line && !line.startsWith(' ') && !line.startsWith('#') && line.endsWith(':')) {
      const first = line.replace(/:$/, '').split(',')[0]!.trim().replace(/^"|"$/g, '');
      const at = first.lastIndexOf('@');
      current = at > 0 ? first.slice(0, at) : first;
      continue;
    }
    const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
    if (m && current) {
      deps.push({ name: current, version: m[1]!, ecosystem: 'npm', source: 'yarn.lock', approximate: false, direct: direct.has(current) });
      current = null;
    }
  }
  return deps;
}

/* ------------------------------------------------------------------ OSV */

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
  affected?: {
    package?: { name: string; ecosystem: string };
    ranges?: { type: string; events: Record<string, string>[] }[];
    database_specific?: { severity?: string };
  }[];
  references?: { url: string }[];
}

export interface InventoryItem extends Dependency {
  /** Newest stable release on the package registry (direct dependencies only), null when unknown. */
  latest: string | null;
}

export interface DependencyScanResult {
  findings: RawFinding[];
  packagesScanned: number;
  notes: string[];
  inventory: InventoryItem[];
}

/** Package registry base URLs used to look up the latest release. An empty/missing URL skips that ecosystem. */
export interface PackageRegistries {
  npm?: string;
  pypi?: string;
  packagist?: string;
}

export const dependencyKey = (d: { ecosystem: string; name: string }) => `${d.ecosystem}|${d.name.toLowerCase()}`;

export async function scanDependencies(
  deps: Dependency[],
  opts: { osvUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number; registries?: PackageRegistries },
): Promise<DependencyScanResult> {
  const notes: string[] = [];
  const findings: RawFinding[] = [];
  if (!deps.length) return { findings, packagesScanned: 0, notes, inventory: [] };
  if (deps.some((d) => d.approximate)) notes.push('Lock dosyası olmadığı için bazı paketler sürüm aralığının alt sınırıyla tarandı.');
  let packagesScanned = 0;
  if (!opts.osvUrl) notes.push('Çevrimiçi bağımlılık taraması kapalı (OSV_API_URL boş).');
  else if (await osvFindings(deps, opts, findings, notes)) packagesScanned = deps.length;

  const latest = opts.registries ? await latestVersions(deps.filter((d) => d.direct), opts.registries, opts.fetchImpl ?? fetch) : new Map<string, string>();
  for (const d of deps) {
    const l = latest.get(dependencyKey(d));
    if (!l || updateType(d.version, l) !== 'major') continue;
    const behind = Number(l.split('.')[0]) - Number(d.version.split('.')[0]);
    findings.push({
      type: 'dependency',
      severity: 'info',
      ruleId: 'dependency/outdated-major',
      title: `${d.name} güncel değil (${d.version} → ${l})`,
      description: `${d.name} için ${behind} ana sürüm geride. Ana sürüm geçişleri kırıcı değişiklik içerebilir; değişiklik notlarını inceleyin.`,
      filePath: d.source,
      packageName: d.name,
      packageVersion: d.version,
      fixedVersion: l,
      identity: d.ecosystem === 'npm' ? `outdated|${d.name}` : `outdated|${d.ecosystem}|${d.name}`,
    });
  }
  return { findings, packagesScanned, notes, inventory: deps.map((d) => ({ ...d, latest: latest.get(dependencyKey(d)) ?? null })) };
}

/** OSV lookup; returns false when the vulnerability database could not be reached. */
async function osvFindings(deps: Dependency[], opts: { osvUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number }, findings: RawFinding[], notes: string[]): Promise<boolean> {
  const f = opts.fetchImpl ?? fetch;
  const timeout = opts.timeoutMs ?? 20_000;
  const vulnIdsByDep = new Map<number, string[]>();
  try {
    for (let start = 0; start < deps.length; start += 500) {
      const batch = deps.slice(start, start + 500);
      const res = await f(`${opts.osvUrl.replace(/\/$/, '')}/v1/querybatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queries: batch.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })) }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`OSV querybatch HTTP ${res.status}`);
      const body = (await res.json()) as { results: { vulns?: { id: string }[] }[] };
      body.results.forEach((r, i) => {
        if (r.vulns?.length) vulnIdsByDep.set(start + i, r.vulns.map((v) => v.id));
      });
    }
  } catch (e) {
    notes.push(`Zafiyet veritabanına (OSV) ulaşılamadı: ${(e as Error).message}. Bağımlılık zafiyetleri bu taramada kontrol edilemedi.`);
    return false;
  }

  const ids = [...new Set([...vulnIdsByDep.values()].flat())].slice(0, 300);
  if (ids.length >= 300) notes.push('300\'den fazla zafiyet kaydı bulundu; ilk 300 tanesi detaylandırıldı.');
  const details = new Map<string, OsvVuln>();
  await mapLimit(ids, 8, async (id) => {
    try {
      const res = await f(`${opts.osvUrl.replace(/\/$/, '')}/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(timeout) });
      if (res.ok) details.set(id, (await res.json()) as OsvVuln);
    } catch {
      /* missing details fall back to a generic finding */
    }
  });

  for (const [idx, vulnIds] of vulnIdsByDep) {
    const dep = deps[idx]!;
    // Prefer one finding per advisory group (GHSA + CVE aliases describe the same issue).
    const seen = new Set<string>();
    for (const id of vulnIds) {
      const v = details.get(id);
      const aliasKey = [id, ...(v?.aliases ?? [])].sort()[0]!;
      if (seen.has(aliasKey)) continue;
      seen.add(aliasKey);
      const severity = osvSeverity(v, dep);
      const fixed = fixedVersion(v, dep);
      const cve = v?.aliases?.find((a) => a.startsWith('CVE-'));
      findings.push({
        type: 'dependency',
        severity,
        ruleId: `dependency/${id}`,
        title: `${dep.name} ${dep.version} — ${v?.summary?.slice(0, 180) ?? id}`,
        description: [
          v?.summary ?? `${id} zafiyeti`,
          fixed ? `Düzeltilmiş sürüm: ${fixed}.` : 'Düzeltilmiş sürüm henüz yayımlanmamış olabilir.',
          dep.approximate ? 'Sürüm, lock dosyası olmadığı için yaklaşık belirlendi.' : `Kaynak: ${dep.source}.`,
        ].join(' '),
        filePath: dep.source,
        packageName: dep.name,
        packageVersion: dep.version,
        fixedVersion: fixed ?? undefined,
        advisoryId: cve ?? id,
        references: (v?.references ?? []).slice(0, 5).map((r) => r.url),
        identity: `dep|${dep.ecosystem}|${dep.name}|${aliasKey}`,
      });
    }
  }
  return true;
}

/** "major" | "minor" | "patch" when `latest` is newer than `current`, otherwise null. */
export function updateType(current: string, latest: string): 'major' | 'minor' | 'patch' | null {
  if (compareVersions(latest, current) <= 0) return null;
  const [a, b] = [current, latest].map((v) => v.replace(/^v/, '').split(/[.-]/).map(Number));
  if (a![0] !== b![0]) return 'major';
  if ((a![1] ?? 0) !== (b![1] ?? 0)) return 'minor';
  return 'patch';
}

const STABLE = (v: string) => !/(dev|alpha|beta|rc|preview|a\d|b\d)/i.test(v);

/** Latest stable release per package from npm, PyPI and Packagist (other ecosystems are skipped). */
export async function latestVersions(deps: Dependency[], reg: PackageRegistries, f: typeof fetch = fetch, timeoutMs = 8_000): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Map(deps.map((d) => [dependencyKey(d), d])).values()].slice(0, 150);
  const base = (u: string | undefined) => (u ? u.replace(/\/$/, '') : '');
  await mapLimit(unique, 6, async (d) => {
    try {
      let version: string | undefined;
      if (d.ecosystem === 'npm' && base(reg.npm)) {
        const res = await f(`${base(reg.npm)}/${d.name.replace('/', '%2f')}/latest`, { signal: AbortSignal.timeout(timeoutMs) });
        if (res.ok) version = ((await res.json()) as { version?: string }).version;
      } else if (d.ecosystem === 'PyPI' && base(reg.pypi)) {
        const res = await f(`${base(reg.pypi)}/pypi/${encodeURIComponent(d.name)}/json`, { signal: AbortSignal.timeout(timeoutMs) });
        if (res.ok) version = ((await res.json()) as { info?: { version?: string } }).info?.version;
      } else if (d.ecosystem === 'Packagist' && base(reg.packagist)) {
        const res = await f(`${base(reg.packagist)}/p2/${d.name}.json`, { signal: AbortSignal.timeout(timeoutMs) });
        if (res.ok) {
          const list = ((await res.json()) as { packages?: Record<string, { version: string }[]> }).packages?.[d.name] ?? [];
          version = list.map((x) => x.version.replace(/^v/, '')).filter(STABLE).sort(compareVersions).at(-1);
        }
      }
      if (version && STABLE(version)) out.set(dependencyKey(d), version.replace(/^v/, ''));
    } catch {
      /* registry hiccups only mean "latest unknown" */
    }
  });
  return out;
}

function osvSeverity(v: OsvVuln | undefined, dep: Dependency): Severity {
  const label =
    v?.database_specific?.severity ??
    v?.affected?.find((a) => a.package?.name === dep.name)?.database_specific?.severity;
  if (label) {
    const l = label.toUpperCase();
    if (l === 'CRITICAL') return 'critical';
    if (l === 'HIGH') return 'high';
    if (l === 'MODERATE' || l === 'MEDIUM') return 'medium';
    if (l === 'LOW') return 'low';
  }
  const vector = v?.severity?.find((s) => s.type === 'CVSS_V3')?.score;
  if (vector) {
    const score = cvss3BaseScore(vector);
    if (score !== null) return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
  }
  return 'medium';
}

function fixedVersion(v: OsvVuln | undefined, dep: Dependency): string | null {
  if (!v?.affected) return null;
  const candidates: string[] = [];
  for (const a of v.affected) {
    if (a.package && a.package.name.toLowerCase() !== dep.name.toLowerCase()) continue;
    for (const r of a.ranges ?? []) for (const e of r.events) if (e.fixed) candidates.push(e.fixed);
  }
  const newer = candidates.filter((c) => compareVersions(c, dep.version) > 0).sort(compareVersions);
  return newer[0] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/);
  const pb = b.replace(/^v/, '').split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** CVSS v3.x base score (FIRST specification). Returns null for unparseable vectors. */
export function cvss3BaseScore(vector: string): number | null {
  const m = Object.fromEntries(
    vector
      .split('/')
      .slice(1)
      .map((p) => p.split(':') as [string, string]),
  );
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[m.AV as 'N'];
  const AC = { L: 0.77, H: 0.44 }[m.AC as 'L'];
  const UI = { N: 0.85, R: 0.62 }[m.UI as 'N'];
  const scopeChanged = m.S === 'C';
  const PR = (scopeChanged ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 })[m.PR as 'N'];
  const cia = { H: 0.56, L: 0.22, N: 0 };
  const C = cia[m.C as 'H'];
  const I = cia[m.I as 'H'];
  const A = cia[m.A as 'H'];
  if ([AV, AC, UI, PR, C, I, A].some((x) => x === undefined)) return null;
  const iss = 1 - (1 - C!) * (1 - I!) * (1 - A!);
  const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * AV! * AC! * PR! * UI!;
  const raw = scopeChanged ? Math.min(1.08 * (impact + exploitability), 10) : Math.min(impact + exploitability, 10);
  return Math.ceil(raw * 10 - 1e-9) / 10;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
