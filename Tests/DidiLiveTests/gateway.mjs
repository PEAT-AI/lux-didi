import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { WebSocket, WebSocketServer } from '../../server/node_modules/ws/wrapper.mjs';
import { startHost } from '../../server/dist/host/runtime.js';
import { defaultLiveLimits } from '../../server/dist/live/index.js';

const [binary, work, nativeBinary, mutatedBinary] = process.argv.slice(2);
assert.ok(binary && work);
const webRoot = resolve('web/dist');
const state = join(work, 'state');
const config = join(work, 'config');
mkdirSync(config, { recursive: true, mode: 0o700 });
let now = Date.now();
let credentialReads = 0;
let opens = 0;
let trapRequests = 0;
const upgrades = [];
const upstreamFrames = [];
const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(upstream, 'listening');
const upstreamOrigin = `ws://127.0.0.1:${upstream.address().port}`;
upstream.on('connection', socket => {
  socket.on('error', () => {});
  socket.on('message', raw => {
    const value = JSON.parse(raw.toString());
    upstreamFrames.push(value);
    if (value.setup) socket.send(JSON.stringify({ setupComplete: {} }));
    const audio = first => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from([first, 0]).toString('base64') } }] } } });
    if (value.realtimeInput?.audio?.data === Buffer.from([1, 0]).toString('base64')) socket.send(JSON.stringify(audio(1)));
    if (value.realtimeInput?.audio?.data === Buffer.from([2, 0]).toString('base64')) {
      socket.send(JSON.stringify(audio(2)));
      socket.send(JSON.stringify({ serverContent: { interrupted: true } }));
      socket.send(JSON.stringify(audio(3)));
      socket.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ text: 'FORBIDDEN_PROVIDER_TEXT' }, { thought: true, text: 'FORBIDDEN_THOUGHT_TEXT' }] }, turnComplete: true, waitingForInput: true } }));
    }
  });
});
const trap = createServer((_req, res) => { trapRequests++; res.writeHead(403); res.end(); });
trap.on('upgrade', (_req, socket) => { trapRequests++; socket.destroy(); });
await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
let redirects = 0;
const profile = {
  provider: 'gemini', liveModelId: 'models/native-live-synthetic', voice: 'SyntheticVoice', keyReference: 'fixture-only',
  route: { enabled: true, provider: 'gemini', modelId: 'models/native-live-synthetic', dataClasses: ['ordinary', 'private'] },
  prompt: { text: 'Synthetic silent protocol test', dataClass: 'ordinary' },
  limits: { ...defaultLiveLimits, unusedMs: 20, handshakeMs: 2000, closeMs: 100, idleMs: 5000, sessionMs: 10000 },
};
let host;
try {
  host = await startHost({ dataDir: state, configDir: config, webRoot, port: 0, now: () => now,
    liveTesting: { profile,
      credentials: { resolve: async () => { credentialReads++; return 'SYNTHETIC-NONACCOUNT-NATIVE-LIVE'; } },
      socketFactory: () => { opens++; return new WebSocket(upstreamOrigin); },
    },
  });
  // This is the newly created controlled child's synthetic authority, not a user's credential.
  const token = readFileSync(join(state, 'admin-credential'), 'utf8').trim();
  const headers = { Authorization: `Bearer ${token}`, 'x-didi-authority-epoch': host.descriptor.authorityEpoch };
  async function json(path, options = {}) {
    const response = await fetch(host.descriptor.origin + path, { ...options, headers: { ...headers, ...options.headers } });
    assert.ok(response.ok, `controlled HTTP ${response.status}`);
    return (await response.json()).data;
  }
  const status = await json('/api/v1/live/status');
  host.service.server.prependListener('upgrade', req => {
    const names = req.rawHeaders.filter((_value, index) => index % 2 === 0).map(name => name.toLowerCase());
    upgrades.push({ host: req.headers.host, authorizationCount: names.filter(name => name === 'authorization').length,
      authorizationMatches: req.headers.authorization === headers.Authorization,
      epoch: req.headers['x-didi-authority-epoch'], profile: req.headers['x-didi-live-profile'],
      cookie: req.headers.cookie !== undefined, origin: req.headers.origin !== undefined });
  });
  const redirectSession = await json('/api/v1/live-sessions', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'stage0-bound-redirect' }, body: JSON.stringify({ inputClass: 'ordinary' }) });
  // Inject a redirect at the BOUND canonical host's audio route. All other paths use the accepted upgrader unchanged.
  const acceptedUpgraders = host.service.server.listeners('upgrade');
  host.service.server.removeAllListeners('upgrade');
  host.service.server.on('upgrade', (req, socket, head) => {
    if (req.url === `/api/v1/live-sessions/${redirectSession.liveSessionId}/audio`) {
      redirects++;
      assert.ok(req.headers.authorization === headers.Authorization, 'redirect request credential stays at BOUND origin');
      assert.equal(req.headers.host, new URL(host.descriptor.origin).host);
      const location = `ws://127.0.0.1:${trap.address().port}${req.url}`;
      socket.end(`HTTP/1.1 302 Found\r\nLocation: ${location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    for (const handle of acceptedUpgraders) handle.call(host.service.server, req, socket, head);
  });
  const fixture = { ...host.descriptor, token, profileIdentity: status.profileIdentity,
    redirectSessionID: redirectSession.liveSessionId };
  const child = spawn(binary, [], { stdio: ['pipe', 'inherit', 'inherit'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  child.stdin.end(JSON.stringify(fixture));
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timer);
  assert.equal(signal, null, 'bounded Swift child completed without timeout');
  console.log(`Stage0 safe counters upgrades=${upgrades.length} credentialReads=${credentialReads} controlledOpens=${opens} redirects=${redirects} trapRequests=${trapRequests}`);
  assert.equal(code, 0, 'actual Foundation Stage0');
  assert.equal(upgrades.length, 6, 'five rejects then one valid attach');
  const good = upgrades.at(-1);
  assert.equal(good.host, new URL(host.descriptor.origin).host);
  assert.equal(good.authorizationCount, 1);
  assert.equal(good.authorizationMatches, true);
  assert.equal(good.epoch, host.descriptor.authorityEpoch);
  assert.equal(good.profile, status.profileIdentity);
  assert.equal(good.cookie, false);
  assert.equal(good.origin, false);
  assert.equal(credentialReads, 1, 'all invalid headers fail before credential access');
  assert.equal(opens, 1, 'all invalid headers fail before provider open');
  assert.equal(redirects, 1, 'redirect tested at actual local listener');
  assert.equal(trapRequests, 0, 'zero requests/credentials reached second listener');
  assert.ok(upstreamFrames.some(frame => frame.realtimeInput?.audio), 'actual PCM reached controlled adapter');
  assert.ok(upstreamFrames.some(frame => frame.realtimeInput?.audioStreamEnd === true), 'exact EndAudioStream grammar');
  console.log('PASS Stage0 exactHost singleAuthorization epoch profile noCookie noOrigin zero redirect leak zero external provider contact');

  async function runNative(executable, args, expectedCode) {
    const process = spawn(executable, args, { stdio: ['pipe', 'inherit', 'inherit'] });
    const deadline = setTimeout(() => process.kill('SIGKILL'), 20000);
    process.stdin.end(JSON.stringify(fixture));
    const [result, signal] = await once(process, 'exit'); clearTimeout(deadline);
    assert.equal(signal, null, 'bounded native child cleanup');
    assert.equal(result, expectedCode, 'native behavioral result');
  }
  if (nativeBinary) {
    const upgradeBaseline = upgrades.length;
    const openBaseline = opens;
    await runNative(nativeBinary, ['--durations=10'], 0);
    assert.equal(upgrades.length - upgradeBaseline, 3, 'exact actual client attach count; all local guard/pin rejects have zero wire');
    assert.equal(opens - openBaseline, 3, 'real controlled provider opens only for the three authorized attaches');
    const audio = upstreamFrames.filter(frame => frame.realtimeInput?.audio);
    assert.deepEqual(audio.map(frame => Buffer.from(frame.realtimeInput.audio.data, 'base64').length), [8, 2, 2], 'invalid/overflow/post-revoke inputs never reach wire');
    for (const frame of audio) assert.equal(frame.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
    console.log('PASS native real-gateway wire accounting invalid/overflow zero-wire PCM16LE mono16k');
    await runNative(nativeBinary, ['--mutation'], 0);
    if (mutatedBinary) {
      await runNative(mutatedBinary, ['--mutation'], 1);
      await runNative(nativeBinary, ['--mutation'], 0);
      assert.equal(opens - openBaseline, 3, 'mutation never authorizes a provider');
      console.log('PASS ISOLATED MUTATION SENSITIVITY: compiled cookie-guard removal is behavioral RED, restored unmodified transport baseline GREEN');
    }
  }

  // Independent owner gate: clock advances, but no attach may trigger expiry on the client's behalf.
  const created = await json('/api/v1/live-sessions', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'accepted-unused-owner-gate' }, body: JSON.stringify({ inputClass: 'ordinary' }) });
  const opensBeforeExpiry = opens;
  now += 100;
  await new Promise(resolve => setTimeout(resolve, 40)); // bounded owner-timer opportunity, not client cleanup
  const snapshot = await json(`/api/v1/live-sessions/${created.liveSessionId}`);
  assert.equal(opens, opensBeforeExpiry, 'unused session never opens provider');
  assert.equal(snapshot.lifecycle, 'terminal', 'UPSTREAM: accepted-unused must settle without client attach');
  assert.equal(snapshot.terminal?.state, 'expired');
  console.log('PASS accepted-unused expiry with zero opens');
} finally {
  await host?.close();
  for (const peer of upstream.clients) peer.terminate();
  await new Promise(resolve => upstream.close(resolve));
  await new Promise(resolve => trap.close(resolve));
}
