import { resolveCodexBinary } from './binary.js';
import {
  codexCapabilities,
  codexOptions,
  DEFAULT_CODEX_CONTEXT_TOKENS,
  DEFAULT_CODEX_MODELS,
  DEFAULT_PERMISSION_OPTIONS,
} from './capabilities.js';
import { codexCliLaunch } from './cli-launch.js';
import { defaultCodexHistoryRoot, readCodexSessionRequestUsage, reconstructCodexHistory } from './codex-history.js';
import { errFrame, eventFrame, okFrame, requestFrame } from './frames.js';
import { mapCodexNotification, nativeApprovalResult, type MapState } from './map-codex.js';
import { AGENT_ID, type AppServerPort, type CodexModelOption, type Frame, type RequestUsageRecord, type Scope } from './types.js';

export type HostIO = {
  write(frame: Frame): void;
  callHost(scope: Scope, method: string, params: unknown): Promise<unknown>;
};

type Slot = {
  cwd: string;
  threadId: string;
  cancelled: boolean;
  replay: unknown[];
  models: CodexModelOption[];
  currentModelId?: string;
  lastCumulativeTokens?: number;
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
      historyRoot?: string;
      readHistoryFile?: (path: string) => string | undefined;
      listHistoryFiles?: (dir: string) => string[];
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
        this.deps.io.write(okFrame(frame, {
          agentId: AGENT_ID,
          protocolVersion: 1,
          requestUsage: true,
          nativeObservation: true,
        }));
        return;
      }
      case 'plugin/dispose':
        this.deps.io.write(okFrame(frame, null)); return;
      case 'check':
        await this.check(frame); return;
      case 'catalog/list':
        this.deps.io.write(okFrame(frame, [])); return;
      case 'catalog/usage':
        this.catalogUsage(frame); return;
      case 'catalog/native-observe':
        this.nativeObserve(frame); return;
      case 'catalog/rename':
      case 'catalog/delete':
        this.deps.io.write(errFrame(frame, 'unsupported', `${frame.method} is not implemented`)); return;
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
        if (frame.method === 'session/model' && slot !== undefined) {
          const modelId = rec(frame.params)?.modelId;
          if (typeof modelId !== 'string' || modelId.length === 0 || !slot.models.some((item) => item.id === modelId)) {
            this.deps.io.write(errFrame(frame, 'invalid-request', `unknown model ${String(modelId)}`));
            return;
          }
          slot.currentModelId = modelId;
        }
        this.deps.io.write(okFrame(frame, codexOptions(slot ?? defaultSlotModels()))); return;
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

  private catalogUsage(frame: Extract<Frame, { kind: 'request' }>): void {
    const historyRoot = this.deps.historyRoot ?? defaultCodexHistoryRoot(this.deps.env ?? process.env);
    if (historyRoot === undefined) {
      this.deps.io.write(okFrame(frame, []));
      return;
    }
    const params = rec(frame.params);
    const from = typeof params?.from === 'string' ? params.from : undefined;
    const rawSessions = Array.isArray(params?.sessions) ? params.sessions : [];
    const results: RequestUsageRecord[] = [];
    for (const item of rawSessions) {
      const entry = rec(item);
      const backendSessionId = typeof entry?.backendSessionId === 'string' ? entry.backendSessionId : '';
      const fallbackModelId = typeof entry?.modelId === 'string' ? entry.modelId : undefined;
      if (backendSessionId.length === 0) continue;
      results.push(...readCodexSessionRequestUsage({
        historyRoot,
        sessionId: backendSessionId,
        ...(from === undefined ? {} : { from }),
        ...(fallbackModelId === undefined ? {} : { fallbackModelId }),
        ...(this.deps.readHistoryFile === undefined ? {} : { readFile: this.deps.readHistoryFile }),
        ...(this.deps.listHistoryFiles === undefined ? {} : { listFiles: this.deps.listHistoryFiles }),
      }));
    }
    this.deps.io.write(okFrame(frame, results));
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
      agentId: AGENT_ID,
      state: 'ready',
      binaryPath: resolved.binaryPath,
      version: probe.version,
      supportStatus: 'verified',
      checkedAt,
      nativeCli: { supported: true },
      options: codexOptions(defaultSlotModels()),
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
    const bindingModelId = typeof binding?.modelId === 'string' && binding.modelId.length > 0 ? binding.modelId : undefined;
    await this.ensureAppServer();
    const existing = this.sessions.get(frame.scope.sessionId);
    if (frame.method !== 'session/new' && existing !== undefined && (storedId === undefined || storedId === existing.threadId)) {
      this.deps.io.write(okFrame(frame, {
        backendSessionId: existing.threadId, capabilities: codexCapabilities(), options: codexOptions(existing), replayEvents: existing.replay,
      }));
      return;
    }
    let threadId = storedId;
    let responseModelId: string | undefined;
    let historyModelId: string | undefined;
    let historyContextTokens: number | undefined;
    let preloadedReplay: unknown[] | undefined;

    if (frame.method === 'session/new') {
      const started = await this.port().request('thread/start', {
        cwd,
        ...(bindingModelId === undefined ? {} : { model: bindingModelId }),
      }) as { model?: string; thread?: { id?: string; model?: string } };
      threadId = started.thread?.id;
      responseModelId = nonEmptyString(started.model) ?? nonEmptyString(started.thread?.model);
    } else if (storedId === undefined || storedId.length === 0) {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'native session id required'));
      return;
    } else {
      if (frame.method === 'session/load') {
        const reconstructed = this.reconstructHistory(storedId);
        if (!reconstructed.ok) {
          this.deps.io.write(errFrame(frame, 'unavailable', reconstructed.reason));
          return;
        }
        preloadedReplay = reconstructed.events;
        historyModelId = reconstructed.modelId;
        historyContextTokens = reconstructed.contextTokens;
      }
      const resumed = await this.port().request('thread/resume', { threadId: storedId }) as {
        model?: string;
        thread?: { id?: string; model?: string };
      };
      threadId = resumed.thread?.id ?? storedId;
      responseModelId = nonEmptyString(resumed.model) ?? nonEmptyString(resumed.thread?.model);
    }
    if (typeof threadId !== 'string' || threadId.length === 0) {
      this.deps.io.write(errFrame(frame, 'backend-error', 'codex thread id missing')); return;
    }
    const baseModels = defaultSlotModels();
    const activeModelId = responseModelId ?? historyModelId ?? bindingModelId ?? baseModels.currentModelId;
    if (activeModelId !== undefined) {
      upsertModel(baseModels.models, activeModelId, historyContextTokens);
    }
    const slot: Slot = {
      cwd,
      threadId,
      cancelled: false,
      replay: preloadedReplay ? [...preloadedReplay] : [],
      models: baseModels.models,
      ...(activeModelId === undefined ? {} : { currentModelId: activeModelId }),
    };
    if (frame.method === 'session/load' && preloadedReplay === undefined) {
      const reconstructed = this.reconstructHistory(threadId);
      if (reconstructed.ok) slot.replay = reconstructed.events;
    }
    this.sessions.set(frame.scope.sessionId, slot);
    this.deps.io.write(okFrame(frame, {
      backendSessionId: threadId, capabilities: codexCapabilities(), options: codexOptions(slot),
      replayEvents: frame.method === 'session/new' ? [] : slot.replay,
    }));
  }

  private nativeObserve(frame: Extract<Frame, { kind: 'request' }>): void {
    const params = rec(frame.params);
    const backendSessionId = typeof params?.backendSessionId === 'string' ? params.backendSessionId : '';
    if (backendSessionId.length === 0) {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'native session id required')); return;
    }
    const live = [...this.sessions.values()].find((slot) => slot.threadId === backendSessionId);
    const reconstructed = this.reconstructHistory(backendSessionId);
    const activity = live !== undefined && live.cancelled === false && this.initializedAppServer ? (reconstructed.ok ? 'idle' : 'unknown') : reconstructed.ok ? 'idle' : 'unknown';
    this.deps.io.write(okFrame(frame, {
      backendSessionId,
      activity,
      ...(params?.includeHistory === true && reconstructed.ok ? { replayEvents: reconstructed.events } : {}),
    }));
  }

  private reconstructHistory(sessionId: string) {
    const historyRoot = this.deps.historyRoot ?? defaultCodexHistoryRoot(this.deps.env ?? process.env);
    if (historyRoot === undefined) return { ok: false as const, reason: 'native history unavailable' };
    return reconstructCodexHistory({
      historyRoot,
      sessionId,
      ...(this.deps.readHistoryFile === undefined ? {} : { readFile: this.deps.readHistoryFile }),
      ...(this.deps.listHistoryFiles === undefined ? {} : { listFiles: this.deps.listHistoryFiles }),
    });
  }

  private async prompt(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    if (frame.scope.kind !== 'session') {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'session scope required')); return;
    }
    const sessionScope = frame.scope;
    const slot = this.sessions.get(sessionScope.sessionId);
    if (slot === undefined) {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'no session')); return;
    }
    const params = rec(frame.params);
    const runId = typeof params?.runId === 'string' ? params.runId : '';
    const input = rec(params?.input);
    const text = typeof input?.text === 'string' ? input.text : '';
    slot.cancelled = false;
    const mapState: MapState = {
      threadId: slot.threadId,
      hostSessionId: sessionScope.sessionId,
      runtimeGenerationId: sessionScope.runtimeGenerationId,
      ...(slot.currentModelId === undefined ? {} : { modelId: slot.currentModelId }),
      ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
      ...(slot.lastCumulativeTokens === undefined ? {} : { lastCumulativeTokens: slot.lastCumulativeTokens }),
      runId,
      onContextWindow: (windowTokens) => {
        const activeId = slot.currentModelId ?? slot.models[0]?.id;
        if (activeId !== undefined && upsertModel(slot.models, activeId, windowTokens)) {
          this.deps.io.write(eventFrame(sessionScope, { type: 'options', options: codexOptions(slot) }));
        }
      },
    };
    let terminalStatus: string | undefined;
    let settle: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const stopNotes = this.port().onNotification((method, noteParams) => {
      for (const event of mapCodexNotification(mapState, method, noteParams)) {
        const emission = { type: 'agent', event };
        slot.replay.push(emission);
        this.deps.io.write(eventFrame(sessionScope, emission));
      }
      if (mapState.lastCumulativeTokens !== undefined) {
        slot.lastCumulativeTokens = mapState.lastCumulativeTokens;
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
        ...(slot.currentModelId === undefined ? {} : { model: slot.currentModelId }),
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

function defaultSlotModels(): { models: CodexModelOption[]; currentModelId?: string } {
  const models = DEFAULT_CODEX_MODELS.map((item) => ({ ...item }));
  const first = models[0]?.id;
  return {
    models,
    ...(first === undefined ? {} : { currentModelId: first }),
  };
}

function upsertModel(models: CodexModelOption[], modelId: string, contextTokens?: number): boolean {
  const existing = models.find((item) => item.id === modelId);
  if (existing !== undefined) {
    if (contextTokens !== undefined && contextTokens > 0 && existing.contextTokens !== contextTokens) {
      existing.contextTokens = contextTokens;
      return true;
    }
    return false;
  }
  models.unshift({
    id: modelId,
    label: modelId,
    contextTokens: contextTokens !== undefined && contextTokens > 0 ? contextTokens : DEFAULT_CODEX_CONTEXT_TOKENS,
  });
  return true;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
