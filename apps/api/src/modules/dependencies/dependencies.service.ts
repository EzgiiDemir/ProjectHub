import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { SEVERITIES, type Severity } from '@projecthub/contracts';
import { AppError, notFound, precondition, scan, type Actor } from '@projecthub/core';
import { securityFindings, securityScans, versions } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';
import { Repos } from '../../infra/repos.js';
import { AiService } from '../ai/ai.service.js';

type Risk = Severity | 'none';
const rank = (s: Risk) => (s === 'none' ? -1 : SEVERITIES.length - SEVERITIES.indexOf(s));
const OUTDATED_RULE = 'dependency/outdated-major';

/** Package URL (purl) for SBOM components. */
function purl(d: { ecosystem: string; name: string; version: string }): string {
  const v = encodeURIComponent(d.version);
  switch (d.ecosystem) {
    case 'npm':
      return `pkg:npm/${d.name.replace(/^@/, '%40')}@${v}`;
    case 'PyPI':
      return `pkg:pypi/${d.name.toLowerCase().replace(/[_.]/g, '-')}@${v}`;
    case 'Packagist':
      return `pkg:composer/${d.name}@${v}`;
    case 'Go':
      return `pkg:golang/${d.name}@${v}`;
    case 'crates.io':
      return `pkg:cargo/${d.name}@${v}`;
    default:
      return `pkg:generic/${encodeURIComponent(d.name)}@${v}`;
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Dependency Center (spec §81): current vs latest release, known vulnerabilities and an upgrade risk per package,
 * plus a CycloneDX SBOM. The inventory itself is written by the worker's security scan (project settings).
 */
@Injectable()
export class DependenciesService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
    private readonly repos: Repos,
    private readonly ai: AiService,
  ) {}

  /**
   * "Yükseltmeyi hazırla": opens an AI task that upgrades one package. Refuses up front — instead of creating a task
   * that fails later — when the AI provider or the configured local model is not available.
   */
  async prepareUpgrade(auth: AuthInfo, idOrSlug: string, input: { ecosystem: string; name: string }, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'ai.execute');
    const status = await this.ai.status(auth);
    if (!status.configured) throw new AppError('AI_NOT_CONFIGURED', `AI şu an kullanılamıyor, görev oluşturulmadı. ${status.reason ?? ''}`.trim());
    const item = (await this.list(auth, scope.project.id)).items.find((i) => i.name === input.name && (i.ecosystem === input.ecosystem || !i.ecosystem));
    if (!item) throw notFound('Paket');
    const target = item.direct ? (item.latest ?? item.fixedVersion) : (item.fixedVersion ?? item.latest);
    if (!target) throw precondition(`${item.name} için daha yeni bir sürüm bilinmiyor`);
    const files = item.ecosystem ? (await this.usage(auth, scope.project.id, item.ecosystem, item.name)).files : [];
    const instruction = [
      `Bağımlılık yükseltmesi hazırla: ${item.ecosystem || 'paket'} "${item.name}" ${item.version} sürümünden ${target} sürümüne.`,
      item.direct ? `Paket doğrudan bağımlılık (${item.source}); manifest ve lock dosyasını birlikte güncelle.` : `Paket dolaylı bağımlılık (${item.source}); onu getiren üst paketi yükselt veya paket yöneticisinin override/resolution mekanizmasını kullan.`,
      item.update === 'major' ? 'Ana sürüm geçişi: paketin değişiklik notlarındaki kırıcı değişiklikleri incele ve etkilenen kodu uyarla.' : '',
      item.vulnerabilities.length ? `Giderilecek zafiyetler: ${item.vulnerabilities.map((v) => `${v.advisoryId ?? `SEC-${v.number}`} (${v.severity})`).join(', ')}.` : '',
      files.length ? `Paketi kullanan dosyalar (tahmin): ${files.slice(0, 30).map((f) => `${f.path}:${f.line}`).join(', ')}.` : '',
      'Değişiklikten sonra build ve testleri çalıştır; sonuçları özetle.',
    ]
      .filter(Boolean)
      .join('\n');
    return this.ai.createTask(auth, scope.project.id, { sourceType: 'manual', title: `${item.name} ${item.version} → ${target} yükseltmesi`.slice(0, 200), instruction }, actor);
  }

  async list(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const inventory = ((scope.project.settings as { dependencyInventory?: scan.InventoryItem[] }).dependencyInventory ?? []).filter((d) => d?.name && d.version);
    const lastScan =
      (
        await this.ctx.db
          .select({ finishedAt: securityScans.finishedAt, commitSha: securityScans.commitSha, summary: securityScans.summary })
          .from(securityScans)
          .where(and(eq(securityScans.projectId, scope.project.id), eq(securityScans.status, 'completed')))
          .orderBy(desc(securityScans.finishedAt))
          .limit(1)
      )[0] ?? null;
    const findings = await this.ctx.db
      .select()
      .from(securityFindings)
      .where(and(eq(securityFindings.projectId, scope.project.id), eq(securityFindings.type, 'dependency'), eq(securityFindings.status, 'open'), isNotNull(securityFindings.packageName)));
    const vulns = findings.filter((f) => f.ruleId !== OUTDATED_RULE);
    const vulnsOf = (name: string, version: string) => vulns.filter((f) => f.packageName!.toLowerCase() === name.toLowerCase() && (!f.packageVersion || f.packageVersion === version));

    const present = (d: { ecosystem: string; name: string; version: string; latest: string | null; direct: boolean; source: string; approximate: boolean }) => {
      const own = vulnsOf(d.name, d.version);
      const update = d.latest ? scan.updateType(d.version, d.latest) : null;
      const worst = own.reduce<Risk>((w, f) => (rank(f.severity) > rank(w) ? f.severity : w), 'none');
      const risk: Risk = worst !== 'none' ? worst : update === 'major' ? 'medium' : update ? 'low' : 'none';
      const fixed = own.map((f) => f.fixedVersion).filter((v): v is string => !!v).sort(scan.compareVersions).at(-1) ?? null;
      return {
        ...d,
        update,
        risk,
        fixedVersion: fixed,
        vulnerabilities: own.map((f) => ({ id: f.id, number: f.number, severity: f.severity, title: f.title, advisoryId: f.advisoryId, fixedVersion: f.fixedVersion })),
      };
    };
    const items = inventory.map((d) => present({ ecosystem: d.ecosystem, name: d.name, version: d.version, latest: d.latest ?? null, direct: d.direct, source: d.source, approximate: d.approximate }));
    // Vulnerable transitive packages are not in the (direct-only) inventory but matter most for security.
    const known = new Set(items.map((i) => `${i.name.toLowerCase()}@${i.version}`));
    for (const f of vulns) {
      const key = `${f.packageName!.toLowerCase()}@${f.packageVersion ?? ''}`;
      if (known.has(key)) continue;
      known.add(key);
      items.push(present({ ecosystem: '', name: f.packageName!, version: f.packageVersion ?? '?', latest: null, direct: false, source: f.filePath ?? '', approximate: false }));
    }
    items.sort((a, b) => rank(b.risk) - rank(a.risk) || Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));
    const cfg = this.ctx.config;
    return {
      scannedAt: lastScan?.finishedAt ?? null,
      commitSha: lastScan?.commitSha ?? null,
      notes: lastScan?.summary?.notes ?? [],
      registryCheck: !!(cfg.NPM_REGISTRY_URL || cfg.PYPI_URL || cfg.PACKAGIST_URL),
      summary: {
        total: items.length,
        direct: items.filter((i) => i.direct).length,
        outdated: items.filter((i) => i.update).length,
        major: items.filter((i) => i.update === 'major').length,
        vulnerable: items.filter((i) => i.vulnerabilities.length).length,
      },
      items,
    };
  }

  /** Estimated upgrade impact: source files that import the package on the default branch (npm and PyPI). */
  async usage(auth: AuthInfo, idOrSlug: string, ecosystem: string, name: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const { git } = await this.repos.forProject(scope.project.id);
    const commit = await git.resolve(`refs/heads/${scope.project.defaultBranch}`);
    if (!commit) return { supported: true, files: [] as { path: string; line: number; text: string }[] };
    let pattern: RegExp;
    let needle = name;
    if (ecosystem === 'npm') {
      pattern = new RegExp(`(?:from\\s*|require\\(\\s*|import\\(\\s*|import\\s+)['"\`]${escapeRe(name)}(?:/[^'"\`]*)?['"\`]`);
    } else if (ecosystem === 'PyPI') {
      needle = name.toLowerCase().replace(/-/g, '_');
      pattern = new RegExp(`^\\s*(?:from|import)\\s+${escapeRe(needle)}(?:[.\\s]|$)`, 'i');
    } else {
      return { supported: false, files: [] };
    }
    const hits = (await git.grep(commit, needle, { maxResults: 2000 })).filter((h) => pattern.test(h.text) && !/(^|\/)(node_modules|vendor|dist|build)\//.test(h.path));
    const byFile = new Map<string, { path: string; line: number; text: string }>();
    for (const h of hits) if (!byFile.has(h.path)) byFile.set(h.path, { path: h.path, line: h.line, text: h.text.trim().slice(0, 200) });
    return { supported: true, files: [...byFile.values()].slice(0, 200) };
  }

  /** CycloneDX 1.6 SBOM of every dependency (direct and transitive) declared on the default branch. */
  async sbom(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const { git } = await this.repos.forProject(scope.project.id);
    const commit = await git.resolve(`refs/heads/${scope.project.defaultBranch}`);
    const files = new Map<string, string>();
    if (commit) {
      for (const f of scan.DEPENDENCY_FILES) {
        const c = await git.readFile(commit, f, 50 * 1024 * 1024);
        if (c) files.set(f, c.content.toString('utf8'));
      }
    }
    const deps = scan.parseDependencies(files);
    const release = (await this.ctx.db.select({ version: versions.version }).from(versions).where(eq(versions.projectId, scope.project.id)).orderBy(desc(versions.createdAt)).limit(1))[0];
    const vulns = (
      await this.ctx.db
        .select()
        .from(securityFindings)
        .where(and(eq(securityFindings.projectId, scope.project.id), eq(securityFindings.type, 'dependency'), eq(securityFindings.status, 'open'), isNotNull(securityFindings.packageName)))
    ).filter((f) => f.ruleId !== OUTDATED_RULE);
    const refOf = new Map(deps.map((d) => [`${d.name.toLowerCase()}@${d.version}`, purl(d)]));
    const bom = {
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      serialNumber: `urn:uuid:${randomUUID()}`,
      version: 1,
      metadata: {
        timestamp: new Date().toISOString(),
        tools: { components: [{ type: 'application', name: 'Project Hub' }] },
        component: { type: 'application', 'bom-ref': scope.project.slug, name: scope.project.name, ...(release ? { version: release.version } : {}) },
        properties: [
          { name: 'projecthub:branch', value: scope.project.defaultBranch },
          ...(commit ? [{ name: 'projecthub:commit', value: commit }] : []),
        ],
      },
      components: deps.map((d) => ({
        type: 'library',
        'bom-ref': purl(d),
        name: d.name,
        version: d.version,
        purl: purl(d),
        scope: 'required',
        properties: [
          { name: 'projecthub:source', value: d.source },
          { name: 'projecthub:direct', value: String(d.direct) },
          ...(d.approximate ? [{ name: 'projecthub:approximate', value: 'true' }] : []),
        ],
      })),
      vulnerabilities: vulns
        .map((f) => ({ f, ref: refOf.get(`${f.packageName!.toLowerCase()}@${f.packageVersion ?? ''}`) }))
        .filter((x) => x.ref)
        .map(({ f, ref }) => ({
          id: f.advisoryId ?? f.ruleId.replace('dependency/', ''),
          source: { name: 'OSV', url: 'https://osv.dev' },
          ratings: [{ severity: f.severity === 'info' ? 'info' : f.severity }],
          description: f.title,
          ...(f.fixedVersion ? { recommendation: `${f.packageName} ${f.fixedVersion} veya üstüne yükseltin` } : {}),
          affects: [{ ref }],
        })),
    };
    return { fileName: `${scope.project.slug}-sbom.cdx.json`, bom };
  }
}
