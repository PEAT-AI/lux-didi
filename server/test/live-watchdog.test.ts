import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, liveMigrations, RESPONSE_WATCHDOG_NUDGE_MS, RESPONSE_WATCHDOG_RECOVERY_MS,
  validateLiveProfile, type LiveContext, type LiveSessionOwner } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { fakeLiveVoicePort, type FakeLiveVoice, type FakeLiveVoiceEvent } from './fixtures/fake-live-voice.js';
import { pcm } from './live-voice-fixture.js';

const NOW = 1_700_000_000_000;
const MODEL = 'models/live-watchdog-test';
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
  owner: LiveSessionOwner; fake: FakeLiveVoice; receipts: Record<string, unknown>[]; liveSessionId: string;
  emit(event: FakeLiveVoiceEvent): Promise<void>; sendAudio(): void; advance(ms: number): Promise<void>;
}

/** Open one owner session on the fake port with an injected clock, and capture the 3j receipts. */
async function openLive(t: TestContext, overrides: { limits?: Record<string, number>; capabilities?: Parameters<typeof fakeLiveVoicePort>[0] } = {}): Promise<Live> {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-watchdog-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  const ctx: LiveContext = { clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch };
  const scheduler = new DeadlineClock();
  const fake = fakeLiveVoicePort(overrides.capabilities ?? {});
  const profile = validateLiveProfile({
    provider: 'gemini', liveModelId: MODEL, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    limits: { handshakeMs: 1000, idleMs: 600_000, sessionMs: 1_200_000, closeMs: 50, ...overrides.limits },
  });
  const receipts: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => {
    const record = raw as Record<string, unknown>;
    if (record.event === 'live_watchdog' || record.event === 'live_turn_open' || record.event === 'live_dead_air_nudge' || record.event === 'live_recovery') receipts.push(record);
  } });
  t.after(() => { detach(); rmSync(dir, { recursive: true, force: true }); });
  const owner = createLiveSessionOwner({ store, voice: fake.port, profile, now: () => scheduler.now, timeZone: 'Asia/Kolkata', schedule: scheduler.schedule });
  const session = owner.create({ idempotencyKey: `watchdog-${dir}`, inputClass: 'ordinary' }, ctx);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, ctx);
  await attachment.ready;
  return {
    owner, fake, receipts, liveSessionId: session.liveSessionId,
    emit: async event => { fake.emit(event); await flush(); },
    sendAudio: () => attachment.sendAudio({ pcm }),
    advance: async ms => { scheduler.now += ms; scheduler.runDue(); await flush(); },
  };
}

const phases = (live: Live): unknown[] => live.receipts.filter(record => record.event === 'live_watchdog').map(record => record.phase);
const ownerTurnEnd = (live: Live): Promise<void> => live.emit({ type: 'inputTranscription', text: 'what is on my plate', finished: true });
const terminalCode = (live: Live): string | undefined => {
  const terminal = live.owner.get(live.liveSessionId).terminal;
  return terminal !== null && 'code' in terminal ? terminal.code : undefined;
};

/** Drive the injected clock in bounded steps until the condition holds, never sleeping. */
async function until(live: Live, condition: () => boolean, budgetMs = 60_000): Promise<void> {
  for (let spent = 0; spent <= budgetMs && !condition(); spent += 1_000) await live.advance(1_000);
  assert.ok(condition(), 'the watchdog did not reach the expected phase');
}

test('a mute owner turn is nudged once and then recovered on a fresh seeded session', async t => {
  const live = await openLive(t);
  await ownerTurnEnd(live);
  assert.deepEqual(phases(live), ['armed'], 'the ended owner turn owes a reply');
  await until(live, () => phases(live).includes('nudged'), RESPONSE_WATCHDOG_NUDGE_MS + 2_000);
  assert.equal(live.fake.sessionsOpened, 1, 'a nudge is not a recovery');
  await until(live, () => phases(live).includes('recovered'), RESPONSE_WATCHDOG_RECOVERY_MS + 2_000);
  assert.deepEqual(phases(live), ['armed', 'nudged', 'recovered']);
  assert.equal(live.fake.sessionsOpened, 2, 'the recovery opened one fresh session');
  assert.ok((live.fake.requests.at(-1)!.history ?? []).length > 0, 'the fresh session carries the journal seed');
  assert.ok(live.receipts.some(record => record.event === 'live_recovery' && record.path === 'fresh_seeded' && record.reason === 'model_mute'),
    'the recovery is the fresh seeded path with reason model_mute');
});

test('model output after the nudge disarms the watchdog', async t => {
  const live = await openLive(t);
  await ownerTurnEnd(live);
  await until(live, () => phases(live).includes('nudged'));
  await live.emit({ type: 'modelTurnStarted' });
  await live.emit({ type: 'audio', pcm: new Uint8Array(8), mimeType: 'audio/pcm;rate=24000' });
  await live.emit({ type: 'turnComplete' });
  const before = phases(live).length;
  await live.advance(RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 5_000);
  assert.deepEqual(phases(live).slice(before), [], 'a completed turn leaves no watchdog work behind');
  assert.equal(live.fake.sessionsOpened, 1, 'no recovery after the model answered');
  assert.equal(terminalCode(live), undefined, 'the call is still up');
});

test('a second mute inside the window settles the call honestly instead of looping', async t => {
  const live = await openLive(t);
  await ownerTurnEnd(live);
  await until(live, () => phases(live).includes('recovered'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 5_000);
  assert.equal(live.fake.sessionsOpened, 2);
  await flush();
  await ownerTurnEnd(live);
  await until(live, () => phases(live).includes('settled'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 5_000);
  assert.deepEqual(phases(live), ['armed', 'nudged', 'recovered', 'armed', 'nudged', 'settled']);
  assert.equal(live.owner.get(live.liveSessionId).terminal?.state, 'failed', 'a second mute inside the window settles');
  assert.equal(terminalCode(live), 'model_unresponsive');
  assert.equal(live.fake.sessionsOpened, 2, 'a second mute inside the window opens no third session');
});

test('idle measures silence, so it fires with mic frames flowing and no speech, and live_turn_open is recorded', async t => {
  const live = await openLive(t, { limits: { idleMs: 3_000 } });
  await live.emit({ type: 'modelTurnStarted' });
  await live.emit({ type: 'audio', pcm: new Uint8Array(8), mimeType: 'audio/pcm;rate=24000' });
  for (let elapsed = 0; elapsed < 5_000 && !live.receipts.some(record => record.event === 'live_turn_open'); elapsed += 500) {
    live.sendAudio();
    await live.advance(500);
  }
  assert.ok(live.receipts.some(record => record.event === 'live_turn_open'), 'an open model turn with no turnComplete is witnessed');
  assert.equal(terminalCode(live), 'idle_timeout');
});

test('a port with different declarations drives the same watchdog, so it reads port events and no model name', async t => {
  for (const capabilities of [{}, { supportsResumption: true, supportsInterruption: true, outputModalities: ['audio'] as const }]) {
    const live = await openLive(t, { capabilities });
    await ownerTurnEnd(live);
    await until(live, () => phases(live).includes('recovered'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 5_000);
    assert.deepEqual(phases(live), ['armed', 'nudged', 'recovered']);
    assert.equal(live.fake.sessionsOpened, 2, 'the recovery is fresh seeded even when resumption is supported');
  }
});
