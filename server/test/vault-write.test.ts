import { seedLuxTurn } from './lux-turn-fixture.js';
import { LUX_TOOLS } from '../connectors/lux-names.js';
import { syntheticTaskFactory } from './synthetic-task.js';
import { attachHostLogSink } from '../tools/host-events.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createLuxWriteTransport } from '../adapters/lux-write/client.js';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, validateLiveProfile, type LiveContext } from '../live/index.js';
import { fakeLiveVoicePort } from './fixtures/fake-live-voice.js';
import { fakeLux } from './fixtures/fake-lux-vault.js';
import { safeEvent } from '../host/log.js';
import { liveMigrations } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { VaultWriter, authorizeComposedWrite, vaultContentKey, type VaultWriteResult } from '../tools/vault-write.js';

const NOW = 1_700_000_000_000;
const SESSION = 'live-vault-write';
const NOTE = 'the boat survey is on Tuesday';


interface Harness { store: Store; writer: VaultWriter; events: Record<string, unknown>[] }

function harness(t: TestContext, url: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'vault-write-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, [...domainMigrations, ...liveMigrations]);
  t.after(() => store.close());
  const events: Record<string, unknown>[] = [];
  const writer = new VaultWriter({ store, backoff: async () => {}, transport: createLuxWriteTransport({ url }), now: () => NOW, log: event => { events.push(event); } });
  return { store, writer, events };
}

const SPOKEN_AT = new Date(NOW).toISOString();
const OWNER_TURN_ID = '2';
const PROVENANCE = `\n\nProvenance: lux-didi; speaker=owner; confidence=1; session=${SESSION}; requested_turn_id=${OWNER_TURN_ID}.`;
/** The discovered create schema is the payload contract; the helper never assembles the wire itself. */
const CREATE_SCHEMA = { type: 'object', required: ['content', 'insight_title'], properties: { content: { type: 'string', minLength: 1 }, insight_title: { type: 'string', minLength: 1 },
  insight_type: { type: 'string' }, project: { type: 'string' }, source_kind: { type: 'string' }, source_ref: { type: 'object' }, idempotency_key: { type: 'string' } } };
/** The write carries its provenance and an idempotency key; the key is the op id, minted per op. */
const saveArgs = (key: unknown) => ({ content: `${NOTE}${PROVENANCE}`, insight_title: NOTE,
  source_kind: 'voice_call', source_ref: { app: 'lux-didi', session_id: SESSION, turn_start_id: OWNER_TURN_ID, turn_end_id: OWNER_TURN_ID, spoken_at: SPOKEN_AT, speaker: 'owner' }, idempotency_key: key });

/** One owner turn, persisted where the host reads it, then one write that names it. */
async function save(h: Harness, content: string, turnId = OWNER_TURN_ID): Promise<VaultWriteResult> {
  seedLuxTurn(h.store, SESSION, Number(turnId), 'owner', content, NOW);
  return h.writer.writeTask({ sessionId: SESSION, tool: 'vault_save', operation: 'create_insight', inputSchema: CREATE_SCHEMA,
    maxPayloadBytes: 100_000, authorized: () => true, args: { requested_turn_id: turnId, payload: { content, insight_title: content } } });
}

test('an authorized task saves its exact words once under the vault project', async t => {
  const fake = await fakeLux(t, 'inserted');
  const h = harness(t, fake.url);
  const first = await save(h, NOTE);
  assert.deepEqual(first, { disposition: 'created', insight_id: 7 });
  const args = (fake.calls[0]?.arguments ?? {}) as Record<string, unknown>;
  assert.equal(typeof args['idempotency_key'], 'string');
  assert.deepEqual({ ...args, idempotency_key: 'op' }, saveArgs('op'));
  assert.equal(fake.calls[0]?.name, 'create_insight');
});

test('an empty authorized task payload writes nothing and returns an honest invalid-payload receipt', async t => {
  const fake = await fakeLux(t, 'inserted'); const h = harness(t, fake.url);
  // The discovered schema owns the payload, so a blank note is refused before the wire.
  assert.deepEqual(await save(h, ''), { disposition: 'refused', reason: 'invalid_arguments_after_host_provenance' });
  assert.equal(fake.calls.length, 0);
});

test('an unreachable vault is logged as unavailable with its closed code', async t => {
  const h = harness(t, 'http://127.0.0.1:1/mcp');
  assert.deepEqual(await save(h, NOTE), { disposition: 'refused', reason: 'transport_unavailable' });
  const attempt = h.events.at(-1);
  assert.deepEqual(attempt, { event: 'vault_write', tool: 'create_insight', outcome: 'refused', insight_id_prefix: '' }, 'the attempt is logged by closed shape only');
});

test('a dictated note reaches the vault once, and only the vault id comes back', async t => {
  const fake = await fakeLux(t, 'inserted');
  const h = harness(t, fake.url);
  const receipt = await save(h, NOTE);
  assert.deepEqual(receipt, { disposition: 'created', insight_id: 7 });
  assert.equal(fake.calls.length, 1, 'exactly one create_insight request');
  assert.equal(fake.calls[0]?.name, 'create_insight');
  const args = (fake.calls[0]?.arguments ?? {}) as Record<string, unknown>;
  assert.deepEqual({ ...args, idempotency_key: 'op' }, saveArgs('op'));
  const row = h.store.transaction(tx => tx.get('SELECT state,insight_id FROM vault_writes', []));
  assert.equal(row?.['state'], 'confirmed');
  assert.equal(row?.['insight_id'], '7');
  const event = h.events.at(-1);
  assert.deepEqual(event, { event: 'vault_write', tool: 'create_insight', outcome: 'created', insight_id_prefix: '7' },
    'the attempt is logged by closed shape: the tool, the outcome and an id prefix, never the note');
  assert.ok(!JSON.stringify(event).includes(NOTE), 'the host event carries no note text');
  assert.deepEqual(safeEvent(event), event, 'the event passes the host log allowlist');
});



test('an admitted task operation freezes its first payload and refuses a second write in the same owner turn', async t => {
  const fake = await fakeLux(t, 'inserted');
  const h = harness(t, fake.url);
  // Authority admitted this operation. The owner turn is the write key, so a second write in it is refused outright.
  const first = await save(h, 'the boat survey is on Wednesday');
  assert.deepEqual(first, { disposition: 'created', insight_id: 7 }, 'the note she keeps reaches the vault');
  assert.equal(fake.calls.length, 1, 'one row is claimed once');
  const again = await save(h, 'The boat survey, is on TUESDAY');
  assert.deepEqual(again, { disposition: 'refused', reason: 'one write per owner turn' }, 'the same authorization is never sent twice');
  const after = await save(h, NOTE, '3');
  assert.deepEqual(after, { disposition: 'created', insight_id: 7 }, 'a fresh owner turn writes again');
  assert.equal(fake.calls.length, 2, 'two turns, two requests');
  assert.equal(String((fake.calls[0]?.arguments as Record<string, unknown>)['content']).includes('Wednesday'), true, 'the frozen row keeps the first words');
});

test('a dispatched helper row at host start becomes uncertain and is never re-sent', async t => {
  const fake = await fakeLux(t, 'inserted');
  const h = harness(t, fake.url);
  // The helper row is keyed by the owner turn, so it is seeded on the turn this test writes.
  h.store.transaction(tx => tx.run("INSERT INTO vault_writes(op_id,live_session_id,utterance_id,operation,content,content_key,title,state,created_at) VALUES ('op-old',?,'helper:2','create_insight',?,'old note','old note','dispatched',?)",
    [SESSION, 'old note', NOW - 5000]));
  const events: Record<string, unknown>[] = [];
  new VaultWriter({ store: h.store, transport: createLuxWriteTransport({ url: fake.url }), now: () => NOW, log: event => { events.push(event); } });
  const row = h.store.transaction(tx => tx.get("SELECT state FROM vault_writes WHERE op_id='op-old'", []));
  assert.equal(row?.['state'], 'uncertain', 'a dispatched row at startup is never trusted');
  const receipt = await save(h, 'old note');
  assert.deepEqual(receipt, { disposition: 'refused', reason: 'one write per owner turn' });
  assert.equal(fake.calls.length, 0, 'an uncertain row is never re-sent');
});

test('a dropped call has no confirmed receipt, is outcome_unknown, and never retries', async t => {
  const fake = await fakeLux(t, 'drop');
  const h = harness(t, fake.url);
  const receipt = await save(h, NOTE);
  assert.deepEqual(receipt, { disposition: 'refused', reason: 'outcome_unknown' });
  assert.equal(fake.calls.length, 1, 'exactly one request, no retry');
});

test('a refused vault call is outcome_unknown after exactly one request', async t => {
  const fake = await fakeLux(t, 'fail');
  const h = harness(t, fake.url);
  const receipt = await save(h, NOTE);
  assert.deepEqual(receipt, { disposition: 'refused', reason: 'outcome_unknown' });
  assert.equal(fake.calls.length, 1);
});

test('a duplicate is reported as a duplicate, never as a new save', async t => {
  const fake = await fakeLux(t, 'duplicate');
  const h = harness(t, fake.url);
  const receipt = await save(h, NOTE);
  assert.deepEqual(receipt, { disposition: 'duplicate_of', insight_id: 7 }, 'the daemon says it already held this note');
  assert.equal(fake.calls.length, 1);
});

test('the write surface is one tool and no other remote name exists', async () => {
  assert.equal(LUX_TOOLS.create, 'create_insight');
  // The fixed read allowlist is gone: discovery publishes the reads, so the retired spellings are the only guard.
  const { LUX_WRITE_TOOLS, LUX_RETIRED_TOOLS } = await import('../connectors/lux-names.js');
  for (const retired of LUX_RETIRED_TOOLS) assert.ok(!(LUX_WRITE_TOOLS as readonly string[]).includes(retired), `${retired} is retired, never a write the helper holds`);
  const client = await import('../adapters/lux-write/client.js');
  assert.deepEqual(Object.keys(client).sort(), ['createLuxWriteTransport', 'luxWriteEndpoint'],
    'the write client exposes one transport factory, and no per-tool door');
  const service = await import('../tools/vault-write.js');
  for (const forbidden of ['delete_insight', 'purge_insight', 'update_insight', 'link_insight']) {
    assert.equal((service as Record<string, unknown>)[forbidden], undefined, `${forbidden} is not a door the write service holds`);
  }
  assert.deepEqual(service.VAULT_WRITE_IDENTITY, { name: 'save_to_vault', accountId: 'gateway:live-voice', resourceId: 'owner-vault' },
    'the write tool is the gateway’s own, not a remote declaration');
});

test('the persisted content key ignores case, spacing and punctuation', () => {
  assert.equal(vaultContentKey(' The boat survey, is on Tuesday. '), vaultContentKey(NOTE));
});

const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

/** The shipped adapter journals deltas (finished 0) and one empty finished transcription; a boundary test must too. */
test('the adapter-shaped transcript never mints a legacy dictation write authorization', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-boundary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  t.after(() => store.close());
  const ctx: LiveContext = { clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch };
  const fake = fakeLiveVoicePort();
  const profile = validateLiveProfile({
    provider: 'gemini', liveModelId: 'models/vault-write-test', voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: 'models/vault-write-test', dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    limits: { handshakeMs: 1000, idleMs: 600_000, sessionMs: 1_200_000, closeMs: 50 },
  });
  const owner = createLiveSessionOwner({ createTaskRuntime: syntheticTaskFactory(store), store, voice: fake.port, profile, now: () => NOW, timeZone: 'UTC',
    schedule: () => ({ unref: () => undefined, cancel: () => undefined }) });
  const session = owner.create({ idempotencyKey: randomUUID(), inputClass: 'ordinary' }, ctx);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, ctx);
  await attachment.ready;
  const drained = (async () => { for await (const chunk of attachment.output) void chunk; })();
  const emit = async (event: Parameters<typeof fake.emit>[0]) => { fake.emit(event); await flush(); };
  const rows = () => store.transaction(tx => tx.all('SELECT content,content_key,state FROM vault_writes WHERE live_session_id=?', [session.liveSessionId]));

  await emit({ type: 'inputTranscription', text: 'save to my vault: the boat ', finished: false });
  await emit({ type: 'inputTranscription', text: 'survey is on Tuesday', finished: false });
  assert.equal(rows().length, 0, 'a delta alone is not an owner turn');
  await emit({ type: 'inputTranscription', text: '', finished: true });
  assert.equal(rows().length, 0, 'a finalized save request is not a legacy vault-write authorization');
  await emit({ type: 'inputTranscription', text: '', finished: true });
  assert.equal(rows().length, 0, 'a blank final cannot mint a legacy authorization');
  await emit({ type: 'inputTranscription', text: 'what is the weather', finished: false });
  await emit({ type: 'inputTranscription', text: '', finished: true });
  assert.equal(rows().length, 0, 'an ordinary owner turn cannot mint a legacy authorization');
  owner.text('save to my vault: the typed note');
  await flush();
  assert.equal(rows().length, 0, 'typed text cannot mint a legacy authorization');
  await emit({ type: 'inputTranscription', text: '', finished: true });
  assert.equal(rows().length, 0, 'a blank turn never carries typed words forward');

  attachment.close();
  await drained;
});

// W5 (C-LUX-SAVE-LANDS Q-05): the owner's ask and its referent arrived as two transcribed fragments
// ("Can you, can you" / "store it in Lux Knowledge"), and the old referent rule took the request's own
// words as the note. A request fragment is never content, and with no referent nothing is authorized.




test('the exact note supplied by an admitted task is the persisted content', async t => {
  const fake = await fakeLux(t, 'inserted');
  const h = harness(t, fake.url);
  assert.equal((await save(h, 'the survey boat is moored at pontoon three')).disposition, 'created');
  const rows = h.store.transaction(tx => tx.all('SELECT content FROM vault_writes'));
  const persisted = JSON.parse(String(rows[0]?.['content'])) as Record<string, unknown>;
  assert.match(String(persisted['content']), /^the survey boat is moored at pontoon three\n\nProvenance: lux-didi; speaker=owner/, 'the exact note is kept, then its provenance');
});


// Upstream src/lux_knowledge/server.py:517, schema SHA256
// cdd259f3d686f24298ed6444880930a0648590730890fe27c98bc9329c7c38a1.
// SaveInsightResult in core.py declares insight_id: int | None.

/** One in-process lux wire: initialize, initialized, the daemon's discovery, then the tool call. */
function luxFetch(options: { tools?: unknown[]; callResult?: unknown; onCall?: (method: string) => Response | undefined } = {}) {
  const calls: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const call = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(call);
    const headers = { 'content-type': 'application/json', 'mcp-session-id': 'synthetic-session' };
    const override = options.onCall?.(String(call['method']));
    if (override) return override;
    if (call['method'] === 'notifications/initialized') return new Response(null, { status: 202, headers });
    const result = call['method'] === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} }
      : call['method'] === 'tools/list' ? { tools: options.tools ?? [discoveredCreate()] }
        : options.callResult ?? { content: [{ type: 'text', text: JSON.stringify({ disposition: 'created', insight_id: 81, candidates: [] }) }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call['id'], result }), { headers });
  };
  return { calls, fetchImpl };
}
function discoveredCreate() {
  return { name: 'create_insight', description: 'Create an insight', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: { type: 'object', required: ['content', 'insight_title'], properties: { content: { type: 'string', minLength: 1 }, insight_title: { type: 'string' } } } };
}
test('C-LUXSAVE11 W12-R1: outbound save obeys the upstream schema and accepts its numeric receipt', async () => {
  const { calls, fetchImpl } = luxFetch();
  const transport = createLuxWriteTransport({ url: 'http://127.0.0.1:12345/mcp' }, fetchImpl);
  const result = await transport.write('create_insight', { content: 'Synthetic candidate.', insight_title: 'Synthetic title' });
  const call = calls.find(entry => entry['method'] === 'tools/call');
  assert.ok(call);
  const params = call['params'] as { name: string; arguments: Record<string, unknown> };
  assert.equal(params.name, 'create_insight');
  // The caller's own keys travel unchanged: the discovered schema is the only shape decided here.
  assert.deepEqual(params.arguments, { content: 'Synthetic candidate.', insight_title: 'Synthetic title' });
  assert.deepEqual(result, { disposition: 'created', insight_id: 81, candidates: [] }, 'a numeric receipt is accepted as the daemon sent it');
});


for (const phase of ['initialize_http', 'initialize_transport', 'initialized_notify', 'endpoint_rejected', 'call_http', 'call_transport', 'schema_rejected'] as const) {
  test(`C-LUXSAVE11 W12-R4: ${phase} is a closed host diagnostic with a paired successful save`, async () => {
    for (const refuse of [true, false]) {
      const events: unknown[] = [];
      const detach = attachHostLogSink({ event: event => events.push(event) });
      try {
        const fakeFetch: typeof fetch = async (_url, init) => {
          const call = JSON.parse(String(init?.body)) as { method: string; id?: number };
          if (refuse && ((phase === 'initialize_transport' && call.method === 'initialize')
            || (phase === 'initialized_notify' && call.method === 'notifications/initialized')
            || (phase === 'call_transport' && call.method === 'tools/call'))) throw Error('synthetic transport failure');
          if (refuse && ((phase === 'initialize_http' && call.method === 'initialize')
            || (phase === 'call_http' && call.method === 'tools/call'))) return new Response(null, { status: 503 });
          const headers = { 'content-type': 'application/json', 'mcp-session-id': 'synthetic-session' };
          if (call.method === 'notifications/initialized') return new Response(null, { status: 202, headers });
          const result = call.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} }
            : call.method === 'tools/list' ? { tools: refuse && phase === 'schema_rejected' ? [{ name: 'create_insight', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }] : [discoveredCreate()] }
              : { content: [{ type: 'text', text: JSON.stringify({ disposition: 'created', insight_id: 81 }) }] };
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }), { headers });
        };
        const transport = createLuxWriteTransport({ url: refuse && phase === 'endpoint_rejected'
          ? 'https://example.invalid/mcp' : 'http://127.0.0.1:12345/mcp' }, fakeFetch);
        const result = await transport.write('create_insight', { content: 'Synthetic body.', insight_title: 'Synthetic' });
        const diagnostics = events.filter(event => event && typeof event === 'object' && (event as { event?: string }).event === 'vault_transport');
        if (refuse) {
          // Every refused phase is a closed refusal with its own reason; nothing is retried above the wire.
          assert.equal(result.disposition, 'refused');
          assert.equal(result.reason, ['initialize_http', 'initialize_transport', 'initialized_notify', 'endpoint_rejected'].includes(phase) ? 'transport_unavailable'
            : phase === 'call_transport' ? 'outcome_unknown' : phase === 'schema_rejected' ? 'tool_missing_or_forbidden' : 'outcome_unknown');
          assert.deepEqual(diagnostics, [{ event: 'vault_transport', phase }]);
          assert.deepEqual(safeEvent(diagnostics[0]), { event: 'vault_transport', phase });
          assert.equal(safeEvent({ event: 'vault_transport', phase, url: 'synthetic private value' }), undefined);
        } else {
          assert.deepEqual(result, { disposition: 'created', insight_id: 81 });
          assert.deepEqual(diagnostics, []);
        }
      } finally { detach(); }
    }
  });
}

test('C-LUXSAVE11 W12-R4: arbitrary transport phases cannot enter host.log', () => {
  assert.equal(safeEvent({ event: 'vault_transport', phase: 'arbitrary model text' }), undefined);
});

test('startup claims an authorized operation by its execution identity exactly once', async t => {
  const h = harness(t, 'http://127.0.0.1:1');
  h.store.transaction(tx => tx.run("INSERT INTO vault_writes(op_id,live_session_id,utterance_id,operation,content,content_key,title,state,created_at) VALUES ('restart-op',?,'restart',?,?,?,?, 'authorized',?)", [SESSION, LUX_TOOLS.create, NOTE, vaultContentKey(NOTE), NOTE, NOW]));
  const calls: string[] = [];
  const options = { store: h.store, now: () => NOW, log: () => {},
    transport: { save: async (args: { content: string }) => { calls.push(args.content); return { outcome: 'inserted' as const, insightId: '7' }; },
      write: async () => ({ disposition: 'created', insight_id: 7 }) } };
  const restarted = new VaultWriter(options);
  await restarted.recovery;
  await new VaultWriter(options).recovery;
  assert.equal(calls.length, 1);
  assert.match(String(calls[0]), /^the boat survey is on Tuesday\n\nProvenance: lux-didi/, 'the recovered note keeps its exact words, then its provenance');
  assert.equal(h.store.transaction(tx => tx.get('SELECT state FROM vault_writes WHERE utterance_id=?', ['restart']))?.state, 'confirmed');
});

test('an unavailable legacy dispatch settles uncertain and leaves the one retry to startup', async t => {
  const h = harness(t, 'http://127.0.0.1:1');
  const row = h.store.transaction(tx => authorizeComposedWrite(tx, { liveSessionId: SESSION, stageId: 'retry-dispatch', content: NOTE, title: NOTE, now: NOW }));
  let calls = 0;
  const writer = new VaultWriter({ store: h.store, now: () => NOW, log: () => {},
    backoff: async () => {},
    transport: { save: async () => { calls++; return { outcome: 'unavailable' as const }; } } });
  await writer.dispatch({ opId: String((row as Record<string, unknown>)['op_id']), content: NOTE, title: NOTE });
  assert.equal(calls, 1, 'one attempt in the request, never a silent second');
  const settled = h.store.transaction(tx => tx.get("SELECT state,retry_count FROM vault_writes WHERE utterance_id='retry-dispatch'"));
  assert.equal(settled?.['state'], 'uncertain', 'an unreachable vault leaves the outcome unconfirmed');
  assert.equal(settled?.['retry_count'], 0, 'the startup recovery owns the single retry');
});

test('startup retries a legacy unavailable row only once across restarts', async t => {
  const h = harness(t, 'http://127.0.0.1:1');
  h.store.transaction(tx => authorizeComposedWrite(tx, { liveSessionId: SESSION, stageId: 'legacy-unavailable', content: NOTE, title: NOTE, now: NOW }));
  h.store.transaction(tx => tx.run("UPDATE vault_writes SET state='failed',code='vault_unavailable'"));
  let calls = 0;
  const delays: number[] = [];
  const options = { store: h.store, now: () => NOW, log: () => {}, backoff: async (ms: number) => { delays.push(ms); },
    transport: { save: async () => { calls++; return { outcome: 'inserted' as const, insightId: '8' }; },
      write: async () => ({ disposition: 'created', insight_id: 8 }) } };
  await new VaultWriter(options).recovery;
  await new VaultWriter(options).recovery;
  assert.equal(calls, 1);
  assert.deepEqual(delays, [250]);
  assert.equal(h.store.transaction(tx => tx.get("SELECT state FROM vault_writes WHERE utterance_id='legacy-unavailable'"))?.state, 'confirmed');
});

test('live migration 16 preserves old vault receipts and permits all new write operations', t => {
  const directory = mkdtempSync(join(tmpdir(), 'vault-v16-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const old = new Store(directory, liveMigrations.filter(migration => migration.owner !== 'live' || migration.version < 16));
  old.transaction(tx => tx.run("INSERT INTO vault_writes(op_id,live_session_id,utterance_id,operation,content,content_key,title,state,created_at,insight_id) VALUES('old','synthetic','old','save_insight','synthetic','synthetic','Synthetic','confirmed',1,'42')"));
  old.close();
  const migrated = new Store(directory, liveMigrations);
  t.after(() => migrated.close());
  const row = migrated.transaction(tx => tx.get("SELECT operation,insight_id,state FROM vault_writes WHERE op_id='old'"));
  assert.deepEqual({ ...row }, { operation: 'create_insight', insight_id: '42', state: 'confirmed' });
  migrated.transaction(tx => {
    for (const operation of ['create_insight', 'update_insight', 'create_insight_link', 'record_search_feedback']) tx.run('INSERT INTO vault_writes(op_id,live_session_id,utterance_id,operation,content,content_key,title,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [operation, 'synthetic', operation, operation, 'synthetic', 'synthetic', 'Synthetic', 'authorized', 1]);
    assert.throws(() => tx.run("INSERT INTO vault_writes(op_id,live_session_id,utterance_id,operation,content,content_key,title,state,created_at) VALUES('forbidden','synthetic','forbidden','purge_insight','synthetic','synthetic','Synthetic','authorized',1)"));
  });
});
