import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { FindingStatus, SecretKind, SecretScope, Severity } from '@projecthub/contracts';
import { audit, enqueue, forbidden, notFound, publish, putSecret, QUEUES, readSecret, scan, type Actor } from '@projecthub/core';
import { environments, projects, secrets, securityFindings, securityScans, users } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';

const SEVERITY_ORDER = sql`CASE ${securityFindings.severity} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

@Injectable()
export class SecurityService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
  ) {}

  /* ---------------- secrets ---------------- */

  async listSecrets(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug, 'secret.manage');
    const rows = await this.ctx.db
      .select({ s: secrets, env: environments.name, by: users.displayName })
      .from(secrets)
      .leftJoin(environments, eq(environments.id, secrets.environmentId))
      .leftJoin(users, eq(users.id, secrets.createdBy))
      .where(and(eq(secrets.projectId, scope.project.id), isNull(secrets.system)))
      .orderBy(asc(secrets.name));
    // Values never leave the server here; only metadata.
    return rows.map((r) => ({
      id: r.s.id,
      name: r.s.name,
      kind: r.s.kind,
      scope: r.s.scope,
      environmentId: r.s.environmentId,
      environmentName: r.env ?? 'Tüm ortamlar',
      createdByName: r.by,
      createdAt: r.s.createdAt,
      updatedAt: r.s.updatedAt,
      rotatedAt: r.s.rotatedAt,
      lastAccessedAt: r.s.lastAccessedAt,
    }));
  }

  async upsertSecret(auth: AuthInfo, idOrSlug: string, input: { name: string; value: string; kind: SecretKind; scope: SecretScope; environmentId: string | null }, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'secret.manage');
    if (input.environmentId) {
      const e = await this.ctx.db.select({ id: environments.id }).from(environments).where(and(eq(environments.id, input.environmentId), eq(environments.projectId, scope.project.id)));
      if (!e.length) throw notFound('Ortam');
    }
    const id = await putSecret(this.ctx.db, this.ctx.config.encryptionKey, { organizationId: auth.organizationId, projectId: scope.project.id, ...input, system: null, createdBy: auth.user.id });
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'secret.written', resourceType: 'secret', resourceId: id, metadata: { name: input.name, scope: input.scope, environmentId: input.environmentId } });
    return { id };
  }

  /** Explicit reveal (spec §54): needs secret.read and is always audited. */
  async reveal(auth: AuthInfo, secretId: string, actor: Actor) {
    const s = (await this.ctx.db.select().from(secrets).where(and(eq(secrets.id, secretId), eq(secrets.organizationId, auth.organizationId))))[0];
    if (!s || !s.projectId || s.system) throw notFound('Secret');
    await this.access.require(auth, s.projectId, 'secret.read');
    const value = await readSecret(this.ctx.db, this.ctx.config.encryptionKey, s.id);
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: s.projectId, actor, action: 'secret.revealed', resourceType: 'secret', resourceId: s.id, metadata: { name: s.name } });
    return { value };
  }

  async deleteSecret(auth: AuthInfo, secretId: string, actor: Actor) {
    const s = (await this.ctx.db.select().from(secrets).where(and(eq(secrets.id, secretId), eq(secrets.organizationId, auth.organizationId))))[0];
    if (!s || !s.projectId || s.system) throw notFound('Secret');
    await this.access.requireWritable(auth, s.projectId, 'secret.manage');
    await this.ctx.db.delete(secrets).where(eq(secrets.id, s.id));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: s.projectId, actor, action: 'secret.deleted', resourceType: 'secret', resourceId: s.id, metadata: { name: s.name } });
  }

  /* ---------------- scans & findings ---------------- */

  async projectSecurity(auth: AuthInfo, idOrSlug: string, q: { status?: string; severity?: string; type?: string }) {
    const scope = await this.access.require(auth, idOrSlug, 'security.read');
    const conds: SQL[] = [eq(securityFindings.projectId, scope.project.id)];
    conds.push(eq(securityFindings.status, (q.status ?? 'open') as FindingStatus));
    if (q.severity) conds.push(eq(securityFindings.severity, q.severity as Severity));
    if (q.type) conds.push(eq(securityFindings.type, q.type as never));
    const findings = await this.ctx.db.select().from(securityFindings).where(and(...conds)).orderBy(SEVERITY_ORDER, desc(securityFindings.lastSeenAt)).limit(500);
    const scans = await this.ctx.db.select().from(securityScans).where(eq(securityScans.projectId, scope.project.id)).orderBy(desc(securityScans.createdAt)).limit(20);
    const counts = await this.ctx.db
      .select({ status: securityFindings.status, severity: securityFindings.severity, n: count() })
      .from(securityFindings)
      .where(eq(securityFindings.projectId, scope.project.id))
      .groupBy(securityFindings.status, securityFindings.severity);
    return {
      score: scope.project.securityScore,
      lastScan: scans.find((s) => s.status === 'completed') ?? null,
      running: scans.some((s) => s.status === 'running' || s.status === 'queued'),
      scans,
      counts,
      findings: findings.map((f) => ({ ...f, key: `SEC-${f.number}` })),
    };
  }

  async startScan(auth: AuthInfo, idOrSlug: string, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'security.manage');
    const row = await this.ctx.db.transaction(async (tx) => {
      const s = (await tx.insert(securityScans).values({ organizationId: auth.organizationId, projectId: scope.project.id, branch: scope.project.defaultBranch, createdBy: auth.user.id }).returning())[0]!;
      await enqueue(tx, { queue: QUEUES.security, type: 'security.scan', organizationId: auth.organizationId, projectId: scope.project.id, maxAttempts: 2, payload: { projectId: scope.project.id, scanId: s.id, trigger: 'manual', requestedBy: auth.user.id } });
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'security.scan_requested', resourceType: 'security_scan', resourceId: s.id });
      await publish(tx, { type: 'security.scan', organizationId: auth.organizationId, projectId: scope.project.id, id: s.id });
      return s;
    });
    return row;
  }

  /** Accept risk / mark false positive / reopen. Accepted findings stop blocking production (audited). */
  async updateFinding(auth: AuthInfo, findingId: string, input: { status: FindingStatus; reason?: string }, actor: Actor) {
    const f = (await this.ctx.db.select().from(securityFindings).where(and(eq(securityFindings.id, findingId), eq(securityFindings.organizationId, auth.organizationId))))[0];
    if (!f) throw notFound('Bulgu');
    await this.access.require(auth, f.projectId, 'security.manage');
    if ((input.status === 'accepted' || input.status === 'false_positive') && (!input.reason || input.reason.trim().length < 5)) {
      throw forbidden('Risk kabulü / yanlış alarm için gerekçe yazın');
    }
    await this.ctx.db
      .update(securityFindings)
      .set({ status: input.status, statusReason: input.reason ?? null, statusChangedBy: auth.user.id, resolvedAt: input.status === 'open' ? null : new Date() })
      .where(eq(securityFindings.id, f.id));
    // Score reflects only open findings.
    const open = await this.ctx.db.select({ severity: securityFindings.severity, type: securityFindings.type }).from(securityFindings).where(and(eq(securityFindings.projectId, f.projectId), eq(securityFindings.status, 'open')));
    const { score } = scan.securityScore(open);
    await this.ctx.db.update(projects).set({ securityScore: score }).where(eq(projects.id, f.projectId));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: f.projectId, actor, action: `security.finding_${input.status}`, resourceType: 'security_finding', resourceId: f.id, metadata: { key: `SEC-${f.number}`, reason: input.reason } });
    await enqueue(this.ctx.db, { queue: QUEUES.maintenance, type: 'project.health', projectId: f.projectId, organizationId: auth.organizationId, dedupeKey: `health:${f.projectId}`, payload: { projectId: f.projectId } });
    await publish(this.ctx.db, { type: 'security.scan', organizationId: auth.organizationId, projectId: f.projectId });
    return { ...f, status: input.status, key: `SEC-${f.number}` };
  }

  /** Organization-wide Security Center (spec §24). Only projects the caller can see. */
  async center(auth: AuthInfo) {
    const visibleProjects = auth.orgPermissions.has('project.read.all')
      ? await this.ctx.db.select({ id: projects.id, name: projects.name, slug: projects.slug, score: projects.securityScore }).from(projects).where(eq(projects.organizationId, auth.organizationId))
      : await this.ctx.db
          .select({ id: projects.id, name: projects.name, slug: projects.slug, score: projects.securityScore })
          .from(projects)
          .where(and(eq(projects.organizationId, auth.organizationId), sql`${projects.id} IN (SELECT project_id FROM project_members WHERE user_id = ${auth.user.id})`));
    const ids = visibleProjects.map((p) => p.id);
    if (!ids.length) return { score: null, counts: {}, projects: [], findings: [] };
    const findings = await this.ctx.db
      .select()
      .from(securityFindings)
      .where(and(inArray(securityFindings.projectId, ids), eq(securityFindings.status, 'open')))
      .orderBy(SEVERITY_ORDER, desc(securityFindings.lastSeenAt))
      .limit(300);
    const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    const all = await this.ctx.db
      .select({ severity: securityFindings.severity, n: count() })
      .from(securityFindings)
      .where(and(inArray(securityFindings.projectId, ids), eq(securityFindings.status, 'open')))
      .groupBy(securityFindings.severity);
    for (const c of all) counts[c.severity] = c.n;
    const scored = visibleProjects.filter((p) => p.score !== null);
    return {
      score: scored.length ? Math.round(scored.reduce((s, p) => s + (p.score ?? 0), 0) / scored.length) : null,
      counts,
      projects: visibleProjects,
      findings: findings.map((f) => ({ ...f, key: `SEC-${f.number}`, projectName: visibleProjects.find((p) => p.id === f.projectId)?.name, projectSlug: visibleProjects.find((p) => p.id === f.projectId)?.slug })),
    };
  }
}
