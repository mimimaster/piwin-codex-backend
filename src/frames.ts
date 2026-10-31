import type { Frame, Scope } from './types.js';
import { PROTOCOL_VERSION } from './types.js';

export function parseFrame(line: string): Frame | undefined {
  try {
    const value = JSON.parse(line) as Frame;
    if (value.protocolVersion !== PROTOCOL_VERSION) return undefined;
    return value;
  } catch {
    return undefined;
  }
}
export function requestFrame(scope: Scope, requestId: string, method: string, params: unknown): Frame {
  return { protocolVersion: PROTOCOL_VERSION, kind: 'request', scope, requestId, method, params };
}
export function okFrame(request: Extract<Frame, { kind: 'request' }>, result: unknown): Frame {
  return { protocolVersion: PROTOCOL_VERSION, kind: 'response', scope: request.scope, requestId: request.requestId, method: request.method, ok: true, result };
}
export function errFrame(request: Extract<Frame, { kind: 'request' }>, code: string, message: string): Frame {
  return { protocolVersion: PROTOCOL_VERSION, kind: 'response', scope: request.scope, requestId: request.requestId, method: request.method, ok: false, error: { code, message } };
}
export function eventFrame(scope: Extract<Scope, { kind: 'session' }>, emission: unknown): Frame {
  return { protocolVersion: PROTOCOL_VERSION, kind: 'event', scope, emission };
}
