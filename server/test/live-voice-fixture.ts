import { once } from 'node:events';
import type { TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import type { GeminiLiveVoiceOptions, LiveVoiceRequest, LiveVoiceEvent, LiveVoiceSession } from '../adapters/live-voice/index.js';

export const CANARY = 'SYNTHETIC-KEY-URL-HANDLE-DO-NOT-PRINT-10226B';
export const request = (): LiveVoiceRequest => ({
  system: { text: 'Synthetic system', dataClass: 'ordinary' }, dataClasses: ['ordinary'], history: [],
});
export const control = (signal = new AbortController().signal) => ({ signal, deadlineMs: Date.now() + 5000 });
export const pcm = new Uint8Array([0, 0, 1, 0, 255, 127, 0, 128]);
export function options(overrides: Partial<GeminiLiveVoiceOptions> = {}): GeminiLiveVoiceOptions {
  return {
    modelId: 'models/explicit-live-test', voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: 'models/explicit-live-test', dataClasses: ['ordinary'] },
    credentials: { resolve: async () => CANARY },
    limits: { handshakeMs: 1000, idleMs: 2000, sessionMs: 4000, closeMs: 50 }, ...overrides,
  };
}
export async function fixture(t: TestContext) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address');
  let peer: WebSocket | undefined;
  let attempts = 0;
  let destination = '';
  const frames: unknown[] = [];
  const waiters = new Map<number, () => void>();
  const connected = new Promise<void>(resolve => server.on('connection', socket => {
    peer = socket;
    socket.on('error', () => {});
    socket.on('message', bytes => {
      frames.push(JSON.parse(bytes.toString()));
      for (const [n, notify] of waiters) if (frames.length >= n) { waiters.delete(n); notify(); }
    });
    resolve();
  }));
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return {
    server, frames, connected, get attempts() { return attempts; }, get destination() { return destination; },
    socketFactory: ((url, config) => {
      attempts++; destination = url;
      return new WebSocket(`ws://127.0.0.1:${address.port}`, config);
    }) satisfies NonNullable<GeminiLiveVoiceOptions['socketFactory']>,
    async frame(n: number): Promise<void> {
      if (frames.length >= n) return;
      await new Promise<void>(resolve => waiters.set(n, resolve));
    },
    send(value: unknown) { peer!.send(JSON.stringify(value)); },
    sendRaw(value: string | Buffer) { peer!.send(value); },
    remoteClose(reason = '') { peer!.close(1000, reason); },
    terminate() { peer!.terminate(); },
    get peer() { return peer!; },
  };
}
export function collect(session: LiveVoiceSession) {
  const events: LiveVoiceEvent[] = [];
  const done = (async () => { for await (const event of session.events) events.push(event); })();
  return { events, done };
}
export async function ready(t: TestContext, overrides: Partial<GeminiLiveVoiceOptions> = {}) {
  const f = await fixture(t);
  const { GeminiLiveVoiceAdapter } = await import('../adapters/live-voice/index.js');
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, ...overrides })).open(request(), control());
  t.after(() => session.close());
  const captured = collect(session);
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  return { f, session, captured };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
