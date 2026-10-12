import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { ai } from '@projecthub/core';
import { ADMIN, client, startHarness, waitFor, type Harness } from './harness.js';

const enabled = process.env.PROJECTHUB_REAL_OLLAMA === '1';
const model = process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b';
const embeddingModel = process.env.OLLAMA_EMBEDDING_MODEL ?? 'embeddinggemma:300m-qat-q4_0';
let harness: Harness;

describe.skipIf(!enabled)('Local AI genuine inference (real Ollama, real PostgreSQL, real API)', () => {
  beforeAll(async () => {
    harness = await startHarness({
      worker: true,
      env: {
        AI_ENABLED: 'true',
        AI_PROVIDER: 'ollama',
        OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
        OLLAMA_MODEL: model,
        OLLAMA_EMBEDDING_MODEL: embeddingModel,
        OLLAMA_REQUEST_TIMEOUT_SECONDS: '300',
      },
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it(
    'retrieves persisted project memory and streams a grounded answer through the local model',
    async () => {
      const api = client(() => harness.base);
      expect((await api.post('/auth/login', ADMIN)).status).toBe(200);
      const created = await api.post('/projects', { name: 'Yerel AI E2E', slug: 'yerel-ai-e2e', source: { type: 'empty' } });
      expect(created.status).toBe(201);

      await waitFor(async () => {
        const project = await api.get('/projects/yerel-ai-e2e');
        return (project.data as { repository?: { status?: string } }).repository?.status === 'ready' ? true : false;
      }, 60_000);

      const embedded = await waitFor(async () => {
        const result = await harness.server.handle.db.execute<{ path: string; dimensions: number; model: string }>(sql`
          SELECT c.path, cardinality(c.embedding)::int AS dimensions, c.embedding_model AS model
          FROM code_chunks c
          INNER JOIN projects p ON p.id = c.project_id
          WHERE p.slug = 'yerel-ai-e2e' AND c.embedding IS NOT NULL
          ORDER BY c.path
          LIMIT 1`);
        return result.rows[0] ?? null;
      }, 120_000);
      expect(embedded).toMatchObject({ dimensions: 768, model: embeddingModel });

      const marker = 'PH-E2E-4070';
      expect(
        (
          await api.post('/projects/yerel-ai-e2e/ai/memory', {
            category: 'fact',
            title: 'Yerel çıkarım doğrulama işareti',
            content: `Bu proje için doğrulama işareti tam olarak ${marker} değeridir.`,
            verification: 'verified',
            sourceLabel: 'genuine-local-inference-e2e',
          })
        ).status,
      ).toBe(201);

      const token = await api.post('/auth/tokens', { name: 'local-ai-e2e', expiresInDays: 1 });
      const bearer = (token.data as { token: string }).token;
      const response = await fetch(`${harness.base}/api/v1/projects/yerel-ai-e2e/ai/ask`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Kayıtlı doğrulama işaretini tam ve aynen yaz; ardından kaynak hafıza etiketini bağlamdaki biçimiyle belirt.' }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const sse = await response.text();
      expect(sse).toContain('event: delta');
      expect(sse).toContain('event: done');
      const streamedText = [...sse.matchAll(/^event: delta\r?\ndata: (.+)$/gm)]
        .map((match) => (JSON.parse(match[1]!) as { text: string }).text)
        .join('');
      expect(streamedText).toContain(marker);
      expect(sse).toContain('memory');
    },
    240_000,
  );

  it(
    'executes a genuine model-selected tool call and closes the bounded agent loop',
    async () => {
      const actions: string[] = [];
      const result = await ai.runToolAgent({
        provider: new ai.OllamaProvider(process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434', model, 180_000),
        system: 'You are a deterministic verification agent. You must call read_marker once, then call finish with the exact returned marker as summary. Do not guess the marker.',
        task: 'Read the hidden verification marker with the provided tool and finish with it.',
        tools: {
          read_marker: {
            risk: 'low',
            schema: z.object({}),
            def: { name: 'read_marker', description: 'Returns the hidden verification marker.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
            run: async () => 'TOOL-OK-314159',
          },
          finish: {
            risk: 'low',
            schema: z.object({ summary: z.string() }),
            def: {
              name: 'finish',
              description: 'Finish after reading the marker.',
              parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
            },
            run: async () => 'ok',
          },
        },
        maxSteps: 4,
        tokenLimit: 8_000,
        onAction: async (name, _input, outcome) => void actions.push(`${name}:${outcome.ok}`),
      });
      expect(result.status).toBe('finished');
      expect((result.finishInput as { summary: string }).summary).toContain('314159');
      expect(actions).toEqual(['read_marker:true', 'finish:true']);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    },
    240_000,
  );

  it(
    'prepares an autonomous code change, verifies it, and stops at human approval',
    async () => {
      const api = client(() => harness.base);
      expect((await api.post('/auth/login', ADMIN)).status).toBe(200);
      const marker = 'LOCAL-AI-AUTONOMOUS-E2E';
      const created = await api.post('/projects/yerel-ai-e2e/ai/tasks', {
        type: 'docs',
        sourceType: 'manual',
        title: 'Gerçek yerel otonom düzenleme doğrulaması',
        instruction: `README.md dosyasının sonuna yeni bir satır olarak tam olarak ${marker} metnini ekle. Başka hiçbir dosyayı değiştirme.`,
      });
      expect(created.status).toBe(201);
      const taskId = (created.data as { id: string }).id;

      const prepared = await waitFor(async () => {
        const response = await api.get(`/ai/tasks/${taskId}`);
        const task = response.data as { status: string; error?: string; diff?: { patch: string } | null };
        return ['awaiting_approval', 'failed', 'cancelled'].includes(task.status) ? task : null;
      }, 360_000);
      expect(prepared, prepared.error).toMatchObject({ status: 'awaiting_approval' });
      expect(prepared.diff?.patch).toContain(marker);

      const verified = await waitFor(async () => {
        const response = await api.get(`/ai/tasks/${taskId}`);
        const task = response.data as { build?: { status: string } | null };
        return task.build && ['passed', 'failed', 'cancelled'].includes(task.build.status) ? task : null;
      }, 120_000);
      expect(verified.build).toMatchObject({ status: 'passed' });
      const rejected = await api.post(`/ai/tasks/${taskId}/reject`, { comment: 'Genuine E2E doğrulaması tamamlandı; test değişikliği birleştirilmedi.' });
      expect(rejected.status).toBe(201);
      expect(rejected.data).toMatchObject({ status: 'rejected' });
    },
    540_000,
  );
});
