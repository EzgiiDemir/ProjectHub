import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, GitRepository, loadConfig, parseManifest, Storage, type JobContext } from '@projecthub/core';
import { aiActions, aiRuns, aiTasks, builds, jobs, organizations, projectManifests, projects, repositories, users, type DatabaseHandle } from '@projecthub/database';
import { freshDatabase } from '../../../test/support/db.js';
import { startFakeAnthropic, type RecordedRequest, type ScriptedTurn } from '../../../test/support/fake-anthropic.js';
import type { WorkerCtx } from '../src/context.js';
import { runAiTask } from '../src/jobs/ai.js';

const BUGGY = `/** Sepet toplamı (kuruş hassasiyetinde yuvarlanır). */
export function cartTotal(items) {
  return items.reduce((sum, i) => sum + i.price, 0);
}
`;
const FIXED = `/** Sepet toplamı (kuruş hassasiyetinde yuvarlanır). */
export function cartTotal(items) {
  return Math.round(items.reduce((sum, i) => sum + i.price * i.qty, 0) * 100) / 100;
}
`;

let h: DatabaseHandle;
let tmp: string;
let ctx: WorkerCtx;
let fake: Awaited<ReturnType<typeof startFakeAnthropic>>;
let orgId: string;
let userId: string;
let projectId: string;
let base: string;
let turnFor: (req: RecordedRequest, i: number) => ScriptedTurn = () => ({ text: 'no script' });
const logger = createLogger('test', 'silent');

beforeAll(async () => {
  h = await freshDatabase();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-ai-'));
  fake = await startFakeAnthropic((req, i) => turnFor(req, i));
  const config = loadConfig({ ...process.env, STORAGE_DIR: tmp, ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: fake.url }, { cwd: tmp });
  const storage = new Storage(config.storageDir);
  await storage.init();
  ctx = { config, db: h.db, pool: h.pool, storage, logger, workerId: 'test-worker' };

  orgId = (await h.db.insert(organizations).values({ name: 'Test', slug: 'test', settings: { ai: { provider: 'anthropic', autonomyLevel: 'L2' } } }).returning())[0]!.id;
  userId = (await h.db.insert(users).values({ email: 'dev@example.com', displayName: 'Dev', status: 'active' }).returning())[0]!.id;
  projectId = (await h.db.insert(projects).values({ organizationId: orgId, name: 'Nova Mağaza', slug: 'nova', technologies: ['Node.js'] }).returning())[0]!.id;
  const repoKey = storage.repoKey(projectId);
  await h.db.insert(repositories).values({ projectId, storageKey: repoKey, status: 'ready', defaultBranch: 'main' });
  const git = await GitRepository.initBare(storage.resolve(repoKey), 'main');
  base = await git.commitChanges({
    branch: 'main',
    baseCommit: null,
    message: 'init',
    author: { name: 'Dev', email: 'dev@example.com' },
    changes: [
      { action: 'upsert', path: 'src/cart.mjs', content: BUGGY },
      { action: 'upsert', path: 'README.md', content: '# Nova\n' },
      { action: 'upsert', path: '.env', content: 'STRIPE_SECRET=sk_live_should_never_be_read\n' },
    ],
  });
});

afterAll(async () => {
  await fake?.close();
  await h?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function newTask(number: number, title: string) {
  return (
    await h.db
      .insert(aiTasks)
      .values({ organizationId: orgId, projectId, number, type: 'fix', title, instruction: 'Sepet toplamı adet ile çarpılmıyor; düzelt.', autonomyLevel: 'L2', sourceType: 'manual', baseBranch: 'main', requestedBy: userId })
      .returning()
  )[0]!;
}

const job = (taskId: string) => ({ job: { id: 'j', type: 'ai.task.run', payload: { taskId }, attempts: 1, maxAttempts: 1 }, logger, signal: new AbortController().signal }) as unknown as JobContext;

describe('AI fix task (real worker job, Anthropic SDK against a scripted Messages API)', () => {
  it('investigates, edits on its own branch, is denied forbidden files, and waits for human approval', async () => {
    const script: ScriptedTurn[] = [
      { text: 'Önce sepet hesabını bulayım.', toolCalls: [{ name: 'search_code', input: { query: 'cartTotal' } }] },
      { toolCalls: [{ name: 'read_file', input: { path: 'src/cart.mjs' } }, { name: 'read_file', input: { path: '.env' } }] },
      { toolCalls: [{ name: 'write_file', input: { path: 'src/cart.mjs', content: FIXED } }, { name: 'write_file', input: { path: 'projecthub.yml', content: 'x' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: 'Sepet toplamı adet ile çarpılıyor ve yuvarlanıyor.', explanation: ['cartTotal fiyatı adetle çarpıyor', 'Sonuç kuruşa yuvarlanıyor'] } }] },
    ];
    turnFor = (_req, i) => script[i]!;
    const task = await newTask(1, 'Sepet toplamı hatası');
    await runAiTask(ctx, job(task.id));

    const t = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, task.id)))[0]!;
    expect(t.status).toBe('awaiting_approval');
    expect(t.branch).toMatch(/^ai\/AI-1-/);
    expect(t.baseCommit).toBe(base);
    expect(t.result?.filesChanged).toEqual([{ path: 'src/cart.mjs', additions: 1, deletions: 1 }]);

    // The change lives only on the AI branch; main is untouched.
    const git = new GitRepository(ctx.storage.resolve(ctx.storage.repoKey(projectId)));
    expect((await git.readFile(t.headCommit!, 'src/cart.mjs'))!.content.toString()).toBe(FIXED);
    expect(await git.resolve('refs/heads/main')).toBe(base);

    // Every tool call is in the audit trail; secrets and the manifest were refused.
    const actions = await h.db.select().from(aiActions).where(eq(aiActions.taskId, task.id));
    const summary = actions.map((a) => `${a.action}:${a.resource ?? ''}:${a.decision}`).sort();
    expect(summary).toEqual(['finish::allowed', 'read_file:.env:denied', 'read_file:src/cart.mjs:allowed', 'search_code::allowed', 'write_file:projecthub.yml:denied', 'write_file:src/cart.mjs:allowed'].sort());

    // Usage is accounted per run.
    const run = (await h.db.select().from(aiRuns).where(eq(aiRuns.taskId, task.id)))[0]!;
    expect(run).toMatchObject({ purpose: 'fix_agent', status: 'completed', provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 480, outputTokens: 160 });

    // Verification build is queued on the AI branch; at L2 it does not open a preview.
    const b = (await h.db.select().from(builds).where(and(eq(builds.projectId, projectId), eq(builds.trigger, 'ai'))))[0]!;
    expect(b).toMatchObject({ branch: t.branch, commitSha: t.headCommit, createPreview: false, triggeredByType: 'ai' });
    expect((await h.db.select().from(jobs).where(eq(jobs.type, 'build.execute'))).length).toBe(1);

    // What actually went over the wire.
    const first = fake.requests[0]!;
    expect(first.path).toContain('/v1/messages');
    expect(String(first.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(first.body).toMatchObject({ model: 'claude-opus-5-5', stream: true, fallbacks: 'default', output_config: { effort: 'high' } });
    expect(first.body.tools!.every((tool) => tool.eager_input_streaming === true)).toBe(true);
    expect(first.body.system![0]!.text).toContain('Nova Mağaza');
    const results = (i: number) => (fake.requests[i]!.body.messages.at(-1)!.content as { type: string; content: string; is_error: boolean }[]);
    expect(results(1)[0]!.content).toContain('src/cart.mjs:2');
    expect(results(2).find((r) => r.content.includes('izin yok'))!.is_error).toBe(true);
    expect(results(2).find((r) => r.content.includes('items.reduce'))!.is_error).toBe(false);
  }, 60_000);

  it('fails the task (no branch, no build) when the model refuses', async () => {
    const before = fake.requests.length;
    turnFor = () => ({ text: '', stopReason: 'refusal' });
    const task = await newTask(2, 'Riskli istek');
    await runAiTask(ctx, job(task.id));
    const t = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, task.id)))[0]!;
    expect(t.status).toBe('failed');
    expect(t.error).toContain('reddetti');
    expect(fake.requests.length).toBe(before + 1);
    const git = new GitRepository(ctx.storage.resolve(ctx.storage.repoKey(projectId)));
    expect((await git.branches()).map((b) => b.name).filter((n) => n.startsWith('ai/AI-2'))).toEqual([]);
  });

  it('respects a project-level autonomy cap from projecthub.yml (ai.autonomy L1 forbids code changes)', async () => {
    await h.db.insert(projectManifests).values({ projectId, version: 1, source: 'repository', commitSha: base, content: parseManifest(`project:
  name: Nova
ai:
  autonomy: L1
`) });
    const before = fake.requests.length;
    const task = await newTask(3, 'Kapalı projede değişiklik');
    await runAiTask(ctx, job(task.id));
    const t = (await h.db.select().from(aiTasks).where(eq(aiTasks.id, task.id)))[0]!;
    expect(t.status).toBe('failed');
    expect(t.error).toContain('en az L2');
    expect(fake.requests.length).toBe(before); // the model is never called
  });
});
