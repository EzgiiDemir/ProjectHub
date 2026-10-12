import type { AgentConversation, AiProvider, AiToolDef, AiToolResult, AiTurn, ChatMessage } from './provider.js';

interface OllamaToolCall {
  function: { name: string; arguments: unknown };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

interface OllamaEmbedResponse {
  model?: string;
  embeddings?: number[][];
  prompt_eval_count?: number;
  error?: string;
}

export interface OllamaRuntimeStatus {
  reachable: boolean;
  baseUrl: string;
  version: string | null;
  models: { name: string; size: number; parameterSize: string | null; quantization: string | null }[];
  loadedModels: { name: string; sizeVram: number | null; expiresAt: string | null }[];
  error: string | null;
}

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function responseError(response: Response): Promise<Error> {
  const body = (await response.text()).slice(0, 1000);
  return new Error(`Ollama isteği başarısız (${response.status}): ${body || response.statusText}`);
}

/** Native Ollama `/api/chat` adapter. No cloud SDK, API key or external network call is involved. */
export class OllamaProvider implements AiProvider {
  readonly name = 'ollama' as const;
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    readonly model: string,
    private readonly timeoutMs = 300_000,
    /** num_ctx sent with every request; never rely on the runtime's version-dependent default. */
    private readonly contextTokens = 16_384,
  ) {
    this.baseUrl = cleanBaseUrl(baseUrl);
  }

  private async chat(body: Record<string, unknown>, signal?: AbortSignal): Promise<OllamaChatResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, stream: false, ...body }),
      signal: requestSignal(signal, this.timeoutMs),
    });
    if (!response.ok) throw await responseError(response);
    const result = (await response.json()) as OllamaChatResponse;
    if (result.error) throw new Error(`Ollama: ${result.error}`);
    return result;
  }

  async complete(opts: { system: string; messages: ChatMessage[]; maxTokens?: number; onText?: (delta: string) => void; signal?: AbortSignal }) {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        messages: [{ role: 'system', content: opts.system }, ...opts.messages],
        options: { num_ctx: this.contextTokens, num_predict: opts.maxTokens ?? 8000, temperature: 0 },
      }),
      signal: requestSignal(opts.signal, this.timeoutMs),
    });
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw new Error('Ollama boş bir akış döndürdü.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const consume = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as OllamaChatResponse;
      if (event.error) throw new Error(`Ollama: ${event.error}`);
      const delta = event.message?.content ?? '';
      if (delta) {
        text += delta;
        opts.onText?.(delta);
      }
      inputTokens = event.prompt_eval_count ?? inputTokens;
      outputTokens = event.eval_count ?? outputTokens;
    };
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) consume(line);
      if (done) break;
    }
    consume(buffer);
    return { text, usage: { inputTokens, outputTokens }, refused: false };
  }

  agent(opts: { system: string; tools: AiToolDef[]; maxTokens?: number; signal?: AbortSignal }): AgentConversation {
    const messages: OllamaMessage[] = [{ role: 'system', content: opts.system }];
    const names = new Map<string, string>();
    let turnNumber = 0;
    const tools = opts.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    const turn = async (): Promise<AiTurn> => {
      turnNumber += 1;
      const response = await this.chat({ messages, tools, options: { num_ctx: this.contextTokens, num_predict: opts.maxTokens ?? 16000, temperature: 0 } }, opts.signal);
      const assistant = response.message ?? { role: 'assistant' as const, content: '' };
      messages.push(assistant);
      const toolCalls = (assistant.tool_calls ?? []).map((call, index) => {
        const id = `ollama-${turnNumber}-${index}`;
        names.set(id, call.function.name);
        let input = call.function.arguments;
        if (typeof input === 'string') {
          const raw = input;
          try {
            input = JSON.parse(raw);
          } catch {
            input = { __invalid_json: raw.slice(0, 200) };
          }
        }
        return { id, name: call.function.name, input };
      });
      return {
        text: assistant.content ?? '',
        toolCalls,
        done: toolCalls.length === 0,
        refused: false,
        truncated: response.done_reason === 'length',
        usage: { inputTokens: response.prompt_eval_count ?? 0, outputTokens: response.eval_count ?? 0 },
      };
    };
    return {
      start: async (userText) => {
        messages.push({ role: 'user', content: userText });
        return turn();
      },
      continue: async (results: AiToolResult[]) => {
        for (const result of results) {
          messages.push({ role: 'tool', tool_name: names.get(result.id), content: result.isError ? `ERROR: ${result.output}` : result.output });
        }
        return turn();
      },
    };
  }
}

/** Local embedding client used by the incremental index and semantic retrieval. */
export class OllamaEmbeddingClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    readonly model: string,
    private readonly timeoutMs = 300_000,
  ) {
    this.baseUrl = cleanBaseUrl(baseUrl);
  }

  async embed(input: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!input.length) return [];
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: input.map((value) => value.slice(0, 12_000)), truncate: true, keep_alive: '30s' }),
      signal: requestSignal(signal, this.timeoutMs),
    });
    if (!response.ok) throw await responseError(response);
    const result = (await response.json()) as OllamaEmbedResponse;
    if (result.error) throw new Error(`Ollama: ${result.error}`);
    if (!Array.isArray(result.embeddings) || result.embeddings.length !== input.length) {
      throw new Error(`Ollama embedding sayısı eşleşmedi (${result.embeddings?.length ?? 0}/${input.length}).`);
    }
    const dimensions = result.embeddings[0]?.length ?? 0;
    if (!dimensions || result.embeddings.some((vector) => vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))) {
      throw new Error('Ollama geçersiz embedding vektörü döndürdü.');
    }
    return result.embeddings;
  }
}

/** Short, read-only health probe for the AI control center. */
export async function getOllamaRuntimeStatus(baseUrl: string, timeoutMs = 5_000): Promise<OllamaRuntimeStatus> {
  const root = cleanBaseUrl(baseUrl);
  const get = async (path: string) => {
    const response = await fetch(`${root}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as Record<string, unknown>;
  };
  try {
    const version = await get('/api/version');
    const [tags, running] = await Promise.all([get('/api/tags'), get('/api/ps').catch(() => ({ models: [] }))]);
    // Ollama can list the same tag twice (e.g. a re-pulled model); keep one entry per name.
    const seen = new Set<string>();
    const models = (Array.isArray(tags.models) ? tags.models : []).filter((raw) => {
      const name = String((raw as Record<string, unknown>).name ?? (raw as Record<string, unknown>).model ?? '');
      return !seen.has(name) && !!seen.add(name);
    });
    const loaded = Array.isArray(running.models) ? running.models : [];
    return {
      reachable: true,
      baseUrl: root,
      version: typeof version.version === 'string' ? version.version : null,
      models: models.map((raw) => {
        const m = raw as Record<string, unknown>;
        const details = (m.details ?? {}) as Record<string, unknown>;
        return {
          name: String(m.name ?? m.model ?? ''),
          size: Number(m.size ?? 0),
          parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : null,
          quantization: typeof details.quantization_level === 'string' ? details.quantization_level : null,
        };
      }),
      loadedModels: loaded.map((raw) => {
        const m = raw as Record<string, unknown>;
        return { name: String(m.name ?? m.model ?? ''), sizeVram: typeof m.size_vram === 'number' ? m.size_vram : null, expiresAt: typeof m.expires_at === 'string' ? m.expires_at : null };
      }),
      error: null,
    };
  } catch (error) {
    return { reachable: false, baseUrl: root, version: null, models: [], loadedModels: [], error: (error as Error).message };
  }
}
