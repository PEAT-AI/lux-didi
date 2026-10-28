import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, AUDIBLE_DEBT_RUNG_MS, liveMigrations, validateLiveProfile,
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
  const owner = createLiveSessionOwner({ store, voice: fake.port, profile, now: () => scheduler.now,
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
const toolCall = (live: Live): Promise<void> => live.emit({ type: 'toolCall',
  calls: [{ id: 'heard-1', name: 'search_knowledge', args: { query: 'plate', limit: 1 } }] } as unknown as FakeLiveVoiceEvent);

const heard = (live: Live): Record<string, unknown>[] => live.receipts.filter(record => record.event === 'live_heard_silence');
const deadAir = (live: Live): Record<string, unknown>[] => live.receipts.filter(record => record.event === 'live_dead_air');
const nudges = (live: Live): Record<string, unknown>[] => live.receipts.filter(record => record.event === 'live_dead_air_nudge');

test('L-04: a fast tool and 6 s of model latency produce one heard-silence event of about 6 s', async t => {
  const live = await openLive(t);
  await ownerSaid(live, 'what is on my plate');
  await live.advance(200);
  await modelTurn(live);
  await audible(live);
  assert.equal(heard(live).length, 0, 'a 200 ms preamble latency is not a reported wait');
  await toolCall(live);
  await live.advance(50);
  assert.equal(live.fake.toolResponses.length, 1, 'the fast tool answered');
  assert.equal(heard(live).length, 0, 'the tool output is not the end of the wait');
  await live.advance(6_000);
  await modelTurn(live);
  await audible(live);
  const events = heard(live);
  assert.equal(events.length, 1, 'one event per wait, not one event per transcription fragment');
  const ms = Number(events[0]!['ms']);
  assert.ok(ms >= 5_900 && ms <= 6_300, `the wait the owner heard is about 6 s, not ${ms} ms`);
  assert.equal(events[0]!['silence'], 'provider', 'H-02: the tool had already returned, so the provider owned that silence');
});

test('L-04: the audible-debt rung is anchored at the last audible frame, not at the tool output', async t => {
  const live = await openLive(t);
  await ownerSaid(live, 'what is on my plate');
  await live.advance(200);
  await modelTurn(live);
  await audible(live);
  // Two seconds of silence between the preamble and the tool: the rung counts them, the tool does not reset them.
  await live.advance(2_000);
  await toolCall(live);
  await live.advance(50);
  assert.equal(live.fake.toolResponses.length, 1, 'the tool answered in 50 ms');
  const remaining = AUDIBLE_DEBT_RUNG_MS - 2_050;
  await live.advance(remaining - 1);
  assert.equal(nudges(live).length, 0, 'the rung is not moved out by the 2 s the owner already waited');
  await live.advance(1);
  assert.equal(nudges(live).length, 1, 'the rung fires 8 s after the last audible frame');
  assert.equal(nudges(live)[0]!['elapsedMs'], AUDIBLE_DEBT_RUNG_MS);
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

test('L-04: a tool turn with no preamble is anchored at the arm time, not at an earlier turn\'s audio', async t => {
  const live = await openLive(t);
  // The previous turn did speak, and that frame is the only model audio in the session.
  await ownerSaid(live, 'what is on my plate');
  await live.advance(200);
  await modelTurn(live);
  await audible(live);
  await live.emit({ type: 'turnComplete' });
  // Ten seconds later a lookup with no preamble at all: the earlier frame must not shorten this rung.
  await live.advance(10_000);
  await ownerSaid(live, 'and my mail');
  await live.advance(100);
  await toolCall(live);
  await live.advance(50);
  assert.equal(live.fake.toolResponses.length, 1, 'the fast tool answered');
  await live.advance(AUDIBLE_DEBT_RUNG_MS - 1_000);
  assert.equal(nudges(live).length, 0, 'a previous turn\'s model audio is not this turn\'s anchor');
  assert.equal(live.fake.sessionsOpened, 1, 'no rebuild over a wait the rung has not rung on');
  await live.advance(1_000);
  assert.equal(nudges(live).length, 1, 'the rung fires 8 s after the tool output');
});
