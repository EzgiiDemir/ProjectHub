import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  ai,
  audit,
  emitDomainEvent,
  enqueue,
  forbidden,
  getOrgSettings,
  invalid,
  nextNumber,
  notFound,
  precondition,
  publish,
  QUEUES,
  timeline,
  type Actor,
} from '@projecthub/core';
import {
  aiActions,
  aiConversations,
  aiMessages,
  aiTasks,
  builds,
  feedback,
  feedbackComments,
  securityFindings,
  users,
  type AiCitation,
} from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';
import { Repos } from '../../infra/repos.js';
import { ProjectsService } from '../projects/projects.service.js';

@Injectable()
export class AiService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
    private readonly repos: Repos,
    private readonly projects: ProjectsService,
  ) {}

  async status(auth: AuthInfo) {
    const { ai: settings } = await getOrgSettings(this.ctx.db, auth.organizationId);
    let configured = true;
    let reason: string | null = null;
    let provider: string | null = null;
    let model: string | null = null;
    try {
      const r = await ai.resolveAi(this.ctx.db, this.ctx.config, auth.organizationId);
      provider = r.provider.name;
      model = r.provider.model;
    } catch (e) {
      configured = false;
      reason = (e as Error).message;
    }
    return {
      configured,
      reason,
      provider,
      model,
      autonomyLevel: settings.autonomyLevel,
      policies: settings.policies,
      monthlyTokenBudget: settings.monthlyTokenBudget,
      monthlyTokensUsed: await ai.monthlyTokenUsage(this.ctx.db, auth.organizationId),
      availableProviders: ai.availableProviders(this.ctx.config),
    };
  }

  /* ---------------- Q&A (Project Brain) ---------------- */

  async conversations(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    return this.ctx.db
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.projectId, scope.project.id), eq(aiConversations.userId, auth.user.id)))
      .orderBy(desc(aiConversations.updatedAt))
      .limit(50);
  }

  async conversation(auth: AuthInfo, conversationId: string) {
    const c = (await this.ctx.db.select().from(aiConversations).where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, auth.user.id))))[0];
    if (!c) throw notFound('Konuşma');
    await this.access.require(auth, c.projectId);
    const messages = await this.ctx.db.select().from(aiMessages).where(eq(aiMessages.conversationId, c.id)).orderBy(asc(aiMessages.createdAt));
    return { ...c, messages };
  }

  /**
   * Answers a question about the project grounded in its code index and history (spec §70–73).
   * Streams text through onText; persists both turns; returns the citations used as context.
   */
  async ask(
    auth: AuthInfo,
    idOrSlug: string,
    input: { message: string; conversationId?: string; filePath?: string },
    onText: (delta: string) => void,
    signal: AbortSignal,
  ) {
    const scope = await this.access.require(auth, idOrSlug);
    if (!scope.can('repository.read')) throw forbidden('Proje AI\'ı kaynak koda dayanır; kaynak kod görme yetkiniz yok');
    const resolved = await ai.resolveAi(this.ctx.db, this.ctx.config, auth.organizationId, { minLevel: 'L1' });
    await ai.assertBudget(this.ctx.db, auth.organizationId, resolved.settings);
    let conversationId = input.conversationId;
    if (conversationId) {
      const c = (await this.ctx.db.select().from(aiConversations).where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, auth.user.id), eq(aiConversations.projectId, scope.project.id))))[0];
      if (!c) throw notFound('Konuşma');
    } else {
      conversationId = (
        await this.ctx.db
          .insert(aiConversations)
          .values({ organizationId: auth.organizationId, projectId: scope.project.id, userId: auth.user.id, title: input.message.slice(0, 120) })
          .returning({ id: aiConversations.id })
      )[0]!.id;
    }
    const history = await this.ctx.db.select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId)).orderBy(asc(aiMessages.createdAt)).limit(20);
    const context = await ai.buildProjectContext(this.ctx.db, scope.project.id, input.message, { filePath: input.filePath });
    await this.ctx.db.insert(aiMessages).values({ conversationId, role: 'user', content: input.message });
    const run = await ai.startRun(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, purpose: 'project_qa', provider: resolved.provider, userId: auth.user.id });
    const system = [
      `You are the project assistant ("Project Brain") of Project Hub for the project "${scope.project.name}".`,
      'Answer in the language of the question (usually Turkish), concisely and concretely.',
      'Ground every claim in the provided context: cite files as `path:line`, builds as "Build #n", feedback as "FB-n", findings as "SEC-n", deployments as "D-n".',
      'If the context does not contain the answer, say so plainly and suggest where to look; never invent code or history.',
      'You only analyse and recommend; you cannot change code from this chat (changes go through AI tasks with human approval).',
      '',
      '<context>',
      context.text,
      '</context>',
    ].join('\n');
    try {
      const res = await resolved.provider.complete({
        system,
        messages: [
          ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          { role: 'user', content: input.filePath ? `[Açık dosya: ${input.filePath}]\n${input.message}` : input.message },
        ],
        maxTokens: 8000,
        onText,
        signal,
      });
      await run.finish(res.usage);
      const answer = res.refused ? 'Bu isteğe yanıt veremiyorum.' : res.text;
      const usedCitations = context.citations.filter((c) => answer.includes(c.label) || (c.type === 'file' && answer.includes(c.ref))).slice(0, 20);
      const msg = (
        await this.ctx.db
          .insert(aiMessages)
          .values({ conversationId, role: 'assistant', content: answer, citations: usedCitations, model: resolved.provider.model, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens })
          .returning()
      )[0]!;
      await this.ctx.db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversationId));
      return { conversationId, messageId: msg.id, citations: usedCitations as AiCitation[], usage: res.usage };
    } catch (e) {
      await run.finish({ inputTokens: 0, outputTokens: 0 }, (e as Error).message);
      throw e;
    }
  }

  /* ---------------- AI tasks ---------------- */

  private present(t: typeof aiTasks.$inferSelect, extra: Record<string, unknown> = {}) {
    return { ...t, key: `AI-${t.number}`, ...extra };
  }

  async listTasks(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    const rows = await this.ctx.db.select().from(aiTasks).where(eq(aiTasks.projectId, scope.project.id)).orderBy(desc(aiTasks.createdAt)).limit(100);
    return rows.map((r) => this.present(r));
  }

  async getTask(auth: AuthInfo, taskId: string) {
    const t = (await this.ctx.db.select().from(aiTasks).where(and(eq(aiTasks.id, taskId), eq(aiTasks.organizationId, auth.organizationId))))[0];
    if (!t) throw notFound('AI görevi');
    const scope = await this.access.require(auth, t.projectId);
    const actions = await this.ctx.db.select().from(aiActions).where(eq(aiActions.taskId, t.id)).orderBy(asc(aiActions.createdAt));
    let diff: { patch: string; truncated: boolean } | null = null;
    if (t.baseCommit && t.headCommit && scope.can('repository.read')) {
      const { git } = await this.repos.forProject(t.projectId);
      diff = await git.diffPatch(t.baseCommit, t.headCommit, { maxBytes: 500_000 });
    }
    const build = t.buildId ? (await this.ctx.db.select().from(builds).where(eq(builds.id, t.buildId)))[0] : null;
    const requester = t.requestedBy ? (await this.ctx.db.select({ n: users.displayName }).from(users).where(eq(users.id, t.requestedBy)))[0]?.n : null;
    return this.present(t, { actions, diff, build: build ? { id: build.id, number: build.number, status: build.status } : null, requestedByName: requester ?? null, canApprove: scope.can('ai.approve') });
  }

  /** Creates an AI fix task (spec §65, POST /feedback/:id/ai-fix and friends). */
  async createTask(
    auth: AuthInfo,
    idOrSlug: string,
    input: { title?: string; instruction?: string; sourceType: 'feedback' | 'build' | 'finding' | 'manual'; sourceId?: string },
    actor: Actor,
  ) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'ai.execute');
    const resolved = await ai.resolveAi(this.ctx.db, this.ctx.config, auth.organizationId, { minLevel: 'L2' });
    await ai.assertBudget(this.ctx.db, auth.organizationId, resolved.settings);
    let title = input.title?.trim() ?? '';
    let instruction = input.instruction?.trim() ?? '';
    if (input.sourceType === 'feedback') {
      const f = (await this.ctx.db.select().from(feedback).where(and(eq(feedback.id, input.sourceId!), eq(feedback.projectId, scope.project.id))))[0];
      if (!f) throw notFound('Geri bildirim');
      title ||= f.triage?.suggestedTitle ?? f.title;
      instruction = [
        `Müşteri geri bildirimi FB-${f.number} (${f.type}): ${f.title}`,
        f.body,
        `Sayfa: ${f.pageUrl}${f.domSelector ? ` · Öğe: ${f.domSelector}` : ''}${f.viewportWidth ? ` · Ekran: ${f.viewportWidth}×${f.viewportHeight}` : ''}`,
        f.triage ? `Ön analiz: ${f.triage.summary} Olası dosyalar: ${f.triage.likelyFiles.join(', ')}` : '',
        f.relatedFiles.length ? `Kod aramasıyla bulunan ilgili yerler: ${f.relatedFiles.map((r) => `${r.path}:${r.line}`).join(', ')}` : '',
        instruction ? `Ek talimat: ${instruction}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    } else if (input.sourceType === 'build') {
      const b = (await this.ctx.db.select().from(builds).where(and(eq(builds.id, input.sourceId!), eq(builds.projectId, scope.project.id))))[0];
      if (!b || b.status !== 'failed') throw invalid('Yalnızca başarısız build\'ler için düzeltme istenebilir');
      title ||= `Build #${b.number} hatasını düzelt`;
      instruction = [`Build #${b.number} (${b.branch}) başarısız. Adım: ${b.error?.step}. Hata: ${b.error?.message}`, b.error?.file ? `Dosya: ${b.error.file}:${b.error.line ?? ''}` : '', b.aiAnalysis ? `Analiz:\n${b.aiAnalysis}` : '', instruction].filter(Boolean).join('\n');
    } else if (input.sourceType === 'finding') {
      const f = (await this.ctx.db.select().from(securityFindings).where(and(eq(securityFindings.id, input.sourceId!), eq(securityFindings.projectId, scope.project.id))))[0];
      if (!f) throw notFound('Güvenlik bulgusu');
      title ||= `SEC-${f.number}: ${f.title}`.slice(0, 200);
      instruction = [`Güvenlik bulgusu SEC-${f.number} [${f.severity}] ${f.title}`, f.description, f.filePath ? `Dosya: ${f.filePath}:${f.line ?? ''}` : '', f.packageName ? `Paket: ${f.packageName}@${f.packageVersion} → ${f.fixedVersion ?? 'güncel sürüm'}` : '', instruction].filter(Boolean).join('\n');
    } else if (!title || !instruction) {
      throw invalid('Görev başlığı ve talimatı gerekli');
    }
    const task = await this.ctx.db.transaction(async (tx) => {
      const number = await nextNumber(tx, auth.organizationId, 'ai_task');
      const t = (
        await tx
          .insert(aiTasks)
          .values({
            organizationId: auth.organizationId,
            projectId: scope.project.id,
            number,
            type: 'fix',
            title: title.slice(0, 200),
            instruction,
            autonomyLevel: resolved.settings.autonomyLevel,
            sourceType: input.sourceType,
            sourceId: input.sourceId ?? null,
            baseBranch: scope.project.defaultBranch,
            requestedBy: auth.user.id,
          })
          .returning()
      )[0]!;
      await enqueue(tx, { queue: QUEUES.ai, type: 'ai.task.run', organizationId: auth.organizationId, projectId: scope.project.id, maxAttempts: 1, payload: { taskId: t.id } });
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'ai.task.created', resourceType: 'ai_task', resourceId: t.id, metadata: { source: input.sourceType } });
      await timeline(tx, { organizationId: auth.organizationId, projectId: scope.project.id, kind: 'ai', tone: 'run', title: `AI görevi AI-${number} başlatıldı`, description: t.title, actorLabel: actor.label, refType: 'ai_task', refId: t.id });
      if (input.sourceType === 'feedback' && input.sourceId) {
        await tx.insert(feedbackComments).values({ feedbackId: input.sourceId, authorType: 'system', body: `AI-${number} düzeltme görevi başlatıldı (${actor.label})` });
      }
      return t;
    });
    return this.present(task);
  }

  /** Human approval: merges the AI branch into its base branch (AI can never merge by itself). */
  async approve(auth: AuthInfo, taskId: string, comment: string | undefined, actor: Actor) {
    const t = (await this.ctx.db.select().from(aiTasks).where(and(eq(aiTasks.id, taskId), eq(aiTasks.organizationId, auth.organizationId))))[0];
    if (!t) throw notFound('AI görevi');
    const scope = await this.access.requireWritable(auth, t.projectId, 'ai.approve');
    if (t.status !== 'awaiting_approval' || !t.branch || !t.baseBranch) throw precondition('Görev onay beklemiyor');
    if (t.buildId) {
      const b = (await this.ctx.db.select({ s: builds.status }).from(builds).where(eq(builds.id, t.buildId)))[0];
      if (b && b.s === 'failed') throw precondition('AI değişikliğinin build\'i başarısız; birleştirmeden önce inceleyin veya reddedin');
      if (b && (b.s === 'queued' || b.s === 'running')) throw precondition('AI değişikliğinin doğrulama build\'i sürüyor; bitmesini bekleyin');
    }
    const { git } = await this.repos.forProject(t.projectId);
    const head = await git.resolve(`refs/heads/${t.branch}`);
    if (head !== t.headCommit) throw precondition('AI branch\'i görev hazırlandıktan sonra değişmiş; yeniden inceleyin');
    const merged = await git.merge({ source: t.branch, target: t.baseBranch, message: `Merge AI-${t.number}: ${t.title}\n\nApproved by ${auth.user.displayName}${comment ? `: ${comment}` : ''}`, author: { name: auth.user.displayName, email: auth.user.email } });
    await this.ctx.db.transaction(async (tx) => {
      await tx.update(aiTasks).set({ status: 'merged', decidedBy: auth.user.id, decisionComment: comment ?? null }).where(eq(aiTasks.id, t.id));
      await audit(tx, { organizationId: auth.organizationId, projectId: t.projectId, actor, action: 'ai.task.approved_merged', resourceType: 'ai_task', resourceId: t.id, metadata: { merge: merged.sha, fastForward: merged.fastForward } });
      await timeline(tx, { organizationId: auth.organizationId, projectId: t.projectId, kind: 'ai', tone: 'ok', title: `AI-${t.number} onaylandı ve birleştirildi`, description: `${t.branch} → ${t.baseBranch} · ${merged.sha.slice(0, 7)}`, actorLabel: actor.label, refType: 'ai_task', refId: t.id });
      await emitDomainEvent(tx, { event: 'ai.task.merged', organizationId: auth.organizationId, projectId: t.projectId, actor, data: { taskId: t.id, key: `AI-${t.number}`, requestedBy: t.requestedBy } });
      if (t.sourceType === 'feedback' && t.sourceId) {
        await tx.insert(feedbackComments).values({ feedbackId: t.sourceId, authorType: 'system', body: `AI-${t.number} düzeltmesi ${t.baseBranch} branch'ine birleştirildi (${actor.label}). Yeni ön izleme ile müşteriye sunulabilir.` });
      }
      if (t.baseBranch === scope.project.defaultBranch) await this.projects.afterPush(tx, t.projectId, auth.organizationId, t.baseBranch);
      await publish(tx, { type: 'ai.task.updated', organizationId: auth.organizationId, projectId: t.projectId, id: t.id });
    });
    return this.getTask(auth, taskId);
  }

  async reject(auth: AuthInfo, taskId: string, comment: string | undefined, actor: Actor) {
    const t = (await this.ctx.db.select().from(aiTasks).where(and(eq(aiTasks.id, taskId), eq(aiTasks.organizationId, auth.organizationId))))[0];
    if (!t) throw notFound('AI görevi');
    await this.access.require(auth, t.projectId, 'ai.approve');
    if (!['awaiting_approval', 'queued', 'failed'].includes(t.status)) throw precondition('Görev reddedilebilir durumda değil');
    if (t.branch) {
      const { git } = await this.repos.forProject(t.projectId);
      const head = await git.resolve(`refs/heads/${t.branch}`);
      if (head) await git.deleteBranch(t.branch, head);
    }
    await this.ctx.db.update(aiTasks).set({ status: 'rejected', decidedBy: auth.user.id, decisionComment: comment ?? null }).where(eq(aiTasks.id, t.id));
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: t.projectId, actor, action: 'ai.task.rejected', resourceType: 'ai_task', resourceId: t.id, metadata: { comment } });
    await timeline(this.ctx.db, { organizationId: auth.organizationId, projectId: t.projectId, kind: 'ai', title: `AI-${t.number} reddedildi`, description: comment ?? '', actorLabel: actor.label, refType: 'ai_task', refId: t.id });
    await publish(this.ctx.db, { type: 'ai.task.updated', organizationId: auth.organizationId, projectId: t.projectId, id: t.id });
    return this.getTask(auth, taskId);
  }

  async reanalyseBuild(auth: AuthInfo, buildId: string) {
    const b = (await this.ctx.db.select().from(builds).where(and(eq(builds.id, buildId), eq(builds.organizationId, auth.organizationId))))[0];
    if (!b) throw notFound('Build');
    await this.access.require(auth, b.projectId, 'ai.execute');
    if (b.status !== 'failed') throw precondition('Yalnızca başarısız build\'ler analiz edilir');
    await ai.resolveAi(this.ctx.db, this.ctx.config, auth.organizationId, { minLevel: 'L1' });
    await enqueue(this.ctx.db, { queue: QUEUES.ai, type: 'ai.build_analysis', organizationId: auth.organizationId, projectId: b.projectId, dedupeKey: `build-analysis:${b.id}`, payload: { buildId: b.id } });
    return { queued: true };
  }
}
