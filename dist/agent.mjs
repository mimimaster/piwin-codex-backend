// src/main.ts
import { spawn as spawn2 } from "node:child_process";
import { createInterface } from "node:readline";

// src/binary.ts
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
function isMissingPlatformVendor(path, exists) {
  return /vendor\/aarch64-apple-darwin\/codex\/codex$/.test(path) && !exists(path);
}
function resolveCodexBinary(input) {
  const exists = input.pathExists ?? existsSync;
  const env = input.env ?? process.env;
  const searched = [];
  const candidates = [input.hostBinaryPath, env.CODEX_CLI, env.CODEX_BINARY];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    searched.push(candidate);
    if (!exists(candidate)) continue;
    if (isMissingPlatformVendor(candidate, exists)) {
      return { ok: false, searched, reason: "platform-binary-missing" };
    }
    return { ok: true, binaryPath: candidate };
  }
  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = `${dir.replace(/[/\\]$/, "")}/codex`;
    searched.push(candidate);
    if (exists(candidate)) return { ok: true, binaryPath: candidate };
  }
  return { ok: false, searched, reason: "not-installed" };
}
function isUnusableCodexProbe(input) {
  if (input.errorCode === "ENOENT") return true;
  const stderr = input.stderr ?? "";
  return /ENOENT|spawn .* ENOENT/i.test(stderr);
}

// src/types.ts
var PROTOCOL_VERSION = 1;
var AGENT_ID = "codex";

// src/capabilities.ts
var yes = { supported: true };
var no = (reason) => ({ supported: false, reason });
var DEFAULT_CODEX_CONTEXT_TOKENS = 272e3;
var DEFAULT_CODEX_MODELS = [
  { id: "gpt-5.4", label: "GPT-5.4", contextTokens: DEFAULT_CODEX_CONTEXT_TOKENS },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", contextTokens: DEFAULT_CODEX_CONTEXT_TOKENS }
];
function codexCapabilities() {
  return {
    agentId: AGENT_ID,
    nativeCli: yes,
    operations: {
      prompt: yes,
      cancel: yes,
      queue: no("Codex app-server does not expose Host queue"),
      intervene: yes,
      setModel: yes,
      setEffort: no("Codex effort apply is not acknowledged yet"),
      setMode: no("Codex mode apply is not acknowledged yet"),
      slashCommands: no("Codex slash commands are not a Host control yet"),
      fileReferences: no("File chips are not a Host Codex operation"),
      images: no("Image input is not implemented in this revision"),
      rename: no("Codex catalog rename is not implemented"),
      delete: no("Codex catalog delete is not implemented"),
      archive: no("Codex archive is native-owned"),
      pin: no("Codex pin is not a Host operation"),
      export: no("Export stays in native Codex history"),
      fork: no("Codex fork is native-owned"),
      rewind: no("Codex rewind is not a Host operation"),
      duplicate: no("Codex duplicate is not a Host operation"),
      pause: no("Codex has no Host pause"),
      compact: no("Compaction is native-owned"),
      conversationTree: no("No Host conversation tree"),
      coldStorage: no("No Host cold storage"),
      hostSubagents: no("Host subagents are Pi-only"),
      hostTools: no("Host tools are not injected into Codex")
    }
  };
}
function codexOptions(input) {
  return {
    agentId: AGENT_ID,
    models: (input.models ?? []).map((model) => ({
      id: model.id,
      label: model.label,
      ...typeof model.contextTokens === "number" && Number.isFinite(model.contextTokens) && model.contextTokens > 0 ? { contextTokens: model.contextTokens } : {}
    })),
    ...input.currentModelId === void 0 ? {} : { currentModelId: input.currentModelId },
    modes: [{ id: "default", label: "Default" }],
    currentModeId: "default",
    modeConfirmed: true,
    commands: input.commands ?? []
  };
}
var DEFAULT_PERMISSION_OPTIONS = [
  { optionId: "allow_once", label: "Allow once", kind: "allow_once" },
  { optionId: "reject_once", label: "Reject once", kind: "reject_once" }
];

// src/cli-launch.ts
function codexCliLaunch(backendSessionId) {
  if (backendSessionId.length === 0) throw new Error("native-thread-required");
  return { backendSessionId, args: ["resume", backendSessionId] };
}

// src/codex-history.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// src/map-codex.ts
function parseCodexTokenBreakdown(raw) {
  const obj = asRecord(raw);
  if (obj === void 0) return void 0;
  const rawInput = nonNegativeInt(obj.inputTokens ?? obj.input_tokens);
  const cacheReadTokens = nonNegativeInt(obj.cachedInputTokens ?? obj.cached_input_tokens);
  const cacheWriteTokens = nonNegativeInt(obj.cacheWriteInputTokens ?? obj.cache_write_input_tokens);
  const promptTokens = Math.max(0, rawInput - cacheReadTokens - cacheWriteTokens);
  const completionTokens = nonNegativeInt(obj.outputTokens ?? obj.output_tokens);
  const reasoning = nonNegativeIntOptional(obj.reasoningOutputTokens ?? obj.reasoning_output_tokens);
  const totalTokens = promptTokens + cacheReadTokens + cacheWriteTokens + completionTokens;
  if (totalTokens <= 0) return void 0;
  return {
    promptTokens,
    cacheReadTokens,
    cacheWriteTokens,
    completionTokens,
    ...reasoning !== void 0 && reasoning > 0 ? { reasoningTokens: reasoning } : {},
    totalTokens
  };
}
function mapCodexNotification(state, method, params) {
  const rec2 = asRecord(params) ?? {};
  const runId = state.runId;
  if (method === "thread/started") {
    const thread = asRecord(rec2.thread);
    if (typeof thread?.id === "string" && thread.id.length > 0) state.threadId = thread.id;
    return [{ type: "session/started", sessionId: state.threadId }];
  }
  if (method === "item/agentMessage/delta" && typeof rec2.delta === "string") {
    if (state.messageId === void 0) {
      state.messageId = typeof rec2.itemId === "string" && rec2.itemId.length > 0 ? rec2.itemId : `codex-${state.threadId}`;
      return [
        { type: "message/start", messageId: state.messageId, role: "assistant", ...runId === void 0 ? {} : { runId } },
        { type: "message/text_delta", messageId: state.messageId, delta: rec2.delta, ...runId === void 0 ? {} : { runId } }
      ];
    }
    return [{ type: "message/text_delta", messageId: state.messageId, delta: rec2.delta, ...runId === void 0 ? {} : { runId } }];
  }
  if (method === "item/started") {
    const item = asRecord(rec2.item);
    if (item?.type === "commandExecution" && typeof item.id === "string") {
      return [{ type: "tool/start", toolCallId: item.id, toolName: "commandExecution", ...runId === void 0 ? {} : { runId } }];
    }
  }
  if (method === "item/completed") {
    const item = asRecord(rec2.item);
    if (item?.type === "commandExecution" && typeof item.id === "string") {
      return [{ type: "tool/end", toolCallId: item.id, isError: false, ...runId === void 0 ? {} : { runId } }];
    }
    if (state.messageId !== void 0) {
      const completedId = state.messageId;
      state.lastCompletedMessageId = completedId;
      delete state.messageId;
      return [{ type: "message/end", messageId: completedId, ...runId === void 0 ? {} : { runId } }];
    }
  }
  if (method === "thread/tokenUsage/updated" || method === "codex/event/token_count") {
    const measurement = mapTokenUsageNotification(state, method, rec2);
    return measurement === void 0 ? [] : [{ type: "usage/finalized", measurement }];
  }
  if (method === "turn/completed" && rec2.status === "interrupted") {
    return [{ type: "session/aborted", sessionId: state.threadId, ...runId === void 0 ? {} : { runId } }];
  }
  return [];
}
function mapTokenUsageNotification(state, method, rec2) {
  const container = method === "thread/tokenUsage/updated" ? asRecord(rec2.tokenUsage) : asRecord(asRecord(rec2.msg)?.info) ?? asRecord(rec2.info);
  if (container === void 0) return void 0;
  const contextWindow = nonNegativeIntOptional(container.modelContextWindow ?? container.model_context_window);
  if (contextWindow !== void 0 && contextWindow > 0) {
    state.onContextWindow?.(contextWindow);
  }
  const totalObj = asRecord(container.total ?? container.total_token_usage);
  const cumulative = nonNegativeIntOptional(totalObj?.totalTokens ?? totalObj?.total_tokens);
  if (cumulative !== void 0) {
    if (cumulative <= (state.lastCumulativeTokens ?? 0)) return void 0;
    state.lastCumulativeTokens = cumulative;
  }
  const lastUsage = parseCodexTokenBreakdown(container.last ?? container.last_token_usage ?? container.total ?? container.total_token_usage);
  if (lastUsage === void 0) return void 0;
  const hostSessionId = nonEmptyString(state.hostSessionId) ?? nonEmptyString(state.threadId);
  if (hostSessionId === void 0) return void 0;
  state.callSeq = (state.callSeq ?? 0) + 1;
  const requestId = cumulative !== void 0 ? `${state.threadId}:total-${cumulative}` : `${state.threadId}:call-${state.callSeq}`;
  const messageId = state.messageId ?? state.lastCompletedMessageId ?? requestId;
  const recordedAt = (state.now ?? (() => (/* @__PURE__ */ new Date()).toISOString()))();
  return {
    measurementId: `${AGENT_ID}:${requestId}`,
    sessionId: hostSessionId,
    messageId,
    promptTokens: lastUsage.promptTokens,
    completionTokens: lastUsage.completionTokens,
    cacheReadTokens: lastUsage.cacheReadTokens,
    cacheWriteTokens: lastUsage.cacheWriteTokens,
    ...lastUsage.reasoningTokens === void 0 ? {} : { reasoningTokens: lastUsage.reasoningTokens },
    totalTokens: lastUsage.totalTokens,
    recordedAt,
    ...state.modelId === void 0 ? {} : { modelId: state.modelId },
    ...state.runId === void 0 || state.runId.length === 0 ? {} : { runId: state.runId },
    ...state.runtimeGenerationId === void 0 || state.runtimeGenerationId.length === 0 ? {} : { runtimeGenerationId: state.runtimeGenerationId }
  };
}
function nativeApprovalResult(optionId) {
  return { decision: optionId.startsWith("allow") ? "accept" : "decline" };
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function nonNegativeInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}
function nonNegativeIntOptional(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : void 0;
}

// src/codex-history.ts
var MAX_LINE_CHARS = 256 * 1024;
var MAX_EVENTS = 2e3;
var MAX_WALK_FILES = 4e3;
function defaultCodexHistoryRoot(env = process.env) {
  if (typeof env.CODEX_HOME === "string" && env.CODEX_HOME.length > 0) return env.CODEX_HOME;
  const home = env.HOME ?? env.USERPROFILE;
  if (typeof home !== "string" || home.length === 0) return void 0;
  return join(home, ".codex");
}
function findCodexRolloutPath(input) {
  if (input.sessionId.length === 0) return void 0;
  const suffix = `-${input.sessionId}.jsonl`;
  const root = join(input.historyRoot, "sessions");
  const files = input.listFiles === void 0 ? walkFiles(root, MAX_WALK_FILES) : input.listFiles(root);
  return files.find((path) => path.endsWith(suffix));
}
function reconstructCodexHistory(input) {
  if (input.sessionId.length === 0) return { ok: false, reason: "native session id required" };
  const path = findCodexRolloutPath(input);
  if (path === void 0) return { ok: false, reason: "native history unavailable" };
  const body = (input.readFile ?? readUtf8)(path);
  if (body === void 0) return { ok: false, reason: "native history unavailable" };
  const events = [];
  let modelId;
  let contextTokens;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.length > MAX_LINE_CHARS) continue;
    let record;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      record = parsed;
    } catch {
      continue;
    }
    if (record.type === "turn_context") {
      const turnModel = asRecord2(record.payload)?.model;
      if (typeof turnModel === "string" && turnModel.length > 0) modelId = turnModel;
    } else if (record.type === "event_msg") {
      const payload = asRecord2(record.payload);
      if (payload?.type === "token_count") {
        const win = asRecord2(payload.info)?.model_context_window;
        if (typeof win === "number" && Number.isFinite(win) && win > 0) contextTokens = Math.trunc(win);
      }
    }
    if (events.length < MAX_EVENTS) {
      events.push(...emissionsFromRecord(record));
    }
  }
  if (events.length === 0) return { ok: false, reason: "native history unavailable" };
  return {
    ok: true,
    events: events.slice(0, MAX_EVENTS),
    ...modelId === void 0 ? {} : { modelId },
    ...contextTokens === void 0 ? {} : { contextTokens }
  };
}
function readCodexSessionRequestUsage(input) {
  if (input.sessionId.length === 0) return [];
  const path = findCodexRolloutPath(input);
  if (path === void 0) return [];
  const body = (input.readFile ?? readUtf8)(path);
  if (body === void 0) return [];
  const fromMs = input.from !== void 0 ? Date.parse(input.from) : Number.NaN;
  const records = [];
  let currentModelId = typeof input.fallbackModelId === "string" && input.fallbackModelId.length > 0 ? input.fallbackModelId : void 0;
  let prevTotalTokens = 0;
  let fallbackSeq = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.length > MAX_LINE_CHARS) continue;
    let record;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      record = parsed;
    } catch {
      continue;
    }
    if (record.type === "turn_context") {
      const turnModel = asRecord2(record.payload)?.model;
      if (typeof turnModel === "string" && turnModel.length > 0) currentModelId = turnModel;
      continue;
    }
    if (record.type !== "event_msg") continue;
    const payload = asRecord2(record.payload);
    if (payload?.type !== "token_count") continue;
    const info = asRecord2(payload.info);
    if (info === void 0) continue;
    const totalObj = asRecord2(info.total_token_usage);
    const cumulative = typeof totalObj?.total_tokens === "number" && Number.isFinite(totalObj.total_tokens) && totalObj.total_tokens >= 0 ? Math.trunc(totalObj.total_tokens) : void 0;
    if (cumulative !== void 0) {
      if (cumulative <= prevTotalTokens) continue;
      prevTotalTokens = cumulative;
    }
    const lastUsage = parseCodexTokenBreakdown(info.last_token_usage ?? info.total_token_usage);
    if (lastUsage === void 0) continue;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : void 0;
    if (timestamp === void 0 || !Number.isFinite(Date.parse(timestamp))) continue;
    fallbackSeq += 1;
    const requestId = cumulative !== void 0 ? `${input.sessionId}:total-${cumulative}` : `${input.sessionId}:req-${fallbackSeq}`;
    records.push({
      requestId,
      backendSessionId: input.sessionId,
      promptTokens: lastUsage.promptTokens,
      completionTokens: lastUsage.completionTokens,
      cacheReadTokens: lastUsage.cacheReadTokens,
      cacheWriteTokens: lastUsage.cacheWriteTokens,
      ...lastUsage.reasoningTokens === void 0 ? {} : { reasoningTokens: lastUsage.reasoningTokens },
      totalTokens: lastUsage.totalTokens,
      recordedAt: new Date(timestamp).toISOString(),
      ...currentModelId === void 0 ? {} : { modelId: currentModelId }
    });
  }
  if (!Number.isFinite(fromMs)) return records;
  return records.filter((item) => Date.parse(item.recordedAt) >= fromMs);
}
function walkFiles(dir, remaining) {
  const found = [];
  const stack = [dir];
  while (stack.length > 0 && found.length < remaining) {
    const current = stack.pop();
    if (current === void 0) break;
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (found.length >= remaining) break;
      const path = join(current, name);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDir) stack.push(path);
      else found.push(path);
    }
  }
  return found;
}
function readUtf8(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return void 0;
  }
}
function emissionsFromRecord(record) {
  if (record.type !== "response_item") return [];
  const payload = asRecord2(record.payload);
  if (payload?.type !== "message") return [];
  const role = payload.role;
  if (role !== "user" && role !== "assistant") return [];
  const kinds = contentKinds(payload);
  if (kinds.includes("agents_md.instructions") || kinds.includes("environments.environment_context")) return [];
  const text = textFromContent(payload.content);
  if (text.length === 0) return [];
  const messageId = typeof payload.id === "string" && payload.id.length > 0 ? payload.id : `codex-${hashText(text)}`;
  return [
    { type: "agent", event: { type: "message/start", messageId, role } },
    { type: "agent", event: { type: "message/text_delta", messageId, delta: text } },
    { type: "agent", event: { type: "message/end", messageId } }
  ];
}
function textFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    const rec2 = asRecord2(block);
    if (rec2 === void 0) continue;
    if ((rec2.type === "input_text" || rec2.type === "output_text" || rec2.type === "text") && typeof rec2.text === "string") {
      parts.push(rec2.text);
    }
  }
  return parts.join("").trim();
}
function contentKinds(payload) {
  const meta = asRecord2(payload.internal_chat_message_metadata_passthrough);
  const kinds = meta?.content_item_kinds;
  return Array.isArray(kinds) ? kinds.filter((kind) => typeof kind === "string") : [];
}
function asRecord2(value) {
  return typeof value === "object" && value !== null && Array.isArray(value) === false ? value : void 0;
}
function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index) | 0;
  }
  return Math.abs(hash).toString(36);
}

// src/frames.ts
function parseFrame(line) {
  try {
    const value = JSON.parse(line);
    if (value.protocolVersion !== PROTOCOL_VERSION) return void 0;
    return value;
  } catch {
    return void 0;
  }
}
function requestFrame(scope, requestId, method, params) {
  return { protocolVersion: PROTOCOL_VERSION, kind: "request", scope, requestId, method, params };
}
function okFrame(request, result) {
  return { protocolVersion: PROTOCOL_VERSION, kind: "response", scope: request.scope, requestId: request.requestId, method: request.method, ok: true, result };
}
function errFrame(request, code, message) {
  return { protocolVersion: PROTOCOL_VERSION, kind: "response", scope: request.scope, requestId: request.requestId, method: request.method, ok: false, error: { code, message } };
}
function eventFrame(scope, emission) {
  return { protocolVersion: PROTOCOL_VERSION, kind: "event", scope, emission };
}

// src/plugin.ts
var CodexPlugin = class {
  constructor(deps) {
    this.deps = deps;
  }
  hostBinaryPath;
  hostCapabilities = {};
  sessions = /* @__PURE__ */ new Map();
  initializedAppServer = false;
  liveAppServer;
  async handle(frame) {
    if (frame.kind !== "request") return;
    try {
      await this.dispatch(frame);
    } catch (error) {
      this.deps.io.write(errFrame(frame, "backend-error", error instanceof Error ? error.message : String(error)));
    }
  }
  async dispatch(frame) {
    switch (frame.method) {
      case "plugin/initialize": {
        const params = rec(frame.params);
        const runtime = rec(params?.runtime);
        const caps = rec(params?.hostCapabilities);
        this.hostBinaryPath = typeof runtime?.binaryPath === "string" ? runtime.binaryPath : void 0;
        this.hostCapabilities = { nativeCliLaunch: caps?.nativeCliLaunch === true, nativeUserInput: caps?.nativeUserInput === true };
        this.deps.io.write(okFrame(frame, {
          agentId: AGENT_ID,
          protocolVersion: 1,
          requestUsage: true,
          nativeObservation: true
        }));
        return;
      }
      case "plugin/dispose":
        this.deps.io.write(okFrame(frame, null));
        return;
      case "check":
        await this.check(frame);
        return;
      case "catalog/list":
        this.deps.io.write(okFrame(frame, []));
        return;
      case "catalog/usage":
        this.catalogUsage(frame);
        return;
      case "catalog/native-observe":
        this.nativeObserve(frame);
        return;
      case "catalog/rename":
      case "catalog/delete":
        this.deps.io.write(errFrame(frame, "unsupported", `${frame.method} is not implemented`));
        return;
      case "session/new":
      case "session/load":
      case "session/resume":
        await this.open(frame);
        return;
      case "session/prompt":
        await this.prompt(frame);
        return;
      case "session/cancel":
        await this.cancel(frame);
        return;
      case "session/options":
      case "session/model":
      case "session/effort":
      case "session/mode": {
        const slot = frame.scope.kind === "session" ? this.sessions.get(frame.scope.sessionId) : void 0;
        if (frame.method === "session/model" && slot !== void 0) {
          const modelId = rec(frame.params)?.modelId;
          if (typeof modelId !== "string" || modelId.length === 0 || !slot.models.some((item) => item.id === modelId)) {
            this.deps.io.write(errFrame(frame, "invalid-request", `unknown model ${String(modelId)}`));
            return;
          }
          slot.currentModelId = modelId;
        }
        this.deps.io.write(okFrame(frame, codexOptions(slot ?? defaultSlotModels())));
        return;
      }
      case "session/commands":
        this.deps.io.write(okFrame(frame, []));
        return;
      case "session/cli-launch":
        this.cliLaunch(frame);
        return;
      case "session/release":
        if (frame.scope.kind === "session") this.sessions.delete(frame.scope.sessionId);
        this.deps.io.write(okFrame(frame, null));
        return;
      default:
        this.deps.io.write(errFrame(frame, "unsupported", frame.method));
    }
  }
  catalogUsage(frame) {
    const historyRoot = this.deps.historyRoot ?? defaultCodexHistoryRoot(this.deps.env ?? process.env);
    if (historyRoot === void 0) {
      this.deps.io.write(okFrame(frame, []));
      return;
    }
    const params = rec(frame.params);
    const from = typeof params?.from === "string" ? params.from : void 0;
    const rawSessions = Array.isArray(params?.sessions) ? params.sessions : [];
    const results = [];
    for (const item of rawSessions) {
      const entry = rec(item);
      const backendSessionId = typeof entry?.backendSessionId === "string" ? entry.backendSessionId : "";
      const fallbackModelId = typeof entry?.modelId === "string" ? entry.modelId : void 0;
      if (backendSessionId.length === 0) continue;
      results.push(...readCodexSessionRequestUsage({
        historyRoot,
        sessionId: backendSessionId,
        ...from === void 0 ? {} : { from },
        ...fallbackModelId === void 0 ? {} : { fallbackModelId },
        ...this.deps.readHistoryFile === void 0 ? {} : { readFile: this.deps.readHistoryFile },
        ...this.deps.listHistoryFiles === void 0 ? {} : { listFiles: this.deps.listHistoryFiles }
      }));
    }
    this.deps.io.write(okFrame(frame, results));
  }
  async check(frame) {
    const resolved = resolveCodexBinary({
      ...this.hostBinaryPath === void 0 ? {} : { hostBinaryPath: this.hostBinaryPath },
      ...this.deps.env === void 0 ? {} : { env: this.deps.env },
      ...this.deps.pathExists === void 0 ? {} : { pathExists: this.deps.pathExists }
    });
    const checkedAt = (this.deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString()))();
    if (!resolved.ok) {
      this.deps.io.write(okFrame(frame, { agentId: AGENT_ID, state: "not-installed", searched: resolved.searched, checkedAt }));
      return;
    }
    const probe = this.deps.probeBinary === void 0 ? { ok: true, version: "unknown" } : await this.deps.probeBinary(resolved.binaryPath);
    if (!probe.ok) {
      this.deps.io.write(okFrame(frame, { agentId: AGENT_ID, state: "not-installed", searched: [resolved.binaryPath], checkedAt }));
      return;
    }
    this.deps.io.write(okFrame(frame, {
      agentId: AGENT_ID,
      state: "ready",
      binaryPath: resolved.binaryPath,
      version: probe.version,
      supportStatus: "verified",
      checkedAt,
      nativeCli: { supported: true },
      options: codexOptions(defaultSlotModels())
    }));
  }
  port() {
    if (this.deps.appServer !== void 0) return this.deps.appServer;
    if (this.liveAppServer !== void 0) return this.liveAppServer;
    throw new Error("codex app-server is not attached in this process; tests inject a mock");
  }
  async ensureAppServer() {
    if (this.initializedAppServer) return;
    if (this.deps.appServer === void 0) {
      const resolved = resolveCodexBinary({
        ...this.hostBinaryPath === void 0 ? {} : { hostBinaryPath: this.hostBinaryPath },
        ...this.deps.env === void 0 ? {} : { env: this.deps.env },
        ...this.deps.pathExists === void 0 ? {} : { pathExists: this.deps.pathExists }
      });
      if (!resolved.ok) throw new Error("codex executable not found");
      if (this.deps.createAppServer === void 0) {
        throw new Error("codex app-server is not attached in this process; tests inject a mock");
      }
      this.liveAppServer = this.deps.createAppServer(resolved.binaryPath);
    }
    const port = this.port();
    await port.request("initialize", {
      clientInfo: { name: "piwin_codex_backend", title: "piwin Codex backend", version: "0.1.0" }
    });
    port.notify("initialized");
    this.initializedAppServer = true;
  }
  async open(frame) {
    if (frame.scope.kind !== "session") {
      this.deps.io.write(errFrame(frame, "invalid-request", "session scope required"));
      return;
    }
    const params = rec(frame.params);
    const cwd = typeof params?.cwd === "string" ? params.cwd : "";
    const binding = rec(params?.binding);
    const storedId = typeof binding?.backendSessionId === "string" ? binding.backendSessionId : void 0;
    const bindingModelId = typeof binding?.modelId === "string" && binding.modelId.length > 0 ? binding.modelId : void 0;
    await this.ensureAppServer();
    const existing = this.sessions.get(frame.scope.sessionId);
    if (frame.method !== "session/new" && existing !== void 0 && (storedId === void 0 || storedId === existing.threadId)) {
      this.deps.io.write(okFrame(frame, {
        backendSessionId: existing.threadId,
        capabilities: codexCapabilities(),
        options: codexOptions(existing),
        replayEvents: existing.replay
      }));
      return;
    }
    let threadId = storedId;
    let responseModelId;
    let historyModelId;
    let historyContextTokens;
    let preloadedReplay;
    if (frame.method === "session/new") {
      const started = await this.port().request("thread/start", {
        cwd,
        ...bindingModelId === void 0 ? {} : { model: bindingModelId }
      });
      threadId = started.thread?.id;
      responseModelId = nonEmptyString2(started.model) ?? nonEmptyString2(started.thread?.model);
    } else if (storedId === void 0 || storedId.length === 0) {
      this.deps.io.write(errFrame(frame, "invalid-request", "native session id required"));
      return;
    } else {
      if (frame.method === "session/load") {
        const reconstructed = this.reconstructHistory(storedId);
        if (!reconstructed.ok) {
          this.deps.io.write(errFrame(frame, "unavailable", reconstructed.reason));
          return;
        }
        preloadedReplay = reconstructed.events;
        historyModelId = reconstructed.modelId;
        historyContextTokens = reconstructed.contextTokens;
      }
      const resumed = await this.port().request("thread/resume", { threadId: storedId });
      threadId = resumed.thread?.id ?? storedId;
      responseModelId = nonEmptyString2(resumed.model) ?? nonEmptyString2(resumed.thread?.model);
    }
    if (typeof threadId !== "string" || threadId.length === 0) {
      this.deps.io.write(errFrame(frame, "backend-error", "codex thread id missing"));
      return;
    }
    const baseModels = defaultSlotModels();
    const activeModelId = responseModelId ?? historyModelId ?? bindingModelId ?? baseModels.currentModelId;
    if (activeModelId !== void 0) {
      upsertModel(baseModels.models, activeModelId, historyContextTokens);
    }
    const slot = {
      cwd,
      threadId,
      cancelled: false,
      replay: preloadedReplay ? [...preloadedReplay] : [],
      models: baseModels.models,
      ...activeModelId === void 0 ? {} : { currentModelId: activeModelId }
    };
    if (frame.method === "session/load" && preloadedReplay === void 0) {
      const reconstructed = this.reconstructHistory(threadId);
      if (reconstructed.ok) slot.replay = reconstructed.events;
    }
    this.sessions.set(frame.scope.sessionId, slot);
    this.deps.io.write(okFrame(frame, {
      backendSessionId: threadId,
      capabilities: codexCapabilities(),
      options: codexOptions(slot),
      replayEvents: frame.method === "session/new" ? [] : slot.replay
    }));
  }
  nativeObserve(frame) {
    const params = rec(frame.params);
    const backendSessionId = typeof params?.backendSessionId === "string" ? params.backendSessionId : "";
    if (backendSessionId.length === 0) {
      this.deps.io.write(errFrame(frame, "invalid-request", "native session id required"));
      return;
    }
    const live = [...this.sessions.values()].find((slot) => slot.threadId === backendSessionId);
    const reconstructed = this.reconstructHistory(backendSessionId);
    const activity = live !== void 0 && live.cancelled === false && this.initializedAppServer ? reconstructed.ok ? "idle" : "unknown" : reconstructed.ok ? "idle" : "unknown";
    this.deps.io.write(okFrame(frame, {
      backendSessionId,
      activity,
      ...params?.includeHistory === true && reconstructed.ok ? { replayEvents: reconstructed.events } : {}
    }));
  }
  reconstructHistory(sessionId) {
    const historyRoot = this.deps.historyRoot ?? defaultCodexHistoryRoot(this.deps.env ?? process.env);
    if (historyRoot === void 0) return { ok: false, reason: "native history unavailable" };
    return reconstructCodexHistory({
      historyRoot,
      sessionId,
      ...this.deps.readHistoryFile === void 0 ? {} : { readFile: this.deps.readHistoryFile },
      ...this.deps.listHistoryFiles === void 0 ? {} : { listFiles: this.deps.listHistoryFiles }
    });
  }
  async prompt(frame) {
    if (frame.scope.kind !== "session") {
      this.deps.io.write(errFrame(frame, "invalid-request", "session scope required"));
      return;
    }
    const sessionScope = frame.scope;
    const slot = this.sessions.get(sessionScope.sessionId);
    if (slot === void 0) {
      this.deps.io.write(errFrame(frame, "invalid-request", "no session"));
      return;
    }
    const params = rec(frame.params);
    const runId = typeof params?.runId === "string" ? params.runId : "";
    const input = rec(params?.input);
    const text = typeof input?.text === "string" ? input.text : "";
    slot.cancelled = false;
    const mapState = {
      threadId: slot.threadId,
      hostSessionId: sessionScope.sessionId,
      runtimeGenerationId: sessionScope.runtimeGenerationId,
      ...slot.currentModelId === void 0 ? {} : { modelId: slot.currentModelId },
      ...this.deps.now === void 0 ? {} : { now: this.deps.now },
      ...slot.lastCumulativeTokens === void 0 ? {} : { lastCumulativeTokens: slot.lastCumulativeTokens },
      runId,
      onContextWindow: (windowTokens) => {
        const activeId = slot.currentModelId ?? slot.models[0]?.id;
        if (activeId !== void 0 && upsertModel(slot.models, activeId, windowTokens)) {
          this.deps.io.write(eventFrame(sessionScope, { type: "options", options: codexOptions(slot) }));
        }
      }
    };
    let terminalStatus;
    let settle;
    const settled = new Promise((resolve) => {
      settle = resolve;
    });
    const stopNotes = this.port().onNotification((method, noteParams) => {
      for (const event of mapCodexNotification(mapState, method, noteParams)) {
        const emission = { type: "agent", event };
        slot.replay.push(emission);
        this.deps.io.write(eventFrame(sessionScope, emission));
      }
      if (mapState.lastCumulativeTokens !== void 0) {
        slot.lastCumulativeTokens = mapState.lastCumulativeTokens;
      }
      if (method === "turn/completed") {
        const status = rec(noteParams)?.status;
        terminalStatus = typeof status === "string" ? status : "completed";
        settle?.();
      }
    });
    const stopExit = this.port().onExit?.((reason) => {
      if (terminalStatus === void 0) terminalStatus = `exited:${reason}`;
      settle?.();
    });
    const stopReq = this.port().onRequest(async (id, method, reqParams) => {
      if (method === "item/commandExecution/requestApproval" || method === "commandExecution/requestApproval") {
        const decision = await this.deps.io.callHost(frame.scope, "permission/request", {
          action: "commandExecution",
          detail: jsonDetail(reqParams),
          context: { kind: "tool", toolName: "commandExecution" },
          options: DEFAULT_PERMISSION_OPTIONS,
          runId
        });
        return nativeApprovalResult(decision?.optionId ?? "reject_once");
      }
      if (method === "tool/requestUserInput" && this.hostCapabilities.nativeUserInput === true) {
        const request = rec(reqParams)?.request ?? reqParams;
        return this.deps.io.callHost(frame.scope, "input/request", { request, runId });
      }
      throw new Error(`unsupported app-server request ${method} (${String(id)})`);
    });
    try {
      await this.port().request("turn/start", {
        threadId: slot.threadId,
        input: [{ type: "text", text }],
        ...slot.currentModelId === void 0 ? {} : { model: slot.currentModelId }
      });
      if (terminalStatus === void 0) await settled;
      const interrupted = slot.cancelled || terminalStatus === "interrupted";
      this.deps.io.write(okFrame(frame, { status: interrupted ? "aborted" : "ok", stopReason: interrupted ? "aborted" : "stop" }));
    } finally {
      stopNotes();
      stopReq();
      stopExit?.();
    }
  }
  async cancel(frame) {
    if (frame.scope.kind === "session") {
      const slot = this.sessions.get(frame.scope.sessionId);
      if (slot !== void 0) {
        slot.cancelled = true;
        await this.port().request("turn/interrupt", { threadId: slot.threadId });
      }
    }
    this.deps.io.write(okFrame(frame, null));
  }
  cliLaunch(frame) {
    if (this.hostCapabilities.nativeCliLaunch !== true) {
      this.deps.io.write(errFrame(frame, "unsupported", "nativeCliLaunch was not negotiated"));
      return;
    }
    if (frame.scope.kind !== "session") {
      this.deps.io.write(errFrame(frame, "invalid-request", "session scope required"));
      return;
    }
    const slot = this.sessions.get(frame.scope.sessionId);
    if (slot === void 0) {
      this.deps.io.write(errFrame(frame, "invalid-request", "no session"));
      return;
    }
    this.deps.io.write(okFrame(frame, codexCliLaunch(slot.threadId)));
  }
};
function createCallbackIo(write2, waiters2) {
  let seq = 0;
  return {
    write: write2,
    callHost(scope, method, params) {
      const requestId = `cb-${seq += 1}`;
      return new Promise((resolve, reject) => {
        waiters2.set(requestId, { resolve, reject });
        write2(requestFrame(scope, requestId, method, params));
      });
    }
  };
}
function defaultSlotModels() {
  const models = DEFAULT_CODEX_MODELS.map((item) => ({ ...item }));
  const first = models[0]?.id;
  return {
    models,
    ...first === void 0 ? {} : { currentModelId: first }
  };
}
function upsertModel(models, modelId, contextTokens) {
  const existing = models.find((item) => item.id === modelId);
  if (existing !== void 0) {
    if (contextTokens !== void 0 && contextTokens > 0 && existing.contextTokens !== contextTokens) {
      existing.contextTokens = contextTokens;
      return true;
    }
    return false;
  }
  models.unshift({
    id: modelId,
    label: modelId,
    contextTokens: contextTokens !== void 0 && contextTokens > 0 ? contextTokens : DEFAULT_CODEX_CONTEXT_TOKENS
  });
  return true;
}
function nonEmptyString2(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function rec(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function jsonDetail(value) {
  try {
    const text = JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 500)}\u2026` : text;
  } catch {
    return "";
  }
}

// src/app-server-stdio.ts
import { spawn } from "node:child_process";
var APP_SERVER_LAUNCH_ARGS = ["app-server", "--listen", "stdio://"];
var MAX_FRAME_BYTES = 1e6;
var MAX_BUFFER_BYTES = 2e6;
var MAX_PENDING = 64;
var MAX_STDERR_BYTES = 16384;
function createAppServerStdio(input) {
  const spawnImpl = input.spawnImpl ?? spawn;
  const child = spawnImpl(input.binaryPath, [...APP_SERVER_LAUNCH_ARGS], {
    stdio: ["pipe", "pipe", "pipe"],
    env: input.env ?? process.env
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  let closed = false;
  const pending = /* @__PURE__ */ new Map();
  const notificationHandlers = /* @__PURE__ */ new Set();
  let requestHandler;
  const exitHandlers = /* @__PURE__ */ new Set();
  const failAll = (error) => {
    if (closed) return;
    closed = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    for (const handler of exitHandlers) handler(error.message);
  };
  const write2 = (message) => {
    if (closed) throw new Error("codex app-server process is closed");
    child.stdin.write(`${JSON.stringify(message)}
`);
  };
  const handleMessage = (message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      throw new Error("codex app-server sent a non-object frame");
    }
    const rec2 = message;
    const id = rec2.id;
    const hasId = typeof id === "string" || typeof id === "number";
    if (typeof rec2.method === "string" && hasId) {
      const handler = requestHandler;
      if (handler === void 0) {
        write2({ id, error: { code: -32601, message: `no handler for ${rec2.method}` } });
        return;
      }
      void handler(id, rec2.method, rec2.params).then(
        (result) => {
          if (!closed) write2({ id, result });
        },
        (error) => {
          if (!closed) write2({ id, error: { code: -32e3, message: error instanceof Error ? error.message : String(error) } });
        }
      );
      return;
    }
    if (typeof rec2.method === "string" && !hasId) {
      for (const handler of notificationHandlers) handler(rec2.method, rec2.params);
      return;
    }
    if (hasId) {
      const waiter = pending.get(id);
      if (waiter === void 0) return;
      pending.delete(id);
      if (rec2.error !== void 0) {
        const err = rec2.error;
        waiter.reject(new Error(typeof err?.message === "string" ? err.message : "codex app-server error"));
        return;
      }
      waiter.resolve(rec2.result);
    }
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER_BYTES) {
      failAll(new Error("codex app-server stdout exceeded buffer bound"));
      child.kill();
      return;
    }
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      if (line.length > MAX_FRAME_BYTES) {
        failAll(new Error("codex app-server frame exceeded size bound"));
        child.kill();
        return;
      }
      try {
        handleMessage(JSON.parse(line));
      } catch (error) {
        failAll(error instanceof Error ? error : new Error("codex app-server malformed JSON"));
        child.kill();
        return;
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
  });
  child.on("error", (error) => {
    failAll(error instanceof Error ? error : new Error("codex app-server spawn failed"));
  });
  child.on("close", (code) => {
    const suffix = stderr.trim().length > 0 ? `: ${stderr.trim()}` : "";
    failAll(new Error(`codex app-server exited (${code ?? "null"})${suffix}`));
  });
  return {
    request(method, params) {
      if (closed) return Promise.reject(new Error("codex app-server process is closed"));
      if (pending.size >= MAX_PENDING) return Promise.reject(new Error("codex app-server pending map is full"));
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          write2({ method, id, params });
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    notify(method, params) {
      write2({ method, params });
    },
    onNotification(handler) {
      notificationHandlers.add(handler);
      return () => {
        notificationHandlers.delete(handler);
      };
    },
    onRequest(handler) {
      requestHandler = handler;
      return () => {
        if (requestHandler === handler) requestHandler = void 0;
      };
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return () => {
        exitHandlers.delete(handler);
      };
    },
    dispose() {
      failAll(new Error("codex app-server disposed"));
      child.kill();
    },
    pid() {
      return child.pid;
    }
  };
}

// src/main.ts
var waiters = /* @__PURE__ */ new Map();
var write = (frame) => {
  process.stdout.write(`${JSON.stringify(frame)}
`);
};
var io = createCallbackIo(write, waiters);
var plugin = new CodexPlugin({
  io,
  createAppServer: (binaryPath) => createAppServerStdio({ binaryPath }),
  probeBinary(binaryPath) {
    return new Promise((resolve) => {
      const child = spawn2(binaryPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        resolve({ ok: false });
        void error;
      });
      child.on("close", (code) => {
        if (code !== 0 || isUnusableCodexProbe({ stderr })) resolve({ ok: false });
        else {
          const match = /(\d+\.\d+\.\d+)/.exec(`${stdout}
${stderr}`);
          resolve({ ok: true, version: match?.[1] ?? "unknown" });
        }
      });
    });
  }
});
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const frame = parseFrame(line);
  if (frame === void 0) return;
  if (frame.kind === "response") {
    const pending = waiters.get(frame.requestId);
    if (pending === void 0) return;
    waiters.delete(frame.requestId);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new Error(frame.error.message));
    return;
  }
  void plugin.handle(frame);
});
