import type { IncomingMessage } from 'node:http';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import type { LiveVoiceAdapterOptions, LiveVoiceRequest, LiveVoiceEvent, LiveVoiceSession } from '../adapters/live-voice/index.js';

export const CANARY = 'SYNTHETIC-KEY-URL-HANDLE-DO-NOT-PRINT-10226B';
export const request = (): LiveVoiceRequest => ({
  system: { text: 'Synthetic system', dataClass: 'ordinary' }, dataClasses: ['ordinary'], history: [],
});
export const control = (signal = new AbortController().signal) => ({ signal, deadlineMs: Date.now() + 5000 });
// Silent PCM only: no microphone or playback is used by this fixture.
export const pcm = new Uint8Array(8);
export function options(overrides: Partial<LiveVoiceAdapterOptions> = {}): LiveVoiceAdapterOptions {
  return {
    modelId: 'models/explicit-live-test', voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: 'models/explicit-live-test', dataClasses: ['ordinary'] },
    credentials: { resolve: async () => CANARY },
    limits: { handshakeMs: 1000, idleMs: 2000, sessionMs: 4000, closeMs: 50 }, ...overrides,
  };
}
export type FrameMode = 'text' | 'binary';
export async function fixture(t: TestContext, frameMode: FrameMode = 'binary') {
  let refusalStatus: number | undefined;
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1',
    verifyClient: (_info: { origin: string; secure: boolean; req: IncomingMessage }, accept: (accepted: boolean, code?: number, message?: string) => void) => {
      if (refusalStatus !== undefined) accept(false, refusalStatus, 'Fixture refusal');
      else accept(true);
    },
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address');
  let peer: WebSocket | undefined;
  let attempts = 0;
  let destination = '';
  const frames: unknown[] = [];
  const clients: WebSocket[] = [];
  const waiters = new Map<number, () => void>();
  let noteClosed: () => void = () => {};
  const closed = new Promise<void>(resolve => { noteClosed = resolve; });
  let connections = 0;
  const connected = new Promise<void>(resolve => server.on('connection', socket => {
    connections += 1;
    peer = socket;
    socket.on('error', () => {});
    socket.on('close', () => noteClosed());
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString());
      frames.push(frame);
      // Gemini rejects unsupported schema keys in setup, including nested objects.
      const hasAdditionalProperties = (value: unknown): boolean => {
        if (!value || typeof value !== 'object') return false;
        if (Array.isArray(value)) return value.some(hasAdditionalProperties);
        return Object.entries(value).some(([key, child]) => key === 'additionalProperties' || hasAdditionalProperties(child));
      };
      if (frame.setup?.tools?.some((tool: { functionDeclarations?: { parameters?: unknown }[] }) =>
        tool.functionDeclarations?.some(declaration => hasAdditionalProperties(declaration.parameters)))) {
        socket.close(1007, `Invalid additionalProperties tools.function_declarations.parameters ${CANARY}`);
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
    server, frames, clients, connected, closed, get attempts() { return attempts; }, get connections() { return connections; }, get destination() { return destination; },
    socketFactory: ((url, config) => {
      attempts++; destination = url;
      const client = new WebSocket(`ws://127.0.0.1:${address.port}`, config);
      clients.push(client); return client;
    }) satisfies NonNullable<LiveVoiceAdapterOptions['socketFactory']>,
    async frame(n: number): Promise<void> {
      if (frames.length >= n) return;
      await new Promise<void>(resolve => waiters.set(n, resolve));
    },
    send(value: unknown) { peer!.send(JSON.stringify(value), { binary: frameMode === 'binary' }); },
    sendRaw(value: string | Buffer) { peer!.send(value, { binary: frameMode === 'binary' }); },
    refuseUpgrades(status: number) { refusalStatus = status; },
    invalidOpcode() {
      // Reserved opcode3 drives the real ws receiver protocol-error interface.
      (peer! as unknown as { _socket: { write(frame: Buffer): void } })._socket.write(Buffer.from([0x83, 0]));
    },
    remoteClose(reason = '', code = 1000) { peer!.close(code, reason); },
    terminate() { peer!.terminate(); },
    get peer() { return peer!; },
  };
}
export function collect(session: LiveVoiceSession) {
  const events: LiveVoiceEvent[] = [];
  const done = (async () => { for await (const event of session.events) events.push(event); })();
  return { events, done };
}
export async function ready(t: TestContext, overrides: Partial<LiveVoiceAdapterOptions> = {}, frameMode: FrameMode = 'binary') {
  const f = await fixture(t, frameMode);
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

// The smoke retained only top-level names; these are synthetic minimal shapes.
export function speechActivityFrames(send: (value: unknown) => void) {
  send({ serverContent: {}, voiceActivity: { type: 'ACTIVITY_START' }, usageMetadata: {} });
  send({ serverContent: {} });
  send({ serverContent: { modelTurn: { parts: [] } }, voiceActivity: { type: 'ACTIVITY_END' } });
  send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } }] } } });
}
