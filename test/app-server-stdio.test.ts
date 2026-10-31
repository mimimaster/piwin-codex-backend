import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_SERVER_LAUNCH_ARGS, createAppServerStdio } from '../src/app-server-stdio.js';

const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

describe('codex app-server stdio client', () => {
  it('pins stdio listen args instead of a --stdio flag', () => {
    expect(APP_SERVER_LAUNCH_ARGS).toEqual(['app-server', '--listen', 'stdio://']);
  });

  it('returns turn/start immediately and keeps notifications flowing until turn/completed', async () => {
    const client = createAppServerStdio({ binaryPath: fakeCodex, env: { ...process.env, FAKE_CODEX_TURN_DELAY_MS: '40' } });
    const events: string[] = [];
    const startedAt = Date.now();
    try {
      client.onNotification((method) => { events.push(method); });
      const initialized = await client.request('initialize', { clientInfo: { name: 'test' } });
      expect(initialized).toMatchObject({ protocol: 'v2' });
      const thread = await client.request('thread/start', { cwd: '/tmp' }) as { thread: { id: string } };
      expect(thread.thread.id).toBe('thr_fake');
      const turnStartedAt = Date.now();
      const turn = await client.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'hi' }] });
      const startElapsed = Date.now() - turnStartedAt;
      expect(turn).toMatchObject({ turn: { id: 'turn_1' } });
      expect(startElapsed).toBeLessThan(100);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('turn/completed not observed')), 1000);
        const stop = client.onNotification((method) => {
          if (method === 'turn/completed') {
            clearTimeout(timeout);
            stop();
            resolve();
          }
        });
        if (events.includes('turn/completed')) {
          clearTimeout(timeout);
          stop();
          resolve();
        }
      });
      expect(events).toContain('item/agentMessage/delta');
      expect(events).toContain('turn/completed');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
    } finally {
      client.dispose();
    }
  });
});
