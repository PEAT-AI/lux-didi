import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { liveMigrations } from '../live/schema.js';
import * as summaries from '../domain/summaries.js';
import type { ModelControl, ModelPort, ModelRequest, ModelResult } from '../adapters/model/types.js';
import {
  DISTILLATION_PROMPT, SUMMARY_MAX_RETRIES, buildDistillationInput, capDistillationInput,
  createSummarizer, parseDistillationResult,
} from '../services/summarize.js';

const NOW = 1_700_000_000_000;

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'didi-summaries-'));
  const store = new Store(dir, [...domainMigrations, ...liveMigrations]);
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedSession(store: Store, id: string, options: { outcome?: string; memoryProvenance?: unknown } = {}): void {
  store.transaction(tx => {
    tx.run(`INSERT INTO live_sessions (live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint,
        client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events, journal_bytes,
        journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at, memory_provenance)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,1,'ended',?,?,?,?,?)`,
      [id, store.assistantId, store.authorityEpoch, `key-${id}`, `fp-${id}`, 'client', 'audit', 'profile', 'prompt', 'terminal',
        options.outcome ?? JSON.stringify({ state: 'closed', code: 'normal' }), NOW, NOW, NOW,
        options.memoryProvenance === undefined ? null : JSON.stringify(options.memoryProvenance)]);
  });
}

function seedTurn(store: Store, id: string, kind: 'inputTranscription' | 'outputTranscription', text: string): void {
  store.transaction(tx => tx.run(
    'INSERT INTO live_journal (live_session_id, kind, text, finished, payload_bytes, arrived_at) VALUES (?,?,?,1,?,?)',
    [id, kind, text, text.length, NOW]));
}

function reply(text: string, status: ModelResult['status'] = 'complete'): ModelResult {
  return { status, text, providerContent: { role: 'model', parts: [{ text }] }, reason: '',
    prompt: { version: 'fixture', hash: 'fixture', omittedContextIds: [] },
    timings: { kind: 'synthetic', totalMs: 1, firstTextMs: 1 } };
}

class FakeModel implements ModelPort {
  calls = 0;
  constructor(private readonly script: (ModelResult | Error)[]) {}
  generate(_request: ModelRequest, _control: ModelControl): Promise<ModelResult> {
    const step = this.script[this.calls++] ?? this.script[this.script.length - 1]!;
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  }
}

function summarizer(store: Store, model: ModelPort) {
  return createSummarizer({ store, model, modelId: 'gemini-2.5-flash', timeZone: 'UTC', now: () => NOW, log: () => {} });
}

function withTurns(store: Store, id: string, outcome?: string): void {
  seedSession(store, id, outcome === undefined ? {} : { outcome });
  seedTurn(store, id, 'inputTranscription', 'one');
  seedTurn(store, id, 'inputTranscription', 'two');
}

test('the distillation prompt is the authored verbatim constant and output parses tolerantly', () => {
  assert.ok(DISTILLATION_PROMPT.startsWith('You write a short private summary of one finished voice conversation'));
  assert.ok(DISTILLATION_PROMPT.endsWith('Set skip to true when nothing worth remembering happened.'));
  assert.deepEqual(parseDistillationResult('```json\n{"skip": false, "summary": "the owner said hello"}\n```'),
    { skip: false, summary: 'the owner said hello' });
  assert.equal(parseDistillationResult('no json here'), null);
  assert.equal(parseDistillationResult('{"skip": "yes"}'), null);
});

test('the input cap keeps the first 4000 and last 20000 characters and marks the cut', () => {
  const input = buildDistillationInput({ turns: [{ speaker: 'owner', text: 'O'.repeat(30_000) }], toolNames: [], dateMs: NOW, timeZone: 'UTC', injected: [] });
  assert.equal(input.truncated, true);
  assert.ok(input.text.startsWith('Session date:'));
  assert.ok(input.text.includes('[... transcript shortened ...]'));
  assert.deepEqual(capDistillationInput('small'), { text: 'small', truncated: false });
});

test('a complete distillation stores one row with the session provenance', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-complete', { memoryProvenance: { status: 'empty', selectedIds: [], omitted: [], injectedSummaryIds: ['prior-a'] } });
    seedTurn(h.store, 's-complete', 'inputTranscription', 'What is on my plate?');
    seedTurn(h.store, 's-complete', 'inputTranscription', 'And tomorrow?');
    seedTurn(h.store, 's-complete', 'outputTranscription', 'You have two meetings.');
    const model = new FakeModel([reply('{"skip": false, "summary": "The owner asked about their plate; Naya found two meetings."}')]);
    await summarizer(h.store, model).distill('s-complete');
    const row = h.store.transaction(tx => summaries.getBySession(tx, 's-complete'))!;
    assert.equal(row.status, 'complete');
    assert.match(row.summary ?? '', /two meetings/);
    assert.equal(row.inputTruncated, false);
    assert.equal(row.retryCount, 0);
    assert.deepEqual(row.injectedSummaryIds, []);
    assert.equal(row.endedAt, NOW);
  } finally { h.cleanup(); }
});

test('a model skip writes status skipped and no summary text', async () => {
  const h = open();
  try {
    withTurns(h.store, 's-skip');
    const model = new FakeModel([reply('{"skip": true, "summary": ""}')]);
    await summarizer(h.store, model).distill('s-skip');
    const row = h.store.transaction(tx => summaries.getBySession(tx, 's-skip'))!;
    assert.equal(row.status, 'skipped');
    assert.equal(row.summary, null);
  } finally { h.cleanup(); }
});

test('sessions with fewer than two finished owner turns are skipped without calling the model', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-thin');
    seedTurn(h.store, 's-thin', 'inputTranscription', 'only one finished turn');
    const model = new FakeModel([reply('{"skip": false, "summary": "should not be used"}')]);
    await summarizer(h.store, model).distill('s-thin');
    const row = h.store.transaction(tx => summaries.getBySession(tx, 's-thin'))!;
    assert.equal(row.status, 'skipped');
    assert.equal(model.calls, 0);
  } finally { h.cleanup(); }
});

test('an invalid JSON answer is a validation failure: failed, never retried', async () => {
  const h = open();
  try {
    withTurns(h.store, 's-invalid');
    const model = new FakeModel([reply('not json'), reply('{"skip": false, "summary": "late"}')]);
    await summarizer(h.store, model).distill('s-invalid');
    const row = h.store.transaction(tx => summaries.getBySession(tx, 's-invalid'))!;
    assert.equal(row.status, 'failed');
    assert.equal(row.errorCode, 'invalid_output');
    assert.equal(row.retryCount, 0);
    assert.equal(model.calls, 1, 'validation failures are never retried');
  } finally { h.cleanup(); }
});

test('a transport error is retried, at most twice, and then succeeds', async () => {
  const h = open();
  try {
    withTurns(h.store, 's-retry');
    const model = new FakeModel([new Error('transport'), reply('{"skip": false, "summary": "recovered"}')]);
    await summarizer(h.store, model).distill('s-retry');
    const row = h.store.transaction(tx => summaries.getBySession(tx, 's-retry'))!;
    assert.equal(row.status, 'complete');
    assert.equal(row.retryCount, 1);
    assert.equal(model.calls, 2);
  } finally { h.cleanup(); }
});

test('transport errors exhaust at most two retries and record the error code', async () => {
  const h = open();
  try {
    withTurns(h.store, 's-exhaust');
    const model = new FakeModel([reply('', 'error'), reply('', 'error'), reply('', 'error'), reply('{"skip": false, "summary": "late"}')]);
    await summarizer(h.store, model).distill('s-exhaust');
    const row = h.store.transaction(tx => summaries.getBySession(tx, 's-exhaust'))!;
    assert.equal(row.status, 'failed');
    assert.equal(row.retryCount, SUMMARY_MAX_RETRIES);
    assert.equal(model.calls, SUMMARY_MAX_RETRIES + 1);
  } finally { h.cleanup(); }
});

test('the reconciler distils every ended session without a row, one at a time, and marks a dead host truncated', async () => {
  const h = open();
  try {
    withTurns(h.store, 's-normal');
    withTurns(h.store, 's-dead', JSON.stringify({ state: 'outcome_unknown' }));
    const model = new FakeModel([reply('{"skip": false, "summary": "first"}'), reply('{"skip": false, "summary": "second"}')]);
    await summarizer(h.store, model).reconcile();
    const rows = h.store.transaction(tx => summaries.listSummaries(tx));
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.liveSessionId === 's-normal')!.inputTruncated, false);
    assert.equal(rows.find(row => row.liveSessionId === 's-dead')!.inputTruncated, true);
    await summarizer(h.store, model).reconcile();
    assert.equal(h.store.transaction(tx => summaries.listSummaries(tx)).length, 2, 'the second pass finds no work');
  } finally { h.cleanup(); }
});

test('deleting a summary also deletes the summaries that recorded it as injected', () => {
  const h = open();
  try {
    const a = h.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: 'a', status: 'complete', summary: 'A', endedAt: NOW, now: NOW }));
    const b = h.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: 'b', status: 'complete', summary: 'B', endedAt: NOW, injectedSummaryIds: [a.id], now: NOW }));
    h.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: 'c', status: 'complete', summary: 'C', endedAt: NOW, now: NOW }));
    const result = h.store.transaction(tx => summaries.deleteSummary(tx, a.id));
    assert.equal(result.notFound, false);
    assert.deepEqual([...result.deletedIds].sort(), [a.id, b.id].sort());
    assert.deepEqual(h.store.transaction(tx => summaries.listSummaries(tx)).map(row => row.liveSessionId), ['c']);
  } finally { h.cleanup(); }
});

test('ended sessions without a summary are the reconciler work list, dead host flagged', () => {
  const h = open();
  try {
    seedSession(h.store, 's1');
    seedSession(h.store, 's2', { outcome: JSON.stringify({ state: 'not_started' }) });
    const pending = h.store.transaction(tx => summaries.endedSessionsWithoutSummary(tx));
    assert.deepEqual(pending.map(row => [row.liveSessionId, row.deadHost]), [['s1', false], ['s2', true]]);
    h.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: 's1', status: 'skipped', endedAt: NOW, now: NOW }));
    assert.deepEqual(h.store.transaction(tx => summaries.endedSessionsWithoutSummary(tx)).map(row => row.liveSessionId), ['s2']);
  } finally { h.cleanup(); }
});
