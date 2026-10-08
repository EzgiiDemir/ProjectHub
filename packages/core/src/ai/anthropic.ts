import Anthropic from '@anthropic-ai/sdk';
import type { AgentConversation, AiProvider, AiToolDef, AiToolResult, AiTurn, ChatMessage } from './provider.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/**
 * Anthropic Messages API adapter. Uses streaming for every request (long inputs/outputs), explicit effort
 * (Claude Opus 5.5 defaults to medium), and server-side refusal fallbacks so a safety decline is retried
 * on the fallback model inside the same call.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string = DEFAULT_ANTHROPIC_MODEL,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 3 });
  }

  private baseParams() {
    return {
      model: this.model,
      betas: ['server-side-fallback-2026-07-01'] as Anthropic.Beta.AnthropicBeta[],
      fallbacks: 'default' as const,
    };
  }

  async complete(opts: { system: string; messages: ChatMessage[]; maxTokens?: number; onText?: (delta: string) => void; signal?: AbortSignal }) {
    const stream = this.client.beta.messages.stream(
      {
        ...this.baseParams(),
        max_tokens: opts.maxTokens ?? 16000,
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
        messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      },
      { signal: opts.signal },
    );
    if (opts.onText) stream.on('text', (d) => opts.onText!(d));
    const msg = await stream.finalMessage();
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return {
      text,
      usage: { inputTokens: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0), outputTokens: msg.usage.output_tokens },
      refused: msg.stop_reason === 'refusal',
    };
  }

  agent(opts: { system: string; tools: AiToolDef[]; maxTokens?: number; signal?: AbortSignal }): AgentConversation {
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    const tools: Anthropic.Beta.BetaTool[] = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
      // Large inputs (whole files) stream as generated; inputs are validated by the agent before running.
      eager_input_streaming: true,
    }));
    const turn = async (): Promise<AiTurn> => {
      const stream = this.client.beta.messages.stream(
        {
          ...this.baseParams(),
          max_tokens: opts.maxTokens ?? 64000,
          output_config: { effort: 'high' },
          system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
          tools,
          messages,
        },
        { signal: opts.signal },
      );
      const msg = await stream.finalMessage();
      messages.push({ role: 'assistant', content: msg.content });
      const toolCalls = msg.content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      return {
        text: msg.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
        toolCalls,
        done: toolCalls.length === 0 && msg.stop_reason !== 'pause_turn',
        refused: msg.stop_reason === 'refusal',
        truncated: msg.stop_reason === 'max_tokens',
        usage: { inputTokens: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0), outputTokens: msg.usage.output_tokens },
      };
    };
    return {
      start: async (userText) => {
        messages.push({ role: 'user', content: userText });
        return turn();
      },
      continue: async (results: AiToolResult[]) => {
        // All results of one assistant turn go back in a single user message.
        messages.push({
          role: 'user',
          content: results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.output, is_error: r.isError ?? false })),
        });
        return turn();
      },
    };
  }
}
