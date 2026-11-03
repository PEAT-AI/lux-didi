import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { chatMigrations } from '../chat/index.js';
import { toolsMigrations } from '../tools/index.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile } from '../live/index.js';
import type { LiveVoiceEvent, LiveVoicePort } from '../adapters/live-voice/types.js';
import { hostTaskFactory } from '../tasks/host.js';
import { resolveTaskModels } from '../config/tasks.js';
import type { Inference } from '../tasks/worker.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { fakeLiveVoicePort } from './fixtures/fake-live-voice.js';
type ProviderEvent<T = LiveVoiceEvent> = T extends { sequence: number } ? Omit<T, 'sequence'> : never;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'task-correction-synthetic-'));
  const store = new Store(directory, [...domainMigrations, ...chatMigrations, ...toolsMigrations, ...liveMigrations]);
  const fake = fakeLiveVoicePort({ provider: 'openai' }), appended: string[] = [], receipts: Record<string, unknown>[] = [];
  const inference: ((value: Inference) => void)[] = [];
  const voice: LiveVoicePort = { capabilities: fake.port.capabilities, open: (request, control) => ({ ...fake.port.open(request, control),
    sendTaskAnswer: ({ text }) => { appended.push(text); return `synthetic-command-${appended.length}`; },
  }) };
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  const profile = validateLiveProfile({ provider: 'openai', liveModelId: 'gpt-live-1', voice: 'cedar', keyReference: 'synthetic-reference',
    audio: { inputRate: 8000, outputRate: 24000 }, route: { enabled: true, provider: 'openai', modelId: 'gpt-live-1', dataClasses: ['ordinary'] }, prompt: { text: 'Synthetic task voice', dataClass: 'ordinary' },
    limits: { handshakeMs: 1000, idleMs: 600000, sessionMs: 1200000, closeMs: 50 } });
  const owner = createLiveSessionOwner({ store, voice, profile, timeZone: 'UTC',
    createTaskRuntime: hostTaskFactory({ store, credentials: { resolve: async () => undefined }, models: resolveTaskModels(undefined), bindings: () => [],
      contentAllowed: () => false, timeZone: 'UTC', effectCheck: async () => true,
      infer: async () => new Promise<Inference>(resolve => { inference.push(resolve); }),
    }),
  });
  t.after(async () => { try { await owner.shutdown(); } finally { sink(); store.close(); rmSync(directory, { recursive: true, force: true }); } });
  const context = { clientId: 'synthetic-client', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
  const session = owner.create({ inputClass: 'ordinary', idempotencyKey: 'synthetic-correction' }, context);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, context); await attachment.ready; await flush();
  // The shared synthetic queue carries the new delegation receipts without changing its transport behavior.
  const emit = async (event: ProviderEvent) => { (fake.emit as (event: ProviderEvent) => void)(event); await flush(); };
  return { emit, appended, receipts, inference, requests: fake.requests };
}
test('VOICE-R12: final correction invalidates a speech-held old answer before releasing delivery', async t => {
  const f = await fixture(t);
  await f.emit({ type: 'delegation', delegationId: 'synthetic-delegation' });
  await f.emit({ type: 'inputTranscription', text: 'Synthetic request A', finished: true, finalOrigin: 'provider' });
  assert.equal(f.inference.length, 1);
  await f.emit({ type: 'audio', pcm: new Uint8Array(480), rate: 24000, audible: true });
  f.inference[0]!({ text: 'Synthetic answer A.', calls: [] }); await flush(); assert.deepEqual(f.appended, []);
  await f.emit({ type: 'inputTranscription', text: 'Synthetic correction B', finished: false });
  await f.emit({ type: 'turnComplete' });
  await f.emit({ type: 'inputTranscription', text: '', finished: true, finalOrigin: 'provider' });
  assert.equal(f.inference.length, 2); assert.deepEqual(f.appended, [], 'answer A must never be appended while B becomes current');
});
test('VOICE-R12 paired valid: a current speech-held answer is released and heard after speech ends', async t => {
  const f = await fixture(t);
  await f.emit({ type: 'delegation', delegationId: 'synthetic-delegation' });
  await f.emit({ type: 'inputTranscription', text: 'Synthetic current request', finished: true, finalOrigin: 'provider' });
  await f.emit({ type: 'audio', pcm: new Uint8Array(480), rate: 24000, audible: true });
  f.inference[0]!({ text: 'Synthetic current answer.', calls: [] }); await flush(); assert.deepEqual(f.appended, []);
  await f.emit({ type: 'interrupted' });
  await f.emit({ type: 'turnComplete' });
  await f.emit({ type: 'inputTranscription', text: '', finished: true, finalOrigin: 'provider' });
  assert.deepEqual(f.appended, ['Synthetic current answer.']);
  await f.emit({ type: 'commentaryAccepted', commandId: 'synthetic-command-1' });
  await f.emit({ type: 'outputTranscription', text: 'Synthetic current answer.', finished: true });
  assert.ok(f.receipts.some(event => event.event === 'task_delivery' && event.state === 'heard'));
});

for (const status of ['waiting', 'heard', 'stale'] as const) test(`VOICE-R14: ordinary provider rebuild seeds only a waiting current answer (${status})`, async t => {
  const f = await fixture(t);
  await f.emit({ type: 'delegation', delegationId: 'synthetic-delegation' });
  await f.emit({ type: 'inputTranscription', text: 'Synthetic rebuild request', finished: true, finalOrigin: 'provider' });
  f.inference[0]!({ text: 'Synthetic waiting rebuild answer.', calls: [] }); await flush();
  assert.deepEqual(f.appended, ['Synthetic waiting rebuild answer.']);
  if (status === 'heard') {
    await f.emit({ type: 'commentaryAccepted', commandId: 'synthetic-command-1' });
    await f.emit({ type: 'outputTranscription', text: 'Synthetic waiting rebuild answer.', finished: true });
  }
  if (status === 'stale') await f.emit({ type: 'inputTranscription', text: 'Synthetic replacement request', finished: true, finalOrigin: 'provider' });
  await f.emit({ type: 'goAway', timeLeftMs: 10000 });
  assert.equal(f.requests.length, 2, 'the provider recovery must open a fresh actual session request');
  const request = f.requests[1]!;
  if (status === 'waiting') {
    assert.match(request.system.text, /Synthetic waiting rebuild answer/);
    assert.match(request.system.text, /first spoken output must be exactly/);
    assert.equal(request.opening, 'user_first'); assert.equal(request.openingText, undefined);
  } else assert.doesNotMatch(request.system.text, /Synthetic waiting rebuild answer/);
});
