import { liveTaskFixture } from './live-task-fixture.js';
import { deferred, fixtureUntil } from './live-voice-fixture.js';
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
import { createLiveSessionOwner, AUDIBLE_DEBT_RUNG_MS, lateCommentarySilence, lateHoldMs,
  liveMigrations, RESPONSE_WATCHDOG_RECOVERY_MS,
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
const toolCall = (id: string) => portEvent({ type: 'toolCall', calls: [{ id, name: 'search_knowledge', args: { query: 'bridge', limit: 1 , mode: null } }] });
/** #924: the adapter's report that an opened continuation made no audible output inside its window. */
const silentContinuation = () => portEvent({ type: 'interactionStatus', value: 'post_tool_no_output' });
const audible = () => portEvent({ type: 'audio', pcm: new Uint8Array(4_800), rate: 24_000, audible: true, rmsDbfs: -14 });

/** The dead-air rungs this call has recorded, in order. */
const rungReceipts = (live: DeadAir): Record<string, unknown>[] => live.receipts.filter(record => record.event === 'live_dead_air_nudge');

interface DeadAir {
  owner: LiveSessionOwner; fake: FakeLiveVoice; receipts: Record<string, unknown>[]; scheduler: DeadlineClock;
  liveSessionId: string;
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
  const owner = createLiveSessionOwner({ createTaskRuntime: syntheticTaskFactory(store), store, voice: fake.port, profile, now: () => scheduler.now, timeZone: 'Asia/Kolkata', schedule: scheduler.schedule });
  const session = owner.create({ idempotencyKey: `dead-air-${randomUUID()}`, inputClass: 'ordinary' }, ctx);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, ctx);
  await attachment.ready;
  await settle();
  return {
    owner, fake, receipts, scheduler, liveSessionId: session.liveSessionId, sentTexts: fake.texts.length,
    emit: async event => { fake.emit(event); await settle(); },
    advance: async ms => { scheduler.now += ms; scheduler.runDue(); await settle(); },
  };
}

test('task dead-air: a finished result appends without provider inference or a tool batch', async t => {
let calls = 0;
const f = await liveTaskFixture(t, async () => { calls++; return { text: 'The synthetic task answer.', calls: [] }; }, { clock: true });
f.finalize('Do the synthetic task.'); f.bind(); const answer = await f.answer();
assert.equal(answer.text, 'The synthetic task answer.'); assert.equal(f.voice.taskAnswers.length, 2); assert.equal(calls, 1);
assert.equal(f.voice.texts.length, 0); assert.equal(f.voice.toolResponses.length, 0, 'no legacy function-output continuation');
});

test('task dead-air: pending work stays quiet through the native 8 second watchdog boundary', async t => {
const release = deferred<void>(); t.after(() => release.resolve()); let calls = 0;
const f = await liveTaskFixture(t, async () => { calls++; await release.promise; return { text: 'The synthetic task answer.', calls: [] }; }, { clock: true });
f.finalize('Do the synthetic task.'); f.bind(); await fixtureUntil(() => calls === 1, 'controlled task');
t.mock.timers.tick(8_000); await f.flush();
assert.equal(f.voice.sessionsOpened, 1); assert.equal(f.voice.taskAnswers.length, 0); assert.equal(f.voice.texts.length, 0);
release.resolve(); assert.equal((await f.answer()).text, 'The synthetic task answer.'); assert.equal(calls, 1);
});

test('C-DEADAIR: a response the owner can hear clears the debt, so the rung never speaks over an answer', async t => {
  const live = await openCall(t);
  await live.emit(ownerFinal('What did we decide about the bridge?'));
  await live.emit(toolCall('d3'));
  await live.emit(audible());
  await live.advance(AUDIBLE_DEBT_RUNG_MS + RESPONSE_WATCHDOG_RECOVERY_MS);
  assert.equal(live.fake.texts.length, live.sentTexts, 'an audible answer is the answer, and nothing is injected behind it');
});

test('task lifecycle: elapsed worker time is durable metadata, not provider response inference', async t => {
const release = deferred<void>(); t.after(() => release.resolve()); let calls = 0;
const f = await liveTaskFixture(t, async () => { calls++; await release.promise; return { text: 'The synthetic task answer.', calls: [] }; }, { clock: true });
f.finalize('Do the synthetic task.'); f.bind(); await fixtureUntil(() => calls === 1, 'controlled task');
const task = f.store.transaction(tx => tx.get('SELECT created_at FROM tasks'));
t.mock.timers.tick(500); release.resolve(); await f.answer();
const finished = f.store.transaction(tx => tx.get('SELECT updated_at,status FROM tasks'));
assert.ok(Number(finished?.updated_at) >= Number(task?.created_at) + 500); assert.equal(calls, 1);
assert.equal(f.voice.taskAnswers.length, 2);
});

// C-REBUILD8 (review BL1): the debt ladder owns the same speaking hold the sliding watchdog keeps. On 2026-10-28
// the N12 nudge came from this path, not from the watchdog: `live_debt phase=rung reason=dead_air` then
// `live_dead_air_nudge elapsedMs=8000` with no `live_watchdog phase=nudged` anywhere near it, and the rebuild
// followed one RESPONSE_WATCHDOG_RECOVERY_MS later. A sentence still being spoken holds both back.
test('task dead-air: owner words hold a result until the finalized correction', async t => {
const release = deferred<void>(); t.after(() => release.resolve()); let calls = 0;
const f = await liveTaskFixture(t, async () => { calls++; await release.promise; return { text: 'The synthetic task answer.', calls: [] }; }, { clock: true });
f.finalize('Do the synthetic task.'); f.bind(); await fixtureUntil(() => calls === 1, 'controlled task');
f.voice.emit({ type: 'inputTranscription', text: 'A synthetic correction is beginning', finished: false }); await f.flush();
release.resolve(); await f.flush(); t.mock.timers.tick(8_000); await f.flush();
assert.equal(f.voice.taskAnswers.length, 0); assert.equal(f.voice.sessionsOpened, 1); assert.equal(f.voice.texts.length, 0);
f.finalize('Use the completed synthetic correction.'); await f.answer(); assert.equal(f.voice.taskAnswers.length, 2);
});

// C-REBUILD (council verdict, standard round 2026-11-01, PERF.md finding 2): 7 of 19 owner rebuilds tore down a
// response in flight under 9.7 s old, against a healthy silent-response max of 9,680 ms (n=69). A response in
// flight younger than its own ceiling is therefore never the ladder's to lose. The rung, the recovery and the debt
// clock keep their values: only the moment the rebuild may fire moves, and it may only move later.
/** Drive the fake clock in the host's own step, so every awaited recovery completes between two steps. */
async function drive(live: DeadAir, until: () => boolean, budgetMs: number): Promise<number> {
  let spent = 0;
  while (spent < budgetMs && !until()) { await live.advance(250); spent += 250; }
  return spent;
}
const heldRebuilds = (live: DeadAir): Record<string, unknown>[] =>
  live.receipts.filter(record => record.event === 'live_rebuild_held');
const removedRebuilds = (live: DeadAir): Record<string, unknown>[] =>
  live.receipts.filter(record => record.event === 'live_rebuild_removed');

test('task dead-air: the completed result waits for audio output to become quiet', async t => {
const release = deferred<void>(); t.after(() => release.resolve()); let calls = 0;
const f = await liveTaskFixture(t, async () => { calls++; await release.promise; return { text: 'The synthetic task answer.', calls: [] }; }, { clock: true });
f.finalize('Do the synthetic task.'); f.bind(); await fixtureUntil(() => calls === 1, 'controlled task');
f.voice.emit({ type: 'audio', pcm: new Uint8Array(960), rate: 24000, audible: true }); await f.flush();
release.resolve(); await f.flush(); assert.equal(f.voice.taskAnswers.length, 0, 'a task answer waits for voice output to be quiet');
f.voice.emit({ type: 'turnComplete' }); assert.equal((await f.answer()).text, 'The synthetic task answer.'); assert.equal(calls, 1);
});

test('task dead-air: a heard answer cancels timeout before the held result replays', async t => {
let calls = 0;
const f = await liveTaskFixture(t, async () => { calls++; return { text: 'The synthetic task answer.', calls: [] }; }, { clock: true });
f.finalize('Do the synthetic task.'); f.bind(); const answer = await f.answer();
f.voice.emit({ type: 'commentaryAccepted', commandId: answer.commandId }); await f.flush();
t.mock.timers.tick(14_999); f.voice.emit({ type: 'outputTranscription', text: answer.text, finished: true }); await f.flush();
t.mock.timers.tick(1); await f.flush(); assert.equal(f.voice.sessionsOpened, 1); assert.equal(calls, 1);
});

test('C-REBUILD B: the unspoken result never goes into a response that is in flight', async t => {
  const live = await openCall(t);
  await live.emit(ownerFinal('What did we decide about the bridge?'));
  await live.emit(toolCall('d3'));
  await drive(live, () => false, 1_000);
  await live.emit(portEvent({ type: 'modelTurnStarted' }));
  // Step the clock until the rebuild, watching the old session's texts: nothing may be written into a response
  // that is still open. What the new session is handed afterwards is that rebuild's own continuation path.
  let intoOldSession: number | undefined;
  for (let spent = 0; spent < 60_000 && live.fake.sessionsOpened === 1; spent += 250) {
    await live.advance(250);
    if (live.fake.sessionsOpened === 1) intoOldSession = live.fake.texts.length;
  }
  assert.equal(intoOldSession, live.sentTexts, 'a result is never pushed into a response in flight');
  assert.equal(live.fake.sessionsOpened, 2, 'a response past its ceiling is still rebuilt');
});

test('C-REBUILD B: a late finding is held for the continuation while a response is in flight', () => {
  const state = { now: 5_000, answeredAt: 0, alreadySpoken: false, ownerWords: 0, responseInProgress: true };
  // Held, not parked: the response's own terminal is the event that offers the note on the continuation. A torn
  // down generation is the one case that never sends it, and then it lives in the research ledger alone.
  assert.equal(lateCommentarySilence(state), 'response_in_flight', 'the note is held while the response is open');
  assert.equal(lateHoldMs('response_in_flight'), undefined, 'and no timer of its own may ever send it');
  assert.equal(lateCommentarySilence({ ...state, responseInProgress: false }), null,
    'with no response in flight the note is spoken as before');
});

test('C-REBUILD C: an owner turn with no tool work and no response is never rebuilt', async t => {
  const live = await openCall(t);
  await live.emit(ownerFinal('The bridge is still out, I will drive instead.'));
  await drive(live, () => false, 60_000);
  assert.equal(live.fake.sessionsOpened, 1, 'the accepted failure: a dead socket here waits for him to speak again');
  assert.equal(live.fake.texts.length, live.sentTexts, 'and no filler is spoken into the silence');
  assert.notEqual(live.owner.get(live.liveSessionId).lifecycle, 'terminal', 'the call is left open, listening');
  const removed = removedRebuilds(live);
  assert.equal(removed.length >= 1, true, 'the decision that stood down is a named receipt');
  assert.equal(removed[0]!.reason, 'owner_turn_no_tool_no_response');
  assert.equal(removed[0]!.removedCount, 1);
});

test('task dead-air: microphone mute never replays an acknowledged result', async t => {
  const f = await liveTaskFixture(t, async () => ({ text: 'The synthetic task answer.', calls: [] }), { clock: true });
  f.finalize('Do the synthetic task.'); f.bind(); const answer = await f.answer();
  f.voice.emit({ type: 'commentaryAccepted', commandId: answer.commandId }); await f.flush();
  f.attachment.setInputMuted(true);
  t.mock.timers.tick(30_000); await f.flush();
  assert.equal(f.voice.sessionsOpened, 1); assert.equal(f.voice.taskAnswers.length, 2);
});

// C-REBUILD (B-R7): the contract's invariant replays. One owed turn has one continuation owner: note delivery,
// silent rescue, watchdog re-evaluation and the provider terminal are mediated by that one owner, and no path may
// send a second create while one is active or after audio for that turn. Each replay asserts one answer and no
// replay of spoken content, on the same fakes the rest of this file uses.
const answeredOnce = (live: DeadAir): boolean => live.fake.texts.length <= live.sentTexts + 1;

test('C-REBUILD invariant: chained responses are two answers, never a third create', async t => {
  const live = await openCall(t);
  await live.emit(ownerFinal('When does the synthetic bridge reopen?'));
  await live.emit(toolCall('c1'));
  await drive(live, () => rungReceipts(live).length > 0, 20_000);
  for (const answer of ['first', 'second']) {
    await live.emit(portEvent({ type: 'modelTurnStarted' }));
    await live.emit(audible());
    await live.emit(portEvent({ type: 'modelText', text: `answer ${answer}`, thought: false }));
    await live.emit(portEvent({ type: 'turnComplete' }));
  }
  await drive(live, () => false, 30_000);
  assert.equal(live.fake.sessionsOpened, 1, 'two chained answers never rebuild the session');
  assert.equal(heldRebuilds(live).length, 0, 'and no rebuild is held or taken for either of them');
  assert.equal(answeredOnce(live), true, 'the turn keeps one continuation owner and one injected line at most');
});

test('C-REBUILD invariant: a held note, the terminal and the rescue arriving together send one line', async t => {
  const live = await openCall(t);
  await live.emit(ownerFinal('What did we decide about the bridge?'));
  await live.emit(toolCall('c2'));
  await live.advance(1_000);
  await live.emit(portEvent({ type: 'modelTurnStarted' }));
  await live.emit(portEvent({ type: 'modelText', text: 'reading', thought: false }));
  // The terminal lands on the same tick the rung would speak, which is the shape that double spoke before.
  await live.emit(portEvent({ type: 'turnComplete' }));
  // One ladder round, not two: this replay is about the turn's one continuation owner, and the next window's
  // repeated-mute door has its own guards.
  await drive(live, () => false, 4_000);
  // The ladder's own rebuild after a silent text response is unchanged; what the invariant forbids is a second
  // line for one owed turn, and that is what is asserted here.
  assert.equal(live.fake.sessionsOpened <= 2, true, 'a terminal and a rescue in one tick take at most the ladder rebuild');
  assert.equal(answeredOnce(live), true, 'and they never send more than one continuation line');
});

test('C-REBUILD invariant: a reordered or repeated terminal changes nothing', async t => {
  const live = await openCall(t);
  await live.emit(ownerFinal('What did we decide about the bridge?'));
  await live.emit(toolCall('c3'));
  await live.advance(1_000);
  await live.emit(portEvent({ type: 'modelTurnStarted' }));
  await live.emit(portEvent({ type: 'turnComplete' }));
  await live.emit(portEvent({ type: 'turnComplete' }));
  await live.emit(portEvent({ type: 'modelTurnStarted' }));
  await drive(live, () => false, 30_000);
  assert.equal(live.fake.sessionsOpened <= 2, true, 'a repeated terminal is not a second reason to rebuild beyond the ladder');
  assert.equal(answeredOnce(live), true, 'and it never re-sends what was already said');
});

test('C-REBUILD invariant: a stale timer after the answer was heard does nothing', async t => {
  const live = await openCall(t);
  await live.emit(ownerFinal('What did we decide about the bridge?'));
  await live.emit(toolCall('c4'));
  await drive(live, () => rungReceipts(live).length > 0, 20_000);
  await live.emit(portEvent({ type: 'modelTurnStarted' }));
  await live.emit(audible());
  const textsAtAnswer = live.fake.texts.length;
  await live.advance(1_000);
  await live.emit(portEvent({ type: 'turnComplete' }));
  await drive(live, () => false, 60_000);
  assert.equal(live.fake.sessionsOpened, 1, 'no timer left over from the hold rebuilds a heard answer');
  assert.equal(live.fake.texts.length, textsAtAnswer, 'and nothing is injected after the answer was heard');
});

test('task barge-in: partial correction blocks stale delivery and finalized words get one answer', async t => {
const release = deferred<void>(); t.after(() => release.resolve()); let calls = 0;
const f = await liveTaskFixture(t, async () => { calls++; await release.promise; return { text: 'The synthetic task answer.', calls: [] }; }, { clock: true });
f.finalize('Do the synthetic task.'); f.bind(); await fixtureUntil(() => calls === 1, 'controlled task');
f.voice.emit({ type: 'audio', pcm: new Uint8Array(960), rate: 24000, audible: true });
f.voice.emit({ type: 'interrupted' }); f.voice.emit({ type: 'inputTranscription', text: 'Wait for the synthetic correction', finished: false });
await f.flush(); release.resolve(); await f.flush(); assert.equal(f.voice.taskAnswers.length, 0);
f.finalize('Use the final synthetic correction.'); f.bind('corrected-binding');
assert.equal((await f.answer()).delegationId, 'corrected-binding'); assert.equal(f.voice.taskAnswers.length, 2);
});

test('C-REBUILD invariant: a session replacement during a deferral carries one line, never two', async t => {
  const live = await openCall(t);
  await live.emit(ownerFinal('What did we decide about the bridge?'));
  await live.emit(toolCall('c6'));
  await live.advance(1_000);
  await live.emit(portEvent({ type: 'modelTurnStarted' }));
  // The response is past its ceiling at the rebuild step, so the replacement really happens.
  await drive(live, () => live.fake.sessionsOpened > 1, 60_000);
  assert.equal(live.fake.sessionsOpened, 2, 'the wedged response is replaced');
  await drive(live, () => false, 10_000);
  assert.equal(answeredOnce(live), true, 'the replacement carries the result once and never replays it');
});

test('C-REBUILD B: a held note is not dropped by the late window on its way back', () => {
  const past = { now: 60_000, answeredAt: 0, alreadySpoken: false, ownerWords: 0 };
  assert.equal(lateCommentarySilence(past), 'window_elapsed', 'an unprompted late line still expires');
  assert.equal(lateCommentarySilence({ ...past, responseInProgress: true }), 'response_in_flight',
    'and a note held by a response in flight is held, not expired, on the way in');
  assert.equal(lateCommentarySilence({ ...past, held: true, responseInProgress: false }), null,
    'on its terminal the same note is spoken, however long the response held it');
});

// #924/#802: about thirty percent of continuations go silent, and today recovery waits for the 8 s dead-air rung
// or the 23 s rebuild. A response the adapter opened and heard nothing from earns exactly one quiet continuation
// input, once per turn, recorded with the gap the owner sat through, and never a rebuild.
test('#924/#802: a silent continuation is nudged once with its gap, and never twice in a turn', async t => {
  const live = await openCall(t);
  await live.emit(ownerFinal('What did we decide about the bridge?'));
  await live.emit(portEvent({ type: 'modelTurnStarted' }));
  await live.advance(1_500);
  await live.emit(silentContinuation());
  const nudges = rungReceipts(live);
  assert.equal(nudges.length, 1, 'one quiet nudge for one stuck continuation');
  assert.ok(Number(nudges[0]?.elapsedMs) >= 1_500, 'the record carries the measured gap the owner sat through');
  assert.equal(live.fake.taskAnswers.length, 1, 'the nudge is one continuation input, never a rebuild');
  assert.match(live.fake.taskAnswers.at(-1)?.text ?? '', /lookup has finished/);
  await live.emit(silentContinuation());
  await live.advance(1_000);
  assert.equal(rungReceipts(live).length, 1, 'a second report in the same turn never nudges again');
  assert.equal(live.fake.sessionsOpened, 1, 'a stuck response is never a rebuild');
});

// #820: owner silence with nothing owed never walks the watchdog into a fresh session.
test('#820: sixty seconds of owner silence with nothing owed never rebuilds the session', async t => {
  const live = await openCall(t);
  await live.emit(ownerFinal('Thanks, that is all for now.'));
  await live.emit(portEvent({ type: 'turnComplete' }));
  await live.advance(60_000);
  assert.equal(live.receipts.filter(record => record.event === 'live_rebuild').length, 0, 'silence is not a mute');
  assert.equal(live.fake.sessionsOpened, 1, 'the session the owner is holding is never replaced for silence');
  assert.ok(live.fake.texts.length <= live.sentTexts + 1, 'and nothing is injected behind the silence');
});

// #820: a helper task that is still running owns the wait, so a long one never counts toward a rebuild.
test('#820: a running helper task never causes a rebuild', async t => {
  const release = deferred<void>(); t.after(() => release.resolve()); let calls = 0;
  const f = await liveTaskFixture(t, async () => { calls++; await release.promise; return { text: 'The synthetic task answer.', calls: [] }; }, { clock: true });
  f.finalize('Do the synthetic task.'); f.bind(); await fixtureUntil(() => calls === 1, 'controlled task');
  t.mock.timers.tick(60_000); await f.flush();
  assert.equal(f.voice.sessionsOpened, 1, 'a long helper task walks no rebuild and no session replacement');
  assert.equal(f.voice.closes, 0, 'and the session the owner holds is never closed for it');
  release.resolve();
});
