import { describe, expect, it } from 'vitest';
import { readCodexSessionRequestUsage, reconstructCodexHistory } from '../src/codex-history.js';

const path = '/hist/sessions/2026/10/31/rollout-2026-10-31T00-00-00-thr_123.jsonl';
const jsonl = [
  JSON.stringify({ type: 'session_meta', payload: { session_id: 'thr_123' } }),
  JSON.stringify({
    timestamp: '2026-10-31T00:00:01.000Z',
    type: 'turn_context',
    payload: { turn_id: 'turn_1', model: 'gpt-5.4' },
  }),
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_user',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello from codex history' }],
    },
  }),
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_dev',
      role: 'developer',
      content: [{ type: 'input_text', text: 'system instructions' }],
    },
  }),
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_asst',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'prior codex reply' }],
    },
  }),
  JSON.stringify({
    timestamp: '2026-10-31T00:00:03.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 120, reasoning_output_tokens: 30, total_tokens: 1120 },
        last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 120, reasoning_output_tokens: 30, total_tokens: 1120 },
        model_context_window: 272000,
      },
    },
  }),
  JSON.stringify({
    timestamp: '2026-10-31T00:00:04.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 120, reasoning_output_tokens: 30, total_tokens: 1120 },
        last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 120, reasoning_output_tokens: 30, total_tokens: 1120 },
        model_context_window: 272000,
      },
    },
  }),
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_agents',
      role: 'user',
      content: [{ type: 'input_text', text: '# AGENTS.md' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions'] },
    },
  }),
].join('\n');

describe('codex native history reconstruction', () => {
  it('replays user and assistant messages and extracts model context metadata from a rollout jsonl', () => {
    const result = reconstructCodexHistory({
      historyRoot: '/hist',
      sessionId: 'thr_123',
      listFiles: () => [path],
      readFile: (candidate) => candidate === path ? jsonl : undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.modelId).toBe('gpt-5.4');
    expect(result.contextTokens).toBe(272000);
    const text = JSON.stringify(result.events);
    expect(text).toContain('hello from codex history');
    expect(text).toContain('prior codex reply');
    expect(text).not.toContain('system instructions');
    expect(text).not.toContain('AGENTS.md');
  });

  it('extracts deduplicated per-request token usage from rollout jsonl', () => {
    const usage = readCodexSessionRequestUsage({
      historyRoot: '/hist',
      sessionId: 'thr_123',
      listFiles: () => [path],
      readFile: (candidate) => candidate === path ? jsonl : undefined,
    });
    expect(usage).toEqual([
      {
        requestId: 'thr_123:total-1120',
        backendSessionId: 'thr_123',
        modelId: 'gpt-5.4',
        promptTokens: 400,
        cacheReadTokens: 600,
        cacheWriteTokens: 0,
        completionTokens: 120,
        reasoningTokens: 30,
        totalTokens: 1120,
        recordedAt: '2026-10-31T00:00:03.000Z',
      },
    ]);
  });

  it('fails closed when the rollout is missing', () => {
    expect(reconstructCodexHistory({
      historyRoot: '/hist',
      sessionId: 'thr_missing',
      listFiles: () => [],
      readFile: () => undefined,
    })).toEqual({ ok: false, reason: 'native history unavailable' });
  });
});
