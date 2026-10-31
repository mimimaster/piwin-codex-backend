#!/usr/bin/env node
/**
 * Fake user-owned Codex executable for process-level tests.
 * Answers JSON-RPC start immediately and emits the rest later.
 */
import { createInterface } from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write('codex-fake 0.0.0-test\n');
  process.exit(0);
}

const listenStdio = process.argv.includes('app-server') && process.argv.includes('stdio://');
if (!listenStdio) {
  process.stderr.write('fake-codex: expected app-server --listen stdio://\n');
  process.exit(2);
}

const delayMs = Number(process.env.FAKE_CODEX_TURN_DELAY_MS ?? '25');

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch {
    process.stderr.write('fake-codex: malformed json\n');
    return;
  }
  const id = message.id;
  const method = message.method;
  if (method === 'initialize') {
    write({ id, result: { userAgent: 'codex-fake', protocol: 'v2' } });
    return;
  }
  if (method === 'thread/start') {
    write({ id, result: { thread: { id: 'thr_fake' } } });
    return;
  }
  if (method === 'thread/resume') {
    const threadId = message.params?.threadId ?? 'thr_fake';
    write({ id, result: { thread: { id: threadId } } });
    return;
  }
  if (method === 'turn/start') {
    write({ id, result: { turn: { id: 'turn_1' } } });
    setTimeout(() => {
      write({ method: 'item/agentMessage/delta', params: { itemId: 'it_1', delta: 'delayed-ok' } });
      write({ method: 'item/completed', params: { item: { id: 'it_1', type: 'agentMessage' } } });
      write({ method: 'turn/completed', params: { status: 'completed', turn: { id: 'turn_1' } } });
    }, delayMs);
    return;
  }
  if (method === 'turn/interrupt') {
    write({ method: 'turn/completed', params: { status: 'interrupted', turn: { id: 'turn_1' } } });
    write({ id, result: {} });
    return;
  }
  write({ id, error: { code: -32601, message: `unknown ${method}` } });
});
