import { randomUUID } from 'node:crypto';
import { hostLogEvent } from './host-events.js';
import { HOME_APPS, beginHandleSession, endHandleSession, homeDestination, mattermostOrigin, openDestination, resolveHandle, type HomeApp, type OpenKind } from './open-handles.js';

/** Builtin gateway identity: the open tools are host-native, never a remote connector. */
export const OPEN_IDENTITY = { accountId: 'gateway:live-voice', resourceId: 'native-actions' } as const;
export const OPEN_ACTIONS = ['open_url', 'open_file', 'open_app'] as const;
export type NativeAction = (typeof OPEN_ACTIONS)[number];
/** The closed set of ack codes; anything else from the native side is reported as failed. */
export const NATIVE_ACTION_CODES = ['opened', 'not_allowed', 'not_found', 'failed'] as const;
export type NativeActionCode = (typeof NATIVE_ACTION_CODES)[number];
/** What the model sees; `open_url` is only the internal transport for the two item tools. */
export const OPEN_TOOL_NAMES: ReadonlySet<string> = new Set<string>(['open_source', 'open_home', 'open_file', 'open_app']);
/** The one sentence the model says when an item open is refused or unknown. */
export const OPEN_GUIDANCE: Record<'not_found' | 'not_allowed', string> = {
  not_found: 'I could not find that item. Look it up again and use the handle the result gives you.',
  not_allowed: 'That link is not one I am allowed to open. Tell him plainly and offer the app home page instead.',
};
/** A control frame and its ack, exactly as they cross the local Live socket. */
export interface NativeActionFrame { type: 'native_action'; id: string; action: NativeAction; target: string; origin?: string }
export interface NativeActionResult { type: 'native_action_result'; id: string; ok: boolean; code: NativeActionCode }

const OPEN_ONLY = 'These tools only open things: they never type, click, send or change anything.';

export const OPEN_TOOLS: readonly { name: string; description: string; parameter: string; pattern: RegExp }[] = [
  { name: 'open_source', description: `Open one item the owner named, using the handle its lookup result carried in a line starting "open:". ${OPEN_ONLY}`, parameter: 'handle', pattern: /^L[0-9]{1,4}$/ },
  { name: 'open_home', description: `Open the home page of Gmail, Google Calendar or Mattermost. ${OPEN_ONLY}`, parameter: 'app', pattern: /^(gmail|calendar|mattermost)$/ },
  { name: 'open_file', description: `Open an existing file or folder inside the owner's home folder with its default app. ${OPEN_ONLY}`, parameter: 'path', pattern: /^\/|^~/ },
  { name: 'open_app', description: `Open an installed application by name. ${OPEN_ONLY}`, parameter: 'name', pattern: /^\S(?:.*\S)?$/ },
];

export function openParameters(tool: (typeof OPEN_TOOLS)[number]): Record<string, unknown> {
  const shape = tool.parameter === 'handle' ? { type: 'string', minLength: 2, maxLength: 5, description: 'The handle from an open: line of a lookup result, like L3.' }
    : tool.parameter === 'app' ? { type: 'string', enum: [...HOME_APPS], description: 'Which home page to open.' }
    : tool.parameter === 'path' ? { type: 'string', minLength: 1, maxLength: 1024, description: 'An absolute or ~ path inside the home folder.' }
    : { type: 'string', minLength: 1, maxLength: 1024, description: 'The application name, without or with .app.' };
  return { type: 'object', properties: { [tool.parameter]: shape }, required: [tool.parameter], additionalProperties: false };
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
export function nativeActionReceipt(action: NativeAction, code: NativeActionCode, detail: string): void {
  hostLogEvent({ event: 'native_action', action, code, detail: /^[a-z0-9]{1,16}$/.test(detail) ? detail : 'none' });
}

/** What a home app is called in plain words, so the open result can name it back to the owner. */
const HOME_TITLES: Record<HomeApp, string> = { gmail: 'Gmail', calendar: 'Google Calendar', mattermost: 'Mattermost' };

/** A title the model may speak: no URL, no credential, at most 120 characters. */
export function safeOpenTitle(title: string): string {
  const clean = title.replace(/https?:\/\/\S+/gi, ' ').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length === 0 ? 'item' : clean.slice(0, 120);
}

function fileTitle(path: string): string {
  const name = path.split('/').filter(Boolean).at(-1) ?? path;
  return safeOpenTitle(name);
}

/**
 * Open2 claimed-open ledger: what actually opened in a session, and the words a reply used to claim one.
 * The host asks this after a response finishes; nothing here reads a model argument.
 */
export interface OpenedReceipt { kind: OpenKind; title: string }
const opened = new Map<string, OpenedReceipt[]>();

/** The one place an `opened` ack becomes a receipt the turn ledger can see. */
export function noteOpened(runId: string, receipt: OpenedReceipt): void {
  const list = opened.get(runId) ?? [];
  list.push(receipt);
  opened.set(runId, list);
}

export function openedIn(runId: string): readonly OpenedReceipt[] { return opened.get(runId) ?? [] }

const CLAIM = /\b(?:i(?:'|’)ve opened|i (?:have )?opened|opened (?:it|that|the|this)|it(?:'|’)s open|it is open|is open now|it(?:'|’)s up in|should be in (?:your|the) browser|i(?:'|’)ve got (?:it|that) open|i found it and opened)\b/;
const CLAIMED_KINDS: readonly { words: RegExp; kind: OpenKind }[] = [
  { words: /\b(?:deck|decks|slides|slide deck|presentation|presentations|document|documents|doc|docs|sheet|sheets|spreadsheet)\b/, kind: 'docs' },
  { words: /\b(?:email|emails|mail|thread|threads|inbox)\b/, kind: 'gmail' },
  { words: /\b(?:event|events|calendar|meeting invite)\b/, kind: 'calendar' },
  { words: /\b(?:channel|channels|chat post|mattermost)\b/, kind: 'mattermost' },
  { words: /\b(?:video|youtube)\b/, kind: 'youtube' },
  { words: /\b(?:file|folder|document on disk)\b/, kind: 'file' },
];

/** What she said this turn, so the claim check reads her own words and never the owner's. */
const spoken = new Map<string, string>();
export function noteSpoken(runId: string, text: string): void {
  spoken.set(runId, `${spoken.get(runId) ?? ''} ${text}`.slice(-4000));
}

/** A turn the owner cut off is over: its words and its receipts never judge the next one. */
export function clearOpenLedger(runId: string): void {
  spoken.delete(runId);
  opened.delete(runId);
}

/**
 * One correction per completed response, and only when a claim is not backed by a receipt of that kind.
 * Consuming the buffer is what holds it to one: a second call in the same turn sees nothing to read.
 */
export function openClaimCorrection(runId: string): { text: string; reason: 'no_receipt' | 'kind_mismatch' } | undefined {
  const said = spoken.get(runId) ?? '';
  const receipts = openedIn(runId);
  spoken.delete(runId);
  opened.delete(runId);
  const claim = CLAIM.exec(said.toLowerCase());
  if (!claim) return undefined;
  const named = CLAIMED_KINDS.find(entry => entry.words.test(said.toLowerCase()))?.kind;
  if (receipts.length === 0) {
    return { reason: 'no_receipt', text: 'Correction: nothing opened just then, whatever I said. Tell him plainly that nothing is open, and offer to look it up again.' };
  }
  if (named !== undefined && !receipts.some(receipt => receipt.kind === named)) {
    const actual = receipts.map(receipt => `${receipt.kind} item titled ${receipt.title}`).join(' and ');
    return { reason: 'kind_mismatch', text: `Correction: I did not open the ${claimedNoun(named)}. What opened was ${actual}. Tell him plainly what opened, and that the ${claimedNoun(named)} he asked for is still closed.` };
  }
  return undefined;
}

function claimedNoun(kind: OpenKind): string {
  return kind === 'docs' ? 'deck' : kind === 'gmail' ? 'email thread' : kind === 'calendar' ? 'calendar event' : kind === 'mattermost' ? 'channel' : kind === 'youtube' ? 'video' : kind;
}

/** One host target for a model-facing open tool: the action, the resolved target and its closed detail token. */export interface OpenTarget { action: NativeAction; target: string; detail: string; kind: OpenKind; title: string }

/** Resolve what a model-facing open tool means; a handle that is unknown or off policy never reaches the native side. */
export function openTarget(toolName: string, args: Record<string, string>): { target: OpenTarget } | { code: 'not_found' | 'not_allowed' } {
  if (toolName === 'open_source') {
    // Open2: only a handle whose open: line reached the model resolves; a minted one it never saw does not.
    const handle = resolveHandle(args['handle']!);
    if (!handle) return { code: 'not_found' };
    const destination = openDestination(handle.url);
    if (!destination) return { code: 'not_allowed' };
    return { target: { action: 'open_url', target: destination.url, detail: destination.kind, kind: destination.kind, title: handle.title } };
  }
  if (toolName === 'open_home') {
    const destination = HOME_APPS.includes(args['app'] as HomeApp) ? homeDestination(args['app'] as HomeApp) : undefined;
    if (!destination) return { code: 'not_allowed' };
    return { target: { action: 'open_url', target: destination.url, detail: args['app']!, kind: 'home', title: HOME_TITLES[args['app'] as HomeApp] } };
  }
  if (toolName === 'open_file') return { target: { action: 'open_file', target: args['path']!, detail: receiptDetail('open_file', args['path']!), kind: 'file', title: fileTitle(args['path']!) } };
  if (toolName === 'open_app') return { target: { action: 'open_app', target: args['name']!, detail: 'app', kind: 'app', title: safeOpenTitle(args['name']!) } };
  return { code: 'not_allowed' };
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
    beginHandleSession(runId);
    this.#senders.set(runId, send);
    return () => this.forget(runId);
  }

  /** A closed socket settles every wait it still owes as `failed`, and drops the session handles. */
  forget(runId: string): void {
    endHandleSession(runId);
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
      // OPEN2-R1: a Mattermost frame names the one origin the host learned from a connector permalink, so
      // the native side can pin it instead of trusting whatever host a destination happens to carry.
      const origin = mattermostFrameOrigin(action, target);
      const frame: NativeActionFrame = origin === undefined ? { type: 'native_action', id, action, target } : { type: 'native_action', id, action, target, origin };
      if (!send(frame)) { clearTimeout(timer); this.#pending.delete(id); resolve('failed'); }
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

/** The Mattermost origin a frame carries, and only for a destination that is a Mattermost viewer link. */
function mattermostFrameOrigin(action: NativeAction, target: string): string | undefined {
  if (action !== 'open_url') return undefined;
  const origin = mattermostOrigin();
  return origin !== undefined && openDestination(target)?.kind === 'mattermost' ? origin : undefined;
}

/** One bus per host process: the socket layer binds the Live session, the model path dispatches. */
export const nativeActions = new NativeActionBus();
