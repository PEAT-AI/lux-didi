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
import * as summaries from '../domain/summaries.js';
import {
  SUMMARY_BOOT_REQUEUE_DELAY_MS, SUMMARY_HOST_START_LIMIT, SUMMARY_MAX_RETRIES, SUMMARY_RETRY_BACKOFF_MS,
  SUMMARY_RETRY_MAX_AGE_MS, createSummarizer,
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
  // The summary prompt takes the assistant name as a parameter (conversation-summary-v2), so both surfaces
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
  const store = new Store(dir, [...domainMigrations, ...liveMigrations]);
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

function worker(store: Store, model: ModelPort, waits: number[]) {
  // The host always passes the route's permitted classes; without them the distiller fails closed and skips.
  return createSummarizer({ store, model, modelId: 'synthetic-text-model', modelAllowedClasses: ['ordinary', 'private'],
    assistantName: 'Naya', timeZone: 'UTC', now: () => SUMMARY_NOW, log: () => {},
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
