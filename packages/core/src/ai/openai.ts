import OpenAI from 'openai';
import type { AgentConversation, AiProvider, AiToolDef, AiToolResult, AiTurn, ChatMessage } from './provider.js';

/** OpenAI Responses API adapter (the provider named in the original specification). */
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    readonly model: string,
    baseURL?: string,
  ) {
    this.client = new OpenAI({ apiKey, maxRetries: 3, ...(baseURL ? { baseURL } : {}) });
  }

  async complete(opts: { system: string; messages: ChatMessage[]; maxTokens?: number; onText?: (delta: string) => void; signal?: AbortSignal }) {
    const stream = this.client.responses.stream(
      {
        model: this.model,
        instructions: opts.system,
        input: opts.messages.map((m) => ({ role: m.role, content: m.content })),
        max_output_tokens: opts.maxTokens ?? 16000,
      },
      { signal: opts.signal },
    );
    if (opts.onText) stream.on('response.output_text.delta', (e) => opts.onText!(e.delta));
    const res = await stream.finalResponse();
    return {
      text: res.output_text,
      usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
      refused: res.output.some((o) => o.type === 'message' && o.content.some((c) => c.type === 'refusal')),
    };
  }

  agent(opts: { system: string; tools: AiToolDef[]; maxTokens?: number; signal?: AbortSignal }): AgentConversation {
    const tools: OpenAI.Responses.FunctionTool[] = opts.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: true }));
    let previous: string | null = null;
    const turn = async (input: OpenAI.Responses.ResponseInput): Promise<AiTurn> => {
      const res = await this.client.responses.create(
        { model: this.model, instructions: opts.system, input, tools, previous_response_id: previous, max_output_tokens: opts.maxTokens ?? 32000 },
        { signal: opts.signal },
      );
      previous = res.id;
      const calls = res.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === 'function_call');
      const toolCalls = calls.map((c) => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(c.arguments);
        } catch {
          parsed = { __invalid_json: c.arguments.slice(0, 200) };
        }
        return { id: c.call_id, name: c.name, input: parsed };
      });
      return {
        text: res.output_text,
        toolCalls,
        done: toolCalls.length === 0,
        refused: res.output.some((o) => o.type === 'message' && o.content.some((c) => c.type === 'refusal')),
        truncated: res.incomplete_details?.reason === 'max_output_tokens',
        usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
      };
    };
    return {
      start: (userText) => turn([{ role: 'user', content: userText }]),
      continue: (results: AiToolResult[]) =>
        turn(results.map((r) => ({ type: 'function_call_output' as const, call_id: r.id, output: r.isError ? `ERROR: ${r.output}` : r.output }))),
    };
  }
}
