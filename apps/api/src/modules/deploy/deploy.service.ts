import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import { and, asc, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DeployAdapter, DeploymentWindow, EnvironmentType } from '@projecthub/contracts';
import {
  audit,
  conflict,
  deploymentWindowDecision,
  emitDomainEvent,
  enqueue,
  forbidden,
  invalid,
  MANIFEST_FILE,
  nextNumber,
  notFound,
  parseManifest,
  policyDenied,
  precondition,
  publish,
  putSecret,
  QUEUES,
  scan,
  sha256,
  timeline,
  type Actor,
} from '@projecthub/core';
import {
  artifacts,
  backups,
  projectMigrations,
  builds,
  databaseConnections,
  deploymentApprovals,
  deployments,
  deploymentSteps,
  deploymentTargets,
  environments,
  projectManifests,
  projects,
  securityFindings,
  users,
  versions,
  type DetectedMigration,
} from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess, type ProjectScope } from '../../infra/project-access.js';
import { Repos } from '../../infra/repos.js';

const DEPLOY_PERMISSION = (type: EnvironmentType) => (type === 'production' ? 'deployment.production' : 'deployment.staging');

@Injectable()
export class DeployService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
    private readonly repos: Repos,
  ) {}

  /* ---------------- environments & targets ---------------- */

  async environments(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const envs = await this.ctx.db
      .select({ e: environments, version: versions.version })
      .from(environments)
      .leftJoin(versions, eq(versions.id, environments.currentVersionId))
      .where(eq(environments.projectId, scope.project.id))
      .orderBy(sql`CASE ${environments.type} WHEN 'development' THEN 0 WHEN 'staging' THEN 1 WHEN 'production' THEN 2 ELSE 3 END`, asc(environments.createdAt));
    const ids = envs.map((e) => e.e.id);
    const targets = ids.length ? await this.ctx.db.select().from(deploymentTargets).where(inArray(deploymentTargets.environmentId, ids)) : [];
    const dbs = ids.length ? await this.ctx.db.select().from(databaseConnections).where(inArray(databaseConnections.environmentId, ids)) : [];
    return envs.map(({ e, version }) => {
      const t = targets.find((x) => x.environmentId === e.id);
      const d = dbs.find((x) => x.environmentId === e.id);
      return {
        ...e,
        currentVersion: version,
        target: t
          ? { adapter: t.adapter, host: t.host, port: t.port, username: t.username, remotePath: t.remotePath, hasCredential: !!t.credentialSecretId, configuration: t.configuration, updatedAt: t.updatedAt }
          : null,
        database: d ? { databaseType: d.databaseType, host: d.host, port: d.port, databaseName: d.databaseName, username: d.username, sslMode: d.sslMode, hasPassword: !!d.passwordSecretId, lastCheckedAt: d.lastCheckedAt, lastCheckOk: d.lastCheckOk, lastCheckMessage: d.lastCheckMessage } : null,
      };
    });
  }

  async upsertEnvironment(
    auth: AuthInfo,
    idOrSlug: string,
    envId: string | null,
    input: { name: string; slug: string; type: EnvironmentType; url: string; healthPath: string; requiresApproval: boolean; requiredApprovals: number; monitor: boolean },
    actor: Actor,
  ) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'environment.manage');
    if (input.monitor && !input.url) throw invalid('İzleme için ortam adresi (URL) gerekli');
    const values = { ...input, organizationId: auth.organizationId, projectId: scope.project.id };
    const row = envId
      ? (await this.ctx.db.update(environments).set(input).where(and(eq(environments.id, envId), eq(environments.projectId, scope.project.id))).returning())[0]
      : (await this.ctx.db.insert(environments).values(values).returning())[0];
    if (!row) throw notFound('Ortam');
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: envId ? 'environment.updated' : 'environment.created', resourceType: 'environment', resourceId: row.id, metadata: input });
    return row;
  }

  async deleteEnvironment(auth: AuthInfo, idOrSlug: string, envId: string, confirm: string, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'environment.manage');
    const env = (await this.ctx.db.select().from(environments).where(and(eq(environments.id, envId), eq(environments.projectId, scope.project.id))))[0];
    if (!env) throw notFound('Ortam');
    if (confirm !== env.slug) throw invalid('Onay için ortam adını (slug) aynen yazın');
    const running = await this.ctx.db.select({ n: count() }).from(deployments).where(and(eq(deployments.environmentId, env.id), inArray(deployments.status, ['queued', 'running', 'pending_approval'])));
    if ((running[0]?.n ?? 0) > 0) throw conflict('Ortamda devam eden deployment var');
    await this.ctx.db.delete(environments).where(eq(environments.id, env.id));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'environment.deleted', resourceType: 'environment', resourceId: env.id, metadata: { name: env.name } });
  }

  private async envOf(scope: ProjectScope, envId: string) {
    const env = (await this.ctx.db.select().from(environments).where(and(eq(environments.id, envId), eq(environments.projectId, scope.project.id))))[0];
    if (!env) throw notFound('Ortam');
    return env;
  }

  /** Deployment target (FTP/SFTP/SSH/local). Credentials are encrypted into the secret store and never returned. */
  async upsertTarget(
    auth: AuthInfo,
    idOrSlug: string,
    envId: string,
    input: { adapter: DeployAdapter; host: string; port?: number; username: string; credential?: string; credentialType: 'password' | 'private_key'; remotePath: string; secure: boolean; keepReleases: number; postDeployCommand?: string },
    actor: Actor,
  ) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'environment.manage');
    const env = await this.envOf(scope, envId);
    if (input.adapter !== 'local' && !input.host) throw invalid('Sunucu adresi gerekli');
    if (input.adapter === 'local') {
      const path = await import('node:path');
      const target = path.resolve(input.remotePath);
      const allowed = this.ctx.config.deployLocalRoots.some((root) => target === root || target.startsWith(root + path.sep));
      if (!allowed) throw policyDenied(`Yerel deployment yalnızca izin verilen klasörlere yapılabilir: ${this.ctx.config.deployLocalRoots.join(', ')}`);
    }
    if (input.adapter === 'ssh' && input.postDeployCommand && /[\n\r]/.test(input.postDeployCommand)) throw invalid('Komut tek satır olmalı');
    const existing = (await this.ctx.db.select().from(deploymentTargets).where(eq(deploymentTargets.environmentId, env.id)))[0];
    let credentialSecretId = existing?.credentialSecretId ?? null;
    if (input.credential) {
      credentialSecretId = await putSecret(this.ctx.db, this.ctx.config.encryptionKey, {
        organizationId: auth.organizationId,
        projectId: scope.project.id,
        environmentId: env.id,
        name: `DEPLOY_${input.credentialType === 'private_key' ? 'PRIVATE_KEY' : 'PASSWORD'}`,
        value: input.credential,
        kind: input.credentialType === 'private_key' ? 'ssh_key' : 'credential',
        scope: 'deploy',
        system: 'deploy-target',
        createdBy: auth.user.id,
      });
    }
    const values = {
      environmentId: env.id,
      adapter: input.adapter,
      host: input.host,
      port: input.port ?? (input.adapter === 'ftp' ? 21 : input.adapter === 'local' ? null : 22),
      username: input.username,
      remotePath: input.remotePath,
      credentialSecretId,
      configuration: { secure: input.secure, keepReleases: input.keepReleases, postDeployCommand: input.postDeployCommand, credentialType: input.credentialType },
    };
    if (existing) await this.ctx.db.update(deploymentTargets).set(values).where(eq(deploymentTargets.id, existing.id));
    else await this.ctx.db.insert(deploymentTargets).values(values);
    await audit(this.ctx.db, {
      organizationId: auth.organizationId,
      projectId: scope.project.id,
      actor,
      action: 'deployment_target.updated',
      resourceType: 'environment',
      resourceId: env.id,
      metadata: { adapter: input.adapter, host: input.host, remotePath: input.remotePath, credentialChanged: !!input.credential },
    });
    if (input.adapter === 'ftp' && !input.secure) {
      await timeline(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, kind: 'deploy', tone: 'warn', title: `${env.name}: şifrelenmemiş FTP hedefi tanımlandı`, description: 'Legacy mod. Mümkünse SFTP/SSH veya FTPS kullanın.', actorLabel: actor.label });
    }
    return (await this.environments(auth, idOrSlug)).find((e) => e.id === env.id);
  }

  async testTarget(auth: AuthInfo, idOrSlug: string, envId: string, actor: Actor) {
    const scope = await this.access.require(auth, idOrSlug, 'environment.manage');
    const env = await this.envOf(scope, envId);
    const t = (await this.ctx.db.select().from(deploymentTargets).where(eq(deploymentTargets.environmentId, env.id)))[0];
    if (!t) throw precondition('Önce deployment hedefi tanımlayın');
    await enqueue(this.ctx.db, { queue: QUEUES.deployment, type: 'deployment.test_target', organizationId: auth.organizationId, projectId: scope.project.id, maxAttempts: 1, payload: { environmentId: env.id, requestedBy: auth.user.id } });
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'deployment_target.test_requested', resourceType: 'environment', resourceId: env.id });
    return { queued: true };
  }

  /* ---------------- versions ---------------- */

  async versions(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const rows = await this.ctx.db
      .select({ v: versions, buildNumber: builds.number, by: users.displayName })
      .from(versions)
      .innerJoin(builds, eq(builds.id, versions.buildId))
      .leftJoin(users, eq(users.id, versions.createdBy))
      .where(eq(versions.projectId, scope.project.id))
      .orderBy(desc(versions.createdAt));
    const deployed = await this.ctx.db
      .select({ versionId: environments.currentVersionId, name: environments.name, type: environments.type })
      .from(environments)
      .where(eq(environments.projectId, scope.project.id));
    return rows.map((r) => ({ ...r.v, buildNumber: r.buildNumber, createdByName: r.by, liveIn: deployed.filter((d) => d.versionId === r.v.id).map((d) => d.name) }));
  }

  /** Spec §48 + §30: a version pins a passed build, tags the commit, keeps its artifact and lists new migrations. */
  async createVersion(auth: AuthInfo, idOrSlug: string, input: { version: string; buildId: string; releaseNotes: string }, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'version.create');
    const b = (await this.ctx.db.select().from(builds).where(and(eq(builds.id, input.buildId), eq(builds.projectId, scope.project.id))))[0];
    if (!b) throw notFound('Build');
    if (b.status !== 'passed' || !b.artifactId) throw precondition('Versiyon yalnızca başarılı ve artifact\'ı olan bir build\'den oluşturulabilir');
    const art = (await this.ctx.db.select().from(artifacts).where(eq(artifacts.id, b.artifactId)))[0];
    if (!art || !(await this.ctx.storage.exists(art.storageKey))) throw precondition('Build artifact\'ı saklama süresi dolduğu için silinmiş; yeniden build alın');
    const dup = await this.ctx.db.select({ id: versions.id }).from(versions).where(and(eq(versions.projectId, scope.project.id), eq(versions.version, input.version)));
    if (dup.length) throw conflict(`v${input.version} zaten var`);
    const { git } = await this.repos.forProject(scope.project.id);
    const previous = (await this.ctx.db.select().from(versions).where(eq(versions.projectId, scope.project.id)).orderBy(desc(versions.createdAt)).limit(1))[0];
    const migrations = await this.detectMigrations(git, scope.project.id, b.commitSha, previous?.commitSha ?? null);
    await git.createTag(`v${input.version}`, b.commitSha, `v${input.version}\n\n${input.releaseNotes}`, { name: auth.user.displayName, email: auth.user.email });
    const row = await this.ctx.db.transaction(async (tx) => {
      const v = (
        await tx
          .insert(versions)
          .values({ organizationId: auth.organizationId, projectId: scope.project.id, version: input.version, commitSha: b.commitSha, buildId: b.id, releaseNotes: input.releaseNotes, migrations, createdBy: auth.user.id })
          .returning()
      )[0]!;
      // Release artifacts are kept indefinitely (spec §49).
      await tx.update(artifacts).set({ type: 'release', retentionUntil: null }).where(eq(artifacts.id, b.artifactId!));
      // Migration registry (spec §44): first version that brought each migration, with a content checksum.
      for (const m of migrations) {
        const file = await git.readFile(b.commitSha, m.path, 2 * 1024 * 1024);
        await tx
          .insert(projectMigrations)
          .values({ projectId: scope.project.id, path: m.path, name: m.name, checksum: sha256(file?.content ?? Buffer.alloc(0)), riskLevel: m.risk, operations: m.operations, firstVersionId: v.id })
          .onConflictDoNothing();
      }
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'version.created', resourceType: 'version', resourceId: v.id, metadata: { version: input.version, build: b.number, migrations: migrations.length } });
      await timeline(tx, {
        organizationId: auth.organizationId,
        projectId: scope.project.id,
        kind: 'version',
        tone: 'ok',
        title: `v${input.version} oluşturuldu`,
        description: `Build #${b.number} · ${b.commitSha.slice(0, 7)}${migrations.length ? ` · ${migrations.length} migration (${migrations.filter((m) => m.risk === 'high').length} yüksek riskli)` : ''}`,
        actorLabel: actor.label,
        refType: 'version',
        refId: v.id,
      });
      return v;
    });
    return row;
  }

  /** Migration files added or changed between two commits, with data-risk analysis. */
  private async detectMigrations(git: Awaited<ReturnType<Repos['forProject']>>['git'], projectId: string, commit: string, previousCommit: string | null): Promise<DetectedMigration[]> {
    let dir: string | undefined;
    const file = await git.readFile(commit, MANIFEST_FILE);
    if (file) {
      try {
        dir = parseManifest(file.content.toString('utf8')).database.migrate?.directory;
      } catch {
        /* invalid manifest is reported by builds */
      }
    }
    if (!dir) {
      const stored = (await this.ctx.db.select().from(projectManifests).where(eq(projectManifests.projectId, projectId)).orderBy(desc(projectManifests.version)).limit(1))[0];
      dir = stored?.content.database.migrate?.directory;
    }
    if (!dir) return [];
    const files = await git.listFiles(commit);
    const migrationPaths = scan.listMigrationFiles(files.map((f) => f.path), dir);
    let changed = new Set(migrationPaths);
    if (previousCommit) {
      const stat = await git.diffStat(previousCommit, commit);
      changed = new Set(stat.map((s) => s.path).filter((p) => migrationPaths.includes(p)));
    }
    const out: DetectedMigration[] = [];
    for (const p of migrationPaths.filter((x) => changed.has(x)).slice(0, 200)) {
      const f = await git.readFile(commit, p, 2 * 1024 * 1024);
      if (f) out.push(scan.analyseMigration(p, f.content.toString('utf8')));
    }
    return out;
  }

  /* ---------------- deployments ---------------- */

  async list(auth: AuthInfo, idOrSlug: string | null) {
    const conds = [eq(deployments.organizationId, auth.organizationId)];
    if (idOrSlug) {
      const scope = await this.access.require(auth, idOrSlug);
      conds.push(eq(deployments.projectId, scope.project.id));
    }
    const rows = await this.ctx.db
      .select({ d: deployments, env: environments.name, envType: environments.type, version: versions.version, by: users.displayName, projectName: projects.name, projectSlug: projects.slug })
      .from(deployments)
      .innerJoin(environments, eq(environments.id, deployments.environmentId))
      .innerJoin(versions, eq(versions.id, deployments.versionId))
      .innerJoin(projects, eq(projects.id, deployments.projectId))
      .leftJoin(users, eq(users.id, deployments.requestedBy))
      .where(and(...conds))
      .orderBy(desc(deployments.createdAt))
      .limit(200);
    const visible = idOrSlug ? rows : await this.filterVisible(auth, rows);
    return visible.map((r) => ({ ...r.d, key: `D-${r.d.number}`, environmentName: r.env, environmentType: r.envType, version: r.version, requestedByName: r.d.requestedByType === 'ai' ? 'AI Asistan' : r.by, projectName: r.projectName, projectSlug: r.projectSlug }));
  }

  private async filterVisible<T extends { d: { projectId: string } }>(auth: AuthInfo, rows: T[]): Promise<T[]> {
    if (auth.orgPermissions.has('project.read.all')) return rows;
    const ids = [...new Set(rows.map((r) => r.d.projectId))];
    const visible = new Set<string>();
    for (const id of ids) {
      try {
        await this.access.require(auth, id);
        visible.add(id);
      } catch {
        /* not visible */
      }
    }
    return rows.filter((r) => visible.has(r.d.projectId));
  }

  /**
   * Spec §44–45 + policy engine §106: validates permissions and policies, then either waits for approvals
   * or queues the durable deployment workflow. Returns immediately (202-style); progress streams via SSE.
   */
  async deploymentWindow(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const decision = deploymentWindowDecision(scope.project.settings, 'production');
    return { window: (scope.project.settings as { deploymentWindow?: DeploymentWindow }).deploymentWindow ?? null, productionNow: decision.status, canEdit: scope.can('project.update') };
  }

  async setDeploymentWindow(auth: AuthInfo, idOrSlug: string, input: DeploymentWindow, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'project.update');
    // jsonb_set touches only this key, so concurrent writers of other settings stay intact.
    await this.ctx.db.execute(sql`UPDATE projects SET settings = jsonb_set(settings, '{deploymentWindow}', ${JSON.stringify(input)}::jsonb), updated_at = now() WHERE id = ${scope.project.id}`);
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'deployment.window_changed', resourceType: 'project', resourceId: scope.project.id, metadata: input });
    await publish(this.ctx.db, { type: 'project.updated', organizationId: auth.organizationId, projectId: scope.project.id });
    return this.deploymentWindow(auth, scope.project.id);
  }

  async create(auth: AuthInfo, idOrSlug: string, input: { environmentId: string; versionId: string; runMigrations: boolean; backup: boolean; overrideSecurityPolicy: boolean; overrideReason?: string }, actor: Actor, opts: { isRollback?: boolean } = {}) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'project.read');
    const env = await this.envOf(scope, input.environmentId);
    const needed = DEPLOY_PERMISSION(env.type);
    if (!scope.can(needed)) throw forbidden(env.type === 'production' ? 'Production deployment yetkiniz yok' : 'Deployment yetkiniz yok');
    // AI may never deploy to production (spec §27, §77) — enforced here, not only in prompts.
    if (actor.type === 'ai' && env.type === 'production') throw policyDenied('AI production ortamına deployment yapamaz');
    const v = (await this.ctx.db.select().from(versions).where(and(eq(versions.id, input.versionId), eq(versions.projectId, scope.project.id))))[0];
    if (!v) throw notFound('Versiyon');
    const target = (await this.ctx.db.select().from(deploymentTargets).where(eq(deploymentTargets.environmentId, env.id)))[0];
    if (!target) throw precondition(`${env.name} ortamı için deployment hedefi (FTP/SFTP/SSH/yerel) tanımlanmamış`);
    const busy = await this.ctx.db.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.environmentId, env.id), inArray(deployments.status, ['queued', 'running', 'pending_approval'])));
    if (busy.length) throw conflict('Bu ortamda bekleyen veya süren bir deployment var');

    let policyOverride: { by: string; reason: string } | null = null;
    if (env.type === 'production') {
      const crit = await this.ctx.db
        .select({ n: count() })
        .from(securityFindings)
        .where(and(eq(securityFindings.projectId, scope.project.id), eq(securityFindings.status, 'open'), eq(securityFindings.severity, 'critical')));
      const critical = crit[0]?.n ?? 0;
      if (critical > 0) {
        if (!input.overrideSecurityPolicy) {
          throw policyDenied(`Projede ${critical} açık kritik güvenlik bulgusu var; production deployment engellendi. Bulguları çözün veya güvenlik yetkisiyle gerekçeli istisna verin.`, { criticalFindings: critical });
        }
        if (!scope.can('security.manage')) throw forbidden('Güvenlik politikası istisnası için security.manage yetkisi gerekir');
        if (!input.overrideReason || input.overrideReason.trim().length < 10) throw invalid('İstisna gerekçesi en az 10 karakter olmalı');
        policyOverride = { by: auth.user.displayName, reason: input.overrideReason.trim() };
      }
    }

    // Deployment window policy (spec §25: "after 22:00 a deployment needs a manager's approval").
    const window = deploymentWindowDecision(scope.project.settings, env.type, { isRollback: opts.isRollback });
    if (window.status === 'outside' && window.action === 'deny') throw policyDenied(window.message, { deploymentWindow: true });
    const outsideWindow = window.status === 'outside' ? window.message : null;
    const needsApproval = env.requiresApproval || !!outsideWindow;
    const row = await this.ctx.db.transaction(async (tx) => {
      const number = await nextNumber(tx, auth.organizationId, 'deployment');
      const previous = env.currentDeploymentId;
      const d = (
        await tx
          .insert(deployments)
          .values({
            organizationId: auth.organizationId,
            projectId: scope.project.id,
            environmentId: env.id,
            versionId: v.id,
            number,
            status: needsApproval ? 'pending_approval' : 'queued',
            adapter: target.adapter,
            runMigrations: input.runMigrations,
            backup: input.backup,
            isRollback: opts.isRollback ?? false,
            policyOverride,
            requestedByType: actor.type === 'ai' ? 'ai' : 'user',
            requestedBy: actor.type === 'user' ? auth.user.id : null,
            previousDeploymentId: previous,
          })
          .returning()
      )[0]!;
      if (!needsApproval) await enqueue(tx, { queue: QUEUES.deployment, type: 'deployment.execute', organizationId: auth.organizationId, projectId: scope.project.id, maxAttempts: 1, payload: { deploymentId: d.id } });
      await audit(tx, {
        organizationId: auth.organizationId,
        projectId: scope.project.id,
        actor,
        action: opts.isRollback ? 'deployment.rollback_requested' : 'deployment.requested',
        resourceType: 'deployment',
        resourceId: d.id,
        metadata: { environment: env.name, version: v.version, policyOverride, ...(outsideWindow ? { deploymentWindow: outsideWindow } : {}) },
      });
      if (policyOverride) {
        await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'security.policy_override', resourceType: 'deployment', resourceId: d.id, metadata: policyOverride });
      }
      await timeline(tx, {
        organizationId: auth.organizationId,
        projectId: scope.project.id,
        kind: 'deploy',
        tone: needsApproval ? 'warn' : 'run',
        title: `${opts.isRollback ? 'Geri alma' : 'Deployment'} D-${number}: v${v.version} → ${env.name}`,
        description: needsApproval ? `${outsideWindow ? 'Zaman penceresi dışında · ' : ''}${env.requiredApprovals} onay bekleniyor` : 'Kuyruğa alındı',
        actorLabel: actor.label,
        refType: 'deployment',
        refId: d.id,
      });
      if (needsApproval) {
        await emitDomainEvent(tx, { event: 'deployment.pending_approval', organizationId: auth.organizationId, projectId: scope.project.id, actor, data: { deploymentId: d.id, environment: env.name, version: v.version } });
      }
      await publish(tx, { type: 'deployment.updated', organizationId: auth.organizationId, projectId: scope.project.id, id: d.id });
      return d;
    });
    return this.get(auth, row.id);
  }

  async get(auth: AuthInfo, deploymentId: string) {
    const d = (await this.ctx.db.select().from(deployments).where(and(eq(deployments.id, deploymentId), eq(deployments.organizationId, auth.organizationId))))[0];
    if (!d) throw notFound('Deployment');
    const scope = await this.access.require(auth, d.projectId);
    const env = (await this.ctx.db.select().from(environments).where(eq(environments.id, d.environmentId)))[0]!;
    const v = (await this.ctx.db.select().from(versions).where(eq(versions.id, d.versionId)))[0]!;
    const steps = await this.ctx.db.select().from(deploymentSteps).where(eq(deploymentSteps.deploymentId, d.id)).orderBy(asc(deploymentSteps.seq));
    const approvals = await this.ctx.db
      .select({ a: deploymentApprovals, name: users.displayName })
      .from(deploymentApprovals)
      .innerJoin(users, eq(users.id, deploymentApprovals.userId))
      .where(eq(deploymentApprovals.deploymentId, d.id));
    const by = d.requestedBy ? (await this.ctx.db.select({ n: users.displayName }).from(users).where(eq(users.id, d.requestedBy)))[0]?.n : null;
    const bkps = await this.ctx.db.select().from(backups).where(eq(backups.deploymentId, d.id));
    let log = '';
    try {
      log = fs.readFileSync(this.ctx.storage.resolve(this.ctx.storage.deploymentLogKey(d.projectId, d.id)), 'utf8').slice(-200_000);
    } catch {
      /* not started yet */
    }
    return {
      ...d,
      key: `D-${d.number}`,
      environment: { id: env.id, name: env.name, type: env.type, url: env.url, requiredApprovals: env.requiredApprovals },
      version: { id: v.id, version: v.version, commitSha: v.commitSha, releaseNotes: v.releaseNotes, migrations: v.migrations },
      requestedByName: d.requestedByType === 'ai' ? 'AI Asistan' : by ?? null,
      steps,
      approvals: approvals.map((x) => ({ ...x.a, userName: x.name })),
      backups: bkps,
      log,
      canApprove: d.status === 'pending_approval' && scope.can('deployment.approve') && d.requestedBy !== auth.user.id && !approvals.some((x) => x.a.userId === auth.user.id),
    };
  }

  /** Four-eyes rule: approvers need deployment.approve and cannot approve their own request. */
  async decide(auth: AuthInfo, deploymentId: string, decision: 'approved' | 'rejected', comment: string | undefined, actor: Actor) {
    const d = (await this.ctx.db.select().from(deployments).where(and(eq(deployments.id, deploymentId), eq(deployments.organizationId, auth.organizationId))))[0];
    if (!d) throw notFound('Deployment');
    await this.access.require(auth, d.projectId, 'deployment.approve');
    if (d.status !== 'pending_approval') throw precondition('Deployment onay beklemiyor');
    if (d.requestedBy === auth.user.id) throw forbidden('Kendi deployment isteğinizi onaylayamazsınız');
    const env = (await this.ctx.db.select().from(environments).where(eq(environments.id, d.environmentId)))[0]!;
    if (env.type === 'production') await this.access.require(auth, d.projectId, 'deployment.production');
    await this.ctx.db.transaction(async (tx) => {
      await tx.insert(deploymentApprovals).values({ deploymentId: d.id, userId: auth.user.id, decision, comment: comment ?? null });
      const approved = (await tx.select({ n: count() }).from(deploymentApprovals).where(and(eq(deploymentApprovals.deploymentId, d.id), eq(deploymentApprovals.decision, 'approved'))))[0]?.n ?? 0;
      if (decision === 'rejected') {
        await tx.update(deployments).set({ status: 'rejected', finishedAt: new Date() }).where(eq(deployments.id, d.id));
      } else if (approved >= env.requiredApprovals) {
        await tx.update(deployments).set({ status: 'queued' }).where(eq(deployments.id, d.id));
        await enqueue(tx, { queue: QUEUES.deployment, type: 'deployment.execute', organizationId: auth.organizationId, projectId: d.projectId, maxAttempts: 1, payload: { deploymentId: d.id } });
      }
      await audit(tx, { organizationId: auth.organizationId, projectId: d.projectId, actor, action: `deployment.${decision}`, resourceType: 'deployment', resourceId: d.id, metadata: { comment } });
      await timeline(tx, {
        organizationId: auth.organizationId,
        projectId: d.projectId,
        kind: 'deploy',
        tone: decision === 'approved' ? 'ok' : 'bad',
        title: `D-${d.number} ${decision === 'approved' ? 'onaylandı' : 'reddedildi'}`,
        description: `${env.name} · ${approved}/${env.requiredApprovals} onay${comment ? ` · ${comment}` : ''}`,
        actorLabel: actor.label,
        refType: 'deployment',
        refId: d.id,
      });
      await publish(tx, { type: 'deployment.updated', organizationId: auth.organizationId, projectId: d.projectId, id: d.id });
    });
    return this.get(auth, deploymentId);
  }

  async cancel(auth: AuthInfo, deploymentId: string, actor: Actor) {
    const d = (await this.ctx.db.select().from(deployments).where(and(eq(deployments.id, deploymentId), eq(deployments.organizationId, auth.organizationId))))[0];
    if (!d) throw notFound('Deployment');
    const scope = await this.access.require(auth, d.projectId);
    if (d.requestedBy !== auth.user.id && !scope.can('deployment.approve')) throw forbidden();
    // Running deployments are not interrupted mid-step (spec §86: no blind retries/aborts during deploy).
    if (!['pending_approval', 'queued'].includes(d.status)) throw precondition('Yalnızca başlamamış deployment\'lar iptal edilebilir');
    await this.ctx.db.update(deployments).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(deployments.id, d.id));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: d.projectId, actor, action: 'deployment.cancelled', resourceType: 'deployment', resourceId: d.id });
    await publish(this.ctx.db, { type: 'deployment.updated', organizationId: auth.organizationId, projectId: d.projectId, id: d.id });
    return this.get(auth, deploymentId);
  }

  /** Spec §105: redeploy the previous stable version of the environment (database rollback is never automatic). */
  async rollback(auth: AuthInfo, deploymentId: string, actor: Actor) {
    const d = (await this.ctx.db.select().from(deployments).where(and(eq(deployments.id, deploymentId), eq(deployments.organizationId, auth.organizationId))))[0];
    if (!d) throw notFound('Deployment');
    const prev = (
      await this.ctx.db
        .select()
        .from(deployments)
        .where(and(eq(deployments.environmentId, d.environmentId), eq(deployments.status, 'succeeded'), ne(deployments.versionId, d.versionId)))
        .orderBy(desc(deployments.createdAt))
        .limit(1)
    )[0];
    if (!prev) throw precondition('Bu ortamda geri dönülebilecek önceki başarılı sürüm yok');
    return this.create(auth, d.projectId, { environmentId: d.environmentId, versionId: prev.versionId, runMigrations: false, backup: true, overrideSecurityPolicy: false }, actor, { isRollback: true });
  }

  /* ---------------- database connections & backups ---------------- */

  async setDatabase(
    auth: AuthInfo,
    idOrSlug: string,
    input: { environmentId: string; host: string; port: number; database: string; username: string; password?: string; sslMode: string },
    actor: Actor,
  ) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'database.manage');
    const env = await this.envOf(scope, input.environmentId);
    const existing = (await this.ctx.db.select().from(databaseConnections).where(eq(databaseConnections.environmentId, env.id)))[0];
    let passwordSecretId = existing?.passwordSecretId ?? null;
    if (input.password) {
      passwordSecretId = await putSecret(this.ctx.db, this.ctx.config.encryptionKey, {
        organizationId: auth.organizationId,
        projectId: scope.project.id,
        environmentId: env.id,
        name: 'DATABASE_PASSWORD',
        value: input.password,
        kind: 'credential',
        scope: 'deploy',
        system: 'database-connection',
        createdBy: auth.user.id,
      });
    }
    const values = { projectId: scope.project.id, environmentId: env.id, host: input.host, port: input.port, databaseName: input.database, username: input.username, passwordSecretId, sslMode: input.sslMode };
    if (existing) await this.ctx.db.update(databaseConnections).set(values).where(eq(databaseConnections.id, existing.id));
    else await this.ctx.db.insert(databaseConnections).values(values);
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'database_connection.updated', resourceType: 'environment', resourceId: env.id, metadata: { host: input.host, database: input.database, passwordChanged: !!input.password } });
    await enqueue(this.ctx.db, { queue: QUEUES.deployment, type: 'database.check', organizationId: auth.organizationId, projectId: scope.project.id, maxAttempts: 1, payload: { environmentId: env.id } });
    return { ok: true };
  }

  async backups(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    return this.ctx.db
      .select({ b: backups, env: environments.name })
      .from(backups)
      .leftJoin(environments, eq(environments.id, backups.environmentId))
      .where(eq(backups.projectId, scope.project.id))
      .orderBy(desc(backups.createdAt))
      .limit(100)
      .then((rows) => rows.map((r) => ({ ...r.b, environmentName: r.env })));
  }

  async createBackup(auth: AuthInfo, idOrSlug: string, environmentId: string, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'database.manage');
    const env = await this.envOf(scope, environmentId);
    const conn = (await this.ctx.db.select().from(databaseConnections).where(eq(databaseConnections.environmentId, env.id)))[0];
    if (!conn) throw precondition('Bu ortam için veritabanı bağlantısı tanımlanmamış');
    await enqueue(this.ctx.db, { queue: QUEUES.deployment, type: 'database.backup', organizationId: auth.organizationId, projectId: scope.project.id, maxAttempts: 1, payload: { environmentId: env.id, requestedBy: auth.user.id } });
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'backup.requested', resourceType: 'environment', resourceId: env.id });
    return { queued: true };
  }

  async backupFile(auth: AuthInfo, backupId: string) {
    const b = (await this.ctx.db.select().from(backups).where(and(eq(backups.id, backupId), eq(backups.organizationId, auth.organizationId))))[0];
    if (!b || b.type !== 'database' || !b.location) throw notFound('Yedek');
    await this.access.require(auth, b.projectId, 'database.manage');
    return { path: this.ctx.storage.resolve(b.location), name: `${b.id}.dump` };
  }
}
