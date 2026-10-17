import type { IncomingMessage } from 'node:http';
import type { TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
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
/** Silent PCM16: 480 samples at 16 kHz, the host's 30 ms capture frame. */
export const pcm16 = (samples = 480): Uint8Array => {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) view.setInt16(index * 2, Math.round(Math.sin((index / 16) * 2 * Math.PI) * 8000), true);
  return bytes;
};
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
  let destination = '';
  let requestPath = '';
  let authorization: string | undefined;
  const frames: Frame[] = [];
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
      frames.push(JSON.parse(bytes.toString()) as Frame);
      for (const [n, notify] of waiters) if (frames.length >= n) { waiters.delete(n); notify(); }
    });
    resolve();
  }));
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return {
    server, frames, connected,
    get connections() { return connections; },
    get destination() { return destination; },
    get requestPath() { return requestPath; },
    get authorization() { return authorization; },
    socketFactory: ((url: string, config: Parameters<NonNullable<LiveVoiceAdapterOptions['socketFactory']>>[1]) => {
      destination = url;
      const client = new WebSocket(`ws://127.0.0.1:${address.port}`, config);
      return client;
    }) satisfies NonNullable<LiveVoiceAdapterOptions['socketFactory']>,
    async frame(n: number): Promise<void> {
      if (frames.length >= n) return;
      await new Promise<void>(resolve => waiters.set(n, resolve));
    },
    send(value: unknown) { peer!.send(JSON.stringify(value)); },
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

/** Open a session against the fake server and take it past the start barrier. */
export async function ready(t: TestContext, overrides: Partial<LiveVoiceAdapterOptions> = {}, input: Partial<LiveVoiceRequest> = {}) {
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
