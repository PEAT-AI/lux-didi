import type { IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import type { TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { OpenAiLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import type { LiveVoiceAdapterOptions, LiveVoiceClock, LiveVoiceEvent, LiveVoiceRequest, LiveVoiceSession } from '../adapters/live-voice/index.js';

/**
 * Fake GPT-Live server: a real WebSocketServer on port 0 with no network, no key and no sleep. The
 * adapter's socketFactory is redirected to it, so the wire frames in `frames` are exactly what the
 * adapter would send to api.openai.com.
 */
export const CANARY = 'SYNTHETIC-OPENAI-KEY-DO-NOT-PRINT-1017';
export const request = (overrides: Partial<LiveVoiceRequest> = {}): LiveVoiceRequest => ({
  system: { text: 'Synthetic persona', dataClass: 'ordinary' }, dataClasses: ['ordinary'], history: [], ...overrides,
});
export const control = (signal = new AbortController().signal) => ({ signal, deadlineMs: Date.now() + 5000 });
/** A PCM16 tone at 16 kHz: 480 samples is the host's 30 ms capture frame, and `amplitude` sets its level. */
export const pcm16 = (samples = 480, amplitude = 8000): Uint8Array => {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) view.setInt16(index * 2, Math.round(Math.sin((index / 16) * 2 * Math.PI) * amplitude), true);
  return bytes;
};
/** Digital silence of the shape gpt-live-1 streams between words: 2400 samples is 100 ms of 24 kHz output. */
export const silence = (samples: number): Uint8Array => new Uint8Array(samples * 2);
export function options(overrides: Partial<LiveVoiceAdapterOptions> = {}): LiveVoiceAdapterOptions {
  return {
    modelId: 'gpt-live-1', voice: 'marin', keyReference: 'openai-primary',
    route: { enabled: true, provider: 'openai', modelId: 'gpt-live-1', dataClasses: ['ordinary'] },
    credentials: { resolve: async () => CANARY },
    limits: { handshakeMs: 1000, idleMs: 2000, sessionMs: 4000, closeMs: 50 }, ...overrides,
  };
}

export type Frame = Record<string, unknown>;

export async function fixture(t: TestContext) {
  let peer: WebSocket | undefined;
  let client: WebSocket | undefined;
  let destination = '';
  let requestPath = '';
  let authorization: string | undefined;
  const frames: Frame[] = [];
  /** C-REBUILD8: the frames the provider's own rule refused, so a test can name them. */
  const rejections: Frame[] = [];
  const waiters = new Map<number, () => void>();
  let connections = 0;
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('fixture has no port');
  const connected = new Promise<void>(resolve => server.on('connection', (socket, req: IncomingMessage) => {
    connections += 1;
    peer = socket;
    requestPath = req.url ?? '';
    authorization = req.headers.authorization;
    socket.on('error', () => {});
    socket.on('message', (bytes: Buffer) => {
      const frame = JSON.parse(bytes.toString()) as Frame;
      frames.push(frame);
      // C-REBUILD8: the provider says its own rule out loud. A commentary append without a delegation is refused
      // by name (`command_rejected code=missing_required_parameter param=delegation_id kind=cmt`, 2026-10-28 N10),
      // so this fake enforces the same rule instead of accepting whatever the adapter writes.
      if (frame['type'] === 'session.commentary.append' && typeof frame['delegation_id'] !== 'string') {
        rejections.push(frame);
        socket.send(JSON.stringify({ type: 'error', error: { type: 'command_rejected', code: 'missing_required_parameter',
          param: 'delegation_id', kind: 'cmt' } }));
      }
      for (const [n, notify] of waiters) if (frames.length >= n) { waiters.delete(n); notify(); }
    });
    resolve();
  }));
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return {
    server, frames, rejections, connected,
    get connections() { return connections; },
    get destination() { return destination; },
    get requestPath() { return requestPath; },
    get authorization() { return authorization; },
    get clientBufferedAmount() { return client?.bufferedAmount ?? 0; },
    socketFactory: ((url: string, config: Parameters<NonNullable<LiveVoiceAdapterOptions['socketFactory']>>[1]) => {
      destination = url;
      client = new WebSocket(`ws://127.0.0.1:${address.port}`, config);
      return client;
    }) satisfies NonNullable<LiveVoiceAdapterOptions['socketFactory']>,
    async frame(n: number): Promise<void> {
      if (frames.length >= n) return;
      await new Promise<void>(resolve => waiters.set(n, resolve));
    },
    send(value: unknown) { peer!.send(JSON.stringify(value)); },
    corkUpload() { (client as unknown as { _socket: { cork(): void } })._socket.cork(); },
    close(code = 1000, reason = 'fixture') { peer!.close(code, reason); },
  };
}

export function collect(session: LiveVoiceSession) {
  const events: LiveVoiceEvent[] = [];
  const done = (async () => { for await (const event of session.events) events.push(event); })();
  return { events, done };
}

/**
 * A fake clock for the adapter's turn-taking windows: `advance` fires every timer due inside the window in
 * order, so a test drives whole seconds of input-episode quiet and playback drain with no timer and no sleep.
 */
export class FakeClock implements LiveVoiceClock {
  private time = 1_000_000;
  private next = 1;
  private pending: { id: number; at: number; fire: () => void }[] = [];
  now(): number { return this.time; }
  setTimer(ms: number, fire: () => void): unknown {
    const id = this.next; this.next += 1;
    this.pending.push({ id, at: this.time + Math.max(0, ms), fire });
    return id;
  }
  clearTimer(handle: unknown): void { this.pending = this.pending.filter(timer => timer.id !== handle); }
  get timers(): number { return this.pending.length; }
  advance(ms: number): void {
    const target = this.time + Math.max(0, ms);
    for (;;) {
      const due = this.pending.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.pending = this.pending.filter(timer => timer !== due);
      this.time = Math.max(this.time, due.at);
      due.fire();
    }
    this.time = target;
  }
}

/**
 * A fake uplink socket: no network, no timers, and `bufferedAmount` is a test knob, which a real ws socket can
 * never offer. The adapter cannot tell it from `ws`: it emits the same events and takes the same calls.
 */
export class FakeSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  completeWrites = true;
  /** When set, a send fills the socket buffer and `drain` empties it, so the adapter's own acceptance
   *  accounting sees a socket that holds what it was handed until the link takes it away. */
  trackBuffer = false;
  private readonly pendingWriteCallbacks: ((error?: Error) => void)[] = [];
  pings = 0;
  /** A live peer answers a ping; a dead one does not, which is what the 8 s silence rule measures. */
  answersPings = true;
  /** The PCM bytes of every mic frame this socket was asked to send, in send order. */
  micFrames(): number[] {
    return this.sent.flatMap(frame => {
      const parsed = JSON.parse(frame) as { type?: string; audio?: string };
      return parsed.type === 'session.input_audio.append' && parsed.audio ? [Buffer.from(parsed.audio, 'base64').byteLength] : [];
    });
  }
  /** The link takes this many bytes out of the socket buffer, at whatever rate the test chooses. */
  drain(bytes: number) { this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes); }
  send(frame: string, callback?: (error?: Error) => void) {
    this.sent.push(frame);
    if (this.trackBuffer) this.bufferedAmount += Buffer.byteLength(frame);
    if (!callback) return;
    if (this.completeWrites) callback();
    else this.pendingWriteCallbacks.push(callback);
  }
  completePendingWrites() {
    for (const callback of this.pendingWriteCallbacks.splice(0)) callback();
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', 1000); }
  terminate() { this.close(); }
  ping() { this.pings += 1; if (this.answersPings) queueMicrotask(() => { if (this.readyState === 1) this.emit('pong'); }); }
  /** An inbound provider frame, exactly as the wire delivers it. */
  deliver(body: Record<string, unknown>) { this.emit('message', Buffer.from(JSON.stringify(body))); }
}

/** A session on the fake socket, taken past the start barrier. Nothing here touches the network or a real clock. */
export async function fakeReady(t: TestContext, overrides: Partial<LiveVoiceAdapterOptions> = {}) {
  const socket = new FakeSocket();
  const session = new OpenAiLiveVoiceAdapter(options({
    ...overrides,
    socketFactory: (() => {
      queueMicrotask(() => { socket.readyState = 1; socket.emit('open'); });
      return socket as unknown as WebSocket;
    }) satisfies NonNullable<LiveVoiceAdapterOptions['socketFactory']>,
  })).open(request(), { signal: new AbortController().signal, deadlineMs: Date.now() + 600_000 });
  t.after(() => session.close());
  const captured = collect(session);
  for (let attempt = 0; attempt < 20 && !socket.sent.length; attempt += 1) await new Promise<void>(resolve => setImmediate(resolve));
  socket.deliver({ type: 'session.started', session: { id: 'sess_fake' } });
  await session.ready;
  return { socket, session, captured };
}

/** Open a session against the fake server and take it past the start barrier. */export async function ready(t: TestContext, overrides: Partial<LiveVoiceAdapterOptions> = {}, input: Partial<LiveVoiceRequest> = {}) {
  const f = await fixture(t);
  const { OpenAiLiveVoiceAdapter } = await import('../adapters/live-voice/index.js');
  const session = new OpenAiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, ...overrides })).open(request(input), control());
  t.after(() => session.close());
  const captured = collect(session);
  await f.frame(1);
  f.send({ type: 'session.started', session: { id: 'sess_fixture' } });
  await session.ready;
  return { f, session, captured };
}
