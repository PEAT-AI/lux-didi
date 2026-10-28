// W-LSUM: the browser-safe Live summary for the page. The operator-only status route refuses a
// cookie principal (403); this sibling route answers the cookie principal (and the operator) with a
// closed whitelist and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { liveMigrations } from '../live/schema.js';
import { toolsMigrations } from '../tools/schema.js';
import { historySessionEvidence, recordHistorySession } from '../domain/history-lifecycle.js';
import * as summaries from '../domain/summaries.js';
import {
  SUMMARY_BOOT_REQUEUE_DELAY_MS, SUMMARY_HOST_START_LIMIT, SUMMARY_MAX_RETRIES, SUMMARY_RETRY_BACKOFF_MS,
  SUMMARY_RETRY_MAX_AGE_MS, createSummarizer, type SummarizerLogEvent,
} from '../services/summarize.js';
import type { ModelControl, ModelPort, ModelRequest, ModelResult } from '../adapters/model/types.js';
import { currentLivePlaybackRate } from '../config/live.js';
import { listenService } from '../http/server.js';
import type { LiveService, LiveStatusPayload } from '../http/live-upgrade.js';

const CONFIGURED: LiveStatusPayload = {
  service: 'live', status: 'configured', provider: 'gemini',
  model: 'gemini-synthetic-live', voice: 'Aoede',
  dataClasses: ['ordinary'], profileIdentity: 'synthetic-profile-identity',
  limits: { sessionMs: 900000, idleMs: 300000 },
};
const DISABLED: LiveStatusPayload = { service: 'live', status: 'disabled' };

function liveStub(payload: LiveStatusPayload): LiveService {
  return {
    enabled: payload.status === 'configured',
    profileIdentity: 'synthetic-profile-identity',
    maxIncomingBytes: 1,
    maxBufferedBytes: 1,
    status: () => payload,
  } as unknown as LiveService;
}

async function fixture(payload: LiveStatusPayload | undefined, ownerProfileStatus: { status: 'default' | 'configured'; displayName: string } = { status: 'configured', displayName: 'Naya' }) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-summary-'));
  const store = new Store(dir);
  const service = await listenService({ store, port: 0, ownerProfileStatus, ...(payload ? { live: liveStub(payload) } : {}) });
  const auth = { Authorization: `Bearer ${readFileSync(join(dir, 'admin-credential'), 'utf8').trim()}` };
  return { dir, store, service, auth, async cleanup() { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function pair(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const bootstrap = await fetch(`${f.service.origin}/api/v1/auth/pairing`, { method: 'POST', headers: { ...f.auth, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(bootstrap.status, 200);
  const { data: { pairingCode } } = await bootstrap.json() as { data: { pairingCode: string } };
  const paired = await fetch(`${f.service.origin}/api/v1/auth/pair`, { method: 'POST', headers: { Origin: f.service.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode }) });
  assert.equal(paired.status, 200);
  return paired.headers.get('set-cookie')!.split(';')[0]!;
}

test('cookie principal gets exactly the whitelisted Live summary', async () => {
  const f = await fixture(CONFIGURED);
  try {
    const cookie = await pair(f);
    const response = await fetch(`${f.service.origin}/api/v1/live/summary`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = (await response.json()).data as Record<string, unknown>;
    // PV1: the closed shape also carries the provider the 3l release exposed and the accent selection;
    // P3 adds the pitch-preserving pace the page shows read-only.
    assert.deepEqual(Object.keys(body).sort(), ['accent', 'limits', 'modelId', 'personaName', 'playbackRate', 'profileEnabled', 'provider', 'voice']);
    assert.equal(body.modelId, 'gemini-synthetic-live');
    assert.equal(body.voice, 'Aoede');
    assert.equal(body.playbackRate, currentLivePlaybackRate(), 'the pace the next start plays at, as the process holds it');
    assert.equal(body.personaName, 'Naya');
    assert.deepEqual(body.limits, { sessionMs: 900000, idleMs: 300000 });
    assert.equal(body.profileEnabled, true);
    const wire = JSON.stringify(body);
    for (const forbidden of ['keyReference', 'endpoint', 'apiKey', 'prompt', 'system', 'personaText']) assert.doesNotMatch(wire, new RegExp(forbidden, 'i'));
    assert.equal(Object.keys(body.limits as object).sort().join(','), 'idleMs,sessionMs');
  } finally { await f.cleanup(); }
});

test('the operator bearer also reaches the summary', async () => {
  const f = await fixture(CONFIGURED);
  try {
    const response = await fetch(`${f.service.origin}/api/v1/live/summary`, { headers: f.auth });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()).data as Record<string, unknown>).personaName, 'Naya');
  } finally { await f.cleanup(); }
});

test('unauthenticated summary is 401 and the operator-only status route still refuses the cookie', async () => {
  const f = await fixture(CONFIGURED);
  try {
    assert.equal((await fetch(`${f.service.origin}/api/v1/live/summary`)).status, 401);
    const cookie = await pair(f);
    assert.equal((await fetch(`${f.service.origin}/api/v1/live/status`, { headers: { Cookie: cookie } })).status, 403);
  } finally { await f.cleanup(); }
});

test('a disabled or missing Live profile answers 200 with profileEnabled false and the rest null', async () => {
  for (const payload of [DISABLED, undefined]) {
    const f = await fixture(payload);
    try {
      const cookie = await pair(f);
      const response = await fetch(`${f.service.origin}/api/v1/live/summary`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const body = (await response.json()).data as Record<string, unknown>;
      // PV1: the summary also names the accent selection, null while no Live profile is running; P3 adds the
      // pace on the same rule, so both fields are null here rather than absent.
      assert.deepEqual(Object.keys(body).sort(), ['accent', 'limits', 'modelId', 'personaName', 'playbackRate', 'profileEnabled', 'provider', 'voice']);
      assert.deepEqual(body, { accent: null, provider: null, modelId: null, voice: null, playbackRate: null, personaName: null, limits: null, profileEnabled: false });
    } finally { await f.cleanup(); }
  }
});

test('the distiller is given the persona name this route reports, from one owner snapshot', () => {
  // The summary prompt takes the assistant name as a parameter (conversation-summary-v4), so both surfaces
  // must read it from the owner profile rather than from a literal.
  const runtime = readFileSync(new URL('../../host/runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /assistantName: owner\.snapshot\.displayName/);
  assert.match(runtime, /ownerProfileStatus: \{ status: owner\.status, displayName: owner\.snapshot\.displayName \}/);
});

// The distillation worker: a failed conversation summary is retried with backoff inside one host life, a
// transient failure is retried at the next host start after the boot delay, and it is closed, never sealed
// on the first attempt, once the bounded budget or the age cap is spent. A permanent refusal is never retried.
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
      [`grant-${id}`, id, 'gemini', 'synthetic-live', 'voice', 'gemini-primary', JSON.stringify(['ordinary', 'private']), 'ordinary', 1, endedAt]);
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

test('a summary that fails for a transient reason is retried with backoff, then stored', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-transient');
    const waits: number[] = [];
    const model = new ScriptedModel([modelResult('error', '', 'transport_error'), modelResult('error', '', 'transport_error'),
      modelResult('complete', '{"skip": false, "summary": "The owner discussed the mint window."}')]);
    await worker(h.store, model, waits).distill('s-transient');
    const row = storedRow(h.store, 's-transient')!;
    assert.equal(row.status, 'complete');
    assert.equal(model.calls, 3, 'three attempts in one host life');
    assert.equal(row.retryCount, 2);
    assert.deepEqual(waits, [...SUMMARY_RETRY_BACKOFF_MS], 'the fake clock saw 2 s then 10 s');
  } finally { h.cleanup(); }
});

test('a summary writes a pending row before the model call and replaces it with the outcome', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-pending');
    const seen: (summaries.SummaryRecord | null)[] = [];
    const model: ModelPort = {
      async generate(): Promise<ModelResult> {
        seen.push(h.store.transaction(tx => summaries.getBySession(tx, 's-pending')));
        return modelResult('complete', '{"skip": false, "summary": "The owner discussed the mint window."}');
      },
    };
    await worker(h.store, model, []).distill('s-pending');
    assert.equal(seen[0]?.status, 'failed', 'a row exists before the model call');
    assert.equal(seen[0]?.errorCode, summaries.PENDING_SUMMARY_ERROR_CODE, 'and it says the summary is in flight');
    const done = storedRow(h.store, 's-pending')!;
    assert.equal(done.status, 'complete', 'the outcome replaces the in-flight row');
    assert.equal(done.errorCode, null, 'and the in-flight code is gone');
  } finally { h.cleanup(); }
});

test('a pending row left by a host that exited is requeued at the next start', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-pending-crash');
    // The production writer: the row a host that exits mid-summary leaves behind.
    const source = h.store.transaction(tx => historySessionEvidence(tx, 's-pending-crash'))!;
    h.store.transaction(tx => summaries.markSummaryPending(tx, 's-pending-crash', SUMMARY_NOW, { dataClass: source.dataClass, sourceRevision: source.revision }));
    const model = new ScriptedModel([modelResult('complete', '{"skip": false, "summary": "late"}')]);
    const waits: number[] = [];
    await worker(h.store, model, waits).requeueFailed();
    assert.deepEqual(waits, [SUMMARY_BOOT_REQUEUE_DELAY_MS], 'the boot requeue waits out the start-up window');
    assert.equal(storedRow(h.store, 's-pending-crash')!.status, 'complete', 'the orphaned summary is distilled');
  } finally { h.cleanup(); }
});

test('C-SUMMARY8: a start finishes the summary a previous host exited on, before a call can plan', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-at-start');
    const source = h.store.transaction(tx => historySessionEvidence(tx, 's-at-start'))!;
    h.store.transaction(tx => summaries.markSummaryPending(tx, 's-at-start', SUMMARY_NOW, { dataClass: source.dataClass, sourceRevision: source.revision }));
    const model = new ScriptedModel([modelResult('complete', '{"skip": false, "summary": "The owner discussed the mint window."}')]);
    const waits: number[] = [];
    const events: SummarizerLogEvent[] = [];
    const outcome = await worker(h.store, model, waits, event => events.push(event)).recoverAtStart();
    assert.equal(outcome, 'done', 'the start waited for the summary and it landed');
    assert.deepEqual(waits, [], 'no boot requeue delay: the opener plan waits behind this pass');
    assert.equal(storedRow(h.store, 's-at-start')!.status, 'complete', 'the interrupted row is replaced by its outcome');
    assert.equal(events.find(event => event.event === 'conversation_summary_started')?.['phase'], 'at_start',
      'the start-up pass names its phase on the closed summary line');
  } finally { h.cleanup(); }
});

test('C-SUMMARY8: a summary that outlives the start budget leaves the call unknown, never blocking the start', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-slow-start');
    const source = h.store.transaction(tx => historySessionEvidence(tx, 's-slow-start'))!;
    h.store.transaction(tx => summaries.markSummaryPending(tx, 's-slow-start', SUMMARY_NOW, { dataClass: source.dataClass, sourceRevision: source.revision }));
    const model: ModelPort = { generate: () => new Promise<ModelResult>(() => { /* a provider that never answers */ }) };
    const outcome = await worker(h.store, model, []).recoverAtStart(1);
    assert.equal(outcome, 'timeout', 'the start gives up on the budget, it does not hang on the provider');
    assert.equal(storedRow(h.store, 's-slow-start')!.status, 'failed', 'the in-flight row stays as it was for the next start');
  } finally { h.cleanup(); }
});

test('C-SUMMARY8: a call too short to summarise costs the next start no wait', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-short');
    h.store.transaction(tx => tx.run("DELETE FROM live_journal WHERE live_session_id='s-short' AND kind='inputTranscription'", []));
    const model = new ScriptedModel([modelResult('complete', '{"skip": false, "summary": "never asked for"}')]);
    const waits: number[] = [];
    const summarizer = worker(h.store, model, waits);
    await summarizer.distill('s-short');
    assert.equal(storedRow(h.store, 's-short')!.skipReason, 'too_few_turns');
    assert.equal(model.calls, 0, 'the session never reached the model');
    assert.equal(await summarizer.recoverAtStart(), 'done', 'nothing pending, so the start returns at once');
    assert.deepEqual(waits, [], 'and it never arms a timer');
    assert.equal(model.calls, 0, 'the skipped call is never distilled again');
  } finally { h.cleanup(); }
});

test('a summary that failed in one host start is retried at the next start, after the boot delay', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-boot');
    const first = new ScriptedModel([modelResult('error', '', 'transport_error')]);
    await worker(h.store, first, []).distill('s-boot');
    const failed = storedRow(h.store, 's-boot')!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'network', 'a transient network failure, not the word error');
    assert.equal(first.calls, SUMMARY_MAX_RETRIES + 1);
    const waits: number[] = [];
    const second = new ScriptedModel([modelResult('complete', '{"skip": false, "summary": "The owner discussed the mint window."}')]);
    await worker(h.store, second, waits).requeueFailed();
    assert.deepEqual(waits, [SUMMARY_BOOT_REQUEUE_DELAY_MS], 'the boot requeue waits out the start-up window');
    const row = storedRow(h.store, 's-boot')!;
    assert.equal(row.status, 'complete');
    assert.equal(second.calls, 1);
    assert.equal(row.retryCount, SUMMARY_MAX_RETRIES, 'the attempts spent in the first start are kept');
  } finally { h.cleanup(); }
});

test('a refusal is permanent: it is never retried and the closed reason is recorded', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-refusal');
    const waits: number[] = [];
    const model = new ScriptedModel([modelResult('blocked', '', 'provider_blocked'), modelResult('complete', '{"skip": false, "summary": "late"}')]);
    await worker(h.store, model, waits).distill('s-refusal');
    assert.equal(model.calls, 1, 'a refusal is not retried');
    assert.deepEqual(waits, []);
    const failed = storedRow(h.store, 's-refusal')!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'provider_blocked');
    const next = new ScriptedModel([modelResult('complete', '{"skip": false, "summary": "late"}')]);
    await worker(h.store, next, []).requeueFailed();
    assert.equal(next.calls, 0, 'a permanent failure is not requeued at the next host start');
    assert.equal(storedRow(h.store, 's-refusal')!.errorCode, 'provider_blocked');
  } finally { h.cleanup(); }
});

test('a transient failure is closed after its bounded host starts, with a final reason', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-bounded');
    await worker(h.store, new ScriptedModel([modelResult('error', '', 'transport_error')]), []).distill('s-bounded');
    for (let start = 2; start <= SUMMARY_HOST_START_LIMIT; start++) {
      await worker(h.store, new ScriptedModel([modelResult('error', '', 'transport_error')]), []).requeueFailed();
      const row = storedRow(h.store, 's-bounded')!;
      assert.equal(row.status, 'failed', `start ${start} still failed for a transient reason`);
      assert.equal(row.errorCode, 'network');
    }
    const closing = new ScriptedModel([modelResult('complete', '{"skip": false, "summary": "late"}')]);
    await worker(h.store, closing, []).requeueFailed();
    assert.equal(closing.calls, 0, 'no further attempt once the budget is spent');
    const row = storedRow(h.store, 's-bounded')!;
    assert.equal(row.status, 'failed');
    assert.equal(row.errorCode, 'retry_exhausted', 'the closed final reason');
  } finally { h.cleanup(); }
});

test('a failed summary older than the age cap is closed instead of retried', async () => {
  const h = summarizerFixture();
  try {
    const id = 's-aged';
    seedConversation(h.store, id, SUMMARY_NOW - SUMMARY_RETRY_MAX_AGE_MS - 1);
    h.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: id, status: 'failed', errorCode: 'network',
      retryCount: 0, endedAt: SUMMARY_NOW - SUMMARY_RETRY_MAX_AGE_MS - 1, now: SUMMARY_NOW }));
    const model = new ScriptedModel([modelResult('complete', '{"skip": false, "summary": "late"}')]);
    await worker(h.store, model, []).requeueFailed();
    assert.equal(model.calls, 0, 'an aged failure is not retried');
    assert.equal(storedRow(h.store, id)!.errorCode, 'retry_exhausted');
  } finally { h.cleanup(); }
});

test('a legacy failed row with the old error class is requeued once at the next start', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-legacy-error');
    // The two rows the owner's store already holds: error_code 'error', retry_count 0.
    h.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: 's-legacy-error', status: 'failed',
      errorCode: 'error', retryCount: 0, now: SUMMARY_NOW }));
    const model = new ScriptedModel([modelResult('complete', '{"skip": false, "summary": "recovered"}')]);
    const waits: number[] = [];
    await worker(h.store, model, waits).requeueFailed();
    assert.deepEqual(waits, [SUMMARY_BOOT_REQUEUE_DELAY_MS], 'the boot requeue waits out the start-up window');
    assert.equal(model.calls, 1, 'the legacy row is distilled once');
    assert.equal(storedRow(h.store, 's-legacy-error')!.status, 'complete', 'and it reaches memory');
  } finally { h.cleanup(); }
});

/** One sealed tool call, in the shape the tools layer writes it: the name in the intent, the code in the response. */
function insertToolCall(store: Store, runId: string, toolName: string, state: 'completed' | 'refused' | 'failed' | 'unknown',
                        response: Record<string, unknown>, ordinal = 0): void {
  const executionId = `run:${runId}:${ordinal}`;
  store.transaction(tx => tx.run(`INSERT INTO tool_calls (owner_id,run_id,execution_id,call_id,intent_json,state,result_id,result_json,result_sha256,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [store.assistantId, runId, executionId, `call-${ordinal}`,
    JSON.stringify({ runId, actorId: 'owner', authorityEpoch: store.authorityEpoch, revision: 1, executionId, toolName, argumentsHash: 'a'.repeat(64) }),
    state, `result-${ordinal}`, JSON.stringify({ response, dataClasses: [] }), 'b'.repeat(64), SUMMARY_NOW + ordinal]));
}

// Contract C-SUMMARY: the recorded tool outcome reaches the distiller even when the assistant spoke a different
// cause, so the stored summary cannot carry the invented explanation into later calls.
test('a refused tool reaches the distillation input by its recorded code, not by the spoken explanation', async () => {
  const h = summarizerFixture();
  try {
    seedConversation(h.store, 's-refused-tool');
    h.store.transaction(tx => tx.run('INSERT INTO live_journal (live_session_id, kind, text, finished, payload_bytes, arrived_at) VALUES (?,?,?,1,?,?)',
      ['s-refused-tool', 'outputTranscription', 'Lux threw an authorization error, so nothing was saved.', 56, SUMMARY_NOW]));
    // The three shapes the tools layer persists (persistTerminal): a gateway write that answers "not done" through
    // the completed path, a failed dispatch whose code is the reason, and a pre-execution refusal.
    insertToolCall(h.store, 's-refused-tool', 'stage_lux_note', 'completed', { staged: false, code: 'authorization_missing' });
    insertToolCall(h.store, 's-refused-tool', 'vault_search', 'failed', { status: 'failed', reason: 'upstream_timeout' }, 1);
    insertToolCall(h.store, 's-refused-tool', 'web_search', 'refused', { status: 'refused', reason: 'not_granted' }, 2);
    // The vault save and the open tools answer "not done" on the completed path too: `{saved:false, code}` and a
    // guard receipt code other than 'opened' (server/tools/vault-write.ts:62, server/tools/index.ts:695).
    insertToolCall(h.store, 's-refused-tool', 'save_to_vault', 'completed', { saved: false, code: 'not_owner_requested', guidance: 'Ask him first.' }, 3);
    insertToolCall(h.store, 's-refused-tool', 'open_app', 'completed', { code: 'no_open_intent', guidance: 'Nothing to open.' }, 4);
    insertToolCall(h.store, 's-refused-tool', 'open_app', 'completed', { code: 'opened', kind: 'app', title: 'Maps' }, 5);
    insertToolCall(h.store, 's-refused-tool', 'calendar_read', 'completed', { events: [] }, 6);
    const requests: ModelRequest[] = [];
    const model: ModelPort = { generate: (request: ModelRequest) => { requests.push(request); return Promise.resolve(modelResult('complete', '{"skip": false, "summary": "the owner asked to save a note."}')); } };
    await worker(h.store, model, []).distill('s-refused-tool');
    assert.equal(requests.length, 1, 'the distiller made one model call');
    const text = requests[0]!.contents.flatMap(content => content.parts.map(part => typeof part['text'] === 'string' ? part['text'] : '')).join('\n');
    assert.ok(text.includes('Tool outcomes:'), 'the block is present');
    assert.ok(text.includes('stage_lux_note refused authorization_missing'), 'the record names the tool and its code');
    assert.ok(text.includes('vault_search failed upstream_timeout'), 'a failed call carries its reason code');
    assert.ok(text.includes('web_search refused not_granted'), 'a pre-execution refusal carries its reason code');
    assert.ok(text.includes('save_to_vault refused not_owner_requested'), 'a refused vault save reads refused, not succeeded');
    assert.ok(text.includes('open_app refused no_open_intent'), 'an open guard refusal reads refused');
    assert.ok(text.includes('open_app succeeded'), 'the opened ack still reads succeeded');
    assert.ok(text.includes('calendar_read succeeded'), 'a completed call reads as succeeded');
    assert.ok(requests[0]!.system.includes('Tool outcomes come only from the Tool outcomes block below'));
    assert.equal(storedRow(h.store, 's-refused-tool')!.status, 'complete', 'the summary is stored');
  } finally { h.cleanup(); }
});
