import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { ServiceError } from '../contracts/errors.js';
import type { Store } from '../runtime/store.js';
import {
  LiveError, type LiveAttachment, type LiveContext, type LiveFragmentPage,
  type LivePublicMarker, type LiveSessionSnapshot,
} from '../live/index.js';
import type { DataClass } from '../adapters/live-voice/index.js';
import { authorityContext, operatorPrincipal } from './auth.js';

export interface LiveStatusPayload {
  service: 'live';
  status: 'unconfigured' | 'disabled' | 'error' | 'configured';
  code?: string;
  provider?: 'gemini';
  model?: string;
  voice?: string;
  dataClasses?: string[];
  profileIdentity?: string;
}

/** The one operator-facing Live surface. Implemented by the host composition, never by a browser. */
export interface LiveService {
  readonly enabled: boolean;
  readonly profileIdentity: string;
  readonly maxIncomingBytes: number;
  readonly maxBufferedBytes: number;
  status(): LiveStatusPayload;
  create(inputClass: DataClass, idempotencyKey: string, context: LiveContext): LiveSessionSnapshot;
  snapshot(liveSessionId: string): LiveSessionSnapshot;
  journal(liveSessionId: string, cursor: number | undefined, limit: number | undefined): LiveFragmentPage;
  revoke(liveSessionId: string): void;
  attach(liveSessionId: string, context: LiveContext): LiveAttachment;
  shutdown(): Promise<void>;
}

const audioPath = /^\/api\/v1\/live-sessions\/([^/]+)\/audio$/;
const sessionIdPattern = /^[0-9a-fA-F-]{36}$/;
const controls = ['endAudioStream', 'close'] as const;
const statusText: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 503: 'Service Unavailable' };

/** Map an owner or guard failure to a closed HTTP error. Never leaks prompt/key bytes. */
export function liveServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
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
  if (marker.text !== null) frame['text'] = marker.text;
  if (marker.finished !== null) frame['finished'] = marker.finished;
  if (marker.value !== null) frame['value'] = marker.value;
  return frame;
}

/** Strict tiny control: exactly one `type` key with a known command, else null. */
function control(raw: string): (typeof controls)[number] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'type') return null;
  const type = (parsed as { type?: unknown }).type;
  return typeof type === 'string' && (controls as readonly string[]).includes(type) ? type as (typeof controls)[number] : null;
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
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, clientTracking: false });
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
      sessionId = match[1]!;
      if (!sessionIdPattern.test(sessionId)) throw new ServiceError('BAD_REQUEST', 'Invalid Live session id', 400);
      const principal = operatorPrincipal(req, options.store, options.origin());
      context = authorityContext(req, options.store, principal);
      const pin = req.headers['x-didi-live-profile'];
      if (pin !== undefined && (typeof pin !== 'string' || pin !== options.live.profileIdentity)) throw new ServiceError('FORBIDDEN', 'Live profile pin is stale', 403);
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
      catch { ws.close(1008, 'attach_rejected'); return; }
      void drive(ws, attachment);
    });
  }

  async function drive(ws: WebSocket, attachment: LiveAttachment): Promise<void> {
    ws.on('error', () => { attachment.detach(); });
    ws.on('close', () => { attachment.detach(); });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (ws.readyState !== ws.OPEN) return;
      if (isBinary) {
        const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (!pcm.length || pcm.length % 2 !== 0) { ws.close(1002, 'invalid_audio'); return; }
        if (pcm.length > options.maxIncomingBytes) { ws.close(1009, 'frame_too_large'); return; }
        try { attachment.sendAudio({ pcm }); } catch { ws.close(1002, 'not_ready'); }
        return;
      }
      const type = control(data.toString());
      if (type === null) { ws.close(1002, 'invalid_control'); return; }
      if (type === 'endAudioStream') { try { attachment.endAudioStream(); } catch { ws.close(1002, 'invalid_command'); } return; }
      attachment.close();
      ws.close(1000, 'client_close');
    });
    try {
      for await (const chunk of attachment.output) {
        if (ws.readyState !== ws.OPEN) { attachment.detach(); return; }
        if (chunk.kind === 'audio') ws.send(chunk.pcm, { binary: true });
        else if (chunk.marker.kind !== 'terminal') ws.send(JSON.stringify(markerFrame(chunk.marker)), { binary: false });
        if (ws.bufferedAmount > options.maxBufferedBytes) { ws.close(1013, 'consumer_backpressure'); return; }
      }
    } catch { /* transport failure never invents a delivered terminal or heard audio */ }
    let snapshot: LiveSessionSnapshot | null = null;
    try { snapshot = await attachment.done; } catch { snapshot = null; }
    if (ws.readyState !== ws.OPEN) return;
    if (snapshot?.terminal) {
      const terminal = snapshot.terminal as { state: string; code?: string };
      ws.send(JSON.stringify({ type: 'terminal', state: terminal.state, code: terminal.code ?? null, complete: snapshot.journal.complete }), { binary: false });
    }
    ws.close(1000, 'terminal');
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
