import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fakeCodex = join(root, 'test/fixtures/fake-codex.mjs');
const artifact = join(root, 'dist/agent.mjs');

describe('codex production entrypoint', () => {
  it('session/new uses stdio app-server instead of the injected-port stub', async () => {
    execFileSync('node', [join(root, 'scripts/build.mjs')], { cwd: root });
    const child = spawn(process.execPath, [artifact], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdin = child.stdin;
    const stdout = child.stdout;
    if (stdin === null || stdout === null) {
      child.kill();
      throw new Error('production artifact stdio was not piped');
    }
    const waiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const rl = createInterface({ input: stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      const parsed = JSON.parse(line) as {
        kind?: string; ok?: boolean; result?: unknown; error?: { message?: string }; requestId?: string;
      };
      if (parsed.kind !== 'response' || typeof parsed.requestId !== 'string') return;
      const waiter = waiters.get(parsed.requestId);
      if (waiter === undefined) return;
      waiters.delete(parsed.requestId);
      if (parsed.ok === true) waiter.resolve(parsed.result);
      else waiter.reject(new Error(parsed.error?.message ?? 'backend-error'));
    });
    const rpc = (requestId: string, frame: Record<string, unknown>): Promise<unknown> => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${requestId}`)), 5000);
        waiters.set(requestId, {
          resolve: (value) => { clearTimeout(timeout); resolve(value); },
          reject: (error) => { clearTimeout(timeout); reject(error); },
        });
        stdin.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', requestId, ...frame })}\n`);
      });
    };
    try {
      await rpc('init', {
        scope: { kind: 'plugin' },
        method: 'plugin/initialize',
        params: { runtime: { binaryPath: fakeCodex }, hostCapabilities: {} },
      });
      const opened = await rpc('new', {
        scope: { kind: 'session', sessionId: 'host-1', runtimeGenerationId: 'gen-1' },
        method: 'session/new',
        params: { cwd: '/tmp', binding: { agentId: 'codex' } },
      }) as { backendSessionId?: string };
      expect(opened.backendSessionId).toBe('thr_fake');
    } finally {
      rl.close();
      child.kill();
    }
  });
});
