// The sequence check also executes the affected OpenAI typed-input adapter contracts.
import './openai-live-voice.test.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Store } from '../runtime/store.js';
import { createDomainPort } from '../domain/facade.js';
import { Outbox } from '../runtime/outbox.js';
import { chatMigrations } from '../chat/index.js';
import { liveMigrations, validateLiveProfile } from '../live/index.js';
import { composeLive } from '../host/live.js';
import { HostLog } from '../host/log.js';
import { listenService } from '../http/server.js';
import { attachHostLogSink, hostLogEvent } from '../tools/host-events.js';
import { fixture, CANARY } from './openai-live-voice-fixture.js';
import { hostTaskFactory } from '../tasks/host.js';
import { resolveTaskModels } from '../config/tasks.js';

// Reject the silent /run failure between provider readiness and the first owner ask.
// This uses the production owner, HTTP handler, upgrader and OpenAI wire adapter.
test('installed canary HTTP/socket/run sequence reaches a real task after provider readiness', async t => {
  const provider = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-canary-sequence-'));
  const store = new Store(dir, [...createDomainPort({ outbox: Outbox }).migrations, ...chatMigrations, ...liveMigrations]);
  const live = composeLive(store, dir, {
    profile: validateLiveProfile({ provider: 'openai', liveModelId: 'gpt-live-1', voice: 'ExplicitVoice', keyReference: 'test-reference', route: { enabled: true, provider: 'openai', modelId: 'gpt-live-1', dataClasses: ['ordinary'] }, prompt: { text: 'Synthetic system', dataClass: 'ordinary' } }),
    credentials: { resolve: async () => CANARY }, socketFactory: provider.socketFactory,
    createTaskRuntime: hostTaskFactory({ store, credentials: { resolve: async () => undefined }, models: resolveTaskModels(undefined), bindings: () => [], executors: () => ({}), timeZone: 'UTC', log: hostLogEvent, infer: async () => ({ text: '', calls: [], no_action: true }), effectCheck: async () => true }),
  }).service;
  const service = await listenService({ store, live, port: 0 });
  t.diagnostic(`CANARY SEQUENCE port=${new URL(service.origin).port} pid=${process.pid}`);
  const hostLog = new HostLog(dir);
  const events: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { if (raw && typeof raw === 'object') events.push(raw as Record<string, unknown>); hostLog.event(raw); } });
  let socket: WebSocket | undefined;
  t.after(async () => {
    detach(); socket?.terminate(); await live.shutdown(); await service.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${store.adminCredential}`, 'x-didi-authority-epoch': store.authorityEpoch, 'content-type': 'application/json' };
  const post = (step: string, body: unknown) => fetch(`${service.origin}/api/v1/live-canary/${step}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const asks = JSON.parse(readFileSync(join(process.env['DIDI_TEST_SOURCE_ROOT'] ?? join(process.cwd(), 'server/test'), '../../scripts/fixtures/canary-asks.example.json'), 'utf8'));
  const opened = await post('open', { asks, deadline: Date.now() + 30_000 });
  assert.equal(opened.status, 200, JSON.stringify(await opened.clone().json()));
  const snapshot = (await opened.json()).data;
  socket = new WebSocket(`${service.origin.replace('http:', 'ws:')}/api/v1/live-sessions/${snapshot.liveSessionId}/audio`, { headers });
  socket.on('message', () => {});
  await once(socket, 'open');
  await provider.frame(1);
  const running = post('run', { sessionId: snapshot.liveSessionId });
  provider.send({ type: 'session.started', session: { id: 'sess_canary' } });
  const response = await running;
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.ok(events.some(event => event['event'] === 'task_lifecycle' && event['phase'] === 'start'), 'real task lifecycle starts');
  assert.ok(provider.frames.some(frame => JSON.stringify(frame).includes(asks[0].finals[0])), 'ask reaches provider');
  const report = (await response.json()).data;
  assert.match(report.lines.join('\n'), new RegExp(`callId=${snapshot.liveSessionId}`));
  // No real task_tool receipt in this fixture: it must remain red.
  assert.ok(report.failed > 0);
  const steps = events.filter(event => event['event'] === 'canary_step');
  assert.deepEqual(steps.map(event => event['step']), ['ready_wait', 'ready_waited', 'ask_injected', 'settled', 'terminal']);
  const persisted = readFileSync(hostLog.path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>).filter(event => event['event'] === 'canary_step');
  assert.equal(persisted.length, steps.length, 'no actual step emitter is dropped before host.log');
  for (const [index, event] of steps.entries()) {
    assert.deepEqual(Object.keys(event).sort(), ['callId', 'code', 'event', 'ms', 'step']);
    assert.equal(event['callId'], snapshot.liveSessionId);
    for (const key of Object.keys(event)) assert.equal(persisted[index]![key], event[key]);
  }
});
