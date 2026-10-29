import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { liveMigrations } from '../live/schema.js';
import * as summaries from '../domain/summaries.js';
import { buildEarlierConversationsSection, earlierConversationsBudget } from '../prompt/live-persona.js';
import { composeLiveSessionInstruction, NAYA_LIVE_BASE, TRUSTED_SYSTEM_CODE_UNIT_LIMIT, composeLiveInstruction } from '../prompt/live-persona.js';
import { compilePrompt, createCapabilitySnapshot, PROMPT_VERSION, validatePreferences } from '../prompt/index.js';
import { recordHistorySession } from '../domain/history-lifecycle.js';
import type { DataClass, ModelControl, ModelPort, ModelRequest, ModelResult, Transport } from '../adapters/model/types.js';
import { GeminiAdapter } from '../adapters/model/index.js';
import {
  OPEN_LOOP_MAX_CHARS, SUMMARY_MAX_RETRIES, SUMMARY_PROMPT_VERSION, SUMMARY_RECOVERY_LIMIT, buildDistillationInput, capDistillationInput,
  createSummarizer, distillationPrompt, parseDistillationResult, TOOL_OUTCOME_MAX_LINES, type SummarizerOptions,
} from '../services/summarize.js';

const NOW = 1_700_000_000_000;

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'didi-summaries-'));
  const store = new Store(dir, [...domainMigrations, ...liveMigrations]);
  return { store, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedSession(store: Store, id: string, options: { outcome?: string; memoryProvenance?: unknown; inputClass?: string } = {}): void {
  store.transaction(tx => {
    tx.run(`INSERT INTO live_sessions (live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint,
        client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events, journal_bytes,
        journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at, memory_provenance)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,1,'ended',?,?,?,?,?)`,
      [id, store.assistantId, store.authorityEpoch, `key-${id}`, `fp-${id}`, 'client', 'audit', 'profile', 'prompt', 'terminal',
        options.outcome ?? JSON.stringify({ state: 'closed', code: 'normal' }), NOW, NOW, NOW,
        options.memoryProvenance === undefined ? null : JSON.stringify(options.memoryProvenance)]);
    if (options.inputClass !== undefined) {
      tx.run(`INSERT INTO live_grants (grant_id, live_session_id, provider, model, voice, key_reference, permitted_classes,
          chosen_input_class, revision, granted_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [`grant-${id}`, id, 'gemini', 'synthetic-live', 'voice', 'gemini-primary', JSON.stringify(['ordinary', 'private']),
          options.inputClass, 1, NOW]);
    }
    // The distiller reads the trusted history eligibility row the terminal path records, never the grant.
    recordHistorySession(tx, id, 'owner', [(options.inputClass ?? 'ordinary') as DataClass], [], NOW);
  });
}

function seedTurn(store: Store, id: string, kind: 'inputTranscription' | 'outputTranscription', text: string): void {
  store.transaction(tx => tx.run(
    'INSERT INTO live_journal (live_session_id, kind, text, finished, payload_bytes, arrived_at) VALUES (?,?,?,1,?,?)',
    [id, kind, text, text.length, NOW]));
}

/**
 * A complete summary the selector can offer: since migration 8 a row must carry the class and the source revision
 * it witnessed, and the session must still have its history eligibility row.
 */
function insertPastSummary(store: Store, id: string, summary: string, endedAt = NOW): void {
  seedSession(store, id);
  store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: id, status: 'complete', summary,
    dataClass: 'ordinary', sourceRevision: 1, endedAt, now: NOW }));
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

function summarizer(store: Store, model: ModelPort | null, assistantName = 'Naya', extra: Partial<SummarizerOptions> = {}) {
  // The host always names the route's permitted classes; without them the distiller fails closed and skips a session.
  return createSummarizer({ store, model, modelId: 'synthetic-text-model', modelAllowedClasses: ['ordinary'],
    assistantName, timeZone: 'UTC', now: () => NOW, log: () => {}, delay: () => Promise.resolve(), ...extra });
}

function withTurns(store: Store, id: string, outcome?: string): void {
  seedSession(store, id, outcome === undefined ? {} : { outcome });
  seedTurn(store, id, 'inputTranscription', 'one');
  seedTurn(store, id, 'inputTranscription', 'two');
}

/** A real GeminiAdapter over a deterministic SSE transport, so controlled() is exercised for real. */
function distillAdapter(summary: string, transport?: Transport): GeminiAdapter {
  const body = { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ skip: false, summary }) }] }, finishReason: 'STOP' }] };
  return new GeminiAdapter({
    modelId: 'gemini-2.5-flash', keyReference: 'gemini-primary',
    credentials: { resolve: async () => 'synthetic-key' },
    route: { enabled: true, provider: 'gemini', modelId: 'gemini-2.5-flash', dataClasses: ['ordinary'] },
    timingKind: 'synthetic',
    transport: transport ?? (async () => {
      const bytes = new TextEncoder().encode(`data: ${JSON.stringify(body)}\r\n\r\n`);
      return new Response(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
    }),
  });
}

test('the distillation prompt is the authored verbatim constant and output parses tolerantly', () => {
  const prompt = distillationPrompt('Mira');
  assert.ok(prompt.startsWith('You write a short private summary of one finished voice conversation between the owner and the assistant, whose name is Mira'));
  assert.ok(prompt.includes('{"skip": boolean, "summary": string, "openLoop": string | null}'));
  assert.ok(prompt.includes('the owner said'));
  assert.ok(prompt.includes('Tool outcomes come only from the Tool outcomes block below'));
  assert.ok(prompt.includes("never by Mira's spoken explanation of it"));
  assert.ok(prompt.includes('Set skip to true only for calls consisting entirely of small talk or app tests.'));
  assert.ok(prompt.includes('A substantive story, decision or discussion must be summarised'));
  assert.deepEqual(parseDistillationResult('```json\n{"skip": false, "summary": "the owner said hello"}\n```'),
    { skip: false, summary: 'the owner said hello', openLoop: null });
  assert.equal(parseDistillationResult('no json here'), null);
  assert.equal(parseDistillationResult('{"skip": "yes"}'), null);
});

test('the input cap keeps the first 4000 and last 20000 characters and marks the cut', () => {
  const input = buildDistillationInput({ assistantName: 'Naya', turns: [{ speaker: 'owner', text: 'O'.repeat(30_000) }], toolNames: [], dateMs: NOW, timeZone: 'UTC', injected: [] });
  assert.equal(input.truncated, true);
  assert.ok(input.text.startsWith('Session date:'));
  assert.ok(input.text.includes('middle of conversation omitted; opening 4000 and ending 20000 characters retained'));
  assert.deepEqual(capDistillationInput('small'), { text: 'small', truncated: false });
});

test('the Tool outcomes block names each recorded state, oldest first, and stops at twenty lines', () => {
  const outcomes = [
    { name: 'calendar_read', outcome: 'succeeded' as const, code: null },
    { name: 'search_web', outcome: 'failed' as const, code: 'upstream_timeout' },
    { name: 'stage_lux_note', outcome: 'refused' as const, code: 'authorization_missing' },
    { name: 'stage_lux_note', outcome: 'outcome unknown' as const, code: null },
    ...[...Array(30).keys()].map(i => ({ name: `tool_${i}`, outcome: 'succeeded' as const, code: null })),
  ];
  const input = buildDistillationInput({ assistantName: 'Naya', turns: [{ speaker: 'owner', text: 'hello' }], toolNames: [], toolOutcomes: outcomes, dateMs: NOW, timeZone: 'UTC', injected: [] });
  const lines = input.text.split('\n');
  const start = lines.indexOf('Tool outcomes:');
  assert.equal(start, lines.length - TOOL_OUTCOME_MAX_LINES - 1, 'the block is appended last');
  assert.deepEqual(lines.slice(start + 1, start + 5),
    ['calendar_read succeeded', 'search_web failed upstream_timeout', 'stage_lux_note refused authorization_missing', 'stage_lux_note outcome unknown']);
});

test('a session with no tool calls carries no Tool outcomes block', () => {
  const input = buildDistillationInput({ assistantName: 'Naya', turns: [{ speaker: 'owner', text: 'hello' }], toolNames: [], dateMs: NOW, timeZone: 'UTC', injected: [] });
  assert.equal(input.text.includes('Tool outcomes:'), false);
});

test('a complete distillation stores one row with the session provenance', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-complete', { memoryProvenance: { status: 'empty', selectedIds: [], omitted: [], injectedSummaryIds: [] } });
    seedTurn(h.store, 's-complete', 'inputTranscription', 'What is on my plate?');
    seedTurn(h.store, 's-complete', 'inputTranscription', 'And tomorrow?');
    seedTurn(h.store, 's-complete', 'outputTranscription', 'You have two meetings.');
    const model = new FakeModel([reply('{"skip": false, "summary": "The owner said they had two meetings; Naya found them."}')]);
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

test('the distiller input carries the injected earlier summaries for the echo guard', () => {
  const input = buildDistillationInput({ assistantName: 'Naya', turns: [{ speaker: 'owner', text: 'hello' }], toolNames: ['remember_note'],
    dateMs: NOW, timeZone: 'UTC', injected: [{ id: 's1', summary: 'the owner shipped a thing' }] });
  assert.ok(input.text.includes('Summaries already shown to Naya in this conversation:'));
  assert.ok(input.text.includes('- s1: the owner shipped a thing'));
  assert.ok(input.text.includes('Tools Naya used: remember_note'));
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

test('a private-labelled session is never distilled', async () => {
  const h = open();
  try {
    seedSession(h.store, 's-private', { inputClass: 'private' });
    seedTurn(h.store, 's-private', 'inputTranscription', 'one');
    seedTurn(h.store, 's-private', 'inputTranscription', 'two');
    const model = new FakeModel([reply('{"skip": false, "summary": "must never reach the model"}')]);
    await summarizer(h.store, model).distill('s-private');
    const row = h.store.transaction(tx => summaries.getBySession(tx, 's-private'))!;
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

test('deleteSummary cascades to the summary only, never the session or its turns', () => {
  const h = open();
  try {
    withTurns(h.store, 's-keep');
    const row = h.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: 's-keep', status: 'complete', summary: 'Kept past', endedAt: NOW, now: NOW }));
    h.store.transaction(tx => summaries.deleteSummary(tx, row.id));
    assert.equal(h.store.transaction(tx => summaries.getBySession(tx, 's-keep')), null);
    assert.ok(h.store.transaction(tx => tx.get('SELECT live_session_id FROM live_sessions WHERE live_session_id=?', ['s-keep'])));
    assert.equal(h.store.transaction(tx => tx.all('SELECT journal_id FROM live_journal WHERE live_session_id=?', ['s-keep'])).length, 2);
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

test('migration v5 upgrades a populated v4 database preserving sessions and turns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-summaries-migrate-'));
  const v4 = domainMigrations.filter(m => m.version <= 4);
  try {
    const before = new Store(dir, [...v4, ...liveMigrations]);
    before.transaction(tx => {
      tx.run("INSERT INTO sessions (id,title,started_at,ended_at,time_zone,revision,created_at,updated_at) VALUES ('sess','Synthetic',?,NULL,'UTC',1,?,?)", [NOW, NOW, NOW]);
      tx.run("INSERT INTO entries (id,session_id,sequence,role,text,captured_at,time_zone,revision) VALUES ('e1','sess',1,'user','synthetic note',?,'UTC',1)", [NOW]);
    });
    assert.deepEqual(before.transaction(tx => tx.all("SELECT version FROM runtime_migrations WHERE owner='domain' ORDER BY version").map(r => Number(r.version))), [1, 2, 3, 4]);
    before.close();
    const after = new Store(dir, [...domainMigrations, ...liveMigrations]);
    try {
    assert.deepEqual(after.transaction(tx => tx.all("SELECT version FROM runtime_migrations WHERE owner='domain' ORDER BY version").map(r => Number(r.version))), domainMigrations.map(m => m.version));
      assert.ok(after.transaction(tx => tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'")));
      assert.equal(after.transaction(tx => tx.get("SELECT text FROM entries WHERE id='e1'"))!['text'], 'synthetic note');
      assert.deepEqual(after.transaction(tx => summaries.listSummaries(tx)), []);
    } finally { after.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('voice and text chat render the same summary for the same past session', () => {
  const h = open();
  try {
    insertPastSummary(h.store, 'past-1', 'The owner said they moved to Lisbon; Naya noted the timezone change.');
    // One store read serves both surfaces.
    const candidates = h.store.transaction(tx => summaries.injectionCandidates(tx));
    const section = buildEarlierConversationsSection(candidates, { now: NOW + 1, timeZone: 'UTC' });
    assert.equal(section.selectedIds.length, 1);
    assert.match(section.section, /moved to Lisbon/);

    const baseline = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en' });
    const voice = composeLiveSessionInstruction({ text: baseline.text, tools: [], records: [],
      trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT, earlierConversations: section.section });
    assert.equal(voice.earlierConversationsIncluded, true);
    assert.ok(voice.text.includes('moved to Lisbon'));
    assert.ok(voice.text.includes('# Earlier conversations'));

    const compiled = compilePrompt({
      ownerId: h.store.assistantId, persona: 'didi', promptVersion: PROMPT_VERSION,
      preferences: validatePreferences({ schemaVersion: 1, ownerId: h.store.assistantId, dataClass: 'ordinary', language: 'en', register: 'plain', humor: 'dry', verbosity: 'brief' }, h.store.assistantId),
      capabilities: createCapabilitySnapshot([], []),
      evidence: [], history: [{ schemaVersion: 1, ownerId: h.store.assistantId, dataClass: 'ordinary', id: 'h1', role: 'user', text: 'What did we discuss?' }],
      budgets: { trustedChars: 40000, contextChars: 12000, historyChars: 12000 },
      earlierConversations: section.section,
    });
    assert.ok(compiled.system.includes('moved to Lisbon'));
    assert.ok(compiled.system.includes('[earlier-conversations]'));
  } finally { h.cleanup(); }
});

test('a summary completes through the real controlled() path within its computed absolute budget', async () => {
  const h = open();
  try {
    withTurns(h.store, 's-real');
    const model = distillAdapter('The owner asked about the calendar.');
    const s = summarizer(h.store, model, 'Naya', { modelId: 'gemini-2.5-flash', now: () => Date.now() });
    await s.distill('s-real');
    const row = h.store.transaction(tx => summaries.getBySession(tx, 's-real'))!;
    assert.equal(row.status, 'complete');
    assert.equal(row.summary, 'The owner asked about the calendar.');
  } finally { h.cleanup(); }
});

test('an already-expired absolute deadline fails loud through the real controlled() path', async () => {
  const h = open();
  try {
    withTurns(h.store, 's-expired');
    let transports = 0;
    const model = distillAdapter('never sent', async () => { transports++; throw Error('transport must not run'); });
    const s = summarizer(h.store, model, 'Naya', { modelId: 'gemini-2.5-flash', now: () => Date.now(), deadlineBudgetMs: -1 });
    await s.distill('s-expired');
    const row = h.store.transaction(tx => summaries.getBySession(tx, 's-expired'))!;
    assert.equal(row.status, 'failed');
    assert.equal(row.errorCode, 'deadline');
    assert.equal(transports, 0, 'an expired deadline is refused before the transport runs');
  } finally { h.cleanup(); }
});

test('host-start recovery re-queues the newest 30 failed-deadline sessions whose journal survives', async () => {
  const h = open();
  try {
    for (let i = 0; i < 36; i++) {
      const id = `s-rec-${String(i).padStart(2, '0')}`;
      withTurns(h.store, id);
      h.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: id, status: 'failed', errorCode: 'deadline', endedAt: NOW + i, now: NOW }));
    }
    seedSession(h.store, 's-nojournal');
    h.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: 's-nojournal', status: 'failed', errorCode: 'deadline', endedAt: NOW + 100, now: NOW }));

    const bounded = h.store.transaction(tx => summaries.failedRetryableSessionsWithJournal(tx, SUMMARY_RECOVERY_LIMIT));
    assert.equal(bounded.length, 30, 'the requeue list is capped at the newest 30');
    assert.equal(bounded[0]!.liveSessionId, 's-rec-35', 'newest first');
    assert.equal(h.store.transaction(tx => summaries.countFailedRetryableSessionsWithJournal(tx)), 36, 'a row with no journal is excluded');

    const model = new FakeModel([reply('{"skip": false, "summary": "recovered"}')]);
    await summarizer(h.store, model).requeueFailed();

    const status = (id: string) => h.store.transaction(tx => summaries.getBySession(tx, id))!.status;
    assert.equal(model.calls, 30, 'exactly the bounded set is distilled');
    for (let i = 35; i >= 6; i--) assert.equal(status(`s-rec-${String(i).padStart(2, '0')}`), 'complete', `s-rec-${i} recovered`);
    for (let i = 5; i >= 0; i--) assert.equal(status(`s-rec-${String(i).padStart(2, '0')}`), 'failed', `s-rec-${i} left for a later start`);
    assert.equal(status('s-nojournal'), 'failed', 'a row with no surviving journal is never re-queued');
  } finally { h.cleanup(); }
});

test('twenty complete summaries fill the space left under the target instead of the old six', () => {
  const h = open();
  try {
    for (let i = 0; i < 20; i++) insertPastSummary(h.store, `past-${String(i).padStart(2, '0')}`,
      `The owner discussed the Mongoose mint delivery window and the Friday schedule, item ${i}.`, NOW - i * 3_600_000);
    const candidates = h.store.transaction(tx => summaries.injectionCandidates(tx));
    assert.equal(candidates.length, 20);
    const build = (earlierSection?: string) => composeLiveSessionInstruction({ text: NAYA_LIVE_BASE, tools: ['search_knowledge'], records: [],
      trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT, ...(earlierSection ? { earlierConversations: earlierSection } : {}) });
    const basis = build();
    const section = buildEarlierConversationsSection(candidates, { now: NOW + 1, timeZone: 'UTC', maxChars: earlierConversationsBudget(basis.text.length) });
    assert.ok(section.selectedIds.length > 6, `kept ${section.selectedIds.length} summaries`);
    assert.equal(section.omitted.length, 20 - section.selectedIds.length);
    assert.deepEqual(section.selectedIds, candidates.map(candidate => candidate.id).filter(id => section.selectedIds.includes(id)), 'newest first');
    const composed = build(section.section);
    assert.equal(composed.earlierConversationsIncluded, true);
    assert.ok(composed.text.length > basis.text.length);
  } finally { h.cleanup(); }
});

/** Records the request each call made, so a test can read the prompt the distiller really sent. */
class RecordingModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly text: string) {}
  generate(request: ModelRequest, _control: ModelControl): Promise<ModelResult> {
    this.requests.push(request);
    return Promise.resolve(reply(this.text));
  }
}

test('another persona name never leaks the default name into a summary', async () => {
  const h = open();
  try {
    withTurns(h.store, 's-mira');
    seedTurn(h.store, 's-mira', 'outputTranscription', 'Mira found the slot.');
    const model = new RecordingModel('{"skip": false, "summary": "The owner asked about Friday; Mira found the slot.", "openLoop": null}');
    await summarizer(h.store, model, 'Mira').distill('s-mira');
    const row = h.store.transaction(tx => summaries.getBySession(tx, 's-mira'))!;
    assert.equal(row.status, 'complete');
    assert.equal(/Naya/.test(row.summary ?? ''), false, 'the stored summary carries no default name');
    const request = model.requests[0]!;
    assert.equal(/Naya/.test(request.system), false, 'the system prompt carries no default name');
    assert.ok(request.system.includes('whose name is Mira'));
    const transcript = request.contents[0]!.parts[0]!.text ?? '';
    assert.ok(transcript.includes('Mira: '), 'the speaker tags use the parameter');
    assert.equal(/Naya/.test(transcript), false);
  } finally { h.cleanup(); }
});

test('W4: a failed request, an unanswered ask and a complaint about her own voice are stored as the open loop', async () => {
  const h = open();
  try {
    withTurns(h.store, 's-failed');
    seedTurn(h.store, 's-failed', 'outputTranscription', 'The owner asked for the Freiburg numbers and the lookup failed.');
    const loop = 'The owner asked for the Freiburg numbers; the lookup failed.';
    const model = new RecordingModel(JSON.stringify({ skip: false, summary: 'The owner asked for the Freiburg numbers; Mira could not find them.', openLoop: loop }));
    await summarizer(h.store, model).distill('s-failed');
    const row = h.store.transaction(tx => summaries.getBySession(tx, 's-failed'))!;
    assert.equal(row.status, 'complete');
    assert.equal(row.openLoop, loop, 'the failed request is the stored open loop');
    const system = model.requests[0]!.system;
    for (const rule of ['failed or came back empty', 'ask left unanswered', "complaint about the assistant's own voice"]) {
      assert.ok(system.includes(rule), `the prompt names the open loop the call left: ${rule}`);
    }
  } finally { h.cleanup(); }
});

test('an unchanged transcript keeps the same sentence count and attribution whatever the name', async () => {
  const h = open();
  try {
    const summary = 'The owner said they moved to Lisbon; Mira found the time change in the calendar. The owner said the movers come on Friday.';
    const turns = [{ speaker: 'owner' as const, text: 'I moved to Lisbon' }, { speaker: 'assistant' as const, text: 'Mira found the time change' }];
    const build = (assistantName: string) => buildDistillationInput({ assistantName, turns, toolNames: [], dateMs: NOW, timeZone: 'UTC', injected: [] });
    const first = build('Mira');
    assert.deepEqual(build('Mira'), first, 'the same transcript and name build the same input');
    const renamed = build('Sol');
    assert.equal(renamed.text.replaceAll('Sol', 'Mira'), first.text, 'only the name differs');
    withTurns(h.store, 's-same');
    const model = new RecordingModel(JSON.stringify({ skip: false, summary, openLoop: null }));
    await summarizer(h.store, model, 'Mira').distill('s-same');
    const row = h.store.transaction(tx => summaries.getBySession(tx, 's-same'))!;
    assert.equal(row.summary, summary, 'the model sentences are stored as written, never rewritten');
    assert.equal(summary.split('. ').length, 2);
    assert.ok(summary.startsWith('The owner said'), 'every sentence stays attributed');
  } finally { h.cleanup(); }
});

test('the open loop is null unless the owner explicitly left something open', async () => {
  const h = open();
  try {
    const run = async (id: string, answer: Record<string, unknown>) => {
      withTurns(h.store, id);
      await summarizer(h.store, new FakeModel([reply(JSON.stringify(answer))])).distill(id);
      return h.store.transaction(tx => summaries.getBySession(tx, id))!;
    };
    const absent = await run('s-loop-absent', { skip: false, summary: 'The owner said they had two meetings.' });
    assert.equal(absent.openLoop, null, 'a v1-shaped answer has no open loop');
    assert.equal(absent.promptVersion, SUMMARY_PROMPT_VERSION, 'the version is recorded on a new row');
    assert.equal((await run('s-loop-null', { skip: false, summary: 'The owner said they had two meetings.', openLoop: null })).openLoop, null);
    assert.equal((await run('s-loop-object', { skip: false, summary: 'The owner said hi.', openLoop: { toDo: 'x' } })).openLoop, null);
    const explicit = await run('s-loop-set', { skip: false, summary: 'The owner said they had two meetings.', openLoop: '  The owner will send the invoice on Friday.  ' });
    assert.equal(explicit.openLoop, 'The owner will send the invoice on Friday.');
    const long = await run('s-loop-long', { skip: false, summary: 'The owner said hi.', openLoop: 'x'.repeat(400) });
    assert.equal(long.openLoop?.length, OPEN_LOOP_MAX_CHARS);
    assert.equal(parseDistillationResult(JSON.stringify({ skip: false, summary: 'the owner said hi', openLoop: 'the owner will call back' }))?.openLoop, 'the owner will call back');
  } finally { h.cleanup(); }
});

test('no text model writes a skipped row naming no_text_model', async () => {
  const h = open();
  try {
    withTurns(h.store, 's-nomodel');
    await summarizer(h.store, null).distill('s-nomodel');
    const row = h.store.transaction(tx => summaries.getBySession(tx, 's-nomodel'))!;
    assert.equal(row.status, 'skipped');
    assert.equal(row.skipReason, 'no_text_model');
    assert.equal(row.summary, null);
    assert.equal(row.openLoop, null);
    assert.equal(row.promptVersion, null, 'no prompt ran, so no version is claimed');
  } finally { h.cleanup(); }
});

test('migration v6 upgrades a populated v5 database and v1 rows read as openLoop null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-summaries-v6-'));
  const v5 = domainMigrations.filter(m => m.version <= 5);
  try {
    const before = new Store(dir, [...v5, ...liveMigrations]);
    before.transaction(tx => tx.run(
      `INSERT INTO conversation_summaries
         (id, live_session_id, status, summary, ended_at, model, input_chars, input_truncated, injected_summary_ids, retry_count, error_code, created_at)
       VALUES ('c-old','s-old','complete','The owner said they moved to Lisbon.',?, 'gemini-2.5-flash', 42, 0, '[]', 0, NULL, ?)`, [NOW, NOW]));
    assert.deepEqual(before.transaction(tx => tx.all("SELECT version FROM runtime_migrations WHERE owner='domain' ORDER BY version").map(r => Number(r.version))), [1, 2, 3, 4, 5]);
    before.close();
    const after = new Store(dir, [...domainMigrations, ...liveMigrations]);
    try {
      assert.deepEqual(after.transaction(tx => tx.all("SELECT version FROM runtime_migrations WHERE owner='domain' ORDER BY version").map(r => Number(r.version))), domainMigrations.map(m => m.version));
      const old = after.transaction(tx => summaries.getBySession(tx, 's-old'))!;
      assert.equal(old.status, 'complete');
      assert.equal(old.summary, 'The owner said they moved to Lisbon.');
      assert.equal(old.openLoop, null, 'a v1 row reads as no open loop');
      assert.equal(old.promptVersion, null);
      assert.equal(old.skipReason, null);
      after.transaction(tx => summaries.insertSummary(tx, { liveSessionId: 's-new', status: 'complete', summary: 'The owner said they moved to Lisbon; Mira found the time change.', openLoop: 'The owner will send the invoice on Friday.', promptVersion: SUMMARY_PROMPT_VERSION, endedAt: NOW, now: NOW }));
      const fresh = after.transaction(tx => summaries.getBySession(tx, 's-new'))!;
      assert.equal(fresh.openLoop, 'The owner will send the invoice on Friday.');
      assert.equal(fresh.promptVersion, SUMMARY_PROMPT_VERSION);
      assert.deepEqual(after.transaction(tx => summaries.listSummaries(tx)).map(r => r.liveSessionId).sort(), ['s-new', 's-old']);
    } finally { after.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the distiller carries no persona name literal', () => {
  const source = readFileSync(new URL('../../services/summarize.ts', import.meta.url), 'utf8');
  assert.equal(/Naya/.test(source), false, 'the persona name is a parameter, never a literal');
});

test('the host-start reconciler re-distils a no_text_model skip once a text model exists', async () => {
  const h = open();
  try {
    withTurns(h.store, 's-requeue');
    seedSession(h.store, 's-thin');
    seedTurn(h.store, 's-thin', 'inputTranscription', 'only one owner turn');
    await summarizer(h.store, null).distill('s-requeue');
    await summarizer(h.store, null).distill('s-thin');
    const status = (id: string) => h.store.transaction(tx => summaries.getBySession(tx, id))!;
    assert.equal(status('s-requeue').skipReason, 'no_text_model');
    assert.equal(status('s-thin').skipReason, 'too_few_turns');
    // Still no model: the reconciler re-reads the row and writes nothing new.
    await summarizer(h.store, null).reconcile();
    assert.equal(status('s-requeue').skipReason, 'no_text_model');
    // With a model, only the no_text_model row is reopened and distilled; the other skip reason stays sealed.
    const model = new FakeModel([reply('{"skip": false, "summary": "The owner said one and two; Mira found nothing.", "openLoop": null}')]);
    await summarizer(h.store, model, 'Mira').reconcile();
    const reopened = status('s-requeue');
    assert.equal(reopened.status, 'complete');
    assert.equal(reopened.promptVersion, SUMMARY_PROMPT_VERSION);
    assert.equal(reopened.skipReason, null);
    assert.equal(model.calls, 1, 'the sealed skip never reaches the model');
    const sealed = status('s-thin');
    assert.equal(sealed.status, 'skipped');
    assert.equal(sealed.skipReason, 'too_few_turns');
    assert.equal(sealed.summary, null);
  } finally { h.cleanup(); }
});

test('an in-flight summary row is never listed as a failed summary', async () => {
  const f = open();
  try {
    f.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: 'in-flight', status: 'failed',
      errorCode: summaries.PENDING_SUMMARY_ERROR_CODE, retryCount: 0, now: 1_700_000_000_000 }));
    f.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: 'real-failure', status: 'failed',
      errorCode: 'network', retryCount: 1, now: 1_700_000_000_000 }));
    const listed = f.store.transaction(tx => summaries.listSummaries(tx)).map(record => record.liveSessionId);
    assert.equal(listed.includes('in-flight'), false, 'a summary still running is not an outcome any reader sees');
    assert.equal(listed.includes('real-failure'), true, 'a summary that really failed is still listed');
  } finally { f.cleanup(); }
});

// C-RECALL104: synthetic ASR text only, including the legacy policy pin R104-R1.
import { backfillHistoryTurns, rebuildHistoryTurnIndex } from '../domain/history-turns.js';
import { createHistoryReader } from '../domain/history-reader.js';
import { forgetHistorySessions } from '../domain/history-lifecycle.js';

test('verbatim turns backfill survives summary skip, is idempotent, and forget clears FTS', () => {
  const f = open();
  try {
    seedSession(f.store, 'recall-legacy');
    seedTurn(f.store, 'recall-legacy', 'inputTranscription', 'The synthetic trip ends at the cobalt lighthouse.');
    seedTurn(f.store, 'recall-legacy', 'outputTranscription', 'We will bring the violet map.');
    f.store.transaction(tx => {
      tx.run('DELETE FROM history_sessions WHERE live_session_id=?', ['recall-legacy']);
      tx.run('UPDATE live_sessions SET terminal_at=? WHERE live_session_id=?', [NOW - 40 * 86400000, 'recall-legacy']);
      tx.run('UPDATE live_journal SET arrived_at=? WHERE live_session_id=?', [NOW - 40 * 86400000, 'recall-legacy']);
      assert.equal(backfillHistoryTurns(tx), 2);
      assert.equal(backfillHistoryTurns(tx), 0);
      assert.equal(tx.get('SELECT data_class FROM history_sessions WHERE live_session_id=?', ['recall-legacy'])?.data_class, 'sensitive');
      const hits = tx.all(`SELECT t.text,bm25(history_turns_fts) AS rank,snippet(history_turns_fts,0,'[',']','...',12) AS excerpt FROM history_turns_fts JOIN history_turns t ON t.id=history_turns_fts.rowid WHERE history_turns_fts MATCH ?`, ['"lighthouse"*']);
      assert.equal(hits.length, 1);
      assert.match(String(hits[0]?.excerpt), /lighthouse/);
      rebuildHistoryTurnIndex(tx);
      assert.equal(tx.all('SELECT rowid FROM history_turns_fts WHERE history_turns_fts MATCH ?', ['lighthouse']).length, 1);
      const reader = createHistoryReader(() => NOW);
      const scope = { ownerId: f.store.assistantId, runId: 'recall-run', routeIdentity: 'synthetic', authorityEpoch: f.store.authorityEpoch, revision: 1, allowedClasses: ['sensitive'] as DataClass[] };
      const found = reader.read(tx, scope, { query: 'lighthouse' });
      assert.equal((found.response.hits as unknown[]).length, 1);
      assert.match(JSON.stringify(found.response), /cobalt lighthouse/);
      assert.equal((reader.read(tx, { ...scope, allowedClasses: ['ordinary'] }, { query: 'lighthouse' }).response.hits as unknown[]).length, 0);
      forgetHistorySessions(tx, ['recall-legacy'], NOW);
      assert.equal(tx.all('SELECT * FROM history_turns').length, 0);
      assert.equal(tx.all('SELECT rowid FROM history_turns_fts WHERE history_turns_fts MATCH ?', ['lighthouse']).length, 0);
      assert.equal(backfillHistoryTurns(tx), 0);
    });
  } finally { f.cleanup(); }
});

test('Store permits only the FTS read-only data_version pragma', () => {
  const f = open();
  try {
    f.store.transaction(tx => {
      assert.equal(typeof tx.get('PRAGMA data_version')?.data_version, 'number');
      assert.throws(() => tx.run('PRAGMA journal_mode=DELETE'), /authoriz/i);
      assert.throws(() => tx.run('PRAGMA writable_schema=ON'), /authoriz/i);
      assert.throws(() => tx.run('PRAGMA data_version=1'), /authoriz/i);
    });
  } finally { f.cleanup(); }
});

test('recall ranks concrete words, centres a late match, pairs speech and excludes the current call', () => {
  const f = open();
  try {
    for (const id of ['trip-answer', 'filler', 'current-call']) seedSession(f.store, id);
    seedTurn(f.store, 'trip-answer', 'inputTranscription', 'Unrelated opening. '.repeat(40) + 'The cobalt lighthouse is our trip destination.');
    seedTurn(f.store, 'trip-answer', 'outputTranscription', 'We will bring the violet map.');
    seedTurn(f.store, 'filler', 'inputTranscription', 'What did we talk about yesterday? '.repeat(50));
    seedTurn(f.store, 'current-call', 'inputTranscription', 'The cobalt lighthouse is our trip destination.');
    f.store.transaction(tx => {
      tx.run('UPDATE history_sessions SET owner_id=?', [f.store.assistantId]);
      backfillHistoryTurns(tx);
      const reader = createHistoryReader(() => NOW);
      const scope = { ownerId: f.store.assistantId, runId: 'different-research-run', currentSessionId: 'current-call', routeIdentity: 'synthetic', authorityEpoch: f.store.authorityEpoch, revision: 1, allowedClasses: ['ordinary'] as DataClass[] };
      const page = reader.read(tx, scope, { query: 'what did we talk about yesterday about the trip lighthouse' }).response;
      const hits = page.hits as Array<Record<string, unknown>>;
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.sessionId, 'trip-answer');
      assert.match(String(hits[0]?.snippet), /Owner:.*cobalt lighthouse/s);
      assert.match(String(hits[0]?.snippet), /Naya: We will bring the violet map/);
      assert.equal(hits[0]?.truncated, true);
      const detail = reader.read(tx, scope, { recordRef: String(hits[0]?.recordRef) }).response;
      assert.match(String(detail.text), /^Owner: Unrelated opening/);
      assert.match(String(detail.text), /Naya: We will bring the violet map/);
      const freshRun = { ...scope, runId: 'later-research-run', conversationId: 'same-call' };
      const issued = reader.read(tx, freshRun, { query: 'lighthouse' }).response.hits as Array<Record<string, unknown>>;
      assert.equal(reader.read(tx, { ...freshRun, runId: 'third-research-run' }, { recordRef: String(issued[0]?.recordRef) }).response.status, 'ok');
    });
  } finally { f.cleanup(); }
});

test('a skipped summary retains finished speech but never tools or unfinished fragments', () => {
  const f = open();
  try {
    seedSession(f.store, 'skipped-story');
    seedTurn(f.store, 'skipped-story', 'inputTranscription', 'The synthetic journey crossed the violet valley.');
    seedTurn(f.store, 'skipped-story', 'outputTranscription', 'I suggested the northern path.');
    f.store.transaction(tx => {
      tx.run('UPDATE history_sessions SET owner_id=?', [f.store.assistantId]);
      summaries.insertSummary(tx, { liveSessionId: 'skipped-story', status: 'skipped', skipReason: 'model_skip', endedAt: NOW, now: NOW });
      tx.run("INSERT INTO live_journal(live_session_id,kind,text,finished,payload_bytes,arrived_at) VALUES(?,'toolResult',?,1,1,?)", ['skipped-story', 'Tool-only secret fixture', NOW]);
      tx.run("INSERT INTO live_journal(live_session_id,kind,text,finished,payload_bytes,arrived_at) VALUES(?,'inputTranscription',?,0,1,?)", ['skipped-story', 'unfinished fixture', NOW]);
      assert.equal(backfillHistoryTurns(tx), 2);
      const rows = tx.all('SELECT text FROM history_turns');
      assert.equal(rows.length, 2);
      assert.doesNotMatch(JSON.stringify(rows), /Tool-only|unfinished/);
      const result = createHistoryReader(() => NOW).read(tx, { ownerId: f.store.assistantId, runId: 'other-call', routeIdentity: 'synthetic', authorityEpoch: f.store.authorityEpoch, revision: 1, allowedClasses: ['ordinary'] }, { query: 'violet valley' });
      assert.match(JSON.stringify(result.response), /synthetic journey/);
    });
  } finally { f.cleanup(); }
});

import { ResearchLedger, runResearch, type ResearchDeps } from '../tools/research.js';
import type { HistoryArguments } from '../domain/history-reader.js';

test('research recall replay keeps named-person dialogue, offers more, and opens an earlier-run ref', async () => {
  const f = open();
  try {
    seedSession(f.store, 'past-trip');
    seedTurn(f.store, 'past-trip', 'inputTranscription', 'A synthetic introduction. '.repeat(40) + 'Mira and I chose the cobalt lighthouse for our trip.');
    seedTurn(f.store, 'past-trip', 'outputTranscription', 'I suggested bringing the violet map.');
    f.store.transaction(tx => {
      tx.run('UPDATE history_sessions SET owner_id=?', [f.store.assistantId]);
      tx.run('UPDATE live_journal SET arrived_at=?', [NOW - 86400000]);
      tx.run('UPDATE live_sessions SET terminal_at=?', [NOW - 86400000]);
      backfillHistoryTurns(tx);
    });
    const reader = createHistoryReader(() => NOW);
    const scope = { ownerId: f.store.assistantId, runId: 'current-live-call', routeIdentity: 'synthetic', authorityEpoch: f.store.authorityEpoch, revision: 1, allowedClasses: ['ordinary'] as DataClass[] };
    const deps: ResearchDeps = {
      now: () => NOW, liveSessionId: 'current-live-call', configured: ['memory'], emit: () => {}, log: () => {}, logSubcall: () => {}, ledger: new ResearchLedger(),
      execute: async calls => calls.map(call => {
        const result = f.store.transaction(tx => reader.read(tx, scope, call.args as HistoryArguments));
        return { key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0,
          binding: { executionId: call.key } as NonNullable<Awaited<ReturnType<ResearchDeps['execute']>>[number]['binding']>, historyPage: result.response };
      }),
    };
    const signal = new AbortController().signal;
    const first = await runResearch(deps, { action: 'start', question: 'what did we talk about yesterday about the trip', lookups: [{ source: 'memory', query: 'trip lighthouse' }] }, signal);
    assert.match(JSON.stringify(first), /Mira and I chose the cobalt lighthouse/);
    assert.match(JSON.stringify(first), /I suggested bringing the violet map/);
    assert.doesNotMatch(String(first['note']), /Nothing more to fetch/i);
    assert.match(String(first['note']), /more|offer the rest/i);
    const pages = first['historyPages'] as Array<{ hits: Array<{ recordRef: string }> }>;
    const ref = pages[0]!.hits[0]!.recordRef;
    const named = await runResearch(deps, { action: 'start', question: 'What did Mira choose?', lookups: [{ source: 'memory', query: 'Mira lighthouse' }] }, signal);
    assert.match(JSON.stringify(named['findings']), /Mira and I chose the cobalt lighthouse/);
    const opened = await runResearch(deps, { action: 'continue', researchId: String(named['researchId']), question: 'Open that whole conversation', lookups: [{ source: 'memory', query: '', history: { recordRef: ref } }] }, signal);
    assert.match(JSON.stringify(opened), /Owner: A synthetic introduction/);
    assert.match(JSON.stringify(opened), /Naya: I suggested bringing the violet map/);
    const forbidden = f.store.transaction(tx => reader.read(tx, { ...scope, runId: 'another-live-call' }, { recordRef: ref }));
    assert.equal(forbidden.response.status, 'history_reference_unavailable');
  } finally { f.cleanup(); }
});

test('startup captures legacy speech before pruning and explicit session reads page the complete call', () => {
  const f = open();
  let reopened: Store | undefined;
  try {
    seedSession(f.store, 'startup-legacy');
    const words = 'Synthetic route marker. '.repeat(300);
    seedTurn(f.store, 'startup-legacy', 'inputTranscription', words);
    seedTurn(f.store, 'startup-legacy', 'outputTranscription', 'The synthetic reply ends the call.');
    f.store.transaction(tx => {
      summaries.insertSummary(tx, { liveSessionId: 'startup-legacy', status: 'skipped', skipReason: 'model_skip', endedAt: NOW, now: NOW });
      tx.run('DELETE FROM history_sessions WHERE live_session_id=?', ['startup-legacy']);
      const old = Date.now() - 40 * 86400000;
      tx.run('UPDATE live_sessions SET terminal_at=? WHERE live_session_id=?', [old, 'startup-legacy']);
      tx.run('UPDATE live_journal SET arrived_at=? WHERE live_session_id=?', [old, 'startup-legacy']);
    });
    f.store.close();
    reopened = new Store(f.dir, [...domainMigrations, ...liveMigrations]);
    const store = reopened;
    store.transaction(tx => {
      assert.equal(tx.all('SELECT id FROM history_turns').length, 2);
      assert.equal(tx.get("SELECT text FROM live_journal WHERE live_session_id=? AND kind='inputTranscription'", ['startup-legacy'])?.text, null);
      const reader = createHistoryReader();
      const scope = { ownerId: store.assistantId, runId: 'new-call', routeIdentity: 'synthetic', authorityEpoch: store.authorityEpoch, revision: 1, allowedClasses: ['sensitive'] as DataClass[] };
      const first = reader.read(tx, scope, { recordRef: 'session:startup-legacy' }).response;
      assert.equal(String(first.text).length, 6000);
      assert.equal(first.complete, false);
      const next = reader.read(tx, scope, { cursor: String(first.nextCursor) }).response;
      assert.equal(String(first.text) + String(next.text), `Owner: ${words}\nNaya: The synthetic reply ends the call.`);
      assert.equal(next.complete, true);
      assert.equal(reader.read(tx, { ...scope, allowedClasses: ['ordinary'] }, { recordRef: 'session:startup-legacy' }).response.status, 'history_reference_unavailable');
    });
  } finally { reopened?.close(); f.cleanup(); }
});


test('F4: explicit Live identity excludes current speech and summary before all five past slots', () => {
  const f = open();
  try {
    for (const id of ['active-call', 'past-1', 'past-2', 'past-3', 'past-4', 'past-5']) {
      seedSession(f.store, id);
      seedTurn(f.store, id, 'inputTranscription', id === 'active-call' ? 'lighthouse lighthouse lighthouse' : 'We discussed the lighthouse for a synthetic fixture.');
    }
    f.store.transaction(tx => {
      tx.run('UPDATE history_sessions SET owner_id=?', [f.store.assistantId]);
      summaries.insertSummary(tx, { liveSessionId: 'active-call', status: 'complete', summary: 'Current lighthouse summary.', endedAt: NOW, now: NOW });
      backfillHistoryTurns(tx);
      const reader = createHistoryReader(() => NOW);
      const scope = { ownerId: f.store.assistantId, runId: 'distinct-research-run', currentSessionId: 'active-call', routeIdentity: 'synthetic', authorityEpoch: f.store.authorityEpoch, revision: 1, allowedClasses: ['ordinary'] as DataClass[] };
      const page = reader.read(tx, scope, { query: 'lighthouse' }).response;
      const hits = page.hits as Array<Record<string, unknown>>;
      assert.equal(hits.length, 5);
      assert.equal(page.totalMatches, 5);
      assert.deepEqual(hits.map(hit => hit.sessionId).sort(), ['past-1', 'past-2', 'past-3', 'past-4', 'past-5']);
      assert.equal(reader.read(tx, scope, { recordRef: 'session:active-call' }).response.status, 'history_reference_unavailable');
    });
  } finally { f.cleanup(); }
});


test('F5: a diacritic-heavy source retains the matched words in its verbatim crop', () => {
  const f = open();
  try {
    seedSession(f.store, 'accented-story');
    const words = 'e\u0301 '.repeat(450) + 'Hélène chose the cobalt lighthouse for the trip.';
    seedTurn(f.store, 'accented-story', 'inputTranscription', words);
    seedTurn(f.store, 'accented-story', 'outputTranscription', 'We will bring the violet map.');
    f.store.transaction(tx => {
      tx.run('UPDATE history_sessions SET owner_id=?', [f.store.assistantId]);
      backfillHistoryTurns(tx);
      const page = createHistoryReader(() => NOW).read(tx, { ownerId: f.store.assistantId, runId: 'accent-research', currentSessionId: 'another-live-call', routeIdentity: 'synthetic', authorityEpoch: f.store.authorityEpoch, revision: 1, allowedClasses: ['ordinary'] }, { query: 'lighthouse' }).response;
      const hits = page.hits as Array<Record<string, unknown>>;
      assert.equal(hits.length, 1);
      assert.match(String(hits[0]?.snippet), /Hélène chose the cobalt lighthouse for the trip\./);
      assert.match(String(hits[0]?.snippet), /Naya: We will bring the violet map\./);
      assert.ok(String(hits[0]?.snippet).includes('e\u0301'), 'the crop preserves source combining marks rather than returning folded speech');
    });
  } finally { f.cleanup(); }
});


test('F6: complete short recall has no more note, while a truncated record offers and clears continuation', async () => {
  const f = open();
  try {
    seedSession(f.store, 'short-record');
    seedSession(f.store, 'long-record');
    seedTurn(f.store, 'short-record', 'inputTranscription', 'The quartz hill is our destination.');
    seedTurn(f.store, 'long-record', 'inputTranscription', 'Synthetic background. '.repeat(45) + 'The cobalt lighthouse is our destination.');
    f.store.transaction(tx => {
      tx.run('UPDATE history_sessions SET owner_id=?', [f.store.assistantId]);
      tx.run('UPDATE live_journal SET arrived_at=?', [NOW - 86400000]);
      backfillHistoryTurns(tx);
    });
    const reader = createHistoryReader(() => NOW);
    const scope = { ownerId: f.store.assistantId, runId: 'different-run', currentSessionId: 'current-call', routeIdentity: 'synthetic', authorityEpoch: f.store.authorityEpoch, revision: 1, allowedClasses: ['ordinary'] as DataClass[] };
    const deps: ResearchDeps = {
      now: () => NOW, liveSessionId: 'current-call', configured: ['memory'], emit: () => {}, log: () => {}, logSubcall: () => {}, ledger: new ResearchLedger(),
      execute: async calls => calls.map(call => {
        const page = f.store.transaction(tx => reader.read(tx, scope, call.args as HistoryArguments)).response;
        return { key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0,
          binding: { executionId: call.key } as NonNullable<Awaited<ReturnType<ResearchDeps['execute']>>[number]['binding']>, historyPage: page };
      }),
    };
    const signal = new AbortController().signal;
    const short = await runResearch(deps, { action: 'start', question: 'what did we say about quartz hill yesterday', lookups: [{ source: 'memory', query: 'quartz hill' }] }, signal);
    assert.equal(short['status'], 'complete');
    assert.equal(short['canContinue'], false);
    assert.match(String(short['note']), /Nothing more to fetch/);
    assert.doesNotMatch(String(short['note']), /offer the rest|more is available/i);
    const long = await runResearch(deps, { action: 'start', question: 'what did we say about the lighthouse yesterday', lookups: [{ source: 'memory', query: 'lighthouse' }] }, signal);
    assert.equal(long['status'], 'partial');
    assert.equal(long['canContinue'], true);
    assert.match(String(long['note']), /offer the rest|more/i);
    assert.doesNotMatch(String(long['note']), /Nothing more to fetch/);
    const ref = (long['historyPages'] as Array<{ hits: Array<{ recordRef: string }> }>)[0]!.hits[0]!.recordRef;
    const full = await runResearch(deps, { action: 'continue', researchId: String(long['researchId']), question: 'Read the complete record', lookups: [{ source: 'memory', history: { recordRef: ref } }] }, signal);
    assert.match(JSON.stringify(full['historyPages']), /Owner: Synthetic background/);
    assert.equal(full['status'], 'complete');
    assert.equal(full['canContinue'], false);
    assert.match(String(full['note']), /Nothing more to fetch/);
  } finally { f.cleanup(); }
});
