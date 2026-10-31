import { describe, expect, it } from 'vitest';
import { CodexPlugin, createCallbackIo } from '../src/plugin.js';
import type { AppServerPort, Frame } from '../src/types.js';

const sessionScope = { kind: 'session' as const, sessionId: 'host-1', runtimeGenerationId: 'gen-1' };
function req(method: string, params: unknown, scope: object = { kind: 'plugin' }): Extract<Frame, { kind: 'request' }> {
  return { protocolVersion: 1, kind: 'request', requestId: `r-${method}`, scope: scope as never, method, params };
}

describe('codex plugin fixtures', () => {
  it('covers success, error, cancel, history, approvals with original json-rpc ids, and missing binary', async () => {
    const written: Frame[] = [];
    const waiters = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const io = createCallbackIo((frame) => written.push(frame), waiters);
    io.callHost = async (_scope, method) => {
      if (method === 'permission/request') return { optionId: 'allow_once' };
      if (method === 'input/request') return { answers: [{ questionId: 'q1', text: 'Ada' }] };
      return null;
    };

    const rpcIds: Array<string | number> = [];
    let notify: ((method: string, params: unknown) => void) | undefined;
    let onReq: ((id: string | number, method: string, params: unknown) => Promise<unknown>) | undefined;
    const calls: { method: string; params: unknown }[] = [];

    const appServer: AppServerPort = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'initialize') return { userAgent: 'codex-app-server', protocol: 'v2' };
        if (method === 'thread/start') return { thread: { id: 'thr_123' } };
        if (method === 'thread/resume') return { thread: { id: 'thr_123' } };
        if (method === 'turn/start') {
          const text = Array.isArray((params as { input?: { text?: string }[] }).input)
            ? (params as { input: { text?: string }[] }).input[0]?.text
            : '';
          if (text === 'boom') throw new Error('native-turn-failed');
          notify?.('thread/started', { thread: { id: 'thr_123' } });
          notify?.('item/agentMessage/delta', { itemId: 'it_1', delta: 'ok-text' });
          const originalId = 'rpc-approval-9';
          rpcIds.push(originalId);
          const result = await onReq?.(originalId, 'item/commandExecution/requestApproval', { command: 'ls' });
          expect(result).toEqual({ decision: 'accept' });
          const inputId = 'rpc-input-3';
          rpcIds.push(inputId);
          const answers = await onReq?.(inputId, 'tool/requestUserInput', {
            request: { title: 'Name', questions: [{ id: 'q1', prompt: 'Name', type: 'text' }] },
          });
          expect(answers).toEqual({ answers: [{ questionId: 'q1', text: 'Ada' }] });
          notify?.('item/completed', { item: { id: 'it_1', type: 'agentMessage' } });
          notify?.('turn/completed', { status: 'completed', turn: { id: 'turn_1' } });
          return { turn: { id: 'turn_1' } };
        }
        if (method === 'turn/interrupt') {
          notify?.('turn/completed', { status: 'interrupted' });
          return {};
        }
        throw new Error(`unexpected ${method}`);
      },
      notify(method) { calls.push({ method, params: {} }); },
      onNotification(handler) { notify = handler; return () => { notify = undefined; }; },
      onRequest(handler) { onReq = handler; return () => { onReq = undefined; }; },
    };

    const plugin = new CodexPlugin({
      io, appServer, pathExists: (path) => path === '/opt/codex', env: { PATH: '' }, now: () => '2026-10-03T08:00:00Z',
    });

    await plugin.handle(req('plugin/initialize', {
      agentId: 'codex', pluginRevision: 'rev', hostProtocolVersion: 1,
      runtime: { binaryPath: '/opt/codex' },
      hostCapabilities: { nativeCliLaunch: true, nativeUserInput: true },
    }));
    await plugin.handle(req('check', { refresh: true }));
    expect(written.at(-1)).toMatchObject({ result: { state: 'ready', binaryPath: '/opt/codex' } });

    await plugin.handle(req('session/new', { cwd: '/work', binding: { agentId: 'codex' } }, sessionScope));
    expect(written.at(-1)).toMatchObject({ result: { backendSessionId: 'thr_123' } });

    await plugin.handle(req('session/prompt', { runId: 'run-1', input: { text: 'hello' } }, sessionScope));
    expect(JSON.stringify(written)).toContain('ok-text');
    expect(rpcIds).toEqual(['rpc-approval-9', 'rpc-input-3']);

    await plugin.handle(req('session/prompt', { runId: 'run-err', input: { text: 'boom' } }, sessionScope));
    expect(written.at(-1)).toMatchObject({ ok: false, error: { code: 'backend-error', message: 'native-turn-failed' } });
    expect(calls.some((call) => call.method === 'initialize')).toBe(true);
    expect(calls.some((call) => call.method === 'initialized')).toBe(true);

    await plugin.handle(req('session/cancel', {}, sessionScope));
    expect(calls.some((call) => call.method === 'turn/interrupt')).toBe(true);

    await plugin.handle(req('session/cli-launch', { cwd: '/work', binding: { agentId: 'codex', backendSessionId: 'thr_123' } }, sessionScope));
    expect(written.at(-1)).toMatchObject({ result: { backendSessionId: 'thr_123', args: ['resume', 'thr_123'] } });

    await plugin.handle(req('session/load', { cwd: '/work', binding: { agentId: 'codex', backendSessionId: 'thr_123' } }, sessionScope));
    const loaded = written.at(-1) as Extract<Frame, { kind: 'response'; ok: true }>;
    expect(JSON.stringify((loaded.result as { replayEvents: unknown[] }).replayEvents)).toContain('ok-text');

    const missing = new CodexPlugin({
      io, appServer, pathExists: () => false, env: { PATH: '' }, now: () => '2026-10-03T08:00:00Z',
    });
    await missing.handle(req('plugin/initialize', { agentId: 'codex', pluginRevision: 'rev', hostProtocolVersion: 1, runtime: {} }));
    await missing.handle(req('check', { refresh: true }));
    expect(written.at(-1)).toMatchObject({ result: { state: 'not-installed' } });
  });
});
