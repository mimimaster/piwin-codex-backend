import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AppServerPort } from './types.js';

export const APP_SERVER_LAUNCH_ARGS = ['app-server', '--listen', 'stdio://'] as const;

const MAX_FRAME_BYTES = 1_000_000;
const MAX_BUFFER_BYTES = 2_000_000;
const MAX_PENDING = 64;
const MAX_STDERR_BYTES = 16_384;

export type AppServerStdio = AppServerPort & {
  dispose(): void;
  pid(): number | undefined;
};

export function createAppServerStdio(input: {
  binaryPath: string;
  spawnImpl?: typeof spawn;
  env?: NodeJS.ProcessEnv;
}): AppServerStdio {
  const spawnImpl = input.spawnImpl ?? spawn;
  const child: ChildProcessWithoutNullStreams = spawnImpl(input.binaryPath, [...APP_SERVER_LAUNCH_ARGS], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: input.env ?? process.env,
  }) as ChildProcessWithoutNullStreams;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let nextId = 1;
  let buffer = '';
  let stderr = '';
  let closed = false;
  const pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const notificationHandlers = new Set<(method: string, params: unknown) => void>();
  let requestHandler: ((id: string | number, method: string, params: unknown) => Promise<unknown>) | undefined;
  const exitHandlers = new Set<(reason: string) => void>();

  const failAll = (error: Error): void => {
    if (closed) return;
    closed = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    for (const handler of exitHandlers) handler(error.message);
  };

  const write = (message: unknown): void => {
    if (closed) throw new Error('codex app-server process is closed');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const handleMessage = (message: unknown): void => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      throw new Error('codex app-server sent a non-object frame');
    }
    const rec = message as Record<string, unknown>;
    const id = rec.id;
    const hasId = typeof id === 'string' || typeof id === 'number';
    if (typeof rec.method === 'string' && hasId) {
      const handler = requestHandler;
      if (handler === undefined) {
        write({ id, error: { code: -32601, message: `no handler for ${rec.method}` } });
        return;
      }
      void handler(id, rec.method, rec.params).then(
        (result) => { if (!closed) write({ id, result }); },
        (error: unknown) => {
          if (!closed) write({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
        },
      );
      return;
    }
    if (typeof rec.method === 'string' && !hasId) {
      for (const handler of notificationHandlers) handler(rec.method, rec.params);
      return;
    }
    if (hasId) {
      const waiter = pending.get(id);
      if (waiter === undefined) return;
      pending.delete(id);
      if (rec.error !== undefined) {
        const err = rec.error as { message?: unknown };
        waiter.reject(new Error(typeof err?.message === 'string' ? err.message : 'codex app-server error'));
        return;
      }
      waiter.resolve(rec.result);
    }
  };

  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER_BYTES) {
      failAll(new Error('codex app-server stdout exceeded buffer bound'));
      child.kill();
      return;
    }
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      if (line.length > MAX_FRAME_BYTES) {
        failAll(new Error('codex app-server frame exceeded size bound'));
        child.kill();
        return;
      }
      try {
        handleMessage(JSON.parse(line) as unknown);
      } catch (error) {
        failAll(error instanceof Error ? error : new Error('codex app-server malformed JSON'));
        child.kill();
        return;
      }
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
  });
  child.on('error', (error) => {
    failAll(error instanceof Error ? error : new Error('codex app-server spawn failed'));
  });
  child.on('close', (code) => {
    const suffix = stderr.trim().length > 0 ? `: ${stderr.trim()}` : '';
    failAll(new Error(`codex app-server exited (${code ?? 'null'})${suffix}`));
  });

  return {
    request(method, params) {
      if (closed) return Promise.reject(new Error('codex app-server process is closed'));
      if (pending.size >= MAX_PENDING) return Promise.reject(new Error('codex app-server pending map is full'));
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          write({ method, id, params });
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    notify(method, params) {
      write({ method, params });
    },
    onNotification(handler) {
      notificationHandlers.add(handler);
      return () => { notificationHandlers.delete(handler); };
    },
    onRequest(handler) {
      requestHandler = handler;
      return () => { if (requestHandler === handler) requestHandler = undefined; };
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return () => { exitHandlers.delete(handler); };
    },
    dispose() {
      failAll(new Error('codex app-server disposed'));
      child.kill();
    },
    pid() {
      return child.pid;
    },
  };
}
