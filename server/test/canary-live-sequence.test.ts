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
import { listenService } from '../http/server.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { fixture, fixtureUntil, CANARY } from './live-voice-fixture.js';
import { syntheticTaskFactory } from './synthetic-task.js';

// Reject the silent /run failure between provider readiness and the first owner ask.
// This uses the production owner, HTTP handler, upgrader and Gemini wire adapter.
test('installed canary HTTP/socket/run sequence reaches a real task after provider readiness', async t => {
  const provider = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-canary-sequence-'));
  const store = new Store(dir, [...createDomainPort({ outbox: Outbox }).migrations, ...chatMigrations, ...liveMigrations]);
  const live = composeLive(store, dir, {
    profile: validateLiveProfile({ provider: 'gemini', liveModelId: 'models/live-session-test', voice: 'ExplicitVoice', keyReference: 'test-reference', route: { enabled: true, provider: 'gemini', modelId: 'models/live-session-test', dataClasses: ['ordinary'] }, prompt: { text: 'Synthetic system', dataClass: 'ordinary' } }),
    credentials: { resolve: async () => CANARY }, socketFactory: provider.socketFactory,
    createTaskRuntime: syntheticTaskFactory(store),
  }).service;
  const service = await listenService({ store, live, port: 0 });
  t.diagnostic(`CANARY SEQUENCE port=${new URL(service.origin).port} pid=${process.pid}`);
  const events: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { if (raw && typeof raw === 'object') events.push(raw as Record<string, unknown>); } });
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
  provider.send({ setupComplete: {} });
  await fixtureUntil(() => provider.frames.length > 1, 'canary owner text reaches provider');
  await fixtureUntil(() => events.some(event => event['event'] === 'task_lifecycle' && event['phase'] === 'start'), 'real task lifecycle starts');
  const response = await running;
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const report = (await response.json()).data;
  assert.match(report.lines.join('\n'), new RegExp(`callId=${snapshot.liveSessionId}`));
  // No real task_tool receipt in this fixture: it must remain red.
  assert.ok(report.failed > 0);
});
