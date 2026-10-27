import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, AUDIBLE_DEBT_RUNG_MS, liveMigrations, RESPONSE_WATCHDOG_RECOVERY_MS,
  validateLiveProfile, type LiveContext, type LiveSessionOwner } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { fakeLiveVoicePort, type FakeLiveVoice, type FakeLiveVoiceEvent } from './fixtures/fake-live-voice.js';

/**
 * C-DEADAIR: a finished lookup is spoken within seconds, not after the 8 s nudge. The 2026-10-27 afternoon calls sat
 * through 15 s because the audible-debt rung was deferred seven seconds behind a response the owner could not hear,
 * on top of an eight second base. These cases pin the four second rung, the shortened grace, the spoken-once guard
 * and the provider latency record, all on the fake port with an injected clock: nothing sleeps.
 */

const MODEL = 'gpt-live-dead-air-test';
const NOW = 1_700_000_000_000;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
/** The port delivers on microtask boundaries, so every emitted event is settled before the clock moves. */
const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await tick(); };

/** A dead-air clock: the test moves time and the owner's timers fire in due order. */
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

const portEvent = (event: unknown) => event as never;
const ownerFinal = (text: string) => portEvent({ type: 'inputTranscription', text, finished: true, finalOrigin: 'app_voice' });
const toolCall = (id: string) => portEvent({ type: 'toolCall', calls: [{ id, name: 'search_knowledge', args: { query: 'bridge', limit: 1 } }] });
const audible = () => portEvent({ type: 'audio', pcm: new Uint8Array(4_800), rate: 24_000, audible: true, rmsDbfs: -14 });

/** The dead-air rungs this call has recorded, in order. */
const rungReceipts = (live: DeadAir): Record<string, unknown>[] => live.receipts.filter(record => record.event === 'live_dead_air_nudge');

interface DeadAir {
  owner: LiveSessionOwner; fake: FakeLiveVoice; receipts: Record<string, unknown>[]; scheduler: DeadlineClock;
  emit(event: FakeLiveVoiceEvent): Promise<void>; advance(ms: number): Promise<void>; sentTexts: number;
}

async function openCall(t: TestContext): Promise<DeadAir> {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-dead-air-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  const ctx: LiveContext = { clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch };
  const scheduler = new DeadlineClock();
  const fake = fakeLiveVoicePort({ provider: 'openai' });
  const profile = validateLiveProfile({
    provider: 'openai', liveModelId: MODEL, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'openai', modelId: MODEL, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    limits: { handshakeMs: 1000, idleMs: 600_000, sessionMs: 1_200_000, closeMs: 50 },
  });
  const receipts: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => { detach(); rmSync(dir, { recursive: true, force: true }); });
  const owner = createLiveSessionOwner({ store, voice: fake.port, profile, now: () => scheduler.now, timeZone: 'Asia/Kolkata', schedule: scheduler.schedule });
  const session = owner.create({ idempotencyKey: `dead-air-${randomUUID()}`, inputClass: 'ordinary' }, ctx);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, ctx);
  await attachment.ready;
  await settle();
  return {
    owner, fake, receipts, scheduler, sentTexts: fake.texts.length,
    emit: async event => { fake.emit(event); await settle(); },
    advance: async ms => { scheduler.now += ms; scheduler.runDue(); await settle(); },
  };
}

test('C-DEADAIR: a response that ends after text and no audio hands the result over at once', async t => {
  const live = await openCall(t);
  await live.emit(ownerFinal('What did we decide about the bridge?'));
  await live.emit(toolCall('d1'));
  assert.equal(live.fake.toolResponses.length, 1, 'the lookup answered before the wait starts');
  // The 07:02:59Z shape: the provider writes the answer as text and never makes a sound.
  await live.emit(portEvent({ type: 'modelTurnStarted' }));
  await live.emit(portEvent({ type: 'modelText', text: 'The bridge reopens on Monday.', thought: false }));
  assert.equal(live.fake.texts.length, live.sentTexts, 'nothing is injected while the response is still open');
  await live.emit(portEvent({ type: 'turnComplete' }));
  assert.equal(live.fake.texts.length, live.sentTexts + 1, 'the result goes out the moment the silent response ends');
  assert.equal(rungReceipts(live).length, 0, 'no ladder wait was needed');
  await live.advance(1_000);
  assert.equal(live.fake.texts.length, live.sentTexts + 1, 'the ladder does not deliver the same result again behind it');
});

test('C-DEADAIR: the rung keeps its 8 s base and a silent in-flight response buys only the short grace', async t => {
  const live = await openCall(t);
  await live.emit(ownerFinal('When does the synthetic bridge reopen?'));
  await live.emit(toolCall('d2'));
  // A response the provider announced and never made audible, with no text at all: the ladder owns this one.
  await live.emit(portEvent({ type: 'modelTurnStarted' }));
  await live.advance(AUDIBLE_DEBT_RUNG_MS - 500);
  assert.equal(rungReceipts(live).length, 0, 'the rung is not early');
  for (let spent = 0; spent < 2_000 && rungReceipts(live).length === 0; spent += 250) await live.advance(250);
  const rungs = rungReceipts(live);
  assert.equal(rungs.length, 1, 'a silent in-flight response holds the rung for the grace, never seven seconds');
  assert.equal(rungs[0]?.['elapsedMs'], AUDIBLE_DEBT_RUNG_MS, 'the rung still names the eight second base');
  assert.equal(live.fake.texts.length, live.sentTexts + 1, 'and it delivers the held result');
});

test('C-DEADAIR: a response the owner can hear clears the debt, so the rung never speaks over an answer', async t => {
  const live = await openCall(t);
  await live.emit(ownerFinal('What did we decide about the bridge?'));
  await live.emit(toolCall('d3'));
  await live.emit(audible());
  await live.advance(AUDIBLE_DEBT_RUNG_MS + RESPONSE_WATCHDOG_RECOVERY_MS);
  assert.equal(live.fake.texts.length, live.sentTexts, 'an audible answer is the answer, and nothing is injected behind it');
});

test('C-DEADAIR: the provider latency is recorded apart from the wait, owner final to response to first audio', async t => {
  const live = await openCall(t);
  await live.emit(ownerFinal('What did we decide about the bridge?'));
  await live.emit(toolCall('d4'));
  await live.advance(1_000);
  await live.emit(portEvent({ type: 'modelTurnStarted' }));
  await live.emit(audible());
  const record = live.receipts.find(entry => entry.event === 'live_response_latency');
  assert.ok(record !== undefined, 'the first audible answer records the provider latency');
  assert.equal(typeof record['msSinceOwnerFinal'], 'number');
  assert.equal(typeof record['msSinceResponseCreated'], 'number');
  assert.equal(typeof record['msSinceToolOutput'], 'number');
  assert.ok(Number(record['msSinceOwnerFinal']) >= 1_000, 'the wait is measured from the owner final words');
});
