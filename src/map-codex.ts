import type { AgentEvent } from './types.js';

export type MapState = { threadId: string; runId?: string; messageId?: string };

export function mapCodexNotification(state: MapState, method: string, params: unknown): AgentEvent[] {
  const rec = typeof params === 'object' && params !== null ? params as Record<string, unknown> : {};
  const runId = state.runId;
  if (method === 'thread/started') {
    const thread = rec.thread as { id?: string } | undefined;
    if (typeof thread?.id === 'string') state.threadId = thread.id;
    return [{ type: 'session/started', sessionId: state.threadId }];
  }
  if (method === 'item/agentMessage/delta' && typeof rec.delta === 'string') {
    if (state.messageId === undefined) {
      state.messageId = typeof rec.itemId === 'string' ? rec.itemId : `codex-${state.threadId}`;
      return [
        { type: 'message/start', messageId: state.messageId, role: 'assistant', ...(runId === undefined ? {} : { runId }) },
        { type: 'message/text_delta', messageId: state.messageId, delta: rec.delta, ...(runId === undefined ? {} : { runId }) },
      ];
    }
    return [{ type: 'message/text_delta', messageId: state.messageId, delta: rec.delta, ...(runId === undefined ? {} : { runId }) }];
  }
  if (method === 'item/started') {
    const item = rec.item as { id?: string; type?: string } | undefined;
    if (item?.type === 'commandExecution' && typeof item.id === 'string') {
      return [{ type: 'tool/start', toolCallId: item.id, toolName: 'commandExecution', ...(runId === undefined ? {} : { runId }) }];
    }
  }
  if (method === 'item/completed') {
    const item = rec.item as { id?: string; type?: string } | undefined;
    if (item?.type === 'commandExecution' && typeof item.id === 'string') {
      return [{ type: 'tool/end', toolCallId: item.id, isError: false, ...(runId === undefined ? {} : { runId }) }];
    }
    if (state.messageId !== undefined) {
      const events: AgentEvent[] = [{ type: 'message/end', messageId: state.messageId, ...(runId === undefined ? {} : { runId }) }];
      delete state.messageId;
      return events;
    }
  }
  if (method === 'turn/completed' && rec.status === 'interrupted') {
    return [{ type: 'session/aborted', sessionId: state.threadId, ...(runId === undefined ? {} : { runId }) }];
  }
  return [];
}

export function nativeApprovalResult(optionId: string): { decision: 'accept' | 'decline' } {
  return { decision: optionId.startsWith('allow') ? 'accept' : 'decline' };
}
