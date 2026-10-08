import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { OPEN_FEEDBACK_STATUSES, type AiSettings } from '@projecthub/contracts';
import {
  aiRuns,
  builds,
  codeChunks,
  deployments,
  environments,
  feedback,
  projectEvents,
  projectManifests,
  projects,
  securityFindings,
  versions,
  type AiCitation,
  type Executor,
} from '@projecthub/database';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { getOrgSettings } from '../settings.js';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { OpenAiProvider } from './openai.js';
import type { AiProvider, AiToolDef, AiToolResult, AiUsage } from './provider.js';

export * from './provider.js';
export { AnthropicProvider, OpenAiProvider, DEFAULT_ANTHROPIC_MODEL };

export interface ResolvedAi {
  provider: AiProvider;
  settings: AiSettings;
}

/** Which providers have credentials (keys only come from the server environment, never from the database). */
export function availableProviders(config: AppConfig) {
  return { anthropic: !!config.ANTHROPIC_API_KEY, openai: !!config.OPENAI_API_KEY };
}

/**
 * Resolves the AI provider for an organization from Admin > AI settings + server credentials.
 * Throws AI_NOT_CONFIGURED with an actionable message when AI cannot run.
 */
export async function resolveAi(db: Executor, config: AppConfig, organizationId: string, opts: { minLevel?: 'L1' | 'L2' | 'L3' } = {}): Promise<ResolvedAi> {
  const { ai } = await getOrgSettings(db, organizationId);
  if (ai.autonomyLevel === 'L0') throw new AppError('AI_NOT_CONFIGURED', 'AI bu organizasyonda kapalı (otonomi seviyesi L0). Yönetim > AI kontrol merkezinden açılabilir.');
  const order = ['L0', 'L1', 'L2', 'L3'];
  if (opts.minLevel && order.indexOf(ai.autonomyLevel) < order.indexOf(opts.minLevel)) {
    throw new AppError('POLICY_DENIED', `Bu işlem için AI otonomi seviyesi en az ${opts.minLevel} olmalı (şu an ${ai.autonomyLevel}).`);
  }
  const keys = availableProviders(config);
  const name = ai.provider ?? (keys.anthropic ? 'anthropic' : keys.openai ? 'openai' : null);
  if (!name || !keys[name]) {
    throw new AppError(
      'AI_NOT_CONFIGURED',
      name
        ? `${name === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} sunucu ortamında tanımlı değil. Sistem yöneticisi .env dosyasına ekleyip servisleri yeniden başlatmalı.`
        : 'AI sağlayıcısı yapılandırılmamış. Sunucuya ANTHROPIC_API_KEY veya OPENAI_API_KEY ekleyin ve Yönetim > AI kontrol merkezinden sağlayıcıyı seçin.',
    );
  }
  if (name === 'anthropic') return { provider: new AnthropicProvider(config.ANTHROPIC_API_KEY, ai.model ?? DEFAULT_ANTHROPIC_MODEL), settings: ai };
  if (!ai.model) throw new AppError('AI_NOT_CONFIGURED', 'OpenAI için model adı seçilmemiş. Yönetim > AI kontrol merkezinden model belirleyin.');
  return { provider: new OpenAiProvider(config.OPENAI_API_KEY, ai.model), settings: ai };
}

export async function monthlyTokenUsage(db: Executor, organizationId: string): Promise<number> {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const r = await db
    .select({ n: sql<number>`coalesce(sum(${aiRuns.inputTokens} + ${aiRuns.outputTokens}), 0)::bigint` })
    .from(aiRuns)
    .where(and(eq(aiRuns.organizationId, organizationId), gte(aiRuns.startedAt, start)));
  return Number(r[0]?.n ?? 0);
}

export async function assertBudget(db: Executor, organizationId: string, settings: AiSettings): Promise<void> {
  const used = await monthlyTokenUsage(db, organizationId);
  if (settings.monthlyTokenBudget > 0 && used >= settings.monthlyTokenBudget) {
    throw new AppError('AI_BUDGET_EXCEEDED', `Aylık AI token bütçesi doldu (${used.toLocaleString('tr-TR')} / ${settings.monthlyTokenBudget.toLocaleString('tr-TR')}). Yönetici bütçeyi artırabilir.`);
  }
}

/** Opens an ai_runs record; call the returned finish() with the usage (success or failure). */
export async function startRun(
  db: Executor,
  input: { organizationId: string; projectId: string | null; taskId?: string | null; purpose: string; provider: AiProvider; userId?: string | null },
) {
  const row = (
    await db
      .insert(aiRuns)
      .values({ organizationId: input.organizationId, projectId: input.projectId, taskId: input.taskId ?? null, purpose: input.purpose, provider: input.provider.name, model: input.provider.model, userId: input.userId ?? null })
      .returning({ id: aiRuns.id })
  )[0]!;
  return {
    id: row.id,
    finish: async (usage: AiUsage, error?: string) => {
      await db
        .update(aiRuns)
        .set({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, status: error ? 'failed' : 'completed', error: error?.slice(0, 2000) ?? null, finishedAt: new Date() })
        .where(eq(aiRuns.id, row.id));
    },
  };
}

/* ------------------------------------------------------------------ agent loop */

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  def: AiToolDef;
  schema: S;
  risk: 'low' | 'medium' | 'high';
  run(input: z.infer<S>): Promise<string>;
}

export interface AgentOutcome {
  status: 'finished' | 'done' | 'max_steps' | 'refused' | 'budget';
  finishInput: unknown;
  text: string;
  usage: AiUsage;
  steps: number;
}

/**
 * Runs a tool-using agent. Every tool input is validated against its schema before execution (inputs may be
 * truncated or malformed), every call is reported to onAction for the audit trail, and the loop ends when the
 * model calls `finish`, stops asking for tools, refuses, exceeds maxSteps, or the token budget runs out.
 */
export async function runToolAgent(opts: {
  provider: AiProvider;
  system: string;
  task: string;
  tools: Record<string, AgentTool>;
  maxSteps: number;
  tokenLimit: number;
  signal?: AbortSignal;
  onAction?: (name: string, input: unknown, outcome: { ok: boolean; risk: string; output: string }) => Promise<void>;
}): Promise<AgentOutcome> {
  const usage: AiUsage = { inputTokens: 0, outputTokens: 0 };
  const convo = opts.provider.agent({ system: opts.system, tools: Object.values(opts.tools).map((t) => t.def), signal: opts.signal });
  let turn = await convo.start(opts.task);
  for (let step = 1; ; step++) {
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    if (turn.refused) return { status: 'refused', finishInput: null, text: turn.text, usage, steps: step };
    if (turn.done) return { status: 'done', finishInput: null, text: turn.text, usage, steps: step };
    if (step > opts.maxSteps) return { status: 'max_steps', finishInput: null, text: turn.text, usage, steps: step };
    if (usage.inputTokens + usage.outputTokens > opts.tokenLimit) return { status: 'budget', finishInput: null, text: turn.text, usage, steps: step };
    const results: AiToolResult[] = [];
    let finishInput: unknown = undefined;
    for (const call of turn.toolCalls) {
      const tool = opts.tools[call.name];
      if (!tool) {
        results.push({ id: call.id, output: `Bilinmeyen araç: ${call.name}`, isError: true });
        continue;
      }
      if (turn.truncated) {
        results.push({ id: call.id, output: 'Çıktı token sınırında kesildi; araç çalıştırılmadı. Daha küçük adımlarla tekrar dene.', isError: true });
        continue;
      }
      const parsed = tool.schema.safeParse(call.input);
      if (!parsed.success) {
        const msg = `Geçersiz girdi: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
        results.push({ id: call.id, output: msg, isError: true });
        await opts.onAction?.(call.name, call.input, { ok: false, risk: tool.risk, output: msg });
        continue;
      }
      try {
        const output = await tool.run(parsed.data);
        results.push({ id: call.id, output });
        await opts.onAction?.(call.name, parsed.data, { ok: true, risk: tool.risk, output });
        if (call.name === 'finish') finishInput = parsed.data;
      } catch (e) {
        const msg = (e as Error).message.slice(0, 2000);
        results.push({ id: call.id, output: msg, isError: true });
        await opts.onAction?.(call.name, parsed.data, { ok: false, risk: tool.risk, output: msg });
      }
    }
    if (finishInput !== undefined) return { status: 'finished', finishInput, text: turn.text, usage, steps: step };
    turn = await convo.continue(results);
  }
}

/* ------------------------------------------------------------------ project brain */

function searchTerms(text: string): string[] {
  const stop = new Set(['nedir', 'nasıl', 'neden', 'nerede', 'hangi', 'için', 'olan', 'with', 'what', 'where', 'does', 'this', 'that', 'the', 'and', 'bir', 'bu', 've', 'ile', 'mı', 'mi', 'mu', 'mü']);
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .flatMap((w) => [w, ...w.split(/(?=[A-Z])|_/)])
    .filter((w) => w.length >= 3 && !stop.has(w));
  return [...new Set(words)].slice(0, 12);
}

export interface ProjectContext {
  text: string;
  citations: AiCitation[];
}

/**
 * Builds the grounding context for questions about a project: relevant source chunks (PostgreSQL full-text
 * search over the incremental code index) plus the project's recent history. Every item is cited.
 */
export async function buildProjectContext(db: Executor, projectId: string, question: string, opts: { filePath?: string; maxChars?: number } = {}): Promise<ProjectContext> {
  const maxChars = opts.maxChars ?? 40_000;
  const citations: AiCitation[] = [];
  const parts: string[] = [];
  const project = (await db.select().from(projects).where(eq(projects.id, projectId)))[0];
  if (!project) return { text: '', citations };
  const manifest = (await db.select({ content: projectManifests.content }).from(projectManifests).where(eq(projectManifests.projectId, projectId)).orderBy(desc(projectManifests.version)).limit(1))[0]?.content;
  parts.push(
    `# Proje\nAd: ${project.name}\nTür: ${project.projectType}\nTeknolojiler: ${project.technologies.join(', ')}\nMüşteri: ${project.customerName}\nVarsayılan branch: ${project.defaultBranch}\nGüncel sürüm: ${project.currentVersion ?? '-'}\nAçıklama: ${project.description}`,
  );
  if (manifest) parts.push(`# projecthub.yml (özet)\n${JSON.stringify(manifest)}`);

  let budget = maxChars - parts.join('\n').length;
  const addChunk = (c: { path: string; startLine: number; endLine: number; content: string }) => {
    const block = `## ${c.path}:${c.startLine}-${c.endLine}\n\`\`\`\n${c.content}\n\`\`\``;
    if (block.length > budget) return;
    budget -= block.length;
    parts.push(block);
    citations.push({ type: 'file', ref: c.path, label: `${c.path}:${c.startLine}`, line: c.startLine });
  };
  if (opts.filePath) {
    const own = await db.select().from(codeChunks).where(and(eq(codeChunks.projectId, projectId), eq(codeChunks.path, opts.filePath))).orderBy(codeChunks.startLine).limit(8);
    if (own.length) parts.push('# Seçili dosya');
    for (const c of own) addChunk(c);
  }
  const terms = searchTerms(question + (opts.filePath ? ` ${opts.filePath}` : ''));
  if (terms.length) {
    const query = terms.map((t) => `${t.replace(/[^\p{L}\p{N}_]/gu, '')}:*`).filter((t) => t.length > 2).join(' | ');
    const rows = await db.execute<{ path: string; start_line: number; end_line: number; content: string }>(sql`
      SELECT path, start_line, end_line, content
      FROM code_chunks
      WHERE project_id = ${projectId} AND search_vector @@ to_tsquery('simple', ${query})
      ORDER BY ts_rank_cd(search_vector, to_tsquery('simple', ${query})) DESC
      LIMIT 10`);
    if (rows.rows.length) parts.push('# İlgili kaynak kod');
    for (const r of rows.rows) {
      if (opts.filePath && r.path === opts.filePath) continue;
      addChunk({ path: r.path, startLine: r.start_line, endLine: r.end_line, content: r.content });
    }
  }

  const recentBuilds = await db.select().from(builds).where(eq(builds.projectId, projectId)).orderBy(desc(builds.createdAt)).limit(5);
  if (recentBuilds.length) {
    parts.push(`# Son build'ler\n${recentBuilds.map((b) => `- #${b.number} ${b.status} ${b.branch}@${b.commitSha.slice(0, 7)} ${b.createdAt.toISOString()}${b.error ? ` HATA [${b.error.step}] ${b.error.file ?? ''}:${b.error.line ?? ''} ${b.error.message}` : ''}`).join('\n')}`);
    for (const b of recentBuilds) citations.push({ type: 'build', ref: b.id, label: `Build #${b.number}` });
  }
  const recentDeploys = await db
    .select({ d: deployments, env: environments.name, v: versions.version })
    .from(deployments)
    .innerJoin(environments, eq(environments.id, deployments.environmentId))
    .innerJoin(versions, eq(versions.id, deployments.versionId))
    .where(eq(deployments.projectId, projectId))
    .orderBy(desc(deployments.createdAt))
    .limit(5);
  if (recentDeploys.length) {
    parts.push(`# Son deployment'lar\n${recentDeploys.map((r) => `- D-${r.d.number} v${r.v} → ${r.env}: ${r.d.status} ${r.d.createdAt.toISOString()}${r.d.error ? ` (${r.d.error})` : ''}`).join('\n')}`);
    for (const r of recentDeploys) citations.push({ type: 'deployment', ref: r.d.id, label: `D-${r.d.number}` });
  }
  const openFb = await db.select().from(feedback).where(and(eq(feedback.projectId, projectId), inArray(feedback.status, OPEN_FEEDBACK_STATUSES))).orderBy(desc(feedback.createdAt)).limit(10);
  if (openFb.length) {
    parts.push(`# Açık müşteri geri bildirimleri\n${openFb.map((f) => `- FB-${f.number} [${f.status}/${f.priority}] ${f.title} — ${f.pageUrl}${f.domSelector ? ` (${f.domSelector})` : ''}: ${f.body.slice(0, 200)}`).join('\n')}`);
    for (const f of openFb) citations.push({ type: 'feedback', ref: f.id, label: `FB-${f.number}` });
  }
  const findings = await db.select().from(securityFindings).where(and(eq(securityFindings.projectId, projectId), eq(securityFindings.status, 'open'))).orderBy(desc(securityFindings.createdAt)).limit(10);
  if (findings.length) {
    parts.push(`# Açık güvenlik bulguları\n${findings.map((f) => `- SEC-${f.number} [${f.severity}] ${f.title} ${f.filePath ?? ''}${f.line ? `:${f.line}` : ''}`).join('\n')}`);
    for (const f of findings) citations.push({ type: 'finding', ref: f.id, label: `SEC-${f.number}` });
  }
  const events = await db.select().from(projectEvents).where(eq(projectEvents.projectId, projectId)).orderBy(desc(projectEvents.createdAt)).limit(15);
  if (events.length) parts.push(`# Zaman akışı (en yeni önce)\n${events.map((e) => `- ${e.createdAt.toISOString()} [${e.kind}] ${e.title} ${e.description}`).join('\n')}`);
  return { text: parts.join('\n\n').slice(0, maxChars + 2000), citations };
}
