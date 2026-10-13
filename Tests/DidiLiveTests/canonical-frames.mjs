import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from '../../server/node_modules/ws/wrapper.mjs';
import { createLiveUpgrader } from '../../server/dist/http/live-upgrade.js';
import { Store } from '../../server/dist/runtime/store.js';

const [binary, work, expectation = 'green'] = process.argv.slice(2);
assert.ok(binary && work && ['red', 'green'].includes(expectation));
mkdirSync(work, { recursive: true, mode: 0o700 });
const store = new Store(join(work, 'synthetic-state'));
const sessionID = randomUUID();
const profile = 'synthetic-canonical-profile';
const variants = [];
let sequence = 0, journal = 0;
const marker = (kind, fields = {}) => ({ kind, sequence: ++sequence, journalSequence: ++journal,
  text: null, finished: null, value: null, ...fields });
for (const kind of ['ready', 'interrupted', 'generationComplete', 'turnComplete']) variants.push({ label: kind, marker: marker(kind) });
for (const kind of ['inputTranscription', 'outputTranscription']) {
  variants.push({ label: kind + '-partial', partial: true, marker: marker(kind, { text: 'Synthetic transcript' }) });
  for (const finished of [false, true]) variants.push({ label: kind + '-' + finished, marker: marker(kind, { text: 'Synthetic transcript', finished }) });
}
for (const value of [false, true]) variants.push({ label: 'waitingForInput-' + value, marker: marker('waitingForInput', { value }) });
for (const event of ['rebuilding', 'resumed']) variants.push({ label: 'continuity-' + event, marker: marker('continuity', { sequence: null, event, ...(event === 'rebuilding' ? { reason: 'transport_error' } : {}) }) });
for (const sequenceValue of [++sequence, null]) {
  variants.push({ label: 'toolCall-' + (sequenceValue === null ? 'null' : 'positive'), marker: marker('toolCall', { sequence: sequenceValue, tool: { name: 'read_note', status: 'error', markdown: '', sources: [] } }) });
  for (const status of ['completed', 'error']) variants.push({ label: 'toolResult-' + status + '-' + (sequenceValue === null ? 'null' : 'positive'), marker: marker('toolResult', { sequence: sequenceValue, tool: { name: 'read_note', status, markdown: 'Synthetic result', sources: [{ title: 'Synthetic source' }, { title: 'Synthetic reference', url: 'https://example.invalid/fixture' }] } }) });
}
const terminals = ['closed', 'failed', 'cancelled', 'deadline', 'not_started', 'outcome_unknown', 'journal_limit', 'consumer_backpressure', 'expired', 'revoked'];
let activeVariants = [], terminalState = 'closed';
const snapshot = () => ({ profileIdentity: profile, ready: true, terminal: { state: terminalState, ...(['closed', 'failed', 'cancelled', 'deadline'].includes(terminalState) ? { code: 'synthetic_code' } : {}) }, journal: { complete: terminalState === 'closed' } });
const live = { enabled: true, profileIdentity: profile, snapshot,
  attach() { return { output: (async function* () { for (const item of activeVariants) yield { kind: 'marker', marker: item.marker }; })(),
    done: Promise.resolve(snapshot()), sendAudio() {}, endAudioStream() {}, close() {}, detach() {}, overflow() {} }; } };
const server = createServer();
let origin = '';
const upgrader = createLiveUpgrader({ live, store, origin: () => origin, maxIncomingBytes: 65536, maxBufferedBytes: 1024 * 1024 });
server.on('upgrade', upgrader.handle);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const canonical = [];
try {
  for (const state of terminals) {
    terminalState = state; activeVariants = state === 'closed' ? variants : [];
    const received = [];
    const socket = new WebSocket(origin.replace('http:', 'ws:') + `/api/v1/live-sessions/${sessionID}/audio`, { headers: {
      Authorization: 'Bearer ' + store.adminCredential, 'x-didi-authority-epoch': store.authorityEpoch, 'x-didi-live-profile': profile,
    } });
    socket.on('message', (raw, binary) => { assert.equal(binary, false); received.push(raw.toString()); });
    await once(socket, 'close');
    assert.equal(received.length, activeVariants.length + 1);
    received.forEach((wire, index) => canonical.push({ label: index < activeVariants.length ? activeVariants[index].label : 'terminal-' + state,
      wire, ...(activeVariants[index]?.partial ? { partial: true } : {}) }));
  }
  const malformed = [];
  function mutate(label, sourceLabel, change) {
    const frame = JSON.parse(canonical.find(item => item.label === sourceLabel).wire); change(frame);
    malformed.push({ label, wire: JSON.stringify(frame) });
  }
  mutate('unknown-kind', 'ready', frame => { frame.type = 'unsupported'; });
  mutate('extra-key', 'ready', frame => { frame.extra = true; });
  for (const value of [null, 1, 'true']) mutate('finished-' + String(value), 'inputTranscription-partial', frame => { frame.finished = value; });
  mutate('missing-text', 'outputTranscription-partial', frame => { delete frame.text; });
  mutate('text-not-string', 'inputTranscription-partial', frame => { frame.text = 1; });
  mutate('sequence-zero', 'ready', frame => { frame.sequence = 0; });
  mutate('sequence-bool', 'ready', frame => { frame.sequence = true; });
  mutate('ordinary-sequence-null', 'ready', frame => { frame.sequence = null; });
  mutate('journal-zero', 'ready', frame => { frame.journalSequence = 0; });
  mutate('value-number', 'waitingForInput-true', frame => { frame.value = 1; });
  mutate('tool-extra-field', 'toolCall-null', frame => { frame.tool.extra = true; });
  mutate('tool-call-wrong-status', 'toolCall-null', frame => { frame.tool.status = 'completed'; });
  mutate('tool-result-wrong-status', 'toolResult-completed-null', frame => { frame.tool.status = 'called'; });
  mutate('tool-result-missing-sources', 'toolResult-completed-null', frame => { delete frame.tool.sources; });
  mutate('tool-source-extra-field', 'toolResult-completed-null', frame => { frame.tool.sources[0].extra = true; });
  mutate('tool-sequence-string', 'toolCall-null', frame => { frame.sequence = '1'; });
  mutate('continuity-extra-key', 'continuity-rebuilding', frame => { frame.extra = true; });
  mutate('continuity-unknown-event', 'continuity-rebuilding', frame => { frame.event = 'unsupported'; });
  mutate('terminal-extra-key', 'terminal-closed', frame => { frame.extra = true; });
  mutate('terminal-unknown-state', 'terminal-closed', frame => { frame.state = 'unsupported'; });
  mutate('terminal-complete-number', 'terminal-closed', frame => { frame.complete = 1; });
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  let output = ''; child.stdout.on('data', data => { output += data.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  child.stdin.end(JSON.stringify({ canonical, malformed }));
  const [code, signal] = await once(child, 'exit'); clearTimeout(timer);
  assert.equal(signal, null); assert.equal(code, expectation === 'red' ? 1 : 0);
  const receipt = JSON.parse(output);
  if (expectation === 'red') {
    assert.ok(receipt.canonicalRejected.includes('inputTranscription-partial'));
    assert.ok(receipt.canonicalRejected.includes('outputTranscription-partial'));
    assert.ok(receipt.canonicalRejected.includes('toolCall-null'));
    assert.ok(receipt.canonicalRejected.includes('toolResult-completed-null'));
  } else { assert.equal(receipt.success, true); assert.equal(receipt.partialStayedUnknown, true); }
  console.log(JSON.stringify({ ...receipt, expectation, nativePID: child.pid, unforced: true, actualCanonicalWebSocketProducer: true }));
} finally {
  await upgrader.close(); await new Promise(resolve => server.close(resolve)); store.close();
  console.log('CANONICAL FRAME CLEANUP server=true sockets=true syntheticStore=true');
}
