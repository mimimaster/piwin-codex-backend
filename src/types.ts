export const PROTOCOL_VERSION = 1 as const;
export const AGENT_ID = 'codex';

export type Scope = { kind: 'plugin' } | { kind: 'session'; sessionId: string; runtimeGenerationId: string };
export type Frame =
  | { protocolVersion: 1; kind: 'request'; requestId: string; scope: Scope; method: string; params: unknown }
  | { protocolVersion: 1; kind: 'response'; requestId: string; scope: Scope; method: string; ok: true; result: unknown }
  | { protocolVersion: 1; kind: 'response'; requestId: string; scope: Scope; method: string; ok: false; error: { code: string; message: string } }
  | { protocolVersion: 1; kind: 'event'; scope: { kind: 'session'; sessionId: string; runtimeGenerationId: string }; emission: unknown };

export type CodexModelOption = {
  id: string;
  label: string;
  contextTokens?: number;
};

export type UsageMeasurement = {
  measurementId: string;
  sessionId: string;
  runId?: string;
  runtimeGenerationId?: string;
  messageId: string;
  modelId?: string;
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  costUsd?: number;
  recordedAt: string;
};

export type RequestUsageRecord = {
  requestId: string;
  backendSessionId: string;
  modelId?: string;
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  costUsd?: number;
  recordedAt: string;
};

export type AgentEvent =
  | { type: 'session/started'; sessionId: string }
  | { type: 'message/start'; messageId: string; role: 'user' | 'assistant'; backendMessageId?: string; runId?: string }
  | { type: 'message/text_delta'; messageId: string; delta: string; runId?: string }
  | { type: 'message/end'; messageId: string; runId?: string }
  | { type: 'tool/start'; toolCallId: string; toolName: string; runId?: string }
  | { type: 'tool/end'; toolCallId: string; isError: boolean; runId?: string }
  | { type: 'usage/finalized'; measurement: UsageMeasurement }
  | { type: 'session/aborted'; sessionId: string; runId?: string };

export type JsonRpc = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };

export type AppServerPort = {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  onRequest(handler: (id: string | number, method: string, params: unknown) => Promise<unknown>): () => void;
  interruptTurn?(threadId: string, turnId: string): Promise<void>;
  onExit?(handler: (reason: string) => void): () => void;
};
