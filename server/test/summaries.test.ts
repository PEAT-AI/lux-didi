import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { liveMigrations } from '../live/schema.js';
import * as summaries from '../domain/summaries.js';
import { buildEarlierConversationsSection, earlierConversationsBudget } from '../prompt/live-persona.js';
import { composeLiveSessionInstruction, NAYA_LIVE_BASE, TRUSTED_SYSTEM_CODE_UNIT_LIMIT, composeLiveInstruction } from '../prompt/live-persona.js';
import { compilePrompt, createCapabilitySnapshot, PROMPT_VERSION, validatePreferences } from '../prompt/index.js';
import type { ModelControl, ModelPort, ModelRequest, ModelResult, Transport } from '../adapters/model/types.js';
import { GeminiAdapter } from '../adapters/model/index.js';
import {
  DISTILLATION_PROMPT, SUMMARY_MAX_RETRIES, SUMMARY_RECOVERY_LIMIT, buildDistillationInput, capDistillationInput,
  createSummarizer, parseDistillationResult,
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
  return createSummarizer({ store, model, modelId: 'synthetic-text-model', timeZone: 'UTC', now: () => NOW, log: () => {} });
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
  assert.ok(DISTILLATION_PROMPT.startsWith('You write a short private summary of one finished voice conversation'));
  assert.ok(DISTILLATION_PROMPT.includes('{"skip": boolean, "summary": string}'));
  assert.ok(DISTILLATION_PROMPT.includes('the owner said'));
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
  const input = buildDistillationInput({ turns: [{ speaker: 'owner', text: 'hello' }], toolNames: ['remember_note'],
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
      assert.deepEqual(after.transaction(tx => tx.all("SELECT version FROM runtime_migrations WHERE owner='domain' ORDER BY version").map(r => Number(r.version))), [1, 2, 3, 4, 5]);
      assert.ok(after.transaction(tx => tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'")));
      assert.equal(after.transaction(tx => tx.get("SELECT text FROM entries WHERE id='e1'"))!['text'], 'synthetic note');
      assert.deepEqual(after.transaction(tx => summaries.listSummaries(tx)), []);
    } finally { after.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('voice and text chat render the same summary for the same past session', () => {
  const h = open();
  try {
    h.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: 'past-1', status: 'complete', summary: 'The owner said they moved to Lisbon; Naya noted the timezone change.', endedAt: NOW, now: NOW }));
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
    const s = createSummarizer({ store: h.store, model, modelId: 'gemini-2.5-flash', timeZone: 'UTC', now: () => Date.now(), log: () => {} });
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
    const s = createSummarizer({ store: h.store, model, modelId: 'gemini-2.5-flash', timeZone: 'UTC', now: () => Date.now(), deadlineBudgetMs: -1, log: () => {} });
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

    const bounded = h.store.transaction(tx => summaries.failedDeadlineSessionsWithJournal(tx, SUMMARY_RECOVERY_LIMIT));
    assert.equal(bounded.length, 30, 'the requeue list is capped at the newest 30');
    assert.equal(bounded[0]!.liveSessionId, 's-rec-35', 'newest first');
    assert.equal(h.store.transaction(tx => summaries.countFailedDeadlineSessionsWithJournal(tx)), 36, 'a row with no journal is excluded');

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
    for (let i = 0; i < 20; i++) h.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: `past-${String(i).padStart(2, '0')}`,
      status: 'complete', summary: `The owner discussed the Mongoose mint delivery window and the Friday schedule, item ${i}.`, endedAt: NOW - i * 3_600_000, now: NOW }));
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
