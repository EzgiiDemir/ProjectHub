import type { AiProviderName } from '@projecthub/contracts';

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

/** JSON-schema function tool. Schemas must set additionalProperties:false and list every property as required. */
export interface AiToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface AiToolResult {
  id: string;
  output: string;
  isError?: boolean;
}

export interface AiTurn {
  text: string;
  toolCalls: AiToolCall[];
  /** The model ended its turn without asking for tools. */
  done: boolean;
  /** The provider declined the request (safety refusal). */
  refused: boolean;
  /** Output was cut at the token limit (tool inputs may be truncated — do not execute them). */
  truncated: boolean;
  usage: AiUsage;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A multi-step tool-using conversation; each adapter keeps the provider-native transcript internally. */
export interface AgentConversation {
  start(userText: string): Promise<AiTurn>;
  continue(results: AiToolResult[]): Promise<AiTurn>;
}

export interface AiProvider {
  readonly name: AiProviderName;
  readonly model: string;
  /** Single answer, streamed through onText when given. */
  complete(opts: { system: string; messages: ChatMessage[]; maxTokens?: number; onText?: (delta: string) => void; signal?: AbortSignal }): Promise<{ text: string; usage: AiUsage; refused: boolean }>;
  agent(opts: { system: string; tools: AiToolDef[]; maxTokens?: number; signal?: AbortSignal }): AgentConversation;
}
