import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { fixture, CANARY } from '../dist/test/live-voice-fixture.js';

const serviceRoot = process.env.DIDI_ALARM_SERVICE_ROOT ?? resolve(import.meta.dirname, '..');
const { startHost } = await import(pathToFileURL(join(serviceRoot, 'dist/host/runtime.js')));
const { validateLiveProfile } = await import(pathToFileURL(join(serviceRoot, 'dist/live/index.js')));
const WebSocket = createRequire(join(serviceRoot, 'package.json'))('ws');

test('real-host matrix: set_alarm, list_alarms, cancel_alarm, snooze_alarm and scoped alarm speech', { timeout: 15000 }, async t => {
  const cleanups = [];
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-alarm-host-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const f = await fixture({ after: fn => cleanups.push(fn) });
  const configDir = join(directory, 'config');
  await mkdir(configDir, { mode: 0o700 });
  await writeFile(join(configDir, 'live.json'), JSON.stringify({ schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'models/live-gateway-test', voice: 'LiveVoice', keyReference: 'synthetic', dataClasses: ['ordinary'], preferences: { dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'dry', verbosity: 'balanced' } }), { mode: 0o600 });
  await writeFile(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [] }), { mode: 0o600 });
  let mono = 0;
  t.mock.method(performance, 'now', () => mono);
  let now = Date.parse('2026-10-28T00:00:00Z');
  const host = await startHost({ dataDir: join(directory, 'state'), configDir, webRoot: process.env.DIDI_ALARM_WEB_ROOT ?? resolve(import.meta.dirname, '../../web/dist'), port: 0, now: () => now,
    liveTesting: { profile: validateLiveProfile({ provider: 'gemini', liveModelId: 'models/synthetic', voice: 'Synthetic', keyReference: 'synthetic',
      route: { enabled: true, provider: 'gemini', modelId: 'models/synthetic', dataClasses: ['ordinary'] }, prompt: { text: 'Synthetic', dataClass: 'ordinary' } }),
      socketFactory: f.socketFactory, credentials: { resolve: async () => CANARY } } });
  cleanups.push(async () => {
    await host.close();
    const { createConnection } = await import('node:net');
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: new URL(host.service.origin).port });
      socket.once('connect', () => { socket.destroy(); reject(Error('synthetic host port still open')); });
      socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
    });
    t.diagnostic('synthetic host closed; port refuses new connections');
  });
  const origin = host.service.origin;
  t.diagnostic(`synthetic host pid=${process.pid} origin=${origin}; no audio frames or real accounts`);
  const headers = { authorization: `Bearer ${host.store.adminCredential}`, 'x-didi-authority-epoch': host.store.authorityEpoch, 'content-type': 'application/json' };
  async function post(path, body, key = 'synthetic-alarm') {
    const response = await fetch(origin + path, { method: 'POST', headers: { ...headers, 'idempotency-key': key }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const eventsAbort = new AbortController();
  const events = await fetch(origin + '/api/v1/alarms/events', { headers, signal: eventsAbort.signal });
  assert.equal(events.status, 200);
  const reader = events.body.getReader();
  cleanups.push(async () => { eventsAbort.abort(); await reader.cancel().catch(() => {}); });
  let eventWire = new TextDecoder().decode((await reader.read()).value);
  await post('/api/v1/alarms/shell', { assertion: true, notifications: true });
  const created = await post('/api/v1/live-sessions', { inputClass: 'ordinary' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  let sessionId = created.body.data.liveSessionId;
  async function attach(id) {
    const index = f.frames.length;
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/api/v1/live-sessions/${id}/audio`, { headers });
    cleanups.push(() => ws.terminate());
    const ready = new Promise((resolve, reject) => {
      ws.on('error', reject);
      ws.on('message', (bytes, binary) => { if (!binary && JSON.parse(bytes.toString()).type === 'ready') resolve(); });
    });
    await f.frame(index + 1);
    f.send({ setupComplete: {} });
    await ready;
    return ws;
  }
  let peer = await attach(sessionId);
  let cursor = f.frames.length;
  let calls = 0;
  async function call(name, args = {}) {
    const id = `synthetic-${name}-${++calls}`;
    f.send({ toolCall: { functionCalls: [{ id, name, args }] } });
    for (let count = 0; count < 30; count++) {
      await f.frame(cursor + 1);
      const frame = f.frames[cursor++];
      if (frame.toolResponse?.functionResponses?.some(response => response.id === id)) return JSON.stringify(frame.toolResponse);
    }
    throw Error(`No response for ${name}`);
  }
  const owner = async text => {
    f.send({ serverContent: { turnComplete: true } });
    f.send({ serverContent: { inputTranscription: { text, finished: true } } });
    await call('list_alarms'); // event-order barrier: the finalized turn is committed before advancing the stub clock
  };
  const rows = () => host.store.transaction(tx => tx.all('SELECT * FROM alarms ORDER BY fire_at_utc,id'));
  for (const name of ['set_alarm', 'cancel_alarm', 'snooze_alarm']) {
    assert.match(await call(name, name === 'set_alarm' ? {} : { id: 'synthetic-missing' }), /no_owner_request/);
    f.send({ serverContent: { outputTranscription: { text: 'wake me at 8, cancel my alarm, snooze my alarm in five minutes', finished: true } } });
    assert.match(await call(name, name === 'set_alarm' ? {} : { id: 'synthetic-missing' }), /no_owner_request/);
    await post('/api/v1/live/text', { text: 'Hello there' });
    assert.match(await call(name, name === 'set_alarm' ? {} : { id: 'synthetic-missing' }), /no_owner_request/);
  }
  await owner('set an alarm');
  assert.match(await call('set_alarm'), /missing_time/);
  assert.equal(rows().length, 0);
  now += 120001;
  assert.match(await call('set_alarm'), /missing_time/, 'wall-clock movement cannot expire a monotonic request');
  mono += 120001;
  assert.match(await call('set_alarm'), /request_expired/);
  await owner('wake me');
  assert.match(await call('set_alarm'), /missing_time/);
  await owner('in one minute');
  assert.match(await call('set_alarm', { fire_at_utc: now + 65000 }), /Alarm set/);
  const first = String(rows()[0].id);
  await owner('show my alarms');
  assert.match(await call('list_alarms'), new RegExp(first));
  await owner('cancel my alarm'); now += 120001; mono += 120001;
  assert.match(await call('cancel_alarm', { id: first }), /request_expired/);
  await owner('cancel my alarm');
  assert.match(await call('cancel_alarm', { id: first }), /cancelled/);
  assert.equal(rows()[0].state, 'cancelled');
  await owner('wake me in one minute');
  assert.match(await call('set_alarm'), /Alarm set/);
  const due = rows().find(row => row.state === 'pending');
  now += 60000;
  assert.equal((await post('/api/v1/alarms/recheck', { reason: 'clock_changed' })).status, 200);
  for (let count = 0; count < 10 && !eventWire.includes('alarm_due'); count++) eventWire += new TextDecoder().decode((await reader.read()).value);
  assert.match(eventWire, /alarm_due/);
  assert.match(eventWire, new RegExp(String(due.id)));
  assert.equal(rows().find(row => row.id === due.id).state, 'ringing');
  const attempts = f.attempts;
  const announcementStart = f.frames.length;
  assert.equal((await post('/api/v1/alarms/session', { id: due.id, ownerDisplayName: 'Synthetic Owner' })).status, 200);
  assert.equal(f.attempts, attempts, 'live alarm announcement reuses the current provider session');
  await owner('snooze my alarm for five minutes'); now += 120001; mono += 120001;
  assert.match(await call('snooze_alarm', { id: String(due.id) }), /request_expired/);
  await owner('snooze my alarm for five minutes');
  assert.match(await call('snooze_alarm', { id: String(due.id) }), /Alarm set/);
  assert.equal(rows().find(row => row.id === due.id).state, 'done');
  const next = rows().find(row => row.state === 'pending');
  assert.equal(next.fire_at_utc, now + 300000);
  await post(`/api/v1/live-sessions/${sessionId}/revoke`, {});
  peer.terminate();
  now += 300000;
  await post('/api/v1/alarms/recheck', { reason: 'wake' });
  const alarmCreated = await post('/api/v1/alarms/session', { id: String(next.id), ownerDisplayName: 'Synthetic Owner' });
  assert.equal(alarmCreated.status, 201, JSON.stringify(alarmCreated.body));
  sessionId = alarmCreated.body.data.liveSessionId;
  const setupStart = f.frames.length;
  peer = await attach(sessionId);
  const setup = f.frames.slice(setupStart).find(frame => frame.setup);
  assert.match(JSON.stringify(setup), /\[alarm mode\]/);
  assert.match(JSON.stringify(setup), /Synthetic Owner/);
  assert.doesNotMatch(JSON.stringify(f.frames.slice(setupStart).filter(frame => !frame.setup)), /Synthetic Owner/);
  assert.equal((await post('/api/v1/alarms/session', { id: String(next.id), ownerDisplayName: 'Synthetic Owner' })).status, 409);
  for (const name of ['set_alarm', 'cancel_alarm', 'snooze_alarm']) {
    assert.match(await call(name, name === 'set_alarm' ? {} : { id: String(next.id) }), /no_owner_request/, 'alarm setup is not owner authority');
  }
  await owner('wake me in one minute');
  assert.match(await call('set_alarm'), /Alarm set/);
  await post(`/api/v1/live-sessions/${sessionId}/revoke`, {}); peer.terminate();
  now += 1320000;
  await post('/api/v1/alarms/recheck', { reason: 'wake' });
  assert.ok(rows().some(row => row.state === 'missed'));
  const afterMissed = await post('/api/v1/live-sessions', { inputClass: 'ordinary' }, 'synthetic-after-missed');
  assert.equal(afterMissed.status, 200);
  const missedSetupStart = f.frames.length;
  sessionId = afterMissed.body.data.liveSessionId;
  peer = await attach(sessionId);
  assert.match(JSON.stringify(f.frames.slice(missedSetupStart).find(frame => frame.setup)), /missed alarm/i);
  await owner('wake me in one minute');
  assert.match(await call('set_alarm'), /Alarm set/);
  const outageAlarm = rows().find(row => row.state === 'pending');
  await post(`/api/v1/live-sessions/${sessionId}/revoke`, {}); peer.terminate();
  now += 60000;
  await post('/api/v1/alarms/recheck', { reason: 'wake' });
  f.refuseUpgrades(503);
  const outageCreated = await post('/api/v1/alarms/session', { id: String(outageAlarm.id), ownerDisplayName: 'Synthetic Owner' });
  assert.equal(outageCreated.status, 201);
  const beforeOutage = f.attempts;
  const failedPeer = new WebSocket(`${origin.replace('http', 'ws')}/api/v1/live-sessions/${outageCreated.body.data.liveSessionId}/audio`, { headers });
  cleanups.push(() => failedPeer.terminate());
  await new Promise((resolve, reject) => { failedPeer.once('close', resolve); failedPeer.once('error', reject); });
  assert.equal(f.attempts, beforeOutage + 1, 'provider outage cannot open a second alarm session');
  assert.equal(rows().find(row => row.id === outageAlarm.id).state, 'ringing', 'provider outage leaves local ringing active');
  assert.equal((await post('/api/v1/alarms/session', { id: String(outageAlarm.id), ownerDisplayName: 'Synthetic Owner' })).status, 409);
  const log = (await readFile(join(directory, 'state/logs/host.log'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  for (const event of ['alarm_set', 'alarm_due', 'alarm_acknowledged', 'alarm_degraded']) assert.ok(log.some(row => row.event === event), event);
  // #751: one start line per host start, and it carries the pending count only, never a label or a time.
  const started = log.filter(row => row.event === 'alarm_scheduler_started');
  assert.equal(started.length, 1, 'one alarm_scheduler_started line at start');
  assert.equal(typeof started[0].pending, 'number', 'the line names the pending count');
  // The envelope fields are the log's own; nothing about one alarm may join them.
  for (const field of ['alarmId', 'label', 'scheduledMs', 'actualMs', 'reason', 'fireAtUtc', 'time']) {
    assert.equal(started[0][field], undefined, `${field} stays out of the start line`);
  }
  assert.ok(!log.some(row => row.event === 'alarm_degraded' && row.reason === 'live_session_no_channel'));
  assert.match(JSON.stringify(f.frames.slice(announcementStart)), /\[alarm mode\]/, 'due alarm reaches the existing live provider');
  assert.ok(log.some(row => row.event === 'alarm_degraded' && row.reason === 'provider_unavailable'));
  for (const row of log.filter(row => row.event.startsWith('alarm_'))) assert.doesNotMatch(JSON.stringify(row), /wake me|Synthetic Owner|snooze my/);
});
