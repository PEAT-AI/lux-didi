import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, IDLE_RESET_CAUSES, isBareAcknowledgement, LIVE_DROPPED_LINE_MARK, liveMigrations, RESPONSE_WATCHDOG_NUDGE_MS, RESPONSE_WATCHDOG_RECOVERY_MS,
  validateLiveProfile, type LiveAttachment, type LiveContext, type LiveOutputChunk, type LiveSessionOwner } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { LIVE_REBUILD_TRIGGERS, safeEvent } from '../host/log.js';
import { LIVE_MUTE_PICKUP } from '../prompt/live-persona.js';
import { fakeLiveVoicePort, type FakeLiveVoice, type FakeLiveVoiceEvent } from './fixtures/fake-live-voice.js';
import type { LiveVoiceEvent, LiveVoicePort, LiveVoiceSession } from '../adapters/live-voice/index.js';
import { pcm, ready as providerReady } from './live-voice-fixture.js';

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
  attachment: LiveAttachment; output: LiveOutputChunk[];
  emit(event: FakeLiveVoiceEvent): Promise<void>; sendAudio(): void; advance(ms: number): Promise<void>;
  /** The owner's injected clock, so a test can date a weak spell against the watchdog's own interval. */
  now(): number;
}

/** The uplink measurement a test plays back through the adapter's existing diagnostics port (W3). */
type MeasuredConnection = { quality: 'ok' | 'weak'; weakAt?: number };

/** Open one owner session on the fake port with an injected clock, and capture the 3j receipts. */
async function openLive(t: TestContext, overrides: { limits?: Record<string, number>; capabilities?: Parameters<typeof fakeLiveVoicePort>[0]; connection?: () => MeasuredConnection; deadLine?: boolean } = {}): Promise<Live> {
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
      || record.event === 'live_rebuild' || record.event === 'live_idle_arm') receipts.push(record);
  } });
  t.after(() => { detach(); rmSync(dir, { recursive: true, force: true }); });
  const owner = createLiveSessionOwner({ store, voice: port, profile, now: () => scheduler.now, timeZone: 'Asia/Kolkata', schedule: scheduler.schedule });
  const session = owner.create({ idempotencyKey: `watchdog-${randomUUID()}`, inputClass: 'ordinary' }, ctx);
  if (overrides.deadLine === true) {
    // The L19 recipe: a previous call in this conversation was lost, so this one opens by naming the drop.
    store.transaction(tx => {
      const conversationId = String(tx.get('SELECT conversation_id FROM live_session_conversations WHERE live_session_id=?', [session.liveSessionId])!['conversation_id']);
      const deadAt = scheduler.now - 120_000;
      tx.run(`INSERT INTO live_sessions (live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint,
          client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events, journal_bytes,
          journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at, memory_provenance)
        VALUES (?,?,?,?,?,?,?,?,?,'terminal',0,0,2,120,1,'ended',?,?,?,?,NULL)`,
        ['watchdog-dead-session', store.assistantId, store.authorityEpoch, 'key-dead', 'fp-dead', 'client', 'audit', 'profile', 'prompt',
          JSON.stringify({ state: 'failed', code: 'resume_failed' }), deadAt, deadAt, deadAt]);
      tx.run('INSERT INTO live_session_conversations(live_session_id,conversation_id) VALUES(?,?)', ['watchdog-dead-session', conversationId]);
    });
  }
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, ctx);
  await attachment.ready;
  const output: LiveOutputChunk[] = [];
  void (async () => { for await (const chunk of attachment.output) output.push(chunk); })();
  return {
    owner, fake, receipts, liveSessionId: session.liveSessionId, attachment, output, now: () => scheduler.now,
    emit: async event => { fake.emit(event); await flush(); },
    sendAudio: () => attachment.sendAudio({ pcm }),
    advance: async ms => { scheduler.now += ms; scheduler.runDue(); await flush(); },
  };
}

/** The provider's VAD edges predate the fixture's event union; the host reads this shape all the same. */
const vadEdge = (value: boolean): FakeLiveVoiceEvent => ({ type: 'waitingForInput', value } as unknown as FakeLiveVoiceEvent);

const phases = (live: Live): unknown[] => live.receipts.filter(record => record.event === 'live_watchdog').map(record => record.phase);
/** The reconnect markers the native shell turns into a ring and its arrival chime (#591). */
const continuityEvents = (live: Live): unknown[] => live.output
  .filter((chunk): chunk is Extract<LiveOutputChunk, { kind: 'marker' }> => chunk.kind === 'marker')
  .filter(chunk => chunk.marker.kind === 'continuity').map(chunk => chunk.marker.event);
const rebuildTriggers = (live: Live): unknown[] => live.receipts.filter(record => record.event === 'live_rebuild').map(record => record.trigger);
const openingText = (live: Live): string | undefined => live.fake.requests.at(-1)?.openingText;
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
  assert.deepEqual(phases(live), ['armed', 'nudged', 'recovering', 'recovered']);
  assert.equal(live.fake.sessionsOpened, 2, 'the recovery opened one fresh session');
  assert.ok((live.fake.requests.at(-1)!.history ?? []).length > 0, 'the fresh session carries the journal seed');
  assert.ok(live.receipts.some(record => record.event === 'live_recovery' && record.path === 'fresh_seeded' && record.reason === 'model_mute'),
    'the recovery is the fresh seeded path with reason model_mute');
  // C-PICKUP: a mute is the model's silence, not a dropped line, so the owner is asked to wait in one short
  // sentence instead of being told the call came back.
  assert.equal(openingText(live), LIVE_MUTE_PICKUP, 'the model went mute, so the pickup names the silence');
  assert.equal(live.receipts.filter(record => record.event === 'live_recovery').at(-1)?.pickup, 'mute',
    'and the recovery line says which pickup it chose');
  assert.equal(live.fake.requests.at(-1)?.opening, 'model_first', 'and the rebuilt session is still asked to continue');
  assert.ok(continuityEvents(live).includes('rebuilding'), 'the reconnect ring and its chime are still requested');
  assert.deepEqual(rebuildTriggers(live), ['no_output_after_owner'], 'the rebuild names owner speech as its trigger');
});

test('#591: an ambient-only turn closes at the watchdog without a nudge, a chime or a rebuild', async t => {
  const live = await openLive(t);
  // Ambient sound near the microphone: a VAD start, a finalized transcript with no words in it, and a
  // model turn that opens and delivers nothing.
  await live.emit(vadEdge(true));
  await live.emit(vadEdge(false));
  await live.emit({ type: 'modelTurnStarted' });
  await live.emit({ type: 'inputTranscription', text: '', finished: true });
  assert.deepEqual(phases(live), ['armed'], 'the silent turn owes a reply the watchdog must judge');
  await until(live, () => phases(live).includes('closed'), RESPONSE_WATCHDOG_NUDGE_MS + 5_000);
  assert.deepEqual(phases(live), ['armed', 'closed'], 'no nudge and no rebuild: the turn is closed and the call listens on');
  assert.equal(live.fake.sessionsOpened, 1, 'ambient sound never rebuilds the provider session');
  assert.equal(openingText(live), undefined, 'nothing is told to speak, so there is no "I am back"');
  assert.deepEqual(continuityEvents(live), [], 'no reconnect marker reaches the native shell, so no ring and no chime');
  assert.deepEqual(rebuildTriggers(live), [], 'and no rebuild to name');
  await live.advance(RESPONSE_WATCHDOG_RECOVERY_MS + 30_000);
  assert.deepEqual(phases(live), ['armed', 'closed'], 'the closed turn leaves no watchdog work behind');
  assert.equal(terminalCode(live), undefined, 'the call is still up for the owner');
});

// C-CONTINUITY R-01/R-02: every trigger the host can name reaches the log with the cause its outcome earned, and a
// trigger or cause outside the closed sets is refused. `research_context` is a trigger of its own, never a drop.
test('the rebuild trigger is a closed set the host log accepts for every token', () => {
  for (const trigger of LIVE_REBUILD_TRIGGERS) {
    const cause = trigger === 'research_context' ? 'host' : 'provider';
    assert.deepEqual(safeEvent({ event: 'live_rebuild', trigger, cause, liveSessionId: '9a1f1c9e-0b7a-4c22-9d2e-8f0b6c3d5e11', generation: 2 }),
      { event: 'live_rebuild', trigger, cause, liveSessionId: '9a1f1c9e-0b7a-4c22-9d2e-8f0b6c3d5e11', generation: 2 }, `the host log keeps the ${trigger} trigger`);
  }
  assert.equal(safeEvent({ event: 'live_rebuild', trigger: 'ambient', cause: 'provider', liveSessionId: '9a1f1c9e-0b7a-4c22-9d2e-8f0b6c3d5e11', generation: 2 }), undefined,
    'a trigger outside the closed set never reaches the host log');
  assert.equal(safeEvent({ event: 'live_rebuild', cause: 'provider', liveSessionId: '9a1f1c9e-0b7a-4c22-9d2e-8f0b6c3d5e11', generation: 2 }), undefined,
    'a rebuild with no trigger at all is not a rebuild');
  assert.equal(safeEvent({ event: 'live_rebuild', trigger: 'line_dropped', cause: 'the-internet', liveSessionId: '9a1f1c9e-0b7a-4c22-9d2e-8f0b6c3d5e11', generation: 2 }), undefined,
    'a cause outside the closed set never reaches the host log');
});

test('an open model turn that emits one chunk and then nothing is nudged once and then recovered', async t => {
  const live = await openLive(t);
  await live.emit({ type: 'modelTurnStarted' });
  for (let chunk = 0; chunk < 5; chunk++) await live.emit({ type: 'audio', pcm: new Uint8Array(8), rate: 24000 });
  assert.deepEqual(phases(live), ['armed'], 'one armed record per turn, not one per audio chunk');
  await until(live, () => phases(live).includes('recovered'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 5_000);
  assert.deepEqual(phases(live), ['armed', 'nudged', 'recovering', 'recovered'], 'a turn that opens and goes quiet is watched to recovery');
  assert.equal(live.fake.sessionsOpened, 2);
  // #591: the model spoke, but the owner never did, so nothing is owed and the rebuild arrives unannounced.
  assert.equal(openingText(live), undefined, 'no owner words since the model spoke means no pickup to answer');
  assert.equal(live.fake.requests.at(-1)?.opening, 'user_first', 'and nothing instructs the rebuilt session to open');
  assert.deepEqual(continuityEvents(live), [], 'and no reconnect marker for the native ring to chime on');
  assert.deepEqual(rebuildTriggers(live), ['no_output_after_ambient'], 'the rebuild names the silence it walked into');
});

test('#591: a turn that produced model text is not the ambient case, so it is still nudged', async t => {
  const live = await openLive(t);
  // Text without audio is still model output: the provider can answer a silent room with text alone.
  await live.emit(vadEdge(false));
  await live.emit({ type: 'modelTurnStarted' });
  await live.emit({ type: 'modelText', text: 'Standing by.', thought: false });
  assert.deepEqual(phases(live), ['armed'], 'the open turn owes a reply the watchdog must judge');
  await until(live, () => phases(live).includes('nudged'), RESPONSE_WATCHDOG_NUDGE_MS + 5_000);
  assert.deepEqual(phases(live), ['armed', 'nudged'], 'a turn that already spoke in text is nudged, never closed as ambient');
});

test('#591: a quiet rebuild drops the dropped-line opener the call inherited from a silent start', async t => {
  const live = await openLive(t, { deadLine: true });
  assert.equal(live.fake.requests.at(-1)?.openingText, LIVE_DROPPED_LINE_MARK, 'this call opened by naming the lost line');
  // The model opens its own turn and goes quiet. The owner never spoke, so nothing was asked of the rebuild.
  await live.emit({ type: 'modelTurnStarted' });
  for (let chunk = 0; chunk < 3; chunk++) await live.emit({ type: 'audio', pcm: new Uint8Array(8), rate: 24_000 });
  await until(live, () => phases(live).includes('recovered'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 5_000);
  assert.equal(live.fake.sessionsOpened, 2, 'the stalled turn was rebuilt');
  assert.deepEqual(rebuildTriggers(live), ['no_output_after_ambient'], 'the rebuild is the quiet one');
  assert.equal(live.fake.requests.at(-1)?.openingText, undefined, 'and it carries no inherited "I am back" line');
  assert.equal(live.fake.requests.at(-1)?.opening, 'user_first', 'nor an instruction to open');
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
  assert.deepEqual(phases(live), ['armed', 'nudged', 'recovering', 'recovered', 'armed', 'nudged', 'settled']);
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

test('an unattended call ends at the idle limit even while VAD only events and closes fire', async t => {
  const live = await openLive(t, { limits: { idleMs: 300_000 } });
  // The opener is the last real activity: model audio, then nothing the owner said.
  await live.emit({ type: 'audio', pcm: new Uint8Array(8), rate: 24_000 });
  const lastActivity = live.now();
  // Ambient VAD and provider bookkeeping only: no owner speech, an empty finalized transcript, a
  // model turn that carries no audio at all.
  for (let spent = 0; spent < 120_000 && terminalCode(live) === undefined; spent += 20_000) {
    // The VAD edges the provider sends on ambient sound, both of them: a start is not speech.
    await live.emit(vadEdge(true));
    await live.emit(vadEdge(false));
    await live.emit({ type: 'modelTurnStarted' });
    await live.emit({ type: 'inputTranscription', text: '', finished: true });
    await live.advance(20_000);
  }
  // The silent turn arms the watchdog: the turn closes without a nudge and without a rebuild, because ambient
  // sound never asked for an answer (#591). The loop above already drove the close; the idle clock never moved.
  await until(live, () => phases(live).includes('closed'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 30_000);
  assert.ok(!phases(live).includes('nudged'), 'the ambient turn was never nudged');
  assert.equal(live.fake.sessionsOpened, 1, 'ambient sound never rebuilds the provider session');
  await until(live, () => terminalCode(live) !== undefined, 400_000);
  assert.equal(terminalCode(live), 'idle_timeout');
  assert.equal(live.now() - lastActivity, 300_000, 'nothing but real activity moved the idle clock');
  const resets = live.receipts.filter(record => record.event === 'live_idle_arm').map(record => record.resetBy);
  assert.deepEqual([...new Set(resets)], ['opened', 'model_audio'], 'only the opener reset the clock');
});

test('the idle arm receipt is a closed set the host log accepts for every cause', () => {
  // The closed set lives in the host log; every cause the arm can name must survive it, or an arm
  // would be silently dropped from the only record of what restarted the idle clock.
  for (const resetBy of IDLE_RESET_CAUSES) {
    assert.deepEqual(safeEvent({ event: 'live_idle_arm', resetBy, idleMs: 300_000 }),
      { event: 'live_idle_arm', resetBy, idleMs: 300_000 }, `the host log keeps the ${resetBy} cause`);
  }
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
    assert.deepEqual(phases(live), ['armed', 'nudged', 'recovering', 'recovered']);
    assert.equal(live.fake.sessionsOpened, 2, 'the recovery is fresh seeded even when resumption is supported');
  }
});

test('#607 unfinished owner fragments before an empty final produce a pickup rebuild', async t => {
  const live = await openLive(t);
  await live.emit({ type: 'inputTranscription', text: `${'synthetic '.repeat(20)}`, finished: false });
  await live.emit({ type: 'inputTranscription', text: '', finished: true });
  await until(live, () => phases(live).includes('recovered'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 5_000);
  assert.deepEqual(rebuildTriggers(live), ['no_output_after_owner']);
  assert.ok(continuityEvents(live).includes('rebuilding'));
  assert.ok(openingText(live), 'the pickup rebuild carries its owner-facing marker');
});

// C-LIVE N-2: the provider streams digital silence for the whole call. Those frames are not conversation, so the
// idle clock ignores them, the 300 s idle end fires on a silent session, and the arm receipt is a state change only.
test('N-2: provider silence frames never reset the idle clock, so a silent session ends at the idle limit', async t => {
  const live = await openLive(t, { limits: { idleMs: 300_000 } });
  await live.emit({ type: 'audio', pcm: new Uint8Array(8), rate: 24_000, audible: true, rmsDbfs: -20 });
  const lastSpeech = live.now();
  for (let spent = 0; spent < 320_000 && terminalCode(live) === undefined; spent += 2_000) {
    await live.emit({ type: 'audio', pcm: new Uint8Array(960), rate: 24_000, audible: false, rmsDbfs: -120 });
    await live.advance(2_000);
  }
  assert.equal(terminalCode(live), 'idle_timeout', 'the idle end fires although silence frames kept arriving');
  assert.ok(live.now() - lastSpeech <= 302_000, `it fired at the idle limit after the last audible frame (${live.now() - lastSpeech} ms)`);
});

test('N-2: live_idle_arm is written on a change of cause only, never once per audio frame', async t => {
  const live = await openLive(t, { limits: { idleMs: 300_000 } });
  for (let frame = 0; frame < 40; frame += 1) await live.emit({ type: 'audio', pcm: new Uint8Array(8), rate: 24_000, audible: true, rmsDbfs: -20 });
  await live.emit({ type: 'inputTranscription', text: 'synthetic owner words', finished: true });
  for (let frame = 0; frame < 40; frame += 1) await live.emit({ type: 'audio', pcm: new Uint8Array(8), rate: 24_000, audible: true, rmsDbfs: -20 });
  const arms = live.receipts.filter(record => record.event === 'live_idle_arm').map(record => record.resetBy);
  assert.deepEqual(arms, ['opened', 'model_audio', 'owner_speech', 'model_audio'], `one receipt per state change: ${JSON.stringify(arms)}`);
});

// C-LIVE N-2 on every live route: the frame the host sees is the gemini adapter's own, not a hand-written
// event, so a broken adapter classification fails here instead of passing on a fixture that already says
// `audible: false`.
test('N-2/W5-R1: the gemini adapter classifies digital silence, and a silent gemini session ends at the idle limit', async t => {
  const { f, captured } = await providerReady(t);
  f.send({ serverContent: { modelTurn: { role: 'model', parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(960).toString('base64') } }] } } });
  const audioOf = (): Extract<LiveVoiceEvent, { type: 'audio' }> | undefined =>
    captured.events.find((event): event is Extract<LiveVoiceEvent, { type: 'audio' }> => event.type === 'audio');
  for (let waited = 0; audioOf() === undefined && waited < 100; waited += 1) await new Promise<void>(resolve => setTimeout(resolve, 10));
  const frame = audioOf();
  assert.ok(frame, 'the gemini adapter emitted the silent frame');
  assert.equal((frame as { audible?: boolean }).audible, false, `the gemini adapter classifies a digital-silence frame as inaudible, not ${String((frame as { audible?: boolean }).audible)}`);
  const live = await openLive(t, { limits: { idleMs: 300_000 } });
  const lastSpeech = live.now();
  for (let spent = 0; spent < 320_000 && terminalCode(live) === undefined; spent += 2_000) {
    await live.emit(frame as FakeLiveVoiceEvent);
    await live.advance(2_000);
  }
  assert.equal(terminalCode(live), 'idle_timeout', 'the idle end fires although the gemini route kept sending silence');
  assert.ok(live.now() - lastSpeech <= 302_000, `it fired at the idle limit (${live.now() - lastSpeech} ms)`);
});

// C-RECOVERY (d): "Okay" after the model finished is an acknowledgement, not a question. It may be watched, but it
// never spends a rebuild: the call goes quiet because the owner is done talking, not because a model stalled.
test('C-RECOVERY (d): a bare acknowledgement after the model spoke never rebuilds the call', async t => {
  const live = await openLive(t);
  await live.emit({ type: 'outputTranscription', text: 'Your three o\'clock is free, okay?', finished: true });
  await live.emit({ type: 'inputTranscription', text: 'Okay', finished: true });
  assert.deepEqual(phases(live), ['armed'], 'the acknowledgement still arms the watchdog on its silence');
  await live.advance(RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 20_000);
  assert.equal(live.fake.sessionsOpened, 1, 'a bare acknowledgement opens no new provider session');
  assert.deepEqual(rebuildTriggers(live), [], 'and it writes no rebuild');
  assert.deepEqual(phases(live), ['armed', 'closed'], 'the turn closes at the nudge deadline instead');
});

// C-RECOVERY (d), the contrast the ruling demands: a real question is still an owed answer and still rebuilds.
test('C-RECOVERY (d): a real question after the model spoke still rebuilds as today', async t => {
  const live = await openLive(t);
  await live.emit({ type: 'outputTranscription', text: 'Monday is clear.', finished: true });
  await live.emit({ type: 'inputTranscription', text: 'what is next on my calendar', finished: true });
  await until(live, () => phases(live).includes('recovered'), RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 4_000);
  assert.equal(live.fake.sessionsOpened, 2, 'a question still earns a rebuild');
  assert.deepEqual(rebuildTriggers(live), ['no_output_after_owner'], 'and the rebuild names owner speech');
});

// C-RECOVERY (d): the acknowledgement class is closed, so no paraphrase or question can hide inside it.
test('C-RECOVERY (d): the acknowledgement class is three closed words at most, and never a question', () => {
  for (const text of ['okay', 'Okay.', 'ok thanks', 'yeah right', 'mhm', 'all right then']) assert.equal(isBareAcknowledgement(text), true, text);
  for (const text of ['okay?', 'no', 'what is next', 'okay what is next on my calendar', 'right, what about tomorrow']) {
    assert.equal(isBareAcknowledgement(text), false, text);
  }
});
