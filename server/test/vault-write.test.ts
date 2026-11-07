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
import { LUX_KNOWLEDGE_TOOLS } from '../connectors/lux-knowledge.js';
import { safeEvent } from '../host/log.js';
import { liveMigrations } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { VaultWriter, authorizeComposedWrite, vaultContentKey, type VaultReceipt } from '../tools/vault-write.js';

const NOW = 1_700_000_000_000;
const SESSION = 'live-vault-write';
const NOTE = 'the boat survey is on Tuesday';


interface Harness { store: Store; writer: VaultWriter; events: Record<string, unknown>[] }

function harness(t: TestContext, url: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'vault-write-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, [...liveMigrations]);
  t.after(() => store.close());
  const events: Record<string, unknown>[] = [];
  const writer = new VaultWriter({ store, backoff: async () => {}, transport: createLuxWriteTransport({ url }), now: () => NOW, log: event => { events.push(event); } });
  return { store, writer, events };
}

const SPOKEN_AT = new Date(NOW).toISOString();
/** The write carries its provenance and an idempotency key; the key is the op id, minted per op. */
const saveArgs = (key: unknown) => ({ content: NOTE, insight_title: NOTE, insight_type: 'UNCATEGORIZED', project: 'didi-voice',
  source_kind: 'voice_call', source_ref: { app: 'lux-didi', session_id: SESSION, turn_start_id: 'task:vault-task:save', turn_end_id: 'task:vault-task:save', spoken_at: SPOKEN_AT }, idempotency_key: key });

async function save(h: Harness, content: string): Promise<VaultReceipt> {
  return h.writer.saveTask({ sessionId: SESSION, identity: { task_id: 'vault-task', task_revision: 1, operation_id: 'save', connection_generation: 1 }, content, title: content, outsideTextSeen: false });
}

test('an authorized task saves its exact words once under the vault project', async t => {
  const fake = await fakeLux(t, 'inserted');
  const h = harness(t, fake.url);
  assert.deepEqual(await save(h, NOTE), { saved: true, insightId: '7' });
  const args = (fake.calls[0]?.arguments ?? {}) as Record<string, unknown>;
  assert.equal(typeof args['idempotency_key'], 'string');
  assert.deepEqual({ ...args, idempotency_key: 'op' }, saveArgs('op'));
  assert.equal(fake.calls[0]?.name, 'create_insight');
});

test('an empty authorized task payload writes nothing and returns an honest invalid-payload receipt', async t => {
  const fake = await fakeLux(t, 'inserted'); const h = harness(t, fake.url);
  assert.deepEqual(await save(h, ''), { saved: false, code: 'write_failed', guidance: 'The note payload was invalid. Nothing was written.' });
  assert.equal(fake.calls.length, 0);
});

test('an unreachable vault is logged as unavailable with its closed code', async t => {
  const h = harness(t, 'http://127.0.0.1:1/mcp');
  assert.deepEqual(await save(h, NOTE), { saved: false, code: 'vault_unavailable', guidance: 'Retried lux once. the vault is not reachable right now' });
  const attempt = h.events.at(-1);
  assert.equal(attempt?.['state'], 'unavailable');
  assert.equal(attempt?.['code'], 'vault_unavailable');
});

test('a dictated note reaches the vault once, and only the vault id comes back', async t => {
  const fake = await fakeLux(t, 'inserted');
  const h = harness(t, fake.url);
  const receipt = await save(h, NOTE);
  assert.deepEqual(receipt, { saved: true, insightId: '7' });
  assert.equal(fake.calls.length, 1, 'exactly one save_insight request');
  assert.equal(fake.calls[0]?.name, 'create_insight');
  const args = (fake.calls[0]?.arguments ?? {}) as Record<string, unknown>;
  assert.deepEqual({ ...args, idempotency_key: 'op' }, saveArgs('op'));
  const row = h.store.transaction(tx => tx.get('SELECT state,insight_id FROM vault_writes', []));
  assert.equal(row?.['state'], 'confirmed');
  assert.equal(row?.['insight_id'], '7');
  const event = h.events.at(-1);
  assert.equal(event?.['event'], 'vault_write');
  assert.equal(event?.['state'], 'confirmed');
  assert.equal(event?.['insightId'], '7');
  assert.ok(Number.isSafeInteger(event?.['latencyMs']));
  assert.ok(!JSON.stringify(event).includes(NOTE), 'the host event carries no note text');
  assert.deepEqual(safeEvent(event), event, 'the event passes the host log allowlist');
});



test('an admitted task operation freezes its first payload and repeats read the same outcome', async t => {
  const fake = await fakeLux(t, 'inserted');
  const h = harness(t, fake.url);
  // Authority admitted this operation. The writer freezes its exact payload and owns replay, not owner-language classification.
  const paraphrase = await save(h, 'the boat survey is on Wednesday');
  assert.equal(paraphrase.saved, true, 'the note she keeps reaches the vault');
  assert.equal(fake.calls.length, 1, 'one row is claimed once');
  const first = await save(h, NOTE);
  assert.equal(first.saved, true);
  const again = await save(h, 'The boat survey, is on TUESDAY');
  assert.deepEqual(again, { saved: true, insightId: '7' }, 'the stored outcome, past case, spacing and punctuation');
  assert.equal(fake.calls.length, 1, 'the same authorization is never sent twice');
  const after = await save(h, NOTE);
  assert.deepEqual(after, { saved: true, insightId: '7' }, 'different replay arguments do not change the first frozen operation');
  assert.equal(fake.calls.length, 1, 'and it still sends nothing');
});

test('a dispatched row at host start becomes uncertain and is never re-sent', async t => {
  const fake = await fakeLux(t, 'inserted');
  const h = harness(t, fake.url);
  h.store.transaction(tx => tx.run("INSERT INTO vault_writes(op_id,live_session_id,utterance_id,operation,content,content_key,title,state,created_at) VALUES ('op-old',?,'task:vault-task:save','create_insight',?,'old note','old note','dispatched',?)",
    [SESSION, 'old note', NOW - 5000]));
  const events: Record<string, unknown>[] = [];
  new VaultWriter({ store: h.store, transport: createLuxWriteTransport({ url: fake.url }), now: () => NOW, log: event => { events.push(event); } });
  const row = h.store.transaction(tx => tx.get("SELECT state FROM vault_writes WHERE op_id='op-old'", []));
  assert.equal(row?.['state'], 'uncertain');
  const receipt = await save(h, 'old note');
  assert.deepEqual(receipt, { saved: false, code: 'outcome_unknown', guidance: 'I am not sure it landed, check the vault' });
  assert.equal(fake.calls.length, 0, 'an uncertain row is never re-sent');
});

test('a dropped call has no confirmed receipt, is outcome_unknown, and never retries', async t => {
  const fake = await fakeLux(t, 'drop');
  const h = harness(t, fake.url);
  const receipt = await save(h, NOTE);
  assert.deepEqual(receipt, { saved: false, code: 'outcome_unknown', guidance: 'I am not sure it landed, check the vault' });
  assert.equal(fake.calls.length, 1, 'exactly one request, no retry');
});

test('a 503 is write_failed after exactly one request', async t => {
  const fake = await fakeLux(t, 'fail');
  const h = harness(t, fake.url);
  const receipt = await save(h, NOTE);
  assert.deepEqual(receipt, { saved: false, code: 'write_failed', guidance: 'I could not confirm that the vault saved the note; do not retry it automatically' });
  assert.equal(fake.calls.length, 1);
});

test('a duplicate refusal is never reported as saved', async t => {
  const fake = await fakeLux(t, 'duplicate');
  const h = harness(t, fake.url);
  const receipt = await save(h, NOTE);
  assert.deepEqual(receipt, { saved: false, code: 'write_failed', guidance: 'I could not confirm that the vault saved the note; do not retry it automatically' });
  assert.equal(fake.calls.length, 1);
});

test('the write surface is one tool and no other remote name exists', async () => {
  assert.equal(LUX_TOOLS.create, 'create_insight');
  for (const tool of LUX_KNOWLEDGE_TOOLS) assert.ok(!/^(save|delete|purge|update|link)_insight$/.test(tool));
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
  assert.equal((await save(h, 'the survey boat is moored at pontoon three')).saved, true);
  const rows = h.store.transaction(tx => tx.all('SELECT content FROM vault_writes'));
  assert.deepEqual(rows.map(row => row['content']), ['the survey boat is moored at pontoon three']);
});


// Upstream src/lux_knowledge/server.py:517, schema SHA256
// cdd259f3d686f24298ed6444880930a0648590730890fe27c98bc9329c7c38a1.
// SaveInsightResult in core.py declares insight_id: int | None.
test('C-LUXSAVE11 W12-R1: outbound save obeys the upstream schema and accepts its numeric receipt', async () => {
  const calls: Record<string, unknown>[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    const call = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(call);
    const headers = { 'content-type': 'application/json', 'mcp-session-id': 'synthetic-session' };
    if (call['method'] === 'notifications/initialized') return new Response(null, { status: 202, headers });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call['id'], result: call['method'] === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: {} }
      : { content: [{ type: 'text', text: JSON.stringify({ disposition: 'created', insight_id: 81, candidates: [] }) }] } }), { headers });
  };
  const transport = createLuxWriteTransport({ url: 'http://127.0.0.1:12345/mcp' }, fakeFetch);
  const result = await transport.save({ content: 'Synthetic candidate.', title: 'Synthetic title', insightType: 'UNCATEGORIZED', project: 'didi-voice' });
  const call = calls.find(entry => entry['method'] === 'tools/call');
  assert.ok(call);
  const params = call['params'] as { name: string; arguments: Record<string, unknown> };
  assert.equal(params.name, 'create_insight');
  // Required and optional names from the unmodified upstream signature, no invented metadata argument.
  const required = ['content', 'insight_title', 'insight_type'];
  const allowed = [...required, 'project', 'force'];
  assert.ok(required.every(key => key in params.arguments));
  assert.ok(Object.keys(params.arguments).every(key => allowed.includes(key)));
  for (const key of ['content', 'insight_title', 'insight_type', 'project']) assert.equal(typeof params.arguments[key], 'string');
  assert.ok(['TECHNICAL_DECISION', 'BUG_GOTCHA', 'PATTERN', 'MEETING', 'USER_PREFERENCE', 'PROJECT_CONSTRAINT', 'UNCATEGORIZED'].includes(String(params.arguments['insight_type'])));
  assert.deepEqual(result, { outcome: 'inserted', insightId: '81' });
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
            : { content: [{ type: 'text', text: JSON.stringify(refuse && phase === 'schema_rejected'
              ? { unrelated: true } : { disposition: 'created', insight_id: 81 }) }] };
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }), { headers });
        };
        const transport = createLuxWriteTransport({ url: refuse && phase === 'endpoint_rejected'
          ? 'https://example.invalid/mcp' : 'http://127.0.0.1:12345/mcp' }, fakeFetch);
        const result = await transport.save({ title: 'Synthetic', content: 'Synthetic body.', insightType: 'UNCATEGORIZED', project: 'didi-voice' });
        const diagnostics = events.filter(event => event && typeof event === 'object' && (event as { event?: string }).event === 'vault_transport');
        if (refuse) {
          // A pre-dispatch refusal is unavailable, a dropped call after the send is unknown, and a refused wire is failed.
          assert.equal(result.outcome, ['initialize_http', 'initialize_transport', 'initialized_notify'].includes(phase) ? 'unavailable'
            : phase === 'call_transport' ? 'unknown' : 'failed');
          assert.deepEqual(diagnostics, [{ event: 'vault_transport', phase }]);
          assert.deepEqual(safeEvent(diagnostics[0]), { event: 'vault_transport', phase });
          assert.equal(safeEvent({ event: 'vault_transport', phase, url: 'synthetic private value' }), undefined);
        } else {
          assert.deepEqual(result, { outcome: 'inserted', insightId: '81' });
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
    transport: { save: async (args: { content: string }) => { calls.push(args.content); return { outcome: 'inserted' as const, insightId: 'restart-7' }; } } };
  const restarted = new VaultWriter(options);
  await restarted.recovery;
  await new VaultWriter(options).recovery;
  assert.deepEqual(calls, [NOTE]);
  assert.equal(h.store.transaction(tx => tx.get('SELECT state FROM vault_writes WHERE utterance_id=?', ['restart']))?.state, 'confirmed');
});

test('unavailable retries once with backoff and then confirms without a duplicate', async t => {
  const h = harness(t, 'http://127.0.0.1:1');
  let calls = 0;
  const delays: number[] = [];
  const writer = new VaultWriter({ store: h.store, now: () => NOW, log: () => {},
    backoff: async ms => { delays.push(ms); },
    transport: { save: async () => ++calls === 1 ? { outcome: 'unavailable' } : { outcome: 'inserted', insightId: 'retry-7' } } });
  const input = { sessionId: SESSION, identity: { task_id: 'retry-task', task_revision: 1, operation_id: 'save', connection_generation: 1 }, content: NOTE, title: NOTE, outsideTextSeen: false };
  const result = await writer.saveTask(input);
  assert.equal(result.saved, true);
  assert.match(String(result.guidance), /retried.*lux/i);
  assert.deepEqual(delays, [250]);
  assert.equal(calls, 2);
  assert.deepEqual(await writer.saveTask(input), { saved: true, insightId: 'retry-7' }); assert.equal(calls, 2, 'replay does not send a third request');
});

test('startup retries a legacy unavailable row only once across restarts', async t => {
  const h = harness(t, 'http://127.0.0.1:1');
  h.store.transaction(tx => authorizeComposedWrite(tx, { liveSessionId: SESSION, stageId: 'legacy-unavailable', content: NOTE, title: NOTE, now: NOW }));
  h.store.transaction(tx => tx.run("UPDATE vault_writes SET state='failed',code='vault_unavailable'"));
  let calls = 0;
  const delays: number[] = [];
  const options = { store: h.store, now: () => NOW, log: () => {}, backoff: async (ms: number) => { delays.push(ms); },
    transport: { save: async () => { calls++; return { outcome: 'inserted' as const, insightId: 'recovered-7' }; } } };
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
