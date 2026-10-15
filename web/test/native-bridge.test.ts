import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBridge,
  createFakeNative,
  installNativeBridge,
  nativeTransport,
  type NativeToWeb,
  type WebToNative,
} from '../src/native-bridge.ts';

const noLog = () => {};

test('the web installs window.didiNative before it posts ready', () => {
  const win: Record<string, unknown> = {};
  const { bridge } = installNativeBridge(win);
  assert.equal(typeof (win.didiNative as { receive: unknown }).receive, 'function');
  bridge.send({ type: 'ready' });
});

test('a real shell receives every outbound message through window.webkit.messageHandlers.didi', () => {
  const posted: WebToNative[] = [];
  const win = {
    webkit: { messageHandlers: { didi: { postMessage: (message: WebToNative) => posted.push(message) } } },
  } as unknown as Record<string, unknown>;
  const { bridge, fake } = installNativeBridge(win);
  assert.equal(fake, undefined, 'a real transport means no fake is installed');
  bridge.send({ type: 'ready' });
  bridge.send({ type: 'start' });
  bridge.send({ type: 'stop' });
  bridge.send({ type: 'mute' });
  bridge.send({ type: 'unmute' });
  bridge.send({ type: 'consentGranted' });
  bridge.send({ type: 'theme', mode: 'light' });
  assert.deepEqual(
    posted.map((message) => message.type),
    ['ready', 'start', 'stop', 'mute', 'unmute', 'consentGranted', 'theme'],
  );
  assert.equal(nativeTransport(win) !== undefined, true);
});

test('hydrate answers ready with consent, mic, live, route, theme and last-session time', () => {
  const win: Record<string, unknown> = {};
  const received: NativeToWeb[] = [];
  const { bridge } = installNativeBridge(win, noLog, { mic: 'granted', theme: 'light', lastSessionEndedAt: '2026-10-15T08:31:00Z' });
  bridge.onNative((message) => received.push(message));
  bridge.send({ type: 'ready' });
  assert.equal(received.length, 1);
  const hydrate = received[0]!;
  assert.equal(hydrate.type, 'hydrate');
  if (hydrate.type !== 'hydrate') return;
  assert.equal(hydrate.consent, false);
  assert.equal(hydrate.mic, 'granted');
  assert.deepEqual(hydrate.live, { state: 'idle' });
  assert.equal(hydrate.route, null);
  assert.equal(hydrate.theme, 'light');
  assert.equal(hydrate.lastSessionEndedAt, '2026-10-15T08:31:00Z');
});

test('a fake native mirrors start, mute, unmute and stop as liveState', () => {
  const win: Record<string, unknown> = {};
  const received: NativeToWeb[] = [];
  const { bridge } = installNativeBridge(win);
  bridge.onNative((message) => received.push(message));
  bridge.send({ type: 'start' });
  bridge.send({ type: 'mute' });
  bridge.send({ type: 'unmute' });
  bridge.send({ type: 'stop' });
  assert.deepEqual(
    received.map((message) => (message.type === 'liveState' ? message.state : message.type)),
    ['starting', 'live', 'muted', 'live', 'stopping', 'idle'],
  );
});

test('a denied microphone answers start with the explicit micDenied error, never a dead idle', () => {
  const win: Record<string, unknown> = {};
  const received: NativeToWeb[] = [];
  const { bridge } = installNativeBridge(win, noLog, { mic: 'denied' });
  bridge.onNative((message) => received.push(message));
  bridge.send({ type: 'start' });
  assert.deepEqual(received, [{ type: 'liveState', state: 'error', error: 'micDenied' }]);
});

test('consent is persisted by the native side and survives a reload hydrate', () => {
  const win: Record<string, unknown> = {};
  const received: NativeToWeb[] = [];
  const { bridge } = installNativeBridge(win);
  bridge.onNative((message) => received.push(message));
  bridge.send({ type: 'consentGranted' });
  bridge.send({ type: 'ready' });
  const hydrate = received.find((message) => message.type === 'hydrate');
  assert.ok(hydrate && hydrate.type === 'hydrate' && hydrate.consent === true);
});

test('native requestStart and requestStop reach the web state machine', () => {
  const bridge = createBridge(noLog);
  const fake = createFakeNative((message) => bridge.receive(message));
  const received: NativeToWeb[] = [];
  bridge.useTransport((message) => fake.handle(message));
  bridge.onNative((message) => received.push(message));
  fake.requestStart();
  fake.requestStop();
  assert.deepEqual(received.map((message) => message.type), ['requestStart', 'requestStop']);
});

test('levels arrive batched as arrays and route/tool payloads stay off the bridge', () => {
  const bridge = createBridge(noLog);
  const fake = createFakeNative((message) => bridge.receive(message));
  const received: NativeToWeb[] = [];
  bridge.useTransport((message) => fake.handle(message));
  bridge.onNative((message) => received.push(message));
  fake.levels([0.1, 0.2], [0.3]);
  const levels = received[0]!;
  assert.equal(levels.type, 'levels');
  if (levels.type !== 'levels') return;
  assert.deepEqual(levels.input, [0.1, 0.2]);
  assert.deepEqual(levels.output, [0.3]);
});

test('an unknown native type is logged by name only and ignored', () => {
  const logged: string[] = [];
  const bridge = createBridge((_kind, type) => logged.push(type));
  const received: NativeToWeb[] = [];
  bridge.onNative((message) => received.push(message));
  bridge.receive({ type: 'notAThing', secret: 'never-logged' });
  bridge.receive({ type: 'hydrate', consent: true, mic: 'granted', live: { state: 'idle' }, route: null, theme: 'dark', lastSessionEndedAt: null });
  assert.deepEqual(logged, ['notAThing']);
  assert.deepEqual(received.map((message) => message.type), ['hydrate']);
});

test('malformed messages never throw and never reach a handler', () => {
  const bridge = createBridge(noLog);
  const received: NativeToWeb[] = [];
  bridge.onNative((message) => received.push(message));
  bridge.receive(undefined);
  bridge.receive(null);
  bridge.receive('hydrate');
  bridge.receive({});
  bridge.receive({ type: 42 });
  assert.equal(received.length, 0);
});

test('unsubscribing a handler stops delivery', () => {
  const bridge = createBridge(noLog);
  const received: NativeToWeb[] = [];
  const off = bridge.onNative((message) => received.push(message));
  off();
  bridge.receive({ type: 'requestStart' });
  assert.equal(received.length, 0);
});
