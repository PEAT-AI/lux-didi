#!/usr/bin/env bash
# No app launch, audio, accounts or external network. Override DIDI_OPEN_WEB_RESOURCES
# with ~/Applications/Lux Didi.app/Contents/Resources to check an installed app.
# By default exercise a fresh, offline-packed staging of this lane's service.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
repo="$PWD"
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-installed-open-web.XXXXXX")
trap 'rm -rf "$work"' EXIT
(cd server && npm run build)
resources="${DIDI_OPEN_WEB_RESOURCES:-$work/Resources}"
if [ -z "${DIDI_OPEN_WEB_RESOURCES:-}" ]; then
  mkdir -p "$resources/server/node_modules/@lux-didi/service" "$resources/web"
  (cd server && npm pack --offline --loglevel=error --ignore-scripts --pack-destination "$work" >/dev/null)
  tar -xzf "$work"/*.tgz --strip-components=1 -C "$resources/server/node_modules/@lux-didi/service"
  # Resolve the same offline dependency installation used by the lane, not external services.
  ln -s "$repo/server/node_modules" "$resources/server/node_modules/@lux-didi/service/node_modules"
  cp -R web/dist "$resources/web/dist"
  echo 'A5 STAGED: offline service package in Resources layout'
fi
service="$resources/server/node_modules/@lux-didi/service"
test -f "$service/dist/host/runtime.js" || { echo 'A5 FAIL: installed host runtime missing' >&2; exit 1; }
scripts/with-compile-lock.sh -- swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  Sources/LuxDidi/NativeActions.swift Tests/DidiLiveTests/NativeActionsRoundTripTests.swift -o "$work/native-round-trip"
"$work/native-round-trip"
node --input-type=module - "$repo" "$resources" "$work" <<'NODE'
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const [repo, resources, work] = process.argv.slice(2);
const require = createRequire(join(repo, 'server/package.json'));
const WebSocket = require('ws');
const { startHost } = await import(pathToFileURL(join(resources, 'server/node_modules/@lux-didi/service/dist/host/runtime.js')));
const { fixture, CANARY } = await import(pathToFileURL(join(repo, 'server/dist/test/live-voice-fixture.js')));
const cleanup = [];
let step = 'fake provider';
try {
  const f = await fixture({ after: callback => cleanup.push(callback) });
  const configDir = join(work, 'config'); mkdirSync(configDir, { mode: 0o700 });
  writeFileSync(join(configDir, 'live.json'), JSON.stringify({ schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'models/live-gateway-test', voice: 'LiveVoice', keyReference: 'gemini-primary', dataClasses: ['ordinary'], preferences: { dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'dry', verbosity: 'balanced' } }), { mode: 0o600 });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [] }), { mode: 0o600 });
  step = 'start installed host';
  const host = await startHost({ dataDir: join(work, 'state'), configDir, webRoot: join(resources, 'web/dist'), port: 0,
    liveTesting: { socketFactory: f.socketFactory, credentials: { resolve: async () => CANARY } } });
  cleanup.push(() => host.close());
  console.log(`A5 HOST: pid=${process.pid} origin=${host.service.origin}`);
  const headers = { authorization: `Bearer ${host.store.adminCredential}`, 'x-didi-authority-epoch': host.store.authorityEpoch, 'content-type': 'application/json' };
  step = 'create synthetic session';
  const created = await fetch(`${host.service.origin}/api/v1/live-sessions`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'synthetic-open-web' }, body: JSON.stringify({ inputClass: 'ordinary' }) });
  const createResult = await created.json();
  assert.equal(created.status, 201, JSON.stringify(createResult));
  const id = createResult.data.liveSessionId;
  const ws = new WebSocket(`${host.service.origin.replace('http', 'ws')}/api/v1/live-sessions/${id}/audio`, { headers });
  cleanup.push(() => ws.terminate());
  const urls = [];
  let ready;
  const readyPromise = new Promise(resolve => { ready = resolve; });
  ws.on('message', (bytes, binary) => {
    if (binary) return;
    const frame = JSON.parse(bytes.toString());
    if (frame.type === 'ready') ready();
    if (frame.type === 'native_action') {
      urls.push(frame.target);
      ws.send(JSON.stringify({ type: 'native_action_result', id: frame.id, ok: true, code: 'opened' }));
    }
  });
  await once(ws, 'open'); await f.frame(1); f.send({ setupComplete: {} });
  await readyPromise;
  const cases = [
    ['site', 'plantix dot net', ['but can you open', 'plantix dot net in my browser'], 'https://plantix.net/', 'opening plantix.net'],
    ['maps', 'Odemira', ['open the map of Odemira'], 'https://www.google.com/maps/search/?api=1&query=Odemira', 'opening'],
    ['search', 'drip irrigation', ['search for drip irrigation'], 'https://www.google.com/search?q=drip+irrigation', 'opening'],
  ];
  for (const [kind, target, turns, url, say] of cases) {
    step = `${kind} native receipt and model response`;
    for (const text of turns) f.send({ serverContent: { inputTranscription: { text, finished: true } } });
    const before = f.frames.length;
    f.send({ toolCall: { functionCalls: [{ id: `synthetic-${kind}`, name: 'open_web', args: { kind, target } }] } });
    // The fixture's frame wait is event-driven. Bound each received frame, never poll.
    let index = before;
    let response;
    while (!response) {
      const timeout = AbortSignal.timeout(2500);
      await Promise.race([f.frame(index + 1), new Promise((_, reject) => timeout.addEventListener('abort', () => reject(Error(`${step}: timeout`)), { once: true }))]);
      const frame = f.frames[index++];
      if (frame.toolResponse) response = JSON.stringify(frame.toolResponse);
    }
    assert.equal(urls.at(-1), url);
    assert.match(response, /opened/); assert.ok(response.includes(say));
    console.log(`A5 PASS: ${kind} ${url}; opened receipt and say`);
  }
  assert.equal(urls.length, cases.length);
  console.log('A5 PASS: installed host open_web smoke, synthetic provider and native peer');
} catch (error) {
  console.error(`A5 FAIL: ${step}: ${error.message}`); process.exitCode = 1;
} finally {
  for (const close of cleanup.reverse()) await close();
}
NODE
