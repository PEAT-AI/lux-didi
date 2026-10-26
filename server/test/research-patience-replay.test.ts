import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESEARCH, RESEARCH_OPERATION, ResearchAdmission, ResearchLedger, runResearch, type ResearchDeps, type ResearchLateFindings } from '../tools/research.js';
import { WEB_DEADLINE_MS } from '../tools/web-search.js';
import { lateCommentarySilence, type LateCommentaryState } from '../live/index.js';
import type { IntentSubResult } from '../tools/intent.js';

const signal = (): AbortSignal => new AbortController().signal;
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const NOW = 1_700_000_000_000;

/** The owner's clock: a timer that fires only when the test moves it, so a 20 s wait costs no real second. */
class OwnerClock {
  now = NOW;
  #timers: { due: number; callback: () => void; cancelled: boolean }[] = [];
  schedule = (callback: () => void, delayMs: number) => {
    const entry = { due: this.now + delayMs, callback, cancelled: false };
    this.#timers.push(entry);
    return { unref: () => {}, cancel: () => { entry.cancelled = true; } };
  };
  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = this.#timers.filter(timer => !timer.cancelled && timer.due <= this.now).sort((a, b) => a.due - b.due)[0];
      if (due === undefined) return;
      this.#timers.splice(this.#timers.indexOf(due), 1);
      due.callback();
    }
  }
}

interface Fixture {
  clock: OwnerClock;
  deps: ResearchDeps;
  late: ResearchLateFindings[];
  firstAnswers: { kind?: string; elapsedMs?: number }[];
  /** Settle the one slow read now, or never. */
  settle: () => void;
  settled: () => boolean;
}

/** One live read that keeps running until the test settles it, exactly as call 01c4bd89's web read did. */
function fixture(): Fixture {
  const clock = new OwnerClock();
  const late: ResearchLateFindings[] = [];
  const firstAnswers: { kind?: string; elapsedMs?: number }[] = [];
  let settled = false;
  let release: () => void = () => {};
  const reading = new Promise<void>(resolve => { release = () => { settled = true; resolve(); }; });
  const deps: ResearchDeps = {
    now: () => clock.now, schedule: clock.schedule, configured: ['knowledge'], ledger: new ResearchLedger(),
    emit() {}, log() {}, step() {}, logSource() {}, logSubcall() {}, logRouted() {},
    logFirstAnswer: event => { firstAnswers.push({ kind: event.kind, elapsedMs: event.elapsedMs }); },
    late: event => { late.push(event); },
    execute: async subs => {
      await reading;
      return subs.map(call => ({
        key: call.key, name: call.name, ok: true,
        text: '### PT Agricon (COMPANY | 2026-10-20) [id 41]\ncreates and trades agricultural products',
        originalCharacters: 96, omittedCharacters: 0,
      }) as IntentSubResult);
    },
  };
  return { clock, deps, late, firstAnswers, settle: release, settled: () => settled };
}

test('R1 constants: patience is 15 s, the line is at 10 s, the hard stop is 20 s, web fits inside', () => {
  assert.equal(RESEARCH_OPERATION.deadlineMs, 15_000, 'a research call waits 15 s for its sources, not 6 s');
  assert.equal(RESEARCH_OPERATION.stillSearchingMs, 10_000, 'the still-searching line is due at 10 s');
  assert.equal(RESEARCH_OPERATION.hardStopMs, 20_000, 'the hard stop is 20 s');
  assert.equal(RESEARCH_OPERATION.deadlineMs + RESEARCH_OPERATION.hostGraceMs, RESEARCH_OPERATION.hardStopMs,
    'the host settle bound and the hard stop are the same number named once');
  assert.equal(WEB_DEADLINE_MS, 14_000, 'a web read can finish inside the 15 s patience budget');
  assert.ok(WEB_DEADLINE_MS < RESEARCH_OPERATION.deadlineMs, 'the read never outlives the call that waits for it');
  assert.equal(RESEARCH.stillReadingNote, 'Still searching: ', 'a source still reading is still searching');
  assert.match(RESEARCH.stillSearchingLine, /[Ss]till searching/, 'the one line says what is true');
});

test('replay 01c4bd89: the call answers after its slow source settles, never before', async () => {
  const h = fixture();
  let answered = false;
  const answeredAt: number[] = [];
  const answer = runResearch(h.deps, { action: 'start', question: 'what does PT Agricon sell' }, signal())
    .then(reply => { answered = true; answeredAt.push(h.clock.now); return reply; });
  await flush();
  assert.equal(answered, false, 'no answer at once');
  h.clock.advance(4_500);
  await flush();
  assert.equal(answered, false, 'the early answer point does not answer while the only source is still reading');
  h.clock.advance(4_200);
  await flush();
  assert.equal(answered, false, 'still reading at 8.7 s, and no half answer went out');
  h.clock.advance(1_400);
  await flush();
  assert.equal(answered, false, 'still reading at 10.1 s: the answer waits for the source the question needs');
  h.settle();
  const reply = await answer;
  await flush();
  assert.equal(answered, true);
  assert.equal(answeredAt[0]! - NOW, 10_100, 'the answer went out when the read landed, inside the 15 s budget');
  assert.equal(reply['status'], 'complete', 'a settled source completes the answer');
  assert.doesNotMatch(JSON.stringify(reply), /timed out/, 'a source that returned is never called a timeout');
  assert.deepEqual(h.firstAnswers, [], 'a call whose sources all settled logs its answer as full, not as a first answer ahead of them');
});

test('replay 01c4bd89: a source that never returns stops the call at the hard stop and is named honestly', async () => {
  const h = fixture();
  let reply: Record<string, unknown> | undefined;
  void runResearch(h.deps, { action: 'start', question: 'what does PT Agricon sell' }, signal()).then(value => { reply = value; });
  for (let elapsed = 0; elapsed < 20_000; elapsed += 1_000) { h.clock.advance(1_000); await flush(); }
  await flush();
  assert.notEqual(reply, undefined, 'the call answered inside the hard stop');
  assert.ok(h.clock.now - NOW <= 20_000, `owner-perceived waiting never passes 20 s, got ${h.clock.now - NOW} ms`);
  assert.equal(reply!['status'], 'partial', 'the answer is partial because a source is still reading');
  assert.match(String(reply!['note']), /Did not return in time: knowledge/, 'the reply names the source that did not return');
  assert.doesNotMatch(JSON.stringify(reply), /timed out/, 'results still arriving are never called a timeout');
  assert.doesNotMatch(String(reply!['note']), /Still searching: knowledge/, 'the hard stop says what really happened');
  assert.deepEqual((reply!['pending'] as string[]), ['knowledge'], 'the pending source is named');
});

test('replay 01c4bd89: findings that land after the answer are handed on, not dropped', async () => {
  const h = fixture();
  let reply: Record<string, unknown> | undefined;
  void runResearch(h.deps, { action: 'start', question: 'what does PT Agricon sell' }, signal()).then(value => { reply = value; });
  for (let elapsed = 0; elapsed < 20_000; elapsed += 1_000) { h.clock.advance(1_000); await flush(); }
  await flush();
  assert.notEqual(reply, undefined, 'the call answered at its bound');
  h.settle();
  await flush();
  assert.equal(h.late.length, 1, 'the late read was handed to the host instead of parked silently');
  assert.equal(h.late[0]!.source, 'knowledge');
  assert.ok(h.late[0]!.items.length > 0, 'the late block carries the real findings');
});

test('R6 loop guard: one own-results continue, then a refusal; a new question still needs an owner turn', () => {
  const admission = new ResearchAdmission();
  admission.ownerTurn();
  assert.deepEqual(admission.admit('start'), { admitted: true }, 'the owner turn admits the start');
  admission.delivered();
  assert.deepEqual(admission.admit('continue', true), { admitted: true }, 'one continue for the pending results of its own research');
  assert.equal(admission.admit('continue', true).admitted, false, 'a second continue is refused: the loop guard');
  assert.equal(admission.admit('continue').admitted, false, 'a continue for a new question is refused without a new owner turn');
  assert.deepEqual(admission.admit('stop'), { admitted: true }, 'the owner can always stop her');
});

// --- R5: the late-commentary rule, pinned where the owner's patience is decided ------------------

test('R5: a filler sound never parks a late finding; only a new question does', () => {
  const answeredAt = 1_000;
  const quiet = { now: 3_000, answeredAt, alreadySpoken: false, ownerWords: 0 };
  const fillerWords: LateCommentaryState = { ...quiet, now: 3_000, inputAt: 1_200, ownerWords: 1 };
  assert.equal(lateCommentarySilence(fillerWords), null, 'one word after the answer is a filler, and the finding lands');
  assert.equal(lateCommentarySilence({ ...fillerWords, ownerWords: 3 }), null, 'three words are still a filler');
  assert.equal(lateCommentarySilence({ ...fillerWords, inputAt: 2_000, ownerWords: 4 }), 'new_question', 'a real question parks the block');
  const immediate: LateCommentaryState = { ...quiet, now: 2_000, inputAt: 1_100, ownerWords: 9 };
  assert.equal(lateCommentarySilence(immediate), null, 'speech inside the 1.5 s speaking hold is not a new question');
  assert.equal(lateCommentarySilence({ ...quiet, inputAt: 2_800 }), 'owner_speaking', 'the owner is still talking');
  assert.equal(lateCommentarySilence({ ...quiet, lastModelAudioAt: 2_000 }), 'answer_playing', 'the answer audio is still playing');
  assert.equal(lateCommentarySilence({ ...quiet, now: 21_000 }), 'window_elapsed', 'a block that lands too late stays context');
  assert.equal(lateCommentarySilence({ ...quiet, alreadySpoken: true }), 'already_spoken', 'one late line per call');
});
