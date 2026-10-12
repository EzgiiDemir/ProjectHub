import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  audit,
  branchProtectionOf,
  conflict,
  emitDomainEvent,
  forbidden,
  invalid,
  nextNumber,
  notFound,
  precondition,
  publish,
  timeline,
  type Actor,
} from '@projecthub/core';
import { builds, pullRequestComments, pullRequestReviews, pullRequests, users } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';
import { Repos } from '../../infra/repos.js';
import { RepositoryService } from './repository.service.js';

type PrRow = typeof pullRequests.$inferSelect;

/**
 * Pull requests over the hub-managed repository: a source branch is reviewed, verified by a build and merged
 * into its target. Protected branches (project settings) only change this way.
 */
@Injectable()
export class PullRequestsService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
    private readonly repos: Repos,
    private readonly repository: RepositoryService,
  ) {}

  private present(pr: PrRow, names: Map<string, string>) {
    return {
      ...pr,
      key: `PR-${pr.number}`,
      authorName: pr.authorId ? (names.get(pr.authorId) ?? '—') : '—',
      mergedByName: pr.mergedBy ? (names.get(pr.mergedBy) ?? '—') : null,
    };
  }

  private async names(ids: (string | null)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map<string, string>();
    const rows = await this.ctx.db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, list));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async list(auth: AuthInfo, idOrSlug: string, status?: string) {
    const scope = await this.access.require(auth, idOrSlug, 'repository.read');
    const conds = [eq(pullRequests.projectId, scope.project.id)];
    if (status === 'open' || status === 'merged' || status === 'closed') conds.push(eq(pullRequests.status, status));
    const rows = await this.ctx.db.select().from(pullRequests).where(and(...conds)).orderBy(desc(pullRequests.number)).limit(200);
    const names = await this.names(rows.flatMap((r) => [r.authorId, r.mergedBy]));
    return rows.map((r) => this.present(r, names));
  }

  async create(auth: AuthInfo, idOrSlug: string, input: { title: string; description: string; sourceBranch: string; targetBranch: string }, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'repository.push');
    if (input.sourceBranch === input.targetBranch) throw invalid('Kaynak ve hedef branch aynı olamaz');
    if (input.sourceBranch.startsWith('ai/')) throw forbidden('AI branch\'leri AI görevi ekranından onaylanır');
    const { git } = await this.repos.forProject(scope.project.id);
    const check = await git.mergeCheck(input.sourceBranch, input.targetBranch);
    if (check.upToDate) throw precondition(`"${input.sourceBranch}" branch'inde "${input.targetBranch}" branch'ine göre yeni commit yok`);
    const open = await this.ctx.db
      .select({ number: pullRequests.number })
      .from(pullRequests)
      .where(and(eq(pullRequests.projectId, scope.project.id), eq(pullRequests.status, 'open'), eq(pullRequests.sourceBranch, input.sourceBranch), eq(pullRequests.targetBranch, input.targetBranch)));
    if (open.length) throw conflict(`Bu branch'ler için açık bir pull request var: PR #${open[0]!.number}`);
    const pr = await this.ctx.db.transaction(async (tx) => {
      const number = await nextNumber(tx, scope.project.id, 'pull_request');
      const row = (
        await tx
          .insert(pullRequests)
          .values({ organizationId: auth.organizationId, projectId: scope.project.id, number, title: input.title, description: input.description, sourceBranch: input.sourceBranch, targetBranch: input.targetBranch, authorId: auth.user.id })
          .returning()
      )[0]!;
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'pull_request.opened', resourceType: 'pull_request', resourceId: row.id, metadata: { number, source: input.sourceBranch, target: input.targetBranch } });
      await timeline(tx, { organizationId: auth.organizationId, projectId: scope.project.id, kind: 'commit', tone: 'run', title: `PR #${number} açıldı: ${input.title}`, description: `${input.sourceBranch} → ${input.targetBranch}`, actorLabel: actor.label, refType: 'pull_request', refId: row.id });
      await emitDomainEvent(tx, { event: 'pull_request.opened', organizationId: auth.organizationId, projectId: scope.project.id, actor, data: { pullRequestId: row.id, number, title: input.title } });
      await publish(tx, { type: 'pull_request.updated', organizationId: auth.organizationId, projectId: scope.project.id, id: row.id });
      return row;
    });
    return this.present(pr, await this.names([pr.authorId]));
  }

  private async load(auth: AuthInfo, idOrSlug: string, number: number) {
    const scope = await this.access.require(auth, idOrSlug, 'repository.read');
    const pr = (await this.ctx.db.select().from(pullRequests).where(and(eq(pullRequests.projectId, scope.project.id), eq(pullRequests.number, number))))[0];
    if (!pr) throw notFound('Pull request');
    return { scope, pr };
  }

  /** Everything the review screen needs, including whether (and why not) it can be merged right now. */
  async get(auth: AuthInfo, idOrSlug: string, number: number) {
    const { scope, pr } = await this.load(auth, idOrSlug, number);
    const { git } = await this.repos.forProject(scope.project.id);
    const head = await git.resolve(`refs/heads/${pr.sourceBranch}`);
    const target = await git.resolve(`refs/heads/${pr.targetBranch}`);
    let diff: Awaited<ReturnType<RepositoryService['compare']>> | null = null;
    let mergeCheck: { upToDate: boolean; fastForward: boolean; conflicts: string[] } | null = null;
    if (pr.status === 'open' && head && target) {
      diff = await this.repository.compare(auth, scope.project.id, pr.targetBranch, pr.sourceBranch);
      mergeCheck = await git.mergeCheck(pr.sourceBranch, pr.targetBranch);
    } else if (pr.status === 'merged' && pr.mergeCommit) {
      const info = await git.commitInfo(pr.mergeCommit);
      if (info) diff = await this.repository.compare(auth, scope.project.id, info.parents[0] ?? pr.mergeCommit, pr.mergeCommit);
    }
    const reviews = await this.ctx.db.select().from(pullRequestReviews).where(eq(pullRequestReviews.pullRequestId, pr.id)).orderBy(asc(pullRequestReviews.createdAt));
    const comments = await this.ctx.db.select().from(pullRequestComments).where(eq(pullRequestComments.pullRequestId, pr.id)).orderBy(asc(pullRequestComments.createdAt));
    const names = await this.names([pr.authorId, pr.mergedBy, ...reviews.map((r) => r.userId), ...comments.map((c) => c.userId)]);
    const build = head
      ? ((await this.ctx.db.select().from(builds).where(and(eq(builds.projectId, scope.project.id), eq(builds.commitSha, head))).orderBy(desc(builds.number)).limit(1))[0] ?? null)
      : null;
    const checks = this.checks(scope.project.settings, pr, head, reviews, build, mergeCheck);
    return {
      ...this.present(pr, names),
      headCommit: head,
      targetCommit: target,
      diff,
      mergeCheck,
      build: build ? { id: build.id, number: build.number, status: build.status } : null,
      reviews: reviews.map((r) => ({ ...r, userName: r.userId ? (names.get(r.userId) ?? '—') : '—', stale: r.commitSha !== head })),
      comments: comments.map((c) => ({ ...c, author: c.authorType === 'user' ? (c.userId ? (names.get(c.userId) ?? '—') : '—') : c.authorType === 'ai' ? 'AI Asistan' : 'Sistem' })),
      checks,
      permissions: { canReview: scope.can('repository.push') && pr.authorId !== auth.user.id, canMerge: scope.can('repository.push'), canEdit: scope.can('repository.push') },
    };
  }

  /** Merge rules: no conflicts, branch protection (approvals on the current head, passing build), no open change request. */
  private checks(
    settings: Record<string, unknown>,
    pr: PrRow,
    head: string | null,
    reviews: (typeof pullRequestReviews.$inferSelect)[],
    build: typeof builds.$inferSelect | null,
    mergeCheck: { upToDate: boolean; fastForward: boolean; conflicts: string[] } | null,
  ) {
    const protection = branchProtectionOf(settings);
    const isProtected = protection.branches.includes(pr.targetBranch);
    const latest = new Map<string, typeof pullRequestReviews.$inferSelect>();
    for (const r of reviews) if (r.userId) latest.set(r.userId, r);
    const current = [...latest.values()].filter((r) => r.commitSha === head && r.userId !== pr.authorId);
    const approvals = current.filter((r) => r.decision === 'approved').length;
    const changesRequested = current.some((r) => r.decision === 'changes_requested');
    const required = isProtected ? protection.requiredApprovals : 0;
    const needsBuild = isProtected && protection.requirePassingBuild;
    const blockers: string[] = [];
    if (pr.status !== 'open') blockers.push('Pull request açık değil');
    if (!head) blockers.push(`Kaynak branch "${pr.sourceBranch}" bulunamadı`);
    if (mergeCheck?.upToDate) blockers.push('Birleştirilecek yeni değişiklik yok');
    if (mergeCheck?.conflicts.length) blockers.push(`Çakışma var: ${mergeCheck.conflicts.join(', ')}`);
    if (approvals < required) blockers.push(`${required} onay gerekli (şu an ${approvals})`);
    if (changesRequested) blockers.push('Değişiklik istenmiş; inceleyenin yeni onayı gerekli');
    if (needsBuild && build?.status !== 'passed') blockers.push(build ? `Son commit'in build'i ${build.status === 'failed' ? 'başarısız' : 'henüz bitmedi'}` : 'Son commit için başarılı build gerekli');
    return { protected: isProtected, requiredApprovals: required, approvals, changesRequested, requiresBuild: needsBuild, buildStatus: build?.status ?? null, blockers, mergeable: blockers.length === 0 };
  }

  async update(auth: AuthInfo, idOrSlug: string, number: number, input: { title?: string; description?: string }, actor: Actor) {
    const { scope, pr } = await this.load(auth, idOrSlug, number);
    if (!scope.can('repository.push')) throw forbidden();
    if (pr.status !== 'open') throw precondition('Yalnızca açık pull request düzenlenebilir');
    await this.ctx.db.update(pullRequests).set(input).where(eq(pullRequests.id, pr.id));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: pr.projectId, actor, action: 'pull_request.updated', resourceType: 'pull_request', resourceId: pr.id });
    await publish(this.ctx.db, { type: 'pull_request.updated', organizationId: auth.organizationId, projectId: pr.projectId, id: pr.id });
    return this.get(auth, idOrSlug, number);
  }

  async comment(auth: AuthInfo, idOrSlug: string, number: number, input: { body: string; path?: string; line?: number }, actor: Actor) {
    const { scope, pr } = await this.load(auth, idOrSlug, number);
    if (!scope.can('repository.read')) throw forbidden();
    await this.ctx.db.insert(pullRequestComments).values({ pullRequestId: pr.id, userId: auth.user.id, body: input.body, path: input.path ?? null, line: input.line ?? null });
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: pr.projectId, actor, action: 'pull_request.commented', resourceType: 'pull_request', resourceId: pr.id });
    await publish(this.ctx.db, { type: 'pull_request.updated', organizationId: auth.organizationId, projectId: pr.projectId, id: pr.id });
    return this.get(auth, idOrSlug, number);
  }

  async review(auth: AuthInfo, idOrSlug: string, number: number, input: { decision: 'approved' | 'changes_requested'; body: string }, actor: Actor) {
    const { scope, pr } = await this.load(auth, idOrSlug, number);
    if (!scope.can('repository.push')) throw forbidden('İnceleme için kod yazma yetkisi gerekir');
    if (pr.authorId === auth.user.id) throw forbidden('Kendi pull request\'inizi onaylayamazsınız');
    if (pr.status !== 'open') throw precondition('Pull request açık değil');
    const { git } = await this.repos.forProject(scope.project.id);
    const head = await git.resolve(`refs/heads/${pr.sourceBranch}`);
    if (!head) throw precondition('Kaynak branch bulunamadı');
    await this.ctx.db.transaction(async (tx) => {
      await tx.insert(pullRequestReviews).values({ pullRequestId: pr.id, userId: auth.user.id, decision: input.decision, body: input.body, commitSha: head });
      await audit(tx, { organizationId: auth.organizationId, projectId: pr.projectId, actor, action: `pull_request.${input.decision}`, resourceType: 'pull_request', resourceId: pr.id, metadata: { commit: head } });
      await emitDomainEvent(tx, { event: 'pull_request.reviewed', organizationId: auth.organizationId, projectId: pr.projectId, actor, data: { pullRequestId: pr.id, number: pr.number, decision: input.decision, authorId: pr.authorId } });
      await publish(tx, { type: 'pull_request.updated', organizationId: auth.organizationId, projectId: pr.projectId, id: pr.id });
    });
    return this.get(auth, idOrSlug, number);
  }

  async merge(auth: AuthInfo, idOrSlug: string, number: number, input: { message?: string; deleteSourceBranch: boolean }, actor: Actor) {
    const { scope, pr } = await this.load(auth, idOrSlug, number);
    if (!scope.can('repository.push') || scope.project.status === 'archived') throw forbidden();
    const detail = await this.get(auth, idOrSlug, number);
    if (!detail.checks.mergeable) throw precondition(`Birleştirilemez: ${detail.checks.blockers.join('; ')}`);
    const { git, repo } = await this.repos.forProject(scope.project.id);
    const message = input.message || `Merge PR #${pr.number}: ${pr.title}\n\n${pr.sourceBranch} → ${pr.targetBranch}`;
    const merged = await git.merge({ source: pr.sourceBranch, target: pr.targetBranch, message, author: { name: auth.user.displayName, email: auth.user.email } });
    await this.ctx.db.transaction(async (tx) => {
      await tx.update(pullRequests).set({ status: 'merged', mergedBy: auth.user.id, mergedAt: new Date(), mergeCommit: merged.sha }).where(eq(pullRequests.id, pr.id));
      await audit(tx, { organizationId: auth.organizationId, projectId: pr.projectId, actor, action: 'pull_request.merged', resourceType: 'pull_request', resourceId: pr.id, metadata: { commit: merged.sha, fastForward: merged.fastForward } });
      await emitDomainEvent(tx, { event: 'pull_request.merged', organizationId: auth.organizationId, projectId: pr.projectId, actor, data: { pullRequestId: pr.id, number: pr.number, title: pr.title, authorId: pr.authorId } });
    });
    await this.repository.recordPush(scope.project.id, auth.organizationId, pr.targetBranch, merged.sha, `Merge PR #${pr.number}: ${pr.title}`, detail.diff?.files.length ?? 0, actor, repo.id, scope.project.defaultBranch);
    if (input.deleteSourceBranch && pr.sourceBranch !== scope.project.defaultBranch && !branchProtectionOf(scope.project.settings).branches.includes(pr.sourceBranch)) {
      const sha = await git.resolve(`refs/heads/${pr.sourceBranch}`);
      if (sha) await git.deleteBranch(pr.sourceBranch, sha).catch(() => undefined);
    }
    await publish(this.ctx.db, { type: 'pull_request.updated', organizationId: auth.organizationId, projectId: pr.projectId, id: pr.id });
    return this.get(auth, idOrSlug, number);
  }

  async setOpen(auth: AuthInfo, idOrSlug: string, number: number, open: boolean, actor: Actor) {
    const { scope, pr } = await this.load(auth, idOrSlug, number);
    if (!scope.can('repository.push')) throw forbidden();
    if (pr.status === 'merged') throw precondition('Birleştirilmiş pull request değiştirilemez');
    await this.ctx.db.update(pullRequests).set({ status: open ? 'open' : 'closed', closedAt: open ? null : new Date() }).where(eq(pullRequests.id, pr.id));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: pr.projectId, actor, action: open ? 'pull_request.reopened' : 'pull_request.closed', resourceType: 'pull_request', resourceId: pr.id });
    await publish(this.ctx.db, { type: 'pull_request.updated', organizationId: auth.organizationId, projectId: pr.projectId, id: pr.id });
    return this.get(auth, idOrSlug, number);
  }

  async setProtection(auth: AuthInfo, idOrSlug: string, input: { branches: string[]; requiredApprovals: number; requirePassingBuild: boolean }, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'project.update');
    // jsonb_set touches only this key, so concurrent writers of other settings (health, tech debt) are safe.
    await this.ctx.db.execute(sql`UPDATE projects SET settings = jsonb_set(settings, '{protection}', ${JSON.stringify(input)}::jsonb), updated_at = now() WHERE id = ${scope.project.id}`);
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'repository.protection_changed', resourceType: 'project', resourceId: scope.project.id, metadata: input });
    await publish(this.ctx.db, { type: 'project.updated', organizationId: auth.organizationId, projectId: scope.project.id });
    return input;
  }
}
