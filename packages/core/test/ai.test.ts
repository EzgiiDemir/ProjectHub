import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startFakeAnthropic } from '../../../test/support/fake-anthropic.js';
import { AnthropicProvider, getOllamaRuntimeStatus, OllamaEmbeddingClient, OllamaProvider, OpenAiProvider, runToolAgent, type AgentTool } from '../src/ai/index.js';

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

describe('Anthropic provider', () => {
  it('streams a Q&A answer token by token and reports usage', async () => {
    const fake = await startFakeAnthropic([{ text: 'Sepet toplamı `src/cart.mjs:2` içinde hesaplanır.', usage: { input: 900, output: 25 } }]);
    closers.push(fake.close);
    const p = new AnthropicProvider('sk-test', undefined, fake.url);
    const deltas: string[] = [];
    const r = await p.complete({ system: 'Proje asistanı', messages: [{ role: 'user', content: 'Sepet nerede hesaplanıyor?' }], onText: (d) => deltas.push(d) });
    expect(r.text).toBe('Sepet toplamı `src/cart.mjs:2` içinde hesaplanır.');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(r.text);
    expect(r).toMatchObject({ refused: false, usage: { inputTokens: 900, outputTokens: 25 } });
    expect(fake.requests[0]!.body).toMatchObject({ model: 'claude-opus-5-5', stream: true, output_config: { effort: 'medium' } });
  });

  it('flags refusals', async () => {
    const fake = await startFakeAnthropic([{ text: '', stopReason: 'refusal' }]);
    closers.push(fake.close);
    const r = await new AnthropicProvider('sk-test', undefined, fake.url).complete({ system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(r.refused).toBe(true);
  });
});

/** Minimal Responses API stand-in (non-streaming create), scripted per call. */
async function startFakeOpenAi(script: ((body: Record<string, unknown>) => Record<string, unknown>)[]) {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      const out = script[requests.length - 1]!(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `resp_${requests.length}`, object: 'response', status: 'completed', model: body.model, usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 }, ...out }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

const call = (id: string, name: string, args: string) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: args, status: 'completed' });

describe('OpenAI provider + agent loop', () => {
  it('chains turns with previous_response_id, validates tool input and stops on finish', async () => {
    const fake = await startFakeOpenAi([
      () => ({ output: [call('c1', 'add', '{"a":2,"b":"üç"}'), call('c2', 'nope', '{}')] }),
      () => ({ output: [call('c3', 'add', '{"a":2,"b":3}')] }),
      () => ({ output: [call('c4', 'finish', '{"summary":"Toplam 5"}')] }),
    ]);
    const tools: Record<string, AgentTool> = {
      add: {
        risk: 'low',
        schema: z.object({ a: z.number(), b: z.number() }),
        def: { name: 'add', description: 'adds', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false } },
        run: async ({ a, b }) => String(a + b),
      },
      finish: {
        risk: 'low',
        schema: z.object({ summary: z.string() }),
        def: { name: 'finish', description: 'done', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } },
        run: async () => 'ok',
      },
    };
    const actions: string[] = [];
    const out = await runToolAgent({
      provider: new OpenAiProvider('sk-test', 'test-model', fake.url),
      system: 'calc',
      task: '2+3?',
      tools,
      maxSteps: 10,
      tokenLimit: 10_000,
      onAction: async (name, _input, r) => void actions.push(`${name}:${r.ok}`),
    });
    expect(out).toMatchObject({ status: 'finished', finishInput: { summary: 'Toplam 5' }, steps: 3, usage: { inputTokens: 150, outputTokens: 30 } });
    expect(actions).toEqual(['add:false', 'add:true', 'finish:true']);
    // Turn 2 continues turn 1 and returns both tool outputs (invalid input and unknown tool as errors).
    expect(fake.requests[1]).toMatchObject({ previous_response_id: 'resp_1' });
    const outputs = fake.requests[1]!.input as { call_id: string; output: string }[];
    expect(outputs.map((o) => o.call_id)).toEqual(['c1', 'c2']);
    expect(outputs[0]!.output).toMatch(/^ERROR: Geçersiz girdi: b:/);
    expect(outputs[1]!.output).toBe('ERROR: Bilinmeyen araç: nope');
    expect((fake.requests[2]!.input as { output: string }[])[0]!.output).toBe('5');
    expect((fake.requests[0]!.tools as { strict: boolean }[]).every((t) => t.strict)).toBe(true);
  });

  it('stops at the step limit', async () => {
    const loop = () => ({ output: [call(String(Math.random()), 'add', '{"a":1,"b":1}')] });
    const fake = await startFakeOpenAi([loop, loop, loop, loop]);
    const out = await runToolAgent({
      provider: new OpenAiProvider('sk-test', 'm', fake.url),
      system: 's',
      task: 't',
      tools: {
        add: { risk: 'low', schema: z.object({ a: z.number(), b: z.number() }), def: { name: 'add', description: '', parameters: {} }, run: async () => '2' },
      },
      maxSteps: 2,
      tokenLimit: 10_000,
    });
    expect(out.status).toBe('max_steps');
    expect(fake.requests.length).toBe(3);
  });
});

async function startFakeOllama(script: Record<string, unknown>[]) {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/version') return void res.end(JSON.stringify({ version: '0.12.3' }));
      if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'local-code:7b', size: 4_500_000_000, details: { parameter_size: '7B', quantization_level: 'Q4_K_M' } }] }));
      if (req.url === '/api/ps') return void res.end(JSON.stringify({ models: [{ name: 'local-code:7b', size_vram: 4_200_000_000, expires_at: '2026-10-08T18:00:00Z' }] }));
      res.statusCode = 404;
      return void res.end();
    }
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      const out = script[requests.length - 1]!;
      res.writeHead(200, { 'content-type': body.stream ? 'application/x-ndjson' : 'application/json' });
      if (body.stream) {
        for (const part of out.parts as string[]) res.write(`${JSON.stringify({ message: { role: 'assistant', content: part }, done: false })}\n`);
        res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 80, eval_count: 12 })}\n`);
      } else {
        res.end(JSON.stringify({ done: true, prompt_eval_count: 40, eval_count: 8, ...out }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { url, requests };
}

describe('Ollama local provider', () => {
  it('generates local semantic vectors in one bounded batch', async () => {
    const fake = await startFakeOllama([{ model: 'local-embed', embeddings: [[1, 0, 0], [0, 1, 0]] }]);
    const vectors = await new OllamaEmbeddingClient(fake.url, 'local-embed').embed(['oturum yenileme', 'fatura toplamı']);
    expect(vectors).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(fake.requests[0]).toMatchObject({ model: 'local-embed', input: ['oturum yenileme', 'fatura toplamı'], truncate: true });
  });

  it('streams chat locally and reports the runtime model inventory', async () => {
    const fake = await startFakeOllama([{ parts: ['Yerel ', 'yanıt'] }]);
    const deltas: string[] = [];
    const result = await new OllamaProvider(fake.url, 'local-code:7b').complete({
      system: 'Türkçe yanıtla',
      messages: [{ role: 'user', content: 'Mimariyi açıkla' }],
      onText: (part) => deltas.push(part),
    });
    expect(result).toEqual({ text: 'Yerel yanıt', usage: { inputTokens: 80, outputTokens: 12 }, refused: false });
    expect(deltas).toEqual(['Yerel ', 'yanıt']);
    // The context window is always explicit: Ollama's default varies by version/VRAM and truncates prompts silently.
    expect(fake.requests[0]).toMatchObject({ model: 'local-code:7b', stream: true, options: { num_ctx: 16_384 } });

    const health = await getOllamaRuntimeStatus(fake.url);
    expect(health).toMatchObject({ reachable: true, version: '0.12.3', models: [{ name: 'local-code:7b', parameterSize: '7B', quantization: 'Q4_K_M' }], loadedModels: [{ name: 'local-code:7b', sizeVram: 4_200_000_000 }] });
  });

  it('executes bounded multi-turn tools through Ollama chat', async () => {
    const fake = await startFakeOllama([
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'add', arguments: { a: 2, b: 3 } } }] } },
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'finish', arguments: { summary: 'Toplam 5' } } }] } },
    ]);
    const tools: Record<string, AgentTool> = {
      add: {
        risk: 'low',
        schema: z.object({ a: z.number(), b: z.number() }),
        def: { name: 'add', description: 'adds', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false } },
        run: async ({ a, b }) => String(a + b),
      },
      finish: {
        risk: 'low',
        schema: z.object({ summary: z.string() }),
        def: { name: 'finish', description: 'done', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } },
        run: async () => 'ok',
      },
    };
    const result = await runToolAgent({ provider: new OllamaProvider(fake.url, 'local-code:7b'), system: 'calc', task: '2+3?', tools, maxSteps: 5, tokenLimit: 1000 });
    expect(result).toMatchObject({ status: 'finished', finishInput: { summary: 'Toplam 5' }, steps: 2, usage: { inputTokens: 80, outputTokens: 16 } });
    const secondMessages = fake.requests[1]!.messages as { role: string; tool_name?: string; content: string }[];
    expect(secondMessages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'add', content: '5' });
  });
});
