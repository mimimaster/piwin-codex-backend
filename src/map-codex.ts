import { AGENT_ID, type AgentEvent, type UsageMeasurement } from './types.js';

export type CodexTokenBreakdown = {
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
};

export type MapState = {
  threadId: string;
  hostSessionId?: string;
  runtimeGenerationId?: string;
  modelId?: string;
  now?: () => string;
  runId?: string;
  messageId?: string;
  lastCompletedMessageId?: string;
  lastCumulativeTokens?: number;
  callSeq?: number;
  onContextWindow?: (windowTokens: number) => void;
};

/**
 * Parse a Codex/OpenAI token breakdown (camelCase app-server v2 or snake_case rollout).
 *
 * OpenAI `input_tokens` includes `cached_input_tokens`; split uncached prompt
 * tokens out so `promptTokens + cacheReadTokens + cacheWriteTokens + completionTokens === totalTokens`.
 */
export function parseCodexTokenBreakdown(raw: unknown): CodexTokenBreakdown | undefined {
  const obj = asRecord(raw);
  if (obj === undefined) return undefined;
  const rawInput = nonNegativeInt(obj.inputTokens ?? obj.input_tokens);
  const cacheReadTokens = nonNegativeInt(obj.cachedInputTokens ?? obj.cached_input_tokens);
  const cacheWriteTokens = nonNegativeInt(obj.cacheWriteInputTokens ?? obj.cache_write_input_tokens);
  const promptTokens = Math.max(0, rawInput - cacheReadTokens - cacheWriteTokens);
  const completionTokens = nonNegativeInt(obj.outputTokens ?? obj.output_tokens);
  const reasoning = nonNegativeIntOptional(obj.reasoningOutputTokens ?? obj.reasoning_output_tokens);
  const totalTokens = promptTokens + cacheReadTokens + cacheWriteTokens + completionTokens;
  if (totalTokens <= 0) return undefined;
  return {
    promptTokens,
    cacheReadTokens,
    cacheWriteTokens,
    completionTokens,
    ...(reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    totalTokens,
  };
}

export function mapCodexNotification(state: MapState, method: string, params: unknown): AgentEvent[] {
  const rec = asRecord(params) ?? {};
  const runId = state.runId;
  if (method === 'thread/started') {
    const thread = asRecord(rec.thread);
    if (typeof thread?.id === 'string' && thread.id.length > 0) state.threadId = thread.id;
    return [{ type: 'session/started', sessionId: state.threadId }];
  }
  if (method === 'item/agentMessage/delta' && typeof rec.delta === 'string') {
    if (state.messageId === undefined) {
      state.messageId = typeof rec.itemId === 'string' && rec.itemId.length > 0 ? rec.itemId : `codex-${state.threadId}`;
      return [
        { type: 'message/start', messageId: state.messageId, role: 'assistant', ...(runId === undefined ? {} : { runId }) },
        { type: 'message/text_delta', messageId: state.messageId, delta: rec.delta, ...(runId === undefined ? {} : { runId }) },
      ];
    }
    return [{ type: 'message/text_delta', messageId: state.messageId, delta: rec.delta, ...(runId === undefined ? {} : { runId }) }];
  }
  if (method === 'item/started') {
    const item = asRecord(rec.item);
    if (item?.type === 'commandExecution' && typeof item.id === 'string') {
      return [{ type: 'tool/start', toolCallId: item.id, toolName: 'commandExecution', ...(runId === undefined ? {} : { runId }) }];
    }
  }
  if (method === 'item/completed') {
    const item = asRecord(rec.item);
    if (item?.type === 'commandExecution' && typeof item.id === 'string') {
      return [{ type: 'tool/end', toolCallId: item.id, isError: false, ...(runId === undefined ? {} : { runId }) }];
    }
    if (state.messageId !== undefined) {
      const completedId = state.messageId;
      state.lastCompletedMessageId = completedId;
      delete state.messageId;
      return [{ type: 'message/end', messageId: completedId, ...(runId === undefined ? {} : { runId }) }];
    }
  }
  if (method === 'thread/tokenUsage/updated' || method === 'codex/event/token_count') {
    const measurement = mapTokenUsageNotification(state, method, rec);
    return measurement === undefined ? [] : [{ type: 'usage/finalized', measurement }];
  }
  if (method === 'turn/completed' && rec.status === 'interrupted') {
    return [{ type: 'session/aborted', sessionId: state.threadId, ...(runId === undefined ? {} : { runId }) }];
  }
  return [];
}

function mapTokenUsageNotification(
  state: MapState,
  method: 'thread/tokenUsage/updated' | 'codex/event/token_count',
  rec: Record<string, unknown>,
): UsageMeasurement | undefined {
  const container = method === 'thread/tokenUsage/updated'
    ? asRecord(rec.tokenUsage)
    : asRecord(asRecord(rec.msg)?.info) ?? asRecord(rec.info);
  if (container === undefined) return undefined;

  const contextWindow = nonNegativeIntOptional(container.modelContextWindow ?? container.model_context_window);
  if (contextWindow !== undefined && contextWindow > 0) {
    state.onContextWindow?.(contextWindow);
  }

  const totalObj = asRecord(container.total ?? container.total_token_usage);
  const cumulative = nonNegativeIntOptional(totalObj?.totalTokens ?? totalObj?.total_tokens);
  if (cumulative !== undefined) {
    if (cumulative <= (state.lastCumulativeTokens ?? 0)) return undefined;
    state.lastCumulativeTokens = cumulative;
  }

  const lastUsage = parseCodexTokenBreakdown(container.last ?? container.last_token_usage ?? container.total ?? container.total_token_usage);
  if (lastUsage === undefined) return undefined;

  const hostSessionId = nonEmptyString(state.hostSessionId) ?? nonEmptyString(state.threadId);
  if (hostSessionId === undefined) return undefined;

  state.callSeq = (state.callSeq ?? 0) + 1;
  const requestId = cumulative !== undefined
    ? `${state.threadId}:total-${cumulative}`
    : `${state.threadId}:call-${state.callSeq}`;
  const messageId = state.messageId ?? state.lastCompletedMessageId ?? requestId;
  const recordedAt = (state.now ?? (() => new Date().toISOString()))();

  return {
    measurementId: `${AGENT_ID}:${requestId}`,
    sessionId: hostSessionId,
    messageId,
    promptTokens: lastUsage.promptTokens,
    completionTokens: lastUsage.completionTokens,
    cacheReadTokens: lastUsage.cacheReadTokens,
    cacheWriteTokens: lastUsage.cacheWriteTokens,
    ...(lastUsage.reasoningTokens === undefined ? {} : { reasoningTokens: lastUsage.reasoningTokens }),
    totalTokens: lastUsage.totalTokens,
    recordedAt,
    ...(state.modelId === undefined ? {} : { modelId: state.modelId }),
    ...(state.runId === undefined || state.runId.length === 0 ? {} : { runId: state.runId }),
    ...(state.runtimeGenerationId === undefined || state.runtimeGenerationId.length === 0
      ? {}
      : { runtimeGenerationId: state.runtimeGenerationId }),
  };
}

export function nativeApprovalResult(optionId: string): { decision: 'accept' | 'decline' } {
  return { decision: optionId.startsWith('allow') ? 'accept' : 'decline' };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function nonNegativeIntOptional(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}
