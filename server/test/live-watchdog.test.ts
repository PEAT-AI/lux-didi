import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, liveMigrations, RESPONSE_WATCHDOG_NUDGE_MS, RESPONSE_WATCHDOG_RECOVERY_MS,
  validateLiveProfile, type LiveContext, type LiveSessionOwner } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { safeEvent } from '../host/log.js';
import { fakeLiveVoicePort, type FakeLiveVoice, type FakeLiveVoiceEvent } from './fixtures/fake-live-voice.js';
import type { LiveVoicePort, LiveVoiceSession } from '../adapters/live-voice/index.js';
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
  /** The owner's injected clock, so a test can date a weak spell against the watchdog's own interval. */
  now(): number;
}

/** The uplink measurement a test plays back through the adapter's existing diagnostics port (W3). */
type MeasuredConnection = { quality: 'ok' | 'weak'; weakAt?: number };

/** Open one owner session on the fake port with an injected clock, and capture the 3j receipts. */
async function openLive(t: TestContext, overrides: { limits?: Record<string, number>; capabilities?: Parameters<typeof fakeLiveVoicePort>[0]; connection?: () => MeasuredConnection } = {}): Promise<Live> {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-watchdog-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  const ctx: LiveContext = { clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch };
  const scheduler = new DeadlineClock();
  const fake = fakeLiveVoicePort(overrides.capabilities ?? {});
  // The fake port measures nothing; a test that needs a connection quality reports it the way an adapter does.
  const port = overrides.connection === undefined ? fake.port : {
    capabilities: fake.port.capabilities,
    open: (liveRequest: Parameters<LiveVoicePort['open']>[0], liveControl: Parameters<LiveVoicePort['open']>[1]) => {
      const opened = fake.port.open(liveRequest, liveControl);
      return { ...opened, diagnostics: () => ({ connection: overrides.connection!() }) } as unknown as LiveVoiceSession;
    },
  } as LiveVoicePort;
  const profile = validateLiveProfile({
    provider: 'gemini', liveModelId: MODEL, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    limits: { handshakeMs: 1000, idleMs: 600_000, sessionMs: 1_200_000, closeMs: 50, ...overrides.limits },
  });
  const receipts: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => {
    const record = raw as Record<string, unknown>;
    if (record.event === 'live_watchdog' || record.event === 'live_turn_open' || record.event === 'live_dead_air_nudge' || record.event === 'live_recovery'
      || record.event === 'live_idle_arm') receipts.push(record);
  } });
  t.after(() => { detach(); rmSync(dir, { recursive: true, force: true }); });
  const owner = createLiveSessionOwner({ store, voice: port, profile, now: () => scheduler.now, timeZone: 'Asia/Kolkata', schedule: scheduler.schedule });
  const session = owner.create({ idempotencyKey: `watchdog-${randomUUID()}`, inputClass: 'ordinary' }, ctx);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, ctx);
  await attachment.ready;
  return {
    owner, fake, receipts, liveSessionId: session.liveSessionId, now: () => scheduler.now,
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

test('an open model turn that emits one chunk and then nothing is nudged once and then recovered', async t => {
  const live = await openLive(t);
  await live.emit({ type: 'modelTurnStarted' });
  for (let chunk = 0; chunk < 5; chunk++) await live.emit({ type: 'audio', pcm: new Uint8Array(8), rate: 24000 });
  assert.deepEqual(phases(live), ['armed'], 'one armed record per turn, not one per audio chunk');
  await until(live, () => phases(live).includes('recovered'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 5_000);
  assert.deepEqual(phases(live), ['armed', 'nudged', 'recovered'], 'a turn that opens and goes quiet is watched to recovery');
  assert.equal(live.fake.sessionsOpened, 2);
});

test('model output after the nudge disarms the watchdog', async t => {
  const live = await openLive(t);
  await ownerTurnEnd(live);
  await until(live, () => phases(live).includes('nudged'));
  await live.emit({ type: 'modelTurnStarted' });
  await live.emit({ type: 'audio', pcm: new Uint8Array(8), rate: 24000 });
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

// W3 requirement 3: a mute that happened on a weak uplink is the internet's fault, not the model's.
test('a weak uplink inside the watched wait settles uplink_starved instead of blaming the model', async t => {
  let quality: 'ok' | 'weak' = 'ok';
  let clockNow = () => 0;
  const live = await openLive(t, { connection: () => ({ quality, ...(quality === 'weak' ? { weakAt: clockNow() } : {}) }) });
  clockNow = live.now;
  await ownerTurnEnd(live);
  await until(live, () => phases(live).includes('recovered'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 5_000);
  assert.equal(terminalCode(live), undefined, 'the first recovery is not a terminal');
  await flush();
  await ownerTurnEnd(live);
  quality = 'weak';
  await until(live, () => phases(live).includes('settled'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 5_000);
  assert.equal(live.owner.get(live.liveSessionId).terminal?.state, 'failed');
  assert.equal(terminalCode(live), 'uplink_starved', 'the link was weak during the wait the watchdog judged');
  const page = live.owner.current();
  assert.equal(page.connection?.endedCode, 'uplink_starved', 'and the live projection names the reason the call ended');
});

test('a weak spell before the watched wait does not relabel a later model timeout', async t => {
  let quality: 'ok' | 'weak' = 'ok';
  let weakAt: number | undefined;
  let clockNow = () => 0;
  const live = await openLive(t, { connection: () => ({ quality, ...(quality === 'weak' ? { weakAt: clockNow() } : weakAt === undefined ? {} : { weakAt }) }) });
  clockNow = live.now;
  await ownerTurnEnd(live);
  quality = 'weak';
  await until(live, () => phases(live).includes('recovered'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 5_000);
  weakAt = live.now() - 1_000;
  quality = 'ok';
  await flush();
  await ownerTurnEnd(live);
  await until(live, () => phases(live).includes('settled'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 5_000);
  assert.equal(terminalCode(live), 'model_unresponsive', 'the wait being judged was healthy');
});

test('idle measures silence, so it fires with mic frames flowing and no speech, and live_turn_open is recorded', async t => {
  const live = await openLive(t, { limits: { idleMs: 3_000 } });
  await live.emit({ type: 'modelTurnStarted' });
  await live.emit({ type: 'audio', pcm: new Uint8Array(8), rate: 24000 });
  for (let elapsed = 0; elapsed < 5_000 && !live.receipts.some(record => record.event === 'live_turn_open'); elapsed += 500) {
    live.sendAudio();
    await live.advance(500);
  }
  assert.ok(live.receipts.some(record => record.event === 'live_turn_open'), 'an open model turn with no turnComplete is witnessed');
  assert.equal(terminalCode(live), 'idle_timeout');
});

test('an unattended call ends at the idle limit even while VAD only events, a nudge and a rebuild fire', async t => {
  const live = await openLive(t, { limits: { idleMs: 300_000 } });
  // The opener is the last real activity: model audio, then nothing the owner said.
  await live.emit({ type: 'audio', pcm: new Uint8Array(8), rate: 24_000 });
  const lastActivity = live.now();
  // Ambient VAD and provider bookkeeping only: no owner speech, an empty finalized transcript, a
  // model turn that carries no audio at all.
  for (let spent = 0; spent < 120_000 && terminalCode(live) === undefined; spent += 20_000) {
    await live.emit({ type: 'modelTurnStarted' });
    await live.emit({ type: 'inputTranscription', text: '', finished: true });
    await live.advance(20_000);
  }
  // The silent turn arms the watchdog: the nudge and its fresh-seeded rebuild both happen here.
  await until(live, () => phases(live).includes('recovered'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 30_000);
  assert.ok(phases(live).includes('nudged'), 'the silent turn was nudged');
  assert.equal(live.fake.sessionsOpened, 2, 'the recovery rebuilt the provider session');
  await until(live, () => terminalCode(live) !== undefined, 400_000);
  assert.equal(terminalCode(live), 'idle_timeout');
  assert.equal(live.now() - lastActivity, 300_000, 'nothing but real activity moved the idle clock');
  const resets = live.receipts.filter(record => record.event === 'live_idle_arm').map(record => record.resetBy);
  assert.deepEqual([...new Set(resets)], ['opened', 'model_audio'], 'only the opener reset the clock');
});

test('the idle arm receipt is a closed set the host log accepts', () => {
  assert.deepEqual(safeEvent({ event: 'live_idle_arm', resetBy: 'model_audio', idleMs: 300_000 }),
    { event: 'live_idle_arm', resetBy: 'model_audio', idleMs: 300_000 }, 'a known cause keeps its receipt');
  assert.equal(safeEvent({ event: 'live_idle_arm', resetBy: 'vad_start', idleMs: 1_000 }), undefined,
    'a cause outside the closed set never reaches the host log');
});

test('a finalized owner transcript with content and model audio each reset the idle clock', async t => {
  const live = await openLive(t, { limits: { idleMs: 300_000 } });
  await live.emit({ type: 'audio', pcm: new Uint8Array(8), rate: 24_000 });
  await live.advance(250_000);
  await live.emit({ type: 'inputTranscription', text: 'book the standup for nine tomorrow', finished: true });
  await live.advance(250_000);
  assert.equal(terminalCode(live), undefined, 'owner speech with content restarted the idle clock');
  await live.emit({ type: 'audio', pcm: new Uint8Array(8), rate: 24_000 });
  await live.advance(250_000);
  assert.equal(terminalCode(live), undefined, 'model audio restarted the idle clock');
  await live.advance(50_000);
  assert.equal(terminalCode(live), 'idle_timeout');
});

test('a port with different declarations runs the same watchdog path', async t => {
  for (const capabilities of [{}, { supportsResumption: true, supportsInterruption: true, outputModalities: ['audio'] as const }]) {
    const live = await openLive(t, { capabilities });
    await ownerTurnEnd(live);
    await until(live, () => phases(live).includes('recovered'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 5_000);
    assert.deepEqual(phases(live), ['armed', 'nudged', 'recovered']);
    assert.equal(live.fake.sessionsOpened, 2, 'the recovery is fresh seeded even when resumption is supported');
  }
});
