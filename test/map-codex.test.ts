import { describe, expect, it } from 'vitest';
import { mapCodexNotification, nativeApprovalResult } from '../src/map-codex.js';

describe('codex mapping', () => {
  it('maps deltas and preserves native approval decisions', () => {
    const state = { threadId: 'thr_1' };
    expect(mapCodexNotification(state, 'thread/started', { thread: { id: 'thr_1' } })).toEqual([
      { type: 'session/started', sessionId: 'thr_1' },
    ]);
    const first = mapCodexNotification(state, 'item/agentMessage/delta', { itemId: 'it_1', delta: 'hello' });
    expect(first[0]).toMatchObject({ type: 'message/start' });
    expect(nativeApprovalResult('allow_once')).toEqual({ decision: 'accept' });
    expect(nativeApprovalResult('reject_once')).toEqual({ decision: 'decline' });
  });
});
