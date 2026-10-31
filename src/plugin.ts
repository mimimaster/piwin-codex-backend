import { isUnusableCodexProbe, resolveCodexBinary } from './binary.js';
import { codexCapabilities, codexOptions, DEFAULT_PERMISSION_OPTIONS } from './capabilities.js';
import { codexCliLaunch } from './cli-launch.js';
import { errFrame, eventFrame, okFrame, requestFrame } from './frames.js';
import { mapCodexNotification, nativeApprovalResult, type MapState } from './map-codex.js';
import { AGENT_ID, type AppServerPort, type Frame, type Scope } from './types.js';

export type HostIO = {
  write(frame: Frame): void;
  callHost(scope: Scope, method: string, params: unknown): Promise<unknown>;
};

type Slot = {
  cwd: string;
  threadId: string;
  cancelled: boolean;
  replay: unknown[];
  models: { id: string; label: string }[];
};

export class CodexPlugin {
  constructor(
    private readonly deps: {
      io: HostIO;
      appServer?: AppServerPort;
      createAppServer?: (binaryPath: string) => AppServerPort;
      pathExists?: (path: string) => boolean;
      env?: NodeJS.ProcessEnv;
      now?: () => string;
      probeBinary?: (binaryPath: string) => Promise<{ ok: true; version: string } | { ok: false }>;
    },
  ) {}

  private hostBinaryPath: string | undefined;
  private hostCapabilities: { nativeCliLaunch?: boolean; nativeUserInput?: boolean } = {};
  private readonly sessions = new Map<string, Slot>();
  private initializedAppServer = false;
  private liveAppServer: AppServerPort | undefined;

  async handle(frame: Frame): Promise<void> {
    if (frame.kind !== 'request') return;
    try { await this.dispatch(frame); }
    catch (error) {
      this.deps.io.write(errFrame(frame, 'backend-error', error instanceof Error ? error.message : String(error)));
    }
  }

  private async dispatch(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    switch (frame.method) {
      case 'plugin/initialize': {
        const params = rec(frame.params);
        const runtime = rec(params?.runtime);
        const caps = rec(params?.hostCapabilities);
        this.hostBinaryPath = typeof runtime?.binaryPath === 'string' ? runtime.binaryPath : undefined;
        this.hostCapabilities = { nativeCliLaunch: caps?.nativeCliLaunch === true, nativeUserInput: caps?.nativeUserInput === true };
        this.deps.io.write(okFrame(frame, { agentId: AGENT_ID, protocolVersion: 1 }));
        return;
      }
      case 'plugin/dispose':
        this.deps.io.write(okFrame(frame, null)); return;
      case 'check':
        await this.check(frame); return;
      case 'catalog/list':
        this.deps.io.write(okFrame(frame, [])); return;
      case 'catalog/usage':
        this.deps.io.write(okFrame(frame, [])); return;
      case 'catalog/rename':
      case 'catalog/delete':
        this.deps.io.write(okFrame(frame, null)); return;
      case 'session/new':
      case 'session/load':
      case 'session/resume':
        await this.open(frame); return;
      case 'session/prompt':
        await this.prompt(frame); return;
      case 'session/cancel':
        await this.cancel(frame); return;
      case 'session/options':
      case 'session/model':
      case 'session/effort':
      case 'session/mode': {
        const slot = frame.scope.kind === 'session' ? this.sessions.get(frame.scope.sessionId) : undefined;
        this.deps.io.write(okFrame(frame, codexOptions(slot ?? {}))); return;
      }
      case 'session/commands':
        this.deps.io.write(okFrame(frame, [])); return;
      case 'session/cli-launch':
        this.cliLaunch(frame); return;
      case 'session/release':
        if (frame.scope.kind === 'session') this.sessions.delete(frame.scope.sessionId);
        this.deps.io.write(okFrame(frame, null)); return;
      default:
        this.deps.io.write(errFrame(frame, 'unsupported', frame.method));
    }
  }

  private async check(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    const resolved = resolveCodexBinary({
      ...(this.hostBinaryPath === undefined ? {} : { hostBinaryPath: this.hostBinaryPath }),
      ...(this.deps.env === undefined ? {} : { env: this.deps.env }),
      ...(this.deps.pathExists === undefined ? {} : { pathExists: this.deps.pathExists }),
    });
    const checkedAt = (this.deps.now ?? (() => new Date().toISOString()))();
    if (!resolved.ok) {
      this.deps.io.write(okFrame(frame, { agentId: AGENT_ID, state: 'not-installed', searched: resolved.searched, checkedAt }));
      return;
    }
    const probe = this.deps.probeBinary === undefined ? { ok: true as const, version: 'unknown' } : await this.deps.probeBinary(resolved.binaryPath);
    if (!probe.ok) {
      this.deps.io.write(okFrame(frame, { agentId: AGENT_ID, state: 'not-installed', searched: [resolved.binaryPath], checkedAt }));
      return;
    }
    this.deps.io.write(okFrame(frame, {
      agentId: AGENT_ID, state: 'ready', binaryPath: resolved.binaryPath, version: probe.version,
      supportStatus: 'verified', checkedAt, nativeCli: { supported: true },
    }));
  }

  private port(): AppServerPort {
    if (this.deps.appServer !== undefined) return this.deps.appServer;
    if (this.liveAppServer !== undefined) return this.liveAppServer;
    throw new Error('codex app-server is not attached in this process; tests inject a mock');
  }

  private async ensureAppServer(): Promise<void> {
    if (this.initializedAppServer) return;
    if (this.deps.appServer === undefined) {
      const resolved = resolveCodexBinary({
        ...(this.hostBinaryPath === undefined ? {} : { hostBinaryPath: this.hostBinaryPath }),
        ...(this.deps.env === undefined ? {} : { env: this.deps.env }),
        ...(this.deps.pathExists === undefined ? {} : { pathExists: this.deps.pathExists }),
      });
      if (!resolved.ok) throw new Error('codex executable not found');
      if (this.deps.createAppServer === undefined) {
        throw new Error('codex app-server is not attached in this process; tests inject a mock');
      }
      this.liveAppServer = this.deps.createAppServer(resolved.binaryPath);
    }
    const port = this.port();
    await port.request('initialize', {
      clientInfo: { name: 'piwin_codex_backend', title: 'piwin Codex backend', version: '0.1.0' },
    });
    port.notify('initialized');
    this.initializedAppServer = true;
  }

  private async open(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    if (frame.scope.kind !== 'session') {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'session scope required')); return;
    }
    const params = rec(frame.params);
    const cwd = typeof params?.cwd === 'string' ? params.cwd : '';
    const binding = rec(params?.binding);
    const storedId = typeof binding?.backendSessionId === 'string' ? binding.backendSessionId : undefined;
    await this.ensureAppServer();
    const existing = this.sessions.get(frame.scope.sessionId);
    if (frame.method !== 'session/new' && existing !== undefined && (storedId === undefined || storedId === existing.threadId)) {
      this.deps.io.write(okFrame(frame, {
        backendSessionId: existing.threadId, capabilities: codexCapabilities(), options: codexOptions(existing), replayEvents: existing.replay,
      }));
      return;
    }
    let threadId = storedId;
    if (frame.method === 'session/new' || storedId === undefined) {
      const started = await this.port().request('thread/start', { cwd }) as { thread?: { id?: string } };
      threadId = started.thread?.id;
    } else {
      const resumed = await this.port().request('thread/resume', { threadId: storedId }) as { thread?: { id?: string } };
      threadId = resumed.thread?.id ?? storedId;
    }
    if (typeof threadId !== 'string' || threadId.length === 0) {
      this.deps.io.write(errFrame(frame, 'backend-error', 'codex thread id missing')); return;
    }
    const slot: Slot = { cwd, threadId, cancelled: false, replay: [], models: [] };
    this.sessions.set(frame.scope.sessionId, slot);
    this.deps.io.write(okFrame(frame, {
      backendSessionId: threadId, capabilities: codexCapabilities(), options: codexOptions(slot),
      replayEvents: frame.method === 'session/new' ? [] : slot.replay,
    }));
  }

  private async prompt(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    if (frame.scope.kind !== 'session') {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'session scope required')); return;
    }
    const slot = this.sessions.get(frame.scope.sessionId);
    if (slot === undefined) {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'no session')); return;
    }
    const params = rec(frame.params);
    const runId = typeof params?.runId === 'string' ? params.runId : '';
    const input = rec(params?.input);
    const text = typeof input?.text === 'string' ? input.text : '';
    slot.cancelled = false;
    const mapState: MapState = { threadId: slot.threadId, runId };
    let terminalStatus: string | undefined;
    let settle: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const stopNotes = this.port().onNotification((method, noteParams) => {
      for (const event of mapCodexNotification(mapState, method, noteParams)) {
        const emission = { type: 'agent', event };
        slot.replay.push(emission);
        this.deps.io.write(eventFrame(frame.scope as Extract<Scope, { kind: 'session' }>, emission));
      }
      if (method === 'turn/completed') {
        const status = rec(noteParams)?.status;
        terminalStatus = typeof status === 'string' ? status : 'completed';
        settle?.();
      }
    });
    const stopExit = this.port().onExit?.((reason) => {
      if (terminalStatus === undefined) terminalStatus = `exited:${reason}`;
      settle?.();
    });
    const stopReq = this.port().onRequest(async (id, method, reqParams) => {
      if (method === 'item/commandExecution/requestApproval' || method === 'commandExecution/requestApproval') {
        const decision = await this.deps.io.callHost(frame.scope, 'permission/request', {
          action: 'commandExecution',
          detail: jsonDetail(reqParams),
          context: { kind: 'tool', toolName: 'commandExecution' },
          options: DEFAULT_PERMISSION_OPTIONS,
          runId,
        }) as { optionId?: string } | undefined;
        return nativeApprovalResult(decision?.optionId ?? 'reject_once');
      }
      if (method === 'tool/requestUserInput' && this.hostCapabilities.nativeUserInput === true) {
        const request = rec(reqParams)?.request ?? reqParams;
        return this.deps.io.callHost(frame.scope, 'input/request', { request, runId });
      }
      throw new Error(`unsupported app-server request ${method} (${String(id)})`);
    });
    try {
      await this.port().request('turn/start', {
        threadId: slot.threadId,
        input: [{ type: 'text', text }],
      });
      if (terminalStatus === undefined) await settled;
      const interrupted = slot.cancelled || terminalStatus === 'interrupted';
      this.deps.io.write(okFrame(frame, { status: interrupted ? 'aborted' : 'ok', stopReason: interrupted ? 'aborted' : 'stop' }));
    } finally {
      stopNotes();
      stopReq();
      stopExit?.();
    }
  }

  private async cancel(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    if (frame.scope.kind === 'session') {
      const slot = this.sessions.get(frame.scope.sessionId);
      if (slot !== undefined) {
        slot.cancelled = true;
        await this.port().request('turn/interrupt', { threadId: slot.threadId });
      }
    }
    this.deps.io.write(okFrame(frame, null));
  }

  private cliLaunch(frame: Extract<Frame, { kind: 'request' }>): void {
    if (this.hostCapabilities.nativeCliLaunch !== true) {
      this.deps.io.write(errFrame(frame, 'unsupported', 'nativeCliLaunch was not negotiated')); return;
    }
    if (frame.scope.kind !== 'session') {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'session scope required')); return;
    }
    const slot = this.sessions.get(frame.scope.sessionId);
    if (slot === undefined) {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'no session')); return;
    }
    this.deps.io.write(okFrame(frame, codexCliLaunch(slot.threadId)));
  }
}

export function createCallbackIo(write: (frame: Frame) => void, waiters: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>): HostIO {
  let seq = 0;
  return {
    write,
    callHost(scope, method, params) {
      const requestId = `cb-${(seq += 1)}`;
      return new Promise((resolve, reject) => {
        waiters.set(requestId, { resolve, reject });
        write(requestFrame(scope, requestId, method, params));
      });
    },
  };
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function jsonDetail(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch { return ''; }
}
