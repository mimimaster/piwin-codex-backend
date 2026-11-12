import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseCodexTokenBreakdown } from './map-codex.js';
import type { AgentEvent, RequestUsageRecord } from './types.js';

export type HistoryEmission = { type: 'agent'; event: AgentEvent };

export type CodexHistoryResult =
  | { ok: true; events: HistoryEmission[]; modelId?: string; contextTokens?: number }
  | { ok: false; reason: string };

const MAX_LINE_CHARS = 256 * 1024;
const MAX_EVENTS = 2_000;
const MAX_WALK_FILES = 4_000;

export function defaultCodexHistoryRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.length > 0) return env.CODEX_HOME;
  const home = env.HOME ?? env.USERPROFILE;
  if (typeof home !== 'string' || home.length === 0) return undefined;
  return join(home, '.codex');
}

export function findCodexRolloutPath(input: {
  historyRoot: string;
  sessionId: string;
  listFiles?: (dir: string) => string[];
}): string | undefined {
  if (input.sessionId.length === 0) return undefined;
  const suffix = `-${input.sessionId}.jsonl`;
  const root = join(input.historyRoot, 'sessions');
  const files = input.listFiles === undefined ? walkFiles(root, MAX_WALK_FILES) : input.listFiles(root);
  return files.find((path) => path.endsWith(suffix));
}

export function reconstructCodexHistory(input: {
  historyRoot: string;
  sessionId: string;
  readFile?: (path: string) => string | undefined;
  listFiles?: (dir: string) => string[];
}): CodexHistoryResult {
  if (input.sessionId.length === 0) return { ok: false, reason: 'native session id required' };
  const path = findCodexRolloutPath(input);
  if (path === undefined) return { ok: false, reason: 'native history unavailable' };
  const body = (input.readFile ?? readUtf8)(path);
  if (body === undefined) return { ok: false, reason: 'native history unavailable' };
  const events: HistoryEmission[] = [];
  let modelId: string | undefined;
  let contextTokens: number | undefined;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.length > MAX_LINE_CHARS) continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type === 'turn_context') {
      const turnModel = asRecord(record.payload)?.model;
      if (typeof turnModel === 'string' && turnModel.length > 0) modelId = turnModel;
    } else if (record.type === 'event_msg') {
      const payload = asRecord(record.payload);
      if (payload?.type === 'token_count') {
        const win = asRecord(payload.info)?.model_context_window;
        if (typeof win === 'number' && Number.isFinite(win) && win > 0) contextTokens = Math.trunc(win);
      }
    }
    if (events.length < MAX_EVENTS) {
      events.push(...emissionsFromRecord(record));
    }
  }
  if (events.length === 0) return { ok: false, reason: 'native history unavailable' };
  return {
    ok: true,
    events: events.slice(0, MAX_EVENTS),
    ...(modelId === undefined ? {} : { modelId }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
  };
}

/**
 * Extract deduplicated per-request token usage from a Codex rollout JSONL.
 *
 * Codex logs cumulative `total_token_usage` alongside per-call `last_token_usage`
 * and may repeat `token_count` frames on rate-limit updates without a new model
 * call; advancing strictly on `total_token_usage.total_tokens` eliminates duplicates.
 */
export function readCodexSessionRequestUsage(input: {
  historyRoot: string;
  sessionId: string;
  from?: string;
  fallbackModelId?: string;
  readFile?: (path: string) => string | undefined;
  listFiles?: (dir: string) => string[];
}): RequestUsageRecord[] {
  if (input.sessionId.length === 0) return [];
  const path = findCodexRolloutPath(input);
  if (path === undefined) return [];
  const body = (input.readFile ?? readUtf8)(path);
  if (body === undefined) return [];

  const fromMs = input.from !== undefined ? Date.parse(input.from) : Number.NaN;
  const records: RequestUsageRecord[] = [];
  let currentModelId = typeof input.fallbackModelId === 'string' && input.fallbackModelId.length > 0
    ? input.fallbackModelId
    : undefined;
  let prevTotalTokens = 0;
  let fallbackSeq = 0;

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.length > MAX_LINE_CHARS) continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type === 'turn_context') {
      const turnModel = asRecord(record.payload)?.model;
      if (typeof turnModel === 'string' && turnModel.length > 0) currentModelId = turnModel;
      continue;
    }
    if (record.type !== 'event_msg') continue;
    const payload = asRecord(record.payload);
    if (payload?.type !== 'token_count') continue;
    const info = asRecord(payload.info);
    if (info === undefined) continue;

    const totalObj = asRecord(info.total_token_usage);
    const cumulative = typeof totalObj?.total_tokens === 'number' && Number.isFinite(totalObj.total_tokens) && totalObj.total_tokens >= 0
      ? Math.trunc(totalObj.total_tokens)
      : undefined;
    if (cumulative !== undefined) {
      if (cumulative <= prevTotalTokens) continue;
      prevTotalTokens = cumulative;
    }

    const lastUsage = parseCodexTokenBreakdown(info.last_token_usage ?? info.total_token_usage);
    if (lastUsage === undefined) continue;

    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined;
    if (timestamp === undefined || !Number.isFinite(Date.parse(timestamp))) continue;

    fallbackSeq += 1;
    const requestId = cumulative !== undefined
      ? `${input.sessionId}:total-${cumulative}`
      : `${input.sessionId}:req-${fallbackSeq}`;

    records.push({
      requestId,
      backendSessionId: input.sessionId,
      promptTokens: lastUsage.promptTokens,
      completionTokens: lastUsage.completionTokens,
      cacheReadTokens: lastUsage.cacheReadTokens,
      cacheWriteTokens: lastUsage.cacheWriteTokens,
      ...(lastUsage.reasoningTokens === undefined ? {} : { reasoningTokens: lastUsage.reasoningTokens }),
      totalTokens: lastUsage.totalTokens,
      recordedAt: new Date(timestamp).toISOString(),
      ...(currentModelId === undefined ? {} : { modelId: currentModelId }),
    });
  }

  if (!Number.isFinite(fromMs)) return records;
  return records.filter((item) => Date.parse(item.recordedAt) >= fromMs);
}

function walkFiles(dir: string, remaining: number): string[] {
  const found: string[] = [];
  const stack = [dir];
  while (stack.length > 0 && found.length < remaining) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: string[];
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

function readUtf8(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function emissionsFromRecord(record: Record<string, unknown>): HistoryEmission[] {
  if (record.type !== 'response_item') return [];
  const payload = asRecord(record.payload);
  if (payload?.type !== 'message') return [];
  const role = payload.role;
  if (role !== 'user' && role !== 'assistant') return [];
  const kinds = contentKinds(payload);
  if (kinds.includes('agents_md.instructions') || kinds.includes('environments.environment_context')) return [];
  const text = textFromContent(payload.content);
  if (text.length === 0) return [];
  const messageId = typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : `codex-${hashText(text)}`;
  return [
    { type: 'agent', event: { type: 'message/start', messageId, role } },
    { type: 'agent', event: { type: 'message/text_delta', messageId, delta: text } },
    { type: 'agent', event: { type: 'message/end', messageId } },
  ];
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (rec === undefined) continue;
    if ((rec.type === 'input_text' || rec.type === 'output_text' || rec.type === 'text') && typeof rec.text === 'string') {
      parts.push(rec.text);
    }
  }
  return parts.join('').trim();
}

function contentKinds(payload: Record<string, unknown>): string[] {
  const meta = asRecord(payload.internal_chat_message_metadata_passthrough);
  const kinds = meta?.content_item_kinds;
  return Array.isArray(kinds) ? kinds.filter((kind): kind is string => typeof kind === 'string') : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
