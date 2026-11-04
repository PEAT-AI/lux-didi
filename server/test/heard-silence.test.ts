import { liveTaskFixture } from './live-task-fixture.js';
import { fixtureUntil } from './live-voice-fixture.js';
import { syntheticTaskFactory } from './synthetic-task.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile,
  type LiveContext, type LiveOutputChunk, type LiveSessionOwner } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { fakeLiveVoicePort, type FakeLiveVoice, type FakeLiveVoiceEvent } from './fixtures/fake-live-voice.js';

const NOW = 1_700_000_000_000;
const MODEL = 'models/heard-silence-test';
const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

/** A dead-air clock: nothing sleeps, the test moves time and the owner's timers fire in due order. */
class DeadlineClock {
  now = NOW;
  readonly pending = new Set<{ due: number; callback: () => void }>();
  schedule = (callback: () => void, delayMs: number) => {
    assert.ok(delayMs > 0, 'a zero-delay loop is a bug, not a schedule');
    const entry = { due: this.now + delayMs, callback };
    this.pending.add(entry);
    return { unref: () => {}, cancel: () => { this.pending.delete(entry); } };
  };
  runDue(): void {
    for (;;) {
      const entry = [...this.pending].find(item => item.due <= this.now);
      if (!entry) return;
      this.pending.delete(entry);
      entry.callback();
    }
  }
}

interface Live {
  owner: LiveSessionOwner;
  fake: FakeLiveVoice;
  receipts: Record<string, unknown>[];
  liveSessionId: string;
  output: LiveOutputChunk[];
  emit(event: FakeLiveVoiceEvent): Promise<void>;
  advance(ms: number): Promise<void>;
}

/** Open one owner session on the fake port with an injected clock, and keep every host log record. */
async function openLive(t: TestContext): Promise<Live> {
  const dir = mkdtempSync(join(tmpdir(), 'didi-heard-silence-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  const ctx: LiveContext = { clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch };
  const scheduler = new DeadlineClock();
  const fake = fakeLiveVoicePort();
  const receipts: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => { detach(); rmSync(dir, { recursive: true, force: true }); });
  const profile = validateLiveProfile({
    provider: 'gemini', liveModelId: MODEL, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    limits: { handshakeMs: 1000, idleMs: 600_000, sessionMs: 1_200_000, closeMs: 50 },
  });
  const owner = createLiveSessionOwner({ createTaskRuntime: syntheticTaskFactory(store), store, voice: fake.port, profile, now: () => scheduler.now,
    timeZone: 'Asia/Kolkata', schedule: scheduler.schedule });
  const session = owner.create({ idempotencyKey: `heard-${randomUUID()}`, inputClass: 'ordinary' }, ctx);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, ctx);
  await attachment.ready;
  const output: LiveOutputChunk[] = [];
  void (async () => { for await (const chunk of attachment.output) output.push(chunk); })();
  return { owner, fake, receipts, liveSessionId: session.liveSessionId, output,
    emit: async event => { fake.emit(event); await flush(); },
    advance: async ms => { scheduler.now += ms; scheduler.runDue(); await flush(); } };
}

/** One final owner transcription segment, the shape the provider emits per finished fragment. */
const ownerSaid = (live: Live, text: string): Promise<void> => live.emit({ type: 'inputTranscription', text, finished: true });
const modelTurn = (live: Live): Promise<void> => live.emit({ type: 'modelTurnStarted' });
const audible = (live: Live): Promise<void> => live.emit({ type: 'audio', pcm: new Uint8Array(960), rate: 24_000, audible: true, rmsDbfs: -20 });

const heard = (live: Live): Record<string, unknown>[] => live.receipts.filter(record => record.event === 'live_heard_silence');
const deadAir = (live: Live): Record<string, unknown>[] => live.receipts.filter(record => record.event === 'live_dead_air');

test('task delivery: provider acceptance settles without transcript and never retries', async t => {
  let calls = 0;
  const f = await liveTaskFixture(t, async () => { calls++; return { text: 'The synthetic task answer.', calls: [] }; }, { clock: true });
  f.bind(); f.finalize('Do the synthetic task.'); const answer = await f.answer();
  assert.equal(f.store.transaction(tx => tx.get('SELECT state FROM task_deliveries WHERE state != ?', ['attached']))?.state, 'pending');
  f.voice.emit({ type: 'commentaryAccepted', commandId: answer.commandId }); await f.flush();
  t.mock.timers.tick(30_000); await f.flush();
  assert.equal(f.voice.sessionsOpened, 1); assert.equal(f.voice.taskAnswers.length, 1); assert.equal(calls, 1);
  assert.equal(f.store.transaction(tx => tx.get('SELECT state FROM task_deliveries WHERE state != ?', ['attached']))?.state, 'delivered');
});

test('task delivery: transcription does not replay an acknowledged answer', async t => {
let calls = 0;
const f = await liveTaskFixture(t, async () => { calls++; return { text: 'The synthetic task answer.', calls: [] }; }, { clock: true });
f.bind(); f.finalize('Do the synthetic task.'); const answer = await f.answer();
f.voice.emit({ type: 'commentaryAccepted', commandId: answer.commandId }); f.voice.emit({ type: 'outputTranscription', text: answer.text, finished: true }); await f.flush();
t.mock.timers.tick(15_000); await f.flush(); assert.equal(f.voice.sessionsOpened, 1); assert.equal(calls, 1);
assert.equal(f.voice.taskAnswers.length, 1, 'acceptance already settled delivery');
});

test('L-05: three fragments of one utterance produce one measurement, not three', async t => {
  const live = await openLive(t);
  await ownerSaid(live, 'what is');
  await live.advance(1_000);
  await ownerSaid(live, 'on my');
  await live.advance(1_000);
  await ownerSaid(live, 'plate');
  await live.advance(2_000);
  await modelTurn(live);
  await audible(live);
  assert.equal(deadAir(live).length, 1, 'one dead-air measurement for one utterance');
  const deadAirMs = Number(deadAir(live)[0]!['deadAirMs']);
  assert.ok(deadAirMs >= 1_900 && deadAirMs <= 2_100, `the dead air counts from the last fragment of the utterance, not its first: ${deadAirMs} ms`);
  const events = heard(live);
  assert.equal(events.length, 1, 'one heard-silence measurement for one utterance');
  const ms = Number(events[0]!['ms']);
  assert.ok(ms >= 1_900 && ms <= 2_100, `the wait after the last fragment is about 2 s, not ${ms} ms`);
  assert.equal(events[0]!['silence'], 'owner', 'the wait followed the owner\'s own utterance, not a tool and not the provider');
});

test('task delivery: prior idle silence cannot create an acknowledgement deadline', async t => {
  const f = await liveTaskFixture(t, async () => ({ text: 'The synthetic task answer.', calls: [] }), { clock: true });
  t.mock.timers.tick(10_000); f.bind(); f.finalize('Give the synthetic task answer.'); const answer = await f.answer();
  f.voice.emit({ type: 'commentaryAccepted', commandId: answer.commandId }); await f.flush();
  t.mock.timers.tick(30_000); await f.flush();
  assert.equal(f.voice.sessionsOpened, 1); assert.equal(f.voice.taskAnswers.length, 1);
});
