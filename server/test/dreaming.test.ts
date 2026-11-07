import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/runtime/store.js';
import { domainMigrations } from '../dist/domain/schema.js';
import { liveMigrations } from '../dist/live/schema.js';
import { recordHistorySession } from '../dist/domain/history-lifecycle.js';
import * as memory from '../dist/domain/memory-items.js';
import { afterListenerServing } from '../dist/host/runtime.js';
import {
  buildDreamingInput, createDreaming, DREAMING_BACKLOG_LIMIT, DREAMING_EXTRACTOR_VERSION, DREAMING_MAX_ATTEMPTS,
  DREAMING_MAX_OPERATIONS, ownerCorrectionTurnIds,
  parseExtraction,
  readDreamingSession, validateOperations, type Dreaming, type DreamingOptions,
} from '../dist/services/dreaming.js';
import type { ModelControl, ModelPort, ModelRequest, ModelResult } from '../dist/adapters/model/types.js';

/**
 * The dreaming pass (#914). Every fixture here is synthetic: no owner content, no real store.
 * The pass reads the real compiled services, the real Store and the real memory tables.
 */

const NOW = Date.parse('2026-11-06T09:00:00Z');

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'didi-dreaming-'));
  const store = new Store(dir, [...domainMigrations, ...liveMigrations]);
  return { store, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedSession(store: Store, id: string, options: { key?: string; endedAt?: number } = {}): void {
  store.transaction(tx => {
    tx.run(`INSERT INTO live_sessions (live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint,
        client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events, journal_bytes,
        journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at, memory_provenance)
      VALUES (?,?,?,?,?,?,?,?,?,'terminal',0,0,0,0,1,'ended',?,?,?,?,NULL)`,
      [id, store.assistantId, store.authorityEpoch, options.key ?? `key-${id}`, `fp-${id}`, 'client', 'audit',
        'profile', 'prompt', JSON.stringify({ state: 'closed', code: 'normal' }), options.endedAt ?? NOW, options.endedAt ?? NOW, options.endedAt ?? NOW]);
    recordHistorySession(tx, id, 'owner', ['ordinary'], [], options.endedAt ?? NOW);
  });
}

let turnClock = 0;
/** The turn ids the pass must cite: `run` answers with the changed count, so the ids are read back. */
function seedTurns(store: Store, id: string, turns: readonly (readonly ['owner' | 'assistant', string])[]): number[] {
  return store.transaction(tx => {
    for (const [role, text] of turns) {
      turnClock += 1;
      tx.run('INSERT INTO history_turns(live_session_id,journal_first,journal_last,role,text,at) VALUES (?,?,?,?,?,?)',
        [id, turnClock, turnClock, role, text, NOW + turnClock * 1_000]);
    }
    return tx.all('SELECT id FROM history_turns WHERE live_session_id=? ORDER BY id', [id]).map(row => Number(row['id']));
  });
}

function reply(text: string, status: ModelResult['status'] = 'complete'): ModelResult {
  return { status, text, providerContent: { role: 'model', parts: [{ text }] }, reason: status === 'complete' ? '' : 'synthetic',
    prompt: { version: 'fixture', hash: 'fixture', omittedContextIds: [] },
    timings: { kind: 'synthetic', totalMs: 1, firstTextMs: 1 } };
}

class FakeModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  private readonly answer: (request: ModelRequest) => ModelResult;
  constructor(answer: (request: ModelRequest) => ModelResult) { this.answer = answer; }
  generate(request: ModelRequest, _control: ModelControl): Promise<ModelResult> {
    this.requests.push(request);
    return Promise.resolve(this.answer(request));
  }
}

function operations(...ops: readonly Record<string, unknown>[]): ModelResult {
  return reply(JSON.stringify({ operations: ops }));
}

function dreaming(store: Store, model: ModelPort | null, extra: Partial<DreamingOptions> = {}): Dreaming {
  return createDreaming({ store, model, modelId: 'synthetic-text-model', modelAllowedClasses: ['ordinary'],
    assistantName: 'Naya', timeZone: 'UTC', now: () => NOW, log: () => {}, ...extra });
}

const PLAN_OP = {
  op: 'add', kind: 'plan', text: 'He plans to fly to Phuket next Friday.', subject: 'trip:phuket', salience: 3,
  event_text: 'next Friday', event_at: '2026-11-13', place: 'Phuket', turn_start_id: 1, turn_end_id: 1,
};

test('a plan keeps his relative phrase and resolves it to the date the call named', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-plan');
    const ids = seedTurns(h.store, 's-plan', [['owner', 'I am flying to Phuket next Friday with my daughter'],
      ['assistant', 'Next Friday it is: I will keep the morning free.'],
      ['owner', 'She wants to see the night market while we are there']]);
    const model = new FakeModel(() => operations({
      op: 'add', kind: 'plan', text: 'He plans to fly to Phuket next Friday.', subject: 'trip:phuket', salience: 3,
      event_text: 'next Friday', event_at: '2026-11-13', place: 'Phuket', turn_start_id: ids[0], turn_end_id: ids[0],
    }));
    const outcome = await dreaming(h.store, model).runSession('s-plan');
    assert.equal(outcome.status, 'done');
    assert.deepEqual(outcome.ops, { add: 1 });
    const items = h.store.transaction(tx => memory.itemsForSubject(tx, 'trip:phuket'));
    assert.equal(items.length, 1);
    assert.equal(items[0]!.eventText, 'next Friday');
    assert.equal(items[0]!.eventAt, Date.parse('2026-11-13'));
    assert.equal(items[0]!.salience, 3);
    assert.equal(items[0]!.createdBy, `dreaming:${DREAMING_EXTRACTOR_VERSION}`);
    assert.equal(items[0]!.authority, 'derived');
    // Provenance is the turn itself, so the read path can join the words back in.
    const sources = h.store.transaction(tx => memory.sources(tx, items[0]!.id));
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.text, 'I am flying to Phuket next Friday with my daughter');
    // The request carried the call's clock, so the model could resolve the phrase at all.
    assert.match(model.requests[0]!.contents[0]!.parts[0]!.text!, /\d{1,2} \w{3} \d{4}/);
  } finally { h.cleanup(); }
});

test('a correction turn supersedes a derived item and keeps the old row', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-correct');
    const ids = seedTurns(h.store, 's-correct', [['owner', 'Actually, the Phuket trip is in December now, not next Friday'],
      ['assistant', 'December, then.'],
      ['owner', 'And my daughter is coming along for the whole week']]);
    const old = h.store.transaction(tx => memory.insertItem(tx, { kind: 'plan', text: 'He plans to fly to Phuket next Friday.',
      subject: 'trip:phuket', validFrom: NOW - 86_400_000, createdAt: NOW - 86_400_000, createdBy: 'dreaming:dreaming-v1' }));
    const model = new FakeModel(() => operations({
      op: 'supersede', old_id: old.id, kind: 'plan', text: 'He plans to fly to Phuket in December.', subject: 'trip:phuket',
      salience: 3, event_text: 'in December', turn_start_id: ids[0], turn_end_id: ids[0],
    }));
    const outcome = await dreaming(h.store, model).runSession('s-correct');
    assert.equal(outcome.status, 'done');
    assert.deepEqual(outcome.ops, { supersede: 1 });
    const items = h.store.transaction(tx => memory.itemsForSubject(tx, 'trip:phuket'));
    assert.equal(items.length, 2, 'the old row survives: nothing is deleted but through forgetScope');
    const superseded = items.find(item => item.id === old.id)!;
    assert.equal(superseded.status, 'superseded');
    const replacement = items.find(item => item.id !== old.id)!;
    assert.equal(superseded.supersededBy, replacement.id);
    assert.equal(replacement.status, 'active');
  } finally { h.cleanup(); }
});

test('an explicit_owner item is protected unless the op cites the owner correction turn', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-protect');
    const ids = seedTurns(h.store, 's-protect', [['owner', 'What is on my calendar tomorrow in Zurich'],
      ['assistant', 'Two calls before noon.'],
      ['owner', 'Move the second one to the afternoon please']]);
    const explicit = h.store.transaction(tx => memory.insertItem(tx, { kind: 'durable_fact', text: 'He lives in Zurich.',
      subject: 'home', validFrom: NOW, createdAt: NOW, createdBy: 'remember_note', authority: 'explicit_owner' }));
    const logged: { event: string }[] = [];
    const model = new FakeModel(() => operations({ op: 'invalidate', id: explicit.id, reason: 'he moved',
      turn_start_id: ids[0], turn_end_id: ids[0] }));
    const outcome = await dreaming(h.store, model, { log: event => logged.push(event) }).runSession('s-protect');
    assert.equal(outcome.status, 'done');
    assert.equal(outcome.rejected, 1);
    assert.ok(logged.some(event => event.event === 'dreaming_op_rejected'), 'the rejection is logged');
    assert.equal(h.store.transaction(tx => memory.itemsForSubject(tx, 'home'))[0]!.status, 'active',
      'an explicit item is never invalidated without a cited correction turn');

    // The same op with a correction turn cited is admitted.
    seedSession(h.store, 's-protect-2');
    const corrected = seedTurns(h.store, 's-protect-2', [['owner', 'No, I said I moved from Zurich to Basel last month'],
      ['owner', 'The new flat is five minutes from the station']]);
    const accepting = new FakeModel(() => operations({ op: 'invalidate', id: explicit.id, reason: 'he moved',
      turn_start_id: corrected[0], turn_end_id: corrected[0] }));
    const second = await dreaming(h.store, accepting).runSession('s-protect-2');
    assert.equal(second.status, 'done');
    assert.equal(second.rejected, 0);
    assert.equal(h.store.transaction(tx => memory.itemsForSubject(tx, 'home'))[0]!.status, 'invalid');
  } finally { h.cleanup(); }
});

test('an operation citing a turn outside the session is rejected, nothing is written', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-outside');
    seedTurns(h.store, 's-outside', [['owner', 'Short call about the holidays'],
      ['owner', 'We leave on the second and come back on the ninth']]);
    seedSession(h.store, 's-other');
    const foreign = seedTurns(h.store, 's-other', [['owner', 'A turn of another call entirely'],
      ['owner', 'And one more turn so the call has substance']]);
    const model = new FakeModel(() => operations({ ...PLAN_OP, turn_start_id: foreign[0], turn_end_id: foreign[0] }));
    const outcome = await dreaming(h.store, model).runSession('s-outside');
    assert.equal(outcome.status, 'done');
    assert.equal(outcome.rejected, 1);
    assert.deepEqual(outcome.ops, {});
    assert.equal(h.store.transaction(tx => memory.activeItems(tx, {})).length, 0);
  } finally { h.cleanup(); }
});

test('a second run of the same session and version is already done and writes nothing', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-repeat');
    const ids = seedTurns(h.store, 's-repeat', [['owner', 'Book the dentist for Tuesday morning please'],
      ['owner', 'Any time before eleven works for me']]);
    const model = new FakeModel(() => operations({ ...PLAN_OP, text: 'He asked for a dentist appointment on Tuesday.',
      subject: 'health:dentist', event_text: 'Tuesday', turn_start_id: ids[0], turn_end_id: ids[0] }));
    const pass = dreaming(h.store, model);
    assert.equal((await pass.runSession('s-repeat')).status, 'done');
    const again = await pass.runSession('s-repeat');
    assert.equal(again.status, 'already_done');
    assert.equal(model.requests.length, 1, 'the second run spends no model request');
    assert.equal(h.store.transaction(tx => memory.activeItems(tx, {})).length, 1);
  } finally { h.cleanup(); }
});

test('a canary session produces no job and is never a backlog candidate', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-canary', { key: 'canary:boot' });
    seedTurns(h.store, 's-canary', [['owner', 'Ring the canary bell and report the tone']]);
    const model = new FakeModel(() => operations({ ...PLAN_OP }));
    const pass = dreaming(h.store, model);
    const outcome = await pass.runSession('s-canary');
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.reason, 'not_owner_session');
    const batch = await pass.backlogBatch(12);
    assert.equal(batch.processed, 0);
    assert.equal(model.requests.length, 0);
    assert.equal(h.store.transaction(tx => memory.job(tx, 's-canary', DREAMING_EXTRACTOR_VERSION)), null);
  } finally { h.cleanup(); }
});

test('a job under a stale generation fails at commit and writes no item', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-stale');
    const ids = seedTurns(h.store, 's-stale', [['owner', 'Remember that I prefer morning calls'],
      ['owner', 'Never anything before nine if it can wait']]);
    const model = new FakeModel(() => {
      // The store forgets while the model runs: every write of this job is refused.
      h.store.transaction(tx => { tx.run('UPDATE memory_generation SET generation = generation + 1 WHERE id = 1'); });
      return operations({ op: 'add', kind: 'preference', text: 'He prefers morning calls.', subject: 'preference:calls',
        salience: 2, turn_start_id: ids[0], turn_end_id: ids[0] });
    });
    const outcome = await dreaming(h.store, model).runSession('s-stale');
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.reason, 'generation_stale');
    assert.equal(h.store.transaction(tx => memory.activeItems(tx, {})).length, 0);
    assert.equal(h.store.transaction(tx => memory.job(tx, 's-stale', DREAMING_EXTRACTOR_VERSION))!.state, 'failed');
  } finally { h.cleanup(); }
});

test('a failed job is retried once and then left alone', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-retry');
    seedTurns(h.store, 's-retry', [['owner', 'Tell me the weather for the weekend please'],
      ['owner', 'We are thinking of the coast on Saturday']]);
    const model = new FakeModel(() => reply('', 'error'));
    const pass = dreaming(h.store, model);
    assert.equal((await pass.runSession('s-retry')).status, 'failed');
    assert.equal((await pass.runSession('s-retry')).status, 'failed');
    const third = await pass.runSession('s-retry');
    assert.equal(third.status, 'skipped');
    assert.equal(third.reason, 'attempts_exhausted');
    assert.equal(model.requests.length, 2, 'one retry, never an endless loop');
  } finally { h.cleanup(); }
});

test('the backlog batch takes the newest ended owner calls first, up to the limit', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-oldest', { endedAt: NOW - 3_000 });
    seedSession(h.store, 's-middle', { endedAt: NOW - 2_000 });
    seedSession(h.store, 's-newest', { endedAt: NOW - 1_000 });
    seedSession(h.store, 's-eval', { key: 'eval:night', endedAt: NOW - 4_000 });
    seedSession(h.store, 's-canary', { key: 'canary:boot', endedAt: NOW - 5_000 });
    for (const id of ['s-oldest', 's-middle', 's-newest', 's-eval', 's-canary']) {
      seedTurns(h.store, id, [['owner', `A substantive owner turn about the number ${id.length} plan`],
        ['owner', `And a second turn so the call clears the substantive floor of ${id.length}`]]);
    }
    const model = new FakeModel(() => operations({ ...PLAN_OP, turn_start_id: 0, turn_end_id: 0 }));
    const logged: Record<string, unknown>[] = [];
    const pass = dreaming(h.store, model, { log: event => logged.push(event) });
    const first = await pass.backlogBatch(2);
    assert.equal(first.processed, 2);
    assert.equal(first.remaining, 1);
    const called = h.store.transaction(tx => tx.all('SELECT session_id FROM memory_jobs ORDER BY started_at'))
      .map(row => String(row['session_id']));
    assert.deepEqual(called.sort(), ['s-middle', 's-newest'], 'newest first, up to the limit, never a canary or eval call');
    const second = await pass.backlogBatch(2);
    assert.equal(second.processed, 1);
    assert.equal(second.remaining, 0);
    const backlog = logged.find(event => event.event === 'dreaming_backlog')!;
    assert.equal(backlog['sessionsProcessed'], 2);
    assert.equal(backlog['sessionsRemaining'], 1);
    assert.ok(typeof backlog['elapsedMs'] === 'number');
  } finally { h.cleanup(); }
});

test('a call below the substantive floor is marked done with no model request and never retried', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-thin');
    seedTurns(h.store, 's-thin', [['owner', 'One short line about coffee']]);
    const model = new FakeModel(() => operations({ ...PLAN_OP }));
    const logged: Record<string, unknown>[] = [];
    const pass = dreaming(h.store, model, { log: event => logged.push(event) });
    const outcome = await pass.runSession('s-thin');
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.reason, 'skipped_below_floor');
    assert.equal(model.requests.length, 0, 'a thin call spends no model request');
    const done = logged.find(event => event.event === 'dreaming_done');
    assert.equal(done?.['outcome'], 'skipped_below_floor', 'the log names the skip rather than an extraction');
    assert.equal(h.store.transaction(tx => memory.job(tx, 's-thin', DREAMING_EXTRACTOR_VERSION))!.state, 'done');
    assert.equal((await pass.runSession('s-thin')).status, 'already_done', 'the same extractor version never retries it');
    assert.equal(model.requests.length, 0);
  } finally { h.cleanup(); }
});

test('#948: a short call that states a durable preference still reaches the extractor', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-coffee');
    const ids = seedTurns(h.store, 's-coffee', [['owner', 'I take my coffee black from now on'],
      ['assistant', 'Black it is.']]);
    const model = new FakeModel(() => operations({ op: 'add', kind: 'preference', text: 'He takes his coffee black.',
      subject: 'coffee', salience: 2, turn_start_id: ids[0], turn_end_id: ids[0] }));
    const logged: Record<string, unknown>[] = [];
    const outcome = await dreaming(h.store, model, { log: event => logged.push(event) }).runSession('s-coffee');
    assert.equal(model.requests.length, 1, 'the durable line earns one request');
    assert.equal(outcome.status, 'done');
    const items = h.store.transaction(tx => memory.itemsForSubject(tx, 'coffee'));
    assert.equal(items.length, 1, 'exactly one preference item, never two');
    assert.equal(items[0]!.kind, 'preference');
    assert.equal(logged.find(event => event.event === 'dreaming_done')?.['outcome'], 'extracted',
      'the job counts as an extraction');
  } finally { h.cleanup(); }
});

test('#948: a short greeting carries no durable statement and yields nothing', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-greeting');
    seedTurns(h.store, 's-greeting', [['owner', 'Hi Naya'], ['assistant', 'Morning.']]);
    const model = new FakeModel(() => operations({ op: 'add', kind: 'preference', text: 'He takes his coffee black.',
      subject: 'coffee', salience: 2, turn_start_id: 1, turn_end_id: 1 }));
    const outcome = await dreaming(h.store, model).runSession('s-greeting');
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.reason, 'skipped_below_floor');
    assert.equal(model.requests.length, 0, 'small talk still spends no request');
    assert.equal(h.store.transaction(tx => memory.activeItems(tx).length), 0);
  } finally { h.cleanup(); }
});

test('#949: the same transient state dreamed from two jobs leaves one active row and one superseded', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-state-a');
    const first = seedTurns(h.store, 's-state-a', [['owner', 'I am travelling to Phuket next Friday with my daughter'],
      ['assistant', 'Noted.']]);
    const modelA = new FakeModel(() => operations({ op: 'add', kind: 'transient_state', text: 'He is travelling this week.',
      subject: 'state:travel', salience: 2, turn_start_id: first[0], turn_end_id: first[0] }));
    assert.equal((await dreaming(h.store, modelA).runSession('s-state-a')).status, 'done');

    seedSession(h.store, 's-state-b', { endedAt: NOW + 3_600_000 });
    const second = seedTurns(h.store, 's-state-b', [['owner', 'Checking in about the booking for Friday morning'],
      ['assistant', 'All set.']]);
    const modelB = new FakeModel(() => operations({ op: 'add', kind: 'transient_state', text: 'He is away on a long trip.',
      subject: 'state:travel', salience: 2, turn_start_id: second[0], turn_end_id: second[0] }));
    const logged: Record<string, unknown>[] = [];
    const outcome = await dreaming(h.store, modelB, { now: () => NOW + 3_600_000, log: event => logged.push(event) })
      .runSession('s-state-b');
    assert.equal(outcome.status, 'done');

    const rows = h.store.transaction(tx => memory.itemsForSubject(tx, 'state:travel'));
    assert.equal(rows.length, 2, 'the second job writes its own row');
    const active = rows.filter(row => row.status === 'active');
    const superseded = rows.filter(row => row.status === 'superseded');
    assert.equal(active.length, 1, 'one active row survives the second job');
    assert.equal(superseded.length, 1, 'the earlier row is superseded, never left active beside it');
    assert.equal(superseded[0]!.supersededBy, active[0]!.id);
    assert.equal(superseded[0]!.validUntil, NOW + 3_600_000, 'the supersede carries the date it happened');
    assert.equal(logged.find(event => event.event === 'dreaming_done')?.['outcome'], 'superseded');
  } finally { h.cleanup(); }
});

test('a below-floor call does not spend the backlog limit', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-thin', { endedAt: NOW - 500 });
    seedTurns(h.store, 's-thin', [['owner', 'One short line about coffee']]);
    seedSession(h.store, 's-thick', { endedAt: NOW - 1_500 });
    const ids = seedTurns(h.store, 's-thick', [['owner', 'I want to plan the winter trip properly'],
      ['owner', 'Somewhere warm for ten days in January']]);
    const model = new FakeModel(() => operations({ ...PLAN_OP, turn_start_id: ids[0], turn_end_id: ids[0] }));
    const logged: Record<string, unknown>[] = [];
    const batch = await dreaming(h.store, model, { log: event => logged.push(event) }).backlogBatch(1);
    assert.equal(model.requests.length, 1, 'the one request goes to the substantive call');
    assert.equal(batch.processed, 1);
    assert.equal(batch.remaining, 0);
    const backlog = logged.find(event => event.event === 'dreaming_backlog')!;
    assert.equal(backlog['sessionsSkipped'], 1, 'the thin call is reported without spending the limit');
    assert.equal(backlog['sessionsProcessed'], 1);
  } finally { h.cleanup(); }
});

test('an exhausted job never takes a backlog slot from a fresh call', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-fresh', { endedAt: NOW - 20_000 });
    const ids = seedTurns(h.store, 's-fresh', [['owner', 'I want to plan the winter trip properly'],
      ['owner', 'Somewhere warm for ten days in January']]);
    for (let index = 0; index < DREAMING_BACKLOG_LIMIT; index += 1) {
      const id = `s-exhausted-${index}`;
      seedSession(h.store, id, { endedAt: NOW - 1_000 + index });
      seedTurns(h.store, id, [['owner', `A substantive owner turn number ${index} about the winter plan`],
        ['owner', 'And a second turn so the call clears the substantive floor']]);
      h.store.transaction(tx => {
        for (let attempt = 0; attempt < DREAMING_MAX_ATTEMPTS; attempt += 1) {
          memory.failJob(tx, memory.claimJob(tx, id, DREAMING_EXTRACTOR_VERSION, NOW).id, 'model_unavailable', NOW);
        }
      });
    }
    const model = new FakeModel(() => operations({ ...PLAN_OP, turn_start_id: ids[0], turn_end_id: ids[0] }));
    const batch = await dreaming(h.store, model).backlogBatch(DREAMING_BACKLOG_LIMIT);
    assert.equal(model.requests.length, 1, 'the one request goes to the fresh call, never to an exhausted job');
    assert.equal(h.store.transaction(tx => memory.job(tx, 's-fresh', DREAMING_EXTRACTOR_VERSION))!.state, 'done');
    assert.equal(batch.processed, 1);
    assert.equal(batch.remaining, 0);
  } finally { h.cleanup(); }
});

test('the backlog never starts before the listener serves', async () => {
  const order: string[] = [];
  const failing = afterListenerServing(Promise.reject(new Error('port taken')), () => order.push('backlog'));
  await assert.rejects(failing);
  assert.deepEqual(order, [], 'a host that could not listen spends no model request');
  const served = await afterListenerServing(Promise.resolve('serving'), () => order.push('backlog'));
  assert.equal(served, 'serving');
  assert.deepEqual(order, ['backlog']);
});

test('the validator names each refusal and turns a duplicate into a noop', () => {
  const items: memory.MemoryItem[] = [];
  const context = { turnIds: new Set([1, 2]), correctionTurnIds: new Set<number>(), items, now: NOW };
  const [first, second] = parseExtraction(JSON.stringify({ operations: [PLAN_OP, { ...PLAN_OP }] })).operations;
  const validated = validateOperations([first!, second!], context);
  assert.equal(validated.rejected.length, 0);
  assert.equal(validated.accepted.length, 2);
  assert.equal(validated.accepted[1]!.op, 'noop', 'the same subject and text twice is one item');

  const bad = parseExtraction(JSON.stringify({ operations: [{ ...PLAN_OP, salience: 7 }, { ...PLAN_OP, kind: 'vibe' }] }));
  assert.deepEqual(bad.rejected.map(entry => entry.reason), ['invalid_salience', 'unknown_kind']);
});

test('operations beyond the per-call cap are counted as rejected, never dropped silently', () => {
  const many = Array.from({ length: DREAMING_MAX_OPERATIONS + 6 }, () => ({ ...PLAN_OP }));
  const parsed = parseExtraction(JSON.stringify({ operations: many }));
  assert.equal(parsed.operations.length, DREAMING_MAX_OPERATIONS, 'the cap still holds');
  assert.equal(parsed.rejected.length, 6, 'every operation over the cap is counted');
  assert.deepEqual(parsed.rejected.map(entry => entry.reason), Array.from({ length: 6 }, () => 'over_cap'));
});

test('a transient state gets a validity date, a dossier subject never reaches the store', () => {
  const parsed = parseExtraction(JSON.stringify({ operations: [
    { op: 'add', kind: 'transient_state', text: 'He is travelling this week.', subject: 'state:travel', salience: 1, turn_start_id: 1, turn_end_id: 1 },
    { op: 'add', kind: 'durable_fact', text: 'He owns a boat.', subject: 'BAD SUBJECT!', salience: 1, turn_start_id: 1, turn_end_id: 1 },
  ] }));
  assert.deepEqual(parsed.rejected.map(entry => entry.reason), ['unknown_subject']);
  const validated = validateOperations(parsed.operations, { turnIds: new Set([1]), correctionTurnIds: new Set<number>(), items: [], now: NOW });
  const added = validated.accepted[0]!;
  assert.equal(added.op, 'add');
  assert.equal(added.op === 'add' ? added.item.validUntil : null, NOW + 30 * 86_400_000);
});

test('only an owner turn that reads as a correction licenses touching his explicit memory', () => {
  const correction = ownerCorrectionTurnIds([
    { id: 1, role: 'owner', text: 'What is on my calendar' },
    { id: 2, role: 'owner', text: 'Actually, I moved to Basel last month' },
    { id: 3, role: 'assistant', text: 'Actually, I moved to Basel last month' },
  ]);
  assert.deepEqual([...correction], [2]);

  const h = open();
  try {
    seedSession(h.store, 's-input');
    const ids = seedTurns(h.store, 's-input', [['owner', 'I am flying to Phuket next Friday with my daughter']]);
    const session = readDreamingSession(h.store, 's-input', 'Asia/Tokyo');
    const input = buildDreamingInput({ assistantName: 'Naya', session, items: [] });
    assert.match(input, new RegExp(`#${ids[0]} Owner`));
    assert.match(input, /turns are the only evidence/);
    assert.match(input, /next Friday/);
  } finally { h.cleanup(); }
});
