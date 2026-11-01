// C-MEMORYTRUTH (10.8): a call summary never remembers a refused write as done, and the next call's seed names
// the alarms the table actually holds. Every case drives the real distiller or the real composer with a fake
// provider port, so no case reaches a provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { liveMigrations } from '../live/schema.js';
import { toolsMigrations } from '../tools/schema.js';
import * as summaries from '../domain/summaries.js';
import { recordHistorySession } from '../domain/history-lifecycle.js';
import { activeAlarms } from '../domain/write-claims.js';
import { armedAlarmsNote, guardSeededSummaries } from '../live/index.js';
import { composeLiveSessionInstruction } from '../prompt/live-persona.js';
import { createSummarizer, type SummarizerLogEvent } from '../services/summarize.js';
import type { ModelControl, ModelPort, ModelRequest, ModelResult } from '../adapters/model/types.js';

const SUMMARY_NOW = 1_700_000_000_000;

function summarizerFixture(): { store: Store; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-summary-worker-'));
  const store = new Store(dir, [...domainMigrations, ...liveMigrations, ...toolsMigrations]);
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedConversation(store: Store, id: string, endedAt = SUMMARY_NOW): void {
  store.transaction(tx => {
    tx.run(`INSERT INTO live_sessions (live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint,
        client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events, journal_bytes,
        journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at, memory_provenance)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,1,'ended',?,?,?,?,?)`,
      [id, store.assistantId, store.authorityEpoch, `key-${id}`, `fp-${id}`, 'client', 'audit', 'profile', 'prompt', 'terminal',
        JSON.stringify({ state: 'closed', code: 'normal' }), endedAt, endedAt, endedAt, null]);
    tx.run(`INSERT INTO live_grants (grant_id, live_session_id, provider, model, voice, key_reference, permitted_classes,
        chosen_input_class, revision, granted_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [`grant-${id}`, id, 'gemini', 'models/live-start10-test', 'voice', 'gemini-primary', JSON.stringify(['ordinary', 'private']), 'ordinary', 1, endedAt]);
    recordHistorySession(tx, id, 'owner', ['ordinary', 'private'], [], endedAt);
    for (const text of ['one', 'two']) {
      tx.run('INSERT INTO live_journal (live_session_id, kind, text, finished, payload_bytes, arrived_at) VALUES (?,?,?,1,?,?)',
        [id, 'inputTranscription', text, text.length, endedAt]);
    }
  });
}

function modelResult(status: ModelResult['status'], text: string, reason = ''): ModelResult {
  return { status, text, providerContent: { role: 'model', parts: [{ text }] }, reason,
    prompt: { version: 'fixture', hash: 'fixture', omittedContextIds: [] },
    timings: { kind: 'synthetic', totalMs: 1, firstTextMs: 1 } };
}

/** Repeats its last scripted step, so an unexpected extra attempt still fails instead of passing. */
class ScriptedModel implements ModelPort {
  calls = 0;
  constructor(private readonly script: ModelResult[]) {}
  generate(_request: ModelRequest, _control: ModelControl): Promise<ModelResult> {
    const step = this.script[Math.min(this.calls++, this.script.length - 1)]!;
    return Promise.resolve(step);
  }
}


function worker(store: Store, model: ModelPort, waits: number[], log: (event: SummarizerLogEvent) => void = () => {}) {
  // The host always passes the route's permitted classes; without them the distiller fails closed and skips.
  return createSummarizer({ store, model, modelId: 'synthetic-text-model', modelAllowedClasses: ['ordinary', 'private'],
    assistantName: 'Naya', timeZone: 'UTC', now: () => SUMMARY_NOW, log,
    delay: ms => { waits.push(ms); return Promise.resolve(); } });
}


function storedRow(store: Store, id: string) {
  return store.transaction(tx => summaries.getBySession(tx, id));
}

function insertToolCall(store: Store, runId: string, toolName: string, state: 'completed' | 'refused' | 'failed' | 'unknown',
                        response: Record<string, unknown>, ordinal = 0): void {
  const executionId = `run:${runId}:${ordinal}`;
  store.transaction(tx => tx.run(`INSERT INTO tool_calls (owner_id,run_id,execution_id,call_id,intent_json,state,result_id,result_json,result_sha256,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [store.assistantId, runId, executionId, `call-${ordinal}`,
    JSON.stringify({ runId, actorId: 'owner', authorityEpoch: store.authorityEpoch, revision: 1, executionId, toolName, argumentsHash: 'a'.repeat(64) }),
    state, `result-${ordinal}`, JSON.stringify({ response, dataClasses: [] }), 'b'.repeat(64), SUMMARY_NOW + ordinal]));
}

const CLAIMED_MEETING = "The owner asked for a lunch meeting. Naya created the event on the owner's calendar.";

function insertAlarm(store: Store, id: string, fireAtUtc: number, label: string): void {
  store.transaction(tx => tx.run(`INSERT INTO alarms (id, fire_at_utc, tz, label, state, created_journal_id)
    VALUES (?,?,?,?, 'pending', ?)`, [id, fireAtUtc, 'UTC', label, 'journal-1']));
}

test('a calendar write refused twice leaves no success fact when the summary claims it worked', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-refused-write');
    // The observed shape: the write was refused twice in the call and nothing exists on the calendar.
    insertToolCall(h.store, 's-refused-write', 'create_event', 'refused', { status: 'refused', reason: 'authorization_missing' }, 0);
    insertToolCall(h.store, 's-refused-write', 'create_event', 'refused', { status: 'refused', reason: 'authorization_missing' }, 1);
    const events: SummarizerLogEvent[] = [];
    const model = new ScriptedModel([modelResult('complete', JSON.stringify({ skip: false, summary: CLAIMED_MEETING }))]);
    await worker(h.store, model, [], event => events.push(event)).distill('s-refused-write');
    const row = storedRow(h.store, 's-refused-write')!;
    assert.equal(row.status, 'complete');
    assert.doesNotMatch(row.summary!, /created/i, 'no refused write is remembered as done');
    assert.match(row.summary!, /asked for a lunch meeting/, 'the sentence the transcript supports is kept');
    const dropped = events.find(event => event.event === 'conversation_summary_claims_dropped');
    assert.ok(dropped, 'the correction is logged');
    assert.equal(dropped['dropped'], 1, 'the log carries counts only');
    assert.equal(JSON.stringify(dropped).includes('lunch'), false, 'never the owner words');
  } finally { h.cleanup(); }
});

test('one failed then one succeeded write keeps exactly one supported success fact (event_created settles)', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-mixed-write');
    insertToolCall(h.store, 's-mixed-write', 'create_event', 'failed', { status: 'failed', reason: 'upstream_error' }, 0);
    // The connector's own settled code for a created event; the settled list in tools/tool-outcome.ts is another
    // wagon's file, so this guard accepts it here by the sealed completed record and its code.
    insertToolCall(h.store, 's-mixed-write', 'create_event', 'completed', { code: 'event_created' }, 1);
    const model = new ScriptedModel([modelResult('complete', JSON.stringify({ skip: false, summary: CLAIMED_MEETING }))]);
    await worker(h.store, model, []).distill('s-mixed-write');
    const row = storedRow(h.store, 's-mixed-write')!;
    assert.equal(row.status, 'complete');
    assert.match(row.summary!, /created the event/, 'the receipt settles the claim');
    assert.equal((row.summary!.match(/created/gi) ?? []).length, 1, 'one success fact, not two');
  } finally { h.cleanup(); }
});

test('an unknown receipt is not a success fact', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-unknown-write');
    insertToolCall(h.store, 's-unknown-write', 'create_event', 'unknown', { status: 'unknown' }, 0);
    const model = new ScriptedModel([modelResult('complete', JSON.stringify({ skip: false, summary: CLAIMED_MEETING }))]);
    await worker(h.store, model, []).distill('s-unknown-write');
    const row = storedRow(h.store, 's-unknown-write')!;
    assert.doesNotMatch(row.summary!, /created/i, 'an unsettled receipt can only be recorded as not done');
  } finally { h.cleanup(); }
});

test('a summary with no write claim is stored byte for byte', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-no-write');
    const plain = 'The owner talked about the mint window and the weather. Naya read the calendar aloud for him.';
    const model = new ScriptedModel([modelResult('complete', JSON.stringify({ skip: false, summary: plain }))]);
    await worker(h.store, model, []).distill('s-no-write');
    assert.equal(storedRow(h.store, 's-no-write')!.summary, plain, 'length and format are untouched without a write');
  } finally { h.cleanup(); }
});

test('a summary cannot deny an alarm the alarms table holds as armed', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-alarm-denied');
    insertAlarm(h.store, '4f2c9a1b77aa', SUMMARY_NOW + 3_600_000, 'wake up for the standup');
    const denial = 'The owner asked for a wake up call. Naya could not set the alarm.';
    const model = new ScriptedModel([modelResult('complete', JSON.stringify({ skip: false, summary: denial }))]);
    await worker(h.store, model, []).distill('s-alarm-denied');
    const row = storedRow(h.store, 's-alarm-denied')!;
    assert.doesNotMatch(row.summary!, /could not set the alarm/, 'the table outranks the spoken denial');
    assert.match(row.summary!, /asked for a wake up call/);
  } finally { h.cleanup(); }
});

test('an armed alarm reaches the next seed from the alarms table though the summary denied it', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-alarm-seed');
    insertAlarm(h.store, '4f2c9a1b77aa', SUMMARY_NOW + 3_600_000, 'wake up for the standup');
    const seed = h.store.transaction(tx => {
      const alarms = activeAlarms(tx);
      const note = armedAlarmsNote(alarms);
      assert.ok(note, 'the table holds one armed alarm');
      const guarded = guardSeededSummaries(tx, [{ id: 'sum-1', liveSessionId: 's-alarm-seed', endedAt: SUMMARY_NOW,
        summary: 'The owner asked for a wake up call. Naya could not set the alarm.' }], alarms);
      return composeLiveSessionInstruction({ text: 'Synthetic base instruction.', tools: [], records: [], trustedChars: 4_000,
        alarms: note, earlierConversations: guarded[0]!.summary });
    });
    assert.match(seed.text, /wake up for the standup/, 'the seed names the label');
    assert.match(seed.text, /alarm 4f2c9a1b/, 'the seed names the id');
    assert.match(seed.text, /Armed alarms: \d\d:\d\d wake up for the standup/, 'the seed names the time');
    assert.doesNotMatch(seed.text, /could not set the alarm/, 'no stored denial contradicts the table');
  } finally { h.cleanup(); }
});

test('a stored summary keeps a write claim its own receipts settle and loses one they do not', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-seeded-refused');
    seedConversation(h.store, 's-seeded-created');
    insertToolCall(h.store, 's-seeded-refused', 'create_event', 'refused', { status: 'refused', reason: 'authorization_missing' }, 0);
    insertToolCall(h.store, 's-seeded-created', 'create_event', 'completed', { code: 'event_created' }, 2);
    const guarded = h.store.transaction(tx => guardSeededSummaries(tx, [
      { id: 'sum-refused', liveSessionId: 's-seeded-refused', endedAt: SUMMARY_NOW, summary: CLAIMED_MEETING },
      { id: 'sum-created', liveSessionId: 's-seeded-created', endedAt: SUMMARY_NOW, summary: CLAIMED_MEETING },
    ], activeAlarms(tx)));
    assert.doesNotMatch(guarded[0]!.summary, /created/i, 'the seed drops the unsupported claim');
    assert.match(guarded[1]!.summary, /created the event/, 'the paired settled case keeps it');
    assert.equal(h.store.transaction(tx => summaries.getBySession(tx, 's-seeded-refused')), undefined,
      'the stored row is not rewritten by the guard');
  } finally { h.cleanup(); }
});
