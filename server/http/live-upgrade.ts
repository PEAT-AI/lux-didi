import { ConnectorCompositionError } from '../connectors/index.js';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { ServiceError } from '../contracts/errors.js';
import type { Store } from '../runtime/store.js';
import {
  LiveError, type LiveAttachment, type LiveContext, type LiveFragmentPage,
  type LivePublicMarker, type LiveSessionSnapshot,
} from '../live/index.js';
import type { DataClass, LiveVoiceProvider } from '../adapters/live-voice/index.js';
import type { LiveAccent } from '../prompt/live-persona.js';
import { authorityContext, operatorPrincipal } from './auth.js';
import { nativeActions } from '../tools/open.js';
import type { CalendarDigestSnapshot } from '../live/warm-context.js';
import type { WarmPrewarmReceipt } from '../live/index.js';

export interface LiveStatusPayload {
  service: 'live';
  status: 'unconfigured' | 'disabled' | 'error' | 'configured';
  code?: string;
  provider?: LiveVoiceProvider;
  model?: string;
  voice?: string;
  dataClasses?: string[];
  profileIdentity?: string;
  /** P3: the pitch-preserving playback rate the native player applies from this session's start. */
  playbackRate?: number;
  limits?: { sessionMs: number; idleMs: number };
}

/** The owner's persisted Live selection; it applies at the next start and never to a call in flight. */
export interface LiveSelectionResult {
  provider: LiveVoiceProvider; modelId: string; voice: string; accent: LiveAccent; appliesAt: 'next_start';
}
/** The one operator-facing Live surface. Implemented by the host composition, never by a browser. */
export interface LiveService {
  /** Persist a provider and voice choice into live.json. Absent when the service cannot write configuration. */
  saveSelection?(input: { provider: unknown; voice?: unknown; accent?: unknown }): LiveSelectionResult;
  current(cursor?: number): import('../live/types.js').LivePageProjection;
  lookupAuthority(runId: string): import('../tools/types.js').LiveAuthority | null;
  readonly enabled: boolean;
  readonly profileIdentity: string;
  readonly maxIncomingBytes: number;
  readonly maxBufferedBytes: number;
  status(): LiveStatusPayload;
  prepareCalendar(): Promise<CalendarDigestSnapshot>;
  prewarm(): Promise<WarmPrewarmReceipt>;
  create(inputClass: DataClass, idempotencyKey: string, context: LiveContext): LiveSessionSnapshot;
  snapshot(liveSessionId: string): LiveSessionSnapshot;
  journal(liveSessionId: string, cursor: number | undefined, limit: number | undefined): LiveFragmentPage;
  revoke(liveSessionId: string): void;
  attach(liveSessionId: string, context: LiveContext): LiveAttachment;
  text(text: string): void;
  shutdown(): Promise<void>;
}

const audioPath = /^\/api\/v1\/live-sessions\/([^/]+)\/audio$/;
const sessionIdPattern = /^[0-9a-fA-F-]{36}$/;
export const LIVE_CONTROLS = ['endAudioStream', 'close', 'inputMuted', 'inputLive'] as const;
const statusText: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 503: 'Service Unavailable' };

/** Map an owner or guard failure to a closed HTTP error. Never leaks prompt/key bytes. */
export function liveServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  // TRAIN3J-R3: a selected provider with no key slot fails loud at create time, named and never as Gemini.
  const liveUnavailable = error as { name?: unknown; code?: unknown } | null;
  if (liveUnavailable?.name === 'LiveUnavailable' && liveUnavailable.code === 'key_missing') {
    return new ServiceError('key_missing', 'The selected provider has no key', 503);
  }
  if (error instanceof ConnectorCompositionError) return new ServiceError('CONNECTOR_COMPOSITION_ERROR', 'Connector composition failed', 503);
  if (!(error instanceof LiveError)) return new ServiceError('INTERNAL_ERROR', 'Internal service error', 500);
  switch (error.code) {
    case 'not_found': return new ServiceError('NOT_FOUND', error.message, 404);
    case 'stale_authority': return new ServiceError('STALE_AUTHORITY', error.message, 409);
    case 'idempotency_conflict': case 'terminal': case 'already_attached': case 'expired': case 'invalidated': case 'not_ready':
      return new ServiceError('CONFLICT', error.message, 409);
    case 'persistence_failed': return new ServiceError('INTERNAL_ERROR', 'Live persistence failed', 500);
    default: return new ServiceError('BAD_REQUEST', error.message, 400);
  }
}

function markerFrame(marker: LivePublicMarker): Record<string, unknown> {
  const frame: Record<string, unknown> = { type: marker.kind, sequence: marker.sequence, journalSequence: marker.journalSequence };
  if (marker.kind === 'continuity') {
    frame['event'] = marker.event;
    if (marker.reason !== undefined) frame['reason'] = marker.reason;
  }
  if (marker.text !== null) frame['text'] = marker.text;
  if (marker.finished !== null) frame['finished'] = marker.finished;
  if (marker.value !== null) frame['value'] = marker.value;
  if (marker.tool) frame['tool'] = { name: marker.tool.name, status: marker.kind === 'toolCall' ? 'called' : marker.tool.status, ...(marker.kind === 'toolResult' ? { markdown: marker.tool.markdown, sources: marker.tool.sources } : {}) };
  return frame;
}

/** Strict tiny control: exactly one `type` key with a known command, else null. */
function control(raw: string): (typeof LIVE_CONTROLS)[number] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'type') return null;
  const type = (parsed as { type?: unknown }).type;
  return typeof type === 'string' && (LIVE_CONTROLS as readonly string[]).includes(type) ? type as (typeof LIVE_CONTROLS)[number] : null;
}

/** Parse one JSON frame without judging it; the native-action bus owns its own closed shape. */
function parseFrame(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * One detach per attachment: the socket's close and error watchers and the output pump share it, so a
 * dead socket detaches the session once, whichever of them sees it first.
 */
export function onceDetach(attachment: LiveAttachment): () => void {
  let detached = false;
  return () => { if (detached) return; detached = true; attachment.detach(); };
}

/** The socket surface the output pump needs, so a test can drive a socket that goes CLOSING. */
type OutputSocket = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close'>;

/** The owner's stop is the one terminal that outranks queued speech and consumer backpressure. */
function stopTerminal(snapshot: LiveSessionSnapshot | null): boolean {
  const terminal = snapshot?.terminal;
  return terminal?.state === 'closed' && (terminal.code === 'user_stop' || terminal.code === 'voice_stop');
}

/** Drain the session's output onto its socket, then report the terminal the session really reached. */
export async function pumpOutput(ws: OutputSocket, attachment: LiveAttachment, detach: () => void, maxBufferedBytes: number): Promise<void> {
  let snapshot: LiveSessionSnapshot | null = null;
  const terminal = attachment.done.then(value => ({ terminal: value }), () => ({ terminal: null }));
  const output = attachment.output[Symbol.asyncIterator]();
  let racing: Promise<{ terminal: LiveSessionSnapshot | null }> = terminal;
  // One pending read, kept across the race so a terminal that loses it never drops a queued chunk.
  let queued = output.next().then(chunk => ({ chunk }));
  try {
    while (true) {
      const next = await Promise.race([racing, queued]);
      if ('terminal' in next) {
        // A stop wins at once; any other terminal lets the queue drain and is sent after it.
        if (!stopTerminal(next.terminal)) { racing = new Promise<never>(() => {}); continue; }
        snapshot = next.terminal; void output.return?.(); break;
      }
      if (next.chunk.done) { snapshot = await attachment.done.catch(() => null); break; }
      const chunk = next.chunk.value;
      if (ws.readyState !== WebSocket.OPEN) { detach(); return; }
      try {
        if (chunk.kind === 'audio') ws.send(chunk.pcm, { binary: true });
        else if (chunk.marker.kind !== 'terminal') ws.send(JSON.stringify(markerFrame(chunk.marker)), { binary: false });
      } catch { detach(); return; }
      if (ws.bufferedAmount > maxBufferedBytes) { attachment.overflow(); ws.close(1013, 'consumer_backpressure'); return; }
      queued = output.next().then(chunk => ({ chunk }));
    }
  } catch { detach(); }
  if (ws.readyState !== WebSocket.OPEN) return;
  if (snapshot?.terminal) {
    const terminal = snapshot.terminal as { state: string; code?: string };
    ws.send(JSON.stringify({ type: 'terminal', state: terminal.state, code: terminal.code ?? null, complete: snapshot.journal.complete }), { binary: false });
  }
  const code = snapshot?.terminal && 'code' in snapshot.terminal ? snapshot.terminal.code : undefined;
  if (snapshot && !snapshot.ready && code && /^[a-z][a-z0-9_]{0,63}$/.test(code)) ws.close(1008, `attach_rejected:${code}`);
  else ws.close(1000, 'terminal');
}

export interface LiveUpgradeOptions {
  live: LiveService;
  store: Store;
  origin(): string;
  maxIncomingBytes: number;
  maxBufferedBytes: number;
}

/**
 * ws8.22 noServer on the existing node:http upgrade event. Fixed protocol, no extensions, no
 * subprotocols. Synchronous precheck -> handleUpgrade -> synchronous owner.attach in the callback;
 * no `await` and no user callback gap, so framing validation happens before any provider open.
 */
export function createLiveUpgrader(options: LiveUpgradeOptions) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, clientTracking: false, handleProtocols: () => false });
  const owned = new Set<WebSocket>();

  function refuse(socket: Duplex, status: number, code: string): void {
    const body = `${JSON.stringify({ error: { code } })}\n`;
    socket.write(`HTTP/1.1 ${status} ${statusText[status] ?? 'Error'}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    socket.destroy();
  }

  function handle(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let context: LiveContext;
    let sessionId: string;
    try {
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) throw new ServiceError('BAD_REQUEST', 'Invalid request target', 400);
      const url = new URL(req.url, options.origin());
      if (req.method !== 'GET') throw new ServiceError('METHOD_NOT_ALLOWED', 'Method is not allowed', 405);
      const match = audioPath.exec(url.pathname);
      if (!match) throw new ServiceError('NOT_FOUND', 'Route not found', 404);
      if (url.search) throw new ServiceError('BAD_REQUEST', 'Query is not accepted', 400);
      if (req.headers['sec-websocket-protocol'] !== undefined) throw new ServiceError('BAD_REQUEST', 'Subprotocols are not accepted', 400);
      sessionId = match[1]!;
      if (!sessionIdPattern.test(sessionId)) throw new ServiceError('BAD_REQUEST', 'Invalid Live session id', 400);
      const principal = operatorPrincipal(req, options.store, options.origin());
      context = authorityContext(req, options.store, principal);
      const pin = req.headers['x-didi-live-profile'];
      if (pin !== undefined) {
        if (typeof pin !== 'string') throw new ServiceError('FORBIDDEN', 'Live profile pin is stale', 403);
        // Nonsecret staleness pin: must match BOTH the frozen grant identity and the current profile.
        if (pin !== options.live.snapshot(sessionId).profileIdentity || pin !== options.live.profileIdentity) throw new ServiceError('FORBIDDEN', 'Live profile pin is stale', 403);
      }
      if (!options.live.enabled) throw new ServiceError('MODEL_NOT_CONFIGURED', 'Live is not locally configured', 503);
    } catch (error) {
      const typed = liveServiceError(error);
      refuse(socket, typed.status, typed.code);
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      owned.add(ws);
      ws.on('close', () => owned.delete(ws));
      let attachment: LiveAttachment;
      try { attachment = options.live.attach(sessionId!, context!); }
      catch (error) {
        const code = error instanceof LiveError || error instanceof ServiceError ? error.code : 'internal';
        // Only bounded class names and an allowlisted code token, never free text or payloads.
        const diagnostics = code === 'internal' ? {
          class: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.constructor.name) ? error.constructor.name : 'Unknown',
          ...(error instanceof Error && error.constructor === Error && error.message === 'connection_policy_missing_or_corrupt'
            ? { detail: error.message } : {}),
        } : {};
        console.error(JSON.stringify({ event: 'live_attach_rejected', liveSessionId: sessionId, code, ...diagnostics }));
        // Typed codes are ASCII; reserve 16 bytes for the prefix in the 123-byte close reason.
        ws.close(1008, `attach_rejected:${code.slice(0, 107)}`);
        return;
      }
      void drive(ws, attachment);
    });
  }

  async function drive(ws: WebSocket, attachment: LiveAttachment): Promise<void> {
    // One native-action sender per Live session; this socket is also the only path audio already uses.
    const forgetActions = nativeActions.bind(attachment.liveSessionId, frame => {
      if (ws.readyState !== ws.OPEN) return false;
      ws.send(JSON.stringify(frame));
      return true;
    });
    const detach = onceDetach(attachment);
    ws.on('error', () => { forgetActions(); detach(); });
    ws.on('close', () => { forgetActions(); detach(); });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (ws.readyState !== ws.OPEN) return;
      if (isBinary) {
        const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (!pcm.length || pcm.length % 2 !== 0) { ws.close(1002, 'invalid_audio'); return; }
        if (pcm.length > options.maxIncomingBytes) { ws.close(1009, 'frame_too_large'); return; }
        try { attachment.sendAudio({ pcm }); } catch { ws.close(1002, 'not_ready'); }
        return;
      }
      const raw = data.toString();
      if (raw.includes('"native_action_result"') && nativeActions.settle(attachment.liveSessionId, parseFrame(raw))) return;
      // O1b-N: a playback receipt is a bounded closed frame. It is validated and recorded inside the
      // session (trace/ingest.ts); a refused one is journaled by typed code and dropped, never closing
      // the socket. An unknown control below still closes, exactly as before.
      if (raw.includes('"playback_receipt"')) { attachment.playbackReceipt(raw); return; }
      const type = control(raw);
      if (type === null) { ws.close(1002, 'invalid_control'); return; }
      if (type === 'inputMuted' || type === 'inputLive') { attachment.setInputMuted(type === 'inputMuted'); return; }
      if (type === 'endAudioStream') { try { attachment.endAudioStream(); } catch { ws.close(1002, 'invalid_command'); } return; }
      // The explicit Stop: the app released the microphone and wants the call over, not the socket merely quieter.
      attachment.close();
      ws.close(1000, 'client_close');
    });
    void pumpOutput(ws, attachment, detach, options.maxBufferedBytes);
  }

  return {
    handle,
    /** Stop upgrades and close only the sockets this upgrader owns. */
    close(): Promise<void> {
      for (const ws of [...owned]) ws.terminate();
      owned.clear();
      return new Promise<void>(resolve => wss.close(() => resolve()));
    },
  };
}
