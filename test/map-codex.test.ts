import { describe, expect, it } from 'vitest';
import { mapCodexNotification, nativeApprovalResult, type MapState } from '../src/map-codex.js';

describe('codex mapping', () => {
  it('maps deltas and preserves native approval decisions', () => {
    const state: MapState = { threadId: 'thr_1' };
    expect(mapCodexNotification(state, 'thread/started', { thread: { id: 'thr_1' } })).toEqual([
      { type: 'session/started', sessionId: 'thr_1' },
    ]);
    const first = mapCodexNotification(state, 'item/agentMessage/delta', { itemId: 'it_1', delta: 'hello' });
    expect(first[0]).toMatchObject({ type: 'message/start' });
    expect(nativeApprovalResult('allow_once')).toEqual({ decision: 'accept' });
    expect(nativeApprovalResult('reject_once')).toEqual({ decision: 'decline' });
  });

  it('splits OpenAI cached input tokens and deduplicates repeated cumulative totals', () => {
    let observedWindow = 0;
    const state: MapState = {
      threadId: 'thr_1',
      hostSessionId: 'host-1',
      runtimeGenerationId: 'gen-1',
      modelId: 'gpt-5.4',
      runId: 'run-1',
      now: () => '2026-11-12T04:00:00.000Z',
      onContextWindow: (win) => { observedWindow = win; },
    };
    const first = mapCodexNotification(state, 'thread/tokenUsage/updated', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      tokenUsage: {
        total: { inputTokens: 29375, cachedInputTokens: 13184, outputTokens: 239, reasoningOutputTokens: 29, totalTokens: 29614 },
        last: { inputTokens: 29375, cachedInputTokens: 13184, outputTokens: 239, reasoningOutputTokens: 29, totalTokens: 29614 },
        modelContextWindow: 475000,
      },
    });
    expect(observedWindow).toBe(475000);
    expect(first).toEqual([
      {
        type: 'usage/finalized',
        measurement: {
          measurementId: 'codex:thr_1:total-29614',
          sessionId: 'host-1',
          runId: 'run-1',
          runtimeGenerationId: 'gen-1',
          messageId: 'thr_1:total-29614',
          modelId: 'gpt-5.4',
          promptTokens: 16191,
          cacheReadTokens: 13184,
          cacheWriteTokens: 0,
          completionTokens: 239,
          reasoningTokens: 29,
          totalTokens: 29614,
          recordedAt: '2026-11-12T04:00:00.000Z',
        },
      },
    ]);

    const duplicate = mapCodexNotification(state, 'thread/tokenUsage/updated', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      tokenUsage: {
        total: { inputTokens: 29375, cachedInputTokens: 13184, outputTokens: 239, reasoningOutputTokens: 29, totalTokens: 29614 },
        last: { inputTokens: 29375, cachedInputTokens: 13184, outputTokens: 239, reasoningOutputTokens: 29, totalTokens: 29614 },
      },
    });
    expect(duplicate).toEqual([]);
  });
});
