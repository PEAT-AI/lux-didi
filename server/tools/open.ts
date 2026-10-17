import { randomUUID } from 'node:crypto';
import { hostLogEvent } from './host-events.js';

/** Builtin gateway identity: the open tools are host-native, never a remote connector. */
export const OPEN_IDENTITY = { accountId: 'gateway:live-voice', resourceId: 'native-actions' } as const;
export const OPEN_ACTIONS = ['open_url', 'open_file', 'open_app'] as const;
export type NativeAction = (typeof OPEN_ACTIONS)[number];
/** The closed set of ack codes; anything else from the native side is reported as failed. */
export const NATIVE_ACTION_CODES = ['opened', 'not_allowed', 'not_found', 'failed'] as const;
export type NativeActionCode = (typeof NATIVE_ACTION_CODES)[number];
export const OPEN_TOOL_NAMES: ReadonlySet<string> = new Set<string>(OPEN_ACTIONS);
/** A control frame and its ack, exactly as they cross the local Live socket. */
export interface NativeActionFrame { type: 'native_action'; id: string; action: NativeAction; target: string }
export interface NativeActionResult { type: 'native_action_result'; id: string; ok: boolean; code: NativeActionCode }

const OPEN_ONLY = 'These tools only open things: they never type, click, send or change anything.';

export const OPEN_TOOLS: readonly { name: NativeAction; description: string; parameter: string; pattern: RegExp }[] = [
  { name: 'open_url', description: `Open an https web page in the owner's browser. ${OPEN_ONLY}`, parameter: 'url', pattern: /^https:\/\// },
  { name: 'open_file', description: `Open an existing file or folder inside the owner's home folder with its default app. ${OPEN_ONLY}`, parameter: 'path', pattern: /^\/|^~/ },
  { name: 'open_app', description: `Open an installed application by name. ${OPEN_ONLY}`, parameter: 'name', pattern: /^\S(?:.*\S)?$/ },
];

export function openParameters(tool: (typeof OPEN_TOOLS)[number]): Record<string, unknown> {
  return { type: 'object', properties: { [tool.parameter]: { type: 'string', minLength: 1, maxLength: 1024, description: tool.parameter === 'url' ? 'An https URL.' : tool.parameter === 'path' ? 'An absolute or ~ path inside the home folder.' : 'The application name, without or with .app.' } }, required: [tool.parameter], additionalProperties: false };
}

/** Exactly one string argument, shaped like the action's target; the native side re-checks the allowlist. */
export function validateOpen(args: unknown, tool: (typeof OPEN_TOOLS)[number]): args is Record<string, string> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const keys = Object.keys(args);
  const value = (args as Record<string, unknown>)[tool.parameter];
  return keys.length === 1 && keys[0] === tool.parameter && typeof value === 'string' && value.length > 0 && value.length <= 1024 && tool.pattern.test(value);
}

/** A scheme, an extension or `app`; never a URL path or a file name. */
export function receiptDetail(action: NativeAction, target: string): string {
  if (action === 'open_app') return 'app';
  if (action === 'open_url') { try { return new URL(target).protocol.replace(':', '') || 'none'; } catch { return 'none'; } }
  const name = target.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : 'none';
}

/** The one receipt the host writes per action: action, code and a scheme or extension, never the target. */
export function nativeActionReceipt(action: NativeAction, code: NativeActionCode, target: string): void {
  hostLogEvent({ event: 'native_action', action, code, detail: receiptDetail(action, target) });
}

interface Pending { runId: string; resolve(code: NativeActionCode): void; timer: ReturnType<typeof setTimeout> }

/**
 * Host to native dispatch over the existing local Live socket. The host owns the frame id and the
 * bounded wait; the native side owns the allowlist, so an unavailable peer is `failed`, never a pass.
 */
export class NativeActionBus {
  readonly #senders = new Map<string, (frame: NativeActionFrame) => boolean>();
  readonly #pending = new Map<string, Pending>();
  readonly #timeoutMs: number;
  constructor(timeoutMs = 5_000) { this.#timeoutMs = timeoutMs }

  /** One sender per Live session; this is what the audio socket already does for audio frames. */
  bind(runId: string, send: (frame: NativeActionFrame) => boolean): () => void {
    this.#senders.set(runId, send);
    return () => this.forget(runId);
  }

  /** A closed socket settles every wait it still owes as `failed`. */
  forget(runId: string): void {
    this.#senders.delete(runId);
    for (const [id, pending] of this.#pending) if (pending.runId === runId) { clearTimeout(pending.timer); this.#pending.delete(id); pending.resolve('failed'); }
  }

  dispatch(runId: string, action: NativeAction, target: string): Promise<NativeActionCode> {
    const send = this.#senders.get(runId);
    if (!send) return Promise.resolve('failed');
    const id = randomUUID();
    return new Promise<NativeActionCode>(resolve => {
      const timer = setTimeout(() => { if (this.#pending.delete(id)) resolve('failed'); }, this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { runId, resolve, timer });
      if (!send({ type: 'native_action', id, action, target })) { clearTimeout(timer); this.#pending.delete(id); resolve('failed'); }
    });
  }

  /** Accept one ack frame. Unknown, duplicated and malformed acks change nothing. */
  settle(runId: string, raw: unknown): boolean {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const value = raw as Record<string, unknown>;
    const keys = Object.keys(value).sort().join(',');
    if (keys !== 'code,id,ok,type' && keys !== 'code,id,type') return false;
    if (value.type !== 'native_action_result' || typeof value.id !== 'string') return false;
    const pending = this.#pending.get(value.id);
    if (!pending || pending.runId !== runId) return false;
    const code = typeof value.code === 'string' && (NATIVE_ACTION_CODES as readonly string[]).includes(value.code) ? value.code as NativeActionCode : 'failed';
    clearTimeout(pending.timer);
    this.#pending.delete(value.id);
    pending.resolve(code);
    return true;
  }
}

/** One bus per host process: the socket layer binds the Live session, the model path dispatches. */
export const nativeActions = new NativeActionBus();
