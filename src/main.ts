import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createCallbackIo, CodexPlugin } from './plugin.js';
import { parseFrame } from './frames.js';
import { isUnusableCodexProbe } from './binary.js';
import { createAppServerStdio } from './app-server-stdio.js';
import type { Frame } from './types.js';

const waiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const write = (frame: Frame): void => { process.stdout.write(`${JSON.stringify(frame)}\n`); };
const io = createCallbackIo(write, waiters);
const plugin = new CodexPlugin({
  io,
  createAppServer: (binaryPath) => createAppServerStdio({ binaryPath }),
  probeBinary(binaryPath) {
    return new Promise((resolve) => {
      const child = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', (error) => {
        resolve({ ok: false });
        void error;
      });
      child.on('close', (code) => {
        if (code !== 0 || isUnusableCodexProbe({ stderr })) resolve({ ok: false });
        else {
          const match = /(\d+\.\d+\.\d+)/.exec(`${stdout}\n${stderr}`);
          resolve({ ok: true, version: match?.[1] ?? 'unknown' });
        }
      });
    });
  },
});
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const frame = parseFrame(line);
  if (frame === undefined) return;
  if (frame.kind === 'response') {
    const pending = waiters.get(frame.requestId);
    if (pending === undefined) return;
    waiters.delete(frame.requestId);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new Error(frame.error.message));
    return;
  }
  void plugin.handle(frame);
});
