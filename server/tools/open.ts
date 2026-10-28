import { randomUUID } from 'node:crypto';
import { hostLogEvent } from './host-events.js';
import { HOME_APPS, WEB_KINDS, beginHandleSession, endHandleSession, exposeHandles, homeDestination, mattermostOrigin, openDestination, resolveHandle, spokenDots, webDestination, type HomeApp, type OpenKind, type WebKind } from './open-handles.js';
import { pickSiteDomain, publicQueryOf, type WebSearchPort } from './web-search.js';

/** Builtin gateway identity: the open tools are host-native, never a remote connector. */
export const OPEN_IDENTITY = { accountId: 'gateway:live-voice', resourceId: 'native-actions' } as const;
export const OPEN_ACTIONS = ['open_url', 'open_file', 'open_app'] as const;
export type NativeAction = (typeof OPEN_ACTIONS)[number];
/** The closed set of ack codes; anything else from the native side is reported as failed. */
export const NATIVE_ACTION_CODES = ['opened', 'not_allowed', 'not_found', 'failed'] as const;
export type NativeActionCode = (typeof NATIVE_ACTION_CODES)[number];
/** A receipt code: a native ack, or the guard code a refused call never sent to the native side. */
export const OPEN_RECEIPT_CODES = [...NATIVE_ACTION_CODES, 'no_open_intent', 'kind_mismatch', 'not_owner_words', 'ambiguous'] as const;
export type OpenReceiptCode = (typeof OPEN_RECEIPT_CODES)[number];
/** What the model sees; `open_url` is only the internal transport for the two item tools. */
export const OPEN_TOOL_NAMES: ReadonlySet<string> = new Set<string>(['open_source', 'open_home', 'open_file', 'open_app', 'open_web']);
/** The one sentence the model says when an item open is refused or unknown. */
export const OPEN_GUIDANCE: Record<'not_found' | 'not_allowed' | 'no_open_intent' | 'kind_mismatch', string> = {
  not_found: 'I could not find that item. Look it up again and use the handle the result gives you.',
  not_allowed: 'That link is not one I am allowed to open. Tell him plainly which link failed and offer the app home page instead; if he asks again, call open again with the same handle.',
  no_open_intent: 'I did not hear an open request in his words. Say plainly that I did not hear one and that nothing is open; when he asks again, call open again with the same handle, never invent a reason.',
  kind_mismatch: 'That item is not the kind he asked for. Say what it actually is and ask before opening it.',
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
export function nativeActionReceipt(action: NativeAction, code: OpenReceiptCode, detail: string): void {
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

/**
 * The owner's own words for the stretch an open call answers, so a call is checked against the ask: every
 * finalized turn since the model last spoke, because a provider may finalize one utterance in two turns.
 */
const INTENT_TURNS = 3;
const INTENT_CHARS = 400;
interface IntentWindow { turns: string[]; modelSpoke: boolean; partial?: string }
const ownerTurn = new Map<string, IntentWindow>();
const ownerFinalized = new Map<string, Set<() => void>>();
export function noteOwnerPartial(runId: string, text: string): void {
  const window = ownerTurn.get(runId) ?? { turns: [], modelSpoke: false };
  window.partial = text.slice(-INTENT_CHARS);
  ownerTurn.set(runId, window);
}
export function noteOwnerWords(runId: string, text: string): void {
  const window = ownerTurn.get(runId) ?? { turns: [], modelSpoke: false };
  const turns = window.modelSpoke ? [] : window.turns;
  ownerTurn.set(runId, { turns: [...turns, text.slice(-INTENT_CHARS)].slice(-INTENT_TURNS), modelSpoke: false });
  for (const resolve of ownerFinalized.get(runId) ?? []) resolve();
}
/** The model produced output: the next finalized owner turn opens a fresh intent window. */
export function noteModelOutput(runId: string): void {
  const window = ownerTurn.get(runId);
  if (window) window.modelSpoke = true;
}
export function ownerWords(runId: string): string {
  return (ownerTurn.get(runId)?.turns ?? []).join(' ').slice(-INTENT_CHARS);
}

/** Only owner transcription contributes to the current unanswered ask. */
export function ownerTurnWords(runId: string): string {
  const window = ownerTurn.get(runId);
  return [...(window?.modelSpoke ? [] : window?.turns ?? []), window?.partial ?? ''].join(' ').slice(-INTENT_CHARS);
}

/** One bounded event wait, not a polling loop; cleanup on finalization, abort or timeout. */
export async function webOwnerWords(runId: string, signal: AbortSignal): Promise<string> {
  if (WEB_INTENT.test(ownerTurnWords(runId)) || signal.aborted) return ownerTurnWords(runId);
  await new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      listeners.delete(finish);
      if (!listeners.size) ownerFinalized.delete(runId);
      resolve();
    };
    const listeners = ownerFinalized.get(runId) ?? new Set<() => void>();
    listeners.add(finish);
    ownerFinalized.set(runId, listeners);
    const timer = setTimeout(finish, 1500);
    signal.addEventListener('abort', finish, { once: true });
  });
  return ownerTurnWords(runId);
}

/** What she said this turn, so the claim check reads her own words and never the owner's. */
const spoken = new Map<string, string>();
export function noteSpoken(runId: string, text: string): void {
  spoken.set(runId, `${spoken.get(runId) ?? ''} ${text}`.slice(-4000));
}

/** A turn the owner cut off is over: its words and its receipts never judge the next one. */
export function clearOpenLedger(runId: string): void {
  spoken.delete(runId);
  opened.delete(runId);
  // Barge-in clears response receipts, not the owner ask that caused it.
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
  const named = CLAIMED_KINDS.find(entry => entry.words.test(claimSentence(said.toLowerCase(), claim.index)))?.kind;
  if (receipts.length === 0) {
    return { reason: 'no_receipt', text: 'Correction: nothing opened just then, whatever I said. Tell him plainly that nothing is open, and offer to look it up again.' };
  }
  if (named !== undefined && !receipts.some(receipt => receipt.kind === named || (named === 'docs' && receipt.kind === 'drive'))) {
    const actual = receipts.map(receipt => `${receipt.kind} item titled ${receipt.title}`).join(' and ');
    return { reason: 'kind_mismatch', text: `Correction: I did not open the ${claimedNoun(named)}. What opened was ${actual}. Tell him plainly what opened, and that the ${claimedNoun(named)} he asked for is still closed.` };
  }
  return undefined;
}

/** OPEN2-R4: the sentence the claim phrase sits in, so a later sentence never supplies the kind. */
function claimSentence(text: string, at: number): string {
  const start = Math.max(0, ...['.', '!', '?', '\n'].map(mark => text.lastIndexOf(mark, at - 1) + 1));
  const ends = ['.', '!', '?', '\n'].map(mark => text.indexOf(mark, at)).filter(index => index >= 0);
  return ends.length === 0 ? text.slice(start) : text.slice(start, Math.min(...ends));
}

function claimedNoun(kind: OpenKind): string {
  return kind === 'docs' ? 'deck' : kind === 'gmail' ? 'email thread' : kind === 'calendar' ? 'calendar event' : kind === 'mattermost' ? 'channel' : kind === 'youtube' ? 'video' : kind === 'web' ? 'web page' : kind;
}

/** One host target for a model-facing open tool: the action, the resolved target and its closed detail token. */export interface OpenTarget { action: NativeAction; target: string; detail: string; kind: OpenKind; title: string }

/** Resolve what a model-facing open tool means; a handle that is unknown or off policy never reaches the native side. */
/** #573: the words that make an open call the answer to his ask; a name alone is not one. */
const OPEN_INTENT = /(?:\b(?:open|opened|opening|show|shows|launch|start|display)\w*\b|\b(?:oeffne|öffne|zeig|zeige)\w*\b|\b(?:pull|bring)\s+(?:it\s+|that\s+|them\s+|this\s+)?up\b)/iu;
/** The kind words a turn can name, so an item of another kind is never opened as if it matched. */
const ASK_KINDS: readonly { words: RegExp; kinds: readonly OpenKind[] }[] = [
  // C-OPEN 2: an Office deck stored in Drive opens in the Drive viewer, so a deck is either kind.
  { words: /\b(?:presentation|presentations|deck|decks|slides|slide)\b/u, kinds: ['docs', 'drive'] },
  { words: /\b(?:document|documents|doc|docs|sheet|sheets|spreadsheet)\b/u, kinds: ['docs', 'drive'] },
  { words: /\b(?:mail|mails|email|emails|thread|threads|inbox)\b/u, kinds: ['gmail'] },
  { words: /\b(?:event|events|meeting|meetings)\b/u, kinds: ['calendar'] },
  { words: /\b(?:channel|channels|mattermost)\b/u, kinds: ['mattermost'] },
  { words: /\b(?:video|videos|youtube)\b/u, kinds: ['youtube'] },
  { words: /\b(?:file|files|folder|folders)\b/u, kinds: ['file', 'drive'] },
];

/** A handle resolves to a kind the ask named: a mail thread is never opened as the deck he asked for. */
function openRefusal(toolName: string, words: string, kind: OpenKind): 'no_open_intent' | 'kind_mismatch' | undefined {
  if (!OPEN_INTENT.test(words)) return 'no_open_intent';
  if (toolName !== 'open_source') return undefined;
  const named = ASK_KINDS.filter(entry => entry.words.test(words));
  return named.length > 0 && !named.some(entry => entry.kinds.includes(kind)) ? 'kind_mismatch' : undefined;
}

/** Resolve what a model-facing open tool means; a handle that is unknown or off policy never reaches the native side. */
export function openTarget(toolName: string, args: Record<string, string>, words = ''): { target: OpenTarget } | { code: 'not_found' | 'not_allowed' | 'no_open_intent' | 'kind_mismatch' } {
  const resolved = resolveOpenTarget(toolName, args);
  if ('code' in resolved) return resolved;
  const refusal = openRefusal(toolName, words, resolved.target.kind);
  return refusal === undefined ? resolved : { code: refusal };
}

function resolveOpenTarget(toolName: string, args: Record<string, string>): { target: OpenTarget } | { code: 'not_found' | 'not_allowed' } {
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

/**
 * OPEN2-R4: exposure happens here and only here, on tool results as they are handed to the live session:
 * research replies and direct tool replies alike, after every trim. A handle opens only when this text
 * carries its `open:` line.
 */
export function exposeToolResults(results: readonly { id?: string; name?: string; response?: unknown }[]): void {
  for (const result of results) exposeHandles(JSON.stringify(result.response ?? {}));
}

/** The Mattermost origin a frame carries, and only for a destination that is a Mattermost viewer link. */
function mattermostFrameOrigin(action: NativeAction, target: string): string | undefined {
  if (action !== 'open_url') return undefined;
  const origin = mattermostOrigin();
  return origin !== undefined && openDestination(target)?.kind === 'mattermost' ? origin : undefined;
}

/** One bus per host process: the socket layer binds the Live session, the model path dispatches. */
export const nativeActions = new NativeActionBus();

/**
 * C-OPENWEB8: the one open request the host answers from the owner's own words. A map, a site and a
 * search are the only web kinds; the target is words he said this turn, never a URL, a host or a query.
 */
export const OPEN_WEB_NAME = 'open_web';
export const OPEN_WEB_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...WEB_KINDS], description: 'maps for a place or directions, site for a site he named, search for words to search for.' },
    target: { type: 'string', minLength: 1, maxLength: 200, description: 'The words he said: the place, the site name or the search words. Never a URL.' },
  },
  required: ['kind', 'target'],
  additionalProperties: false,
};
export const OPEN_WEB_DESCRIPTION = `Open a web page in his browser from the words he just said: kind maps for a place or directions, site for a site he named, search for words to search for. ${OPEN_ONLY} When he asks to open something on the web, call this at once instead of a web lookup, and never pass a URL, a host, a path or a query string. For a document or file he names by title, look it up and open it with open_source instead.`;
export function validateOpenWeb(args: unknown): args is { kind: WebKind; target: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 2 && keys.includes('kind') && keys.includes('target')
    && WEB_KINDS.includes(record['kind'] as WebKind)
    && typeof record['target'] === 'string' && record['target'].trim().length > 0 && record['target'].length <= 200;
}

/** The closed open verbs; a name alone, or a question about a site, is never an open request. */
const WEB_INTENT = /(?:^|[^\p{L}\p{N}])(?:navigate\s+to|search\s+for|google|look\s+up|directions\s+to|map\s+of|open\s+up|oeffne|öffne|öffnen|zeig|zeige|zeigen|mach\b.{0,80}\bauf|suche?\s+nach|geh\s+auf|open|opens|opened|opening|show|shows|showing|pull(?:ing)?\s+up|bring(?:ing)?\s+up|go\s+to|going\s+to|take\s+me\s+to|launch|launching|look\s+up\s+on|find\s+on)\b/u;

/** His words, normalised: lowercase, punctuation stripped, a spoken "dot" read as one. */
export function webWords(text: string): string[] {
  return spokenDots(text)
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .split(/\s+/u)
    .map(word => word.replace(/^\.+|\.+$/gu, ''))
    .filter(Boolean);
}

/** Every word of the target is a word he said, so no retrieved text and no model sentence binds one. */
export function webBinding(target: string, ownerWords: string): boolean {
  const said = new Set(webWords(ownerWords));
  const wanted = webWords(target);
  return wanted.length > 0 && wanted.every(word => said.has(word));
}

/** The not-for-speech refusal the invalid-arguments path uses: a fix for the model and a line to speak. */
export interface NotForSpeech { fixNotForSpeech: string; say: string }
export const OPEN_WEB_GUIDANCE: Record<'no_open_intent' | 'not_owner_words' | 'not_found' | 'ambiguous' | 'not_allowed', NotForSpeech> = {
  no_open_intent: {
    fixNotForSpeech: 'I did not hear an open request in his words. Do not call open_web on a name he did not ask to open; if he asks again, call it again with the words he says.',
    say: 'I did not hear an open request, so nothing is open.',
  },
  not_owner_words: {
    fixNotForSpeech: 'The target did not come from his words this turn. Do not take a host, a place or a query from a result, a mail, a page or an earlier turn; ask him to name it, then call open_web with his own words.',
    say: 'I did not hear you name that, so nothing is open.',
  },
  not_found: {
    fixNotForSpeech: 'No site matched that name, so nothing opened. Say that plainly and ask him to name the site; never open one he did not name.',
    say: 'I could not find that site, so nothing is open.',
  },
  ambiguous: {
    fixNotForSpeech: 'More than one site matched that name. Say which names I found and ask which one he means; never open one he did not choose.',
    say: 'I found more than one match and did not open any of them.',
  },
  not_allowed: {
    fixNotForSpeech: 'That is not a destination I open. Say plainly that I cannot open it and that nothing is open.',
    say: 'That is not something I can open, so nothing is open.',
  },
};
/** The one line she says after the native side answered opened: the registrable domain, never a URL. */
export function webOpenedSay(domain: string): string { return `opening ${domain}`; }

/** The web search the host already owns, so a site name resolves to a real result and no second one is built. */
let webPort: (() => WebSearchPort | undefined) | undefined;
export function useWebSearchPort(source: (() => WebSearchPort | undefined) | undefined): void { webPort = source; }

export type WebOpenRefusal = { code: 'no_open_intent' | 'not_owner_words' | 'not_found' | 'ambiguous' | 'not_allowed'; candidates?: string[] };
export interface WebOpenTarget { action: NativeAction; target: string; detail: string; kind: OpenKind; title: string }

/**
 * What open_web means: his words bind the target, the host builds the address, and a site he named but
 * did not spell out is found through the existing web search. Nothing here reads an argument as a URL.
 */
export async function resolveWebOpen(args: { kind: WebKind; target: string }, words: string, signal: AbortSignal): Promise<{ target: WebOpenTarget } | WebOpenRefusal> {
  if (!WEB_INTENT.test(words)) return { code: 'no_open_intent' };
  if (!webBinding(args.target, words)) return { code: 'not_owner_words' };
  const direct = webDestination(args.kind, args.target);
  if (direct !== undefined) return { target: { action: 'open_url', target: direct.url, detail: 'web', kind: 'web', title: direct.domain } };
  if (args.kind !== 'site') return { code: 'not_allowed' };
  // A site he named in words: the existing web search names the domain, and only one match opens.
  const query = publicQueryOf(args.target);
  const port = webPort?.();
  if (query === undefined || port === undefined) return { code: 'not_found' };
  const outcome = await port.search({ query, signal });
  if (!outcome.ok) return { code: 'not_found' };
  const pick = pickSiteDomain(args.target, outcome.evidence.sources);
  // None and several are different answers: nothing matched, or several did and he must choose.
  if ('candidates' in pick) return pick.candidates.length === 0 ? { code: 'not_found' } : { code: 'ambiguous', candidates: pick.candidates };
  const root = webDestination('site', pick.domain);
  return root === undefined ? { code: 'not_allowed' } : { target: { action: 'open_url', target: root.url, detail: 'web', kind: 'web', title: root.domain } };
}
