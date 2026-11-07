// W13: the capture gate admits every read tool its connector module publishes. A person read refused
// here is an answer the host throws away (LOGS.md L-03: 3 of 3 Mattermost person resolves ended in
// `unsupported_source_tool` while the child had answered), so the gate's admitted list and the module
// read lists are asserted together: a tool added to a connector can never be silently refused again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { hostMigrations } from '../host/runtime.js';
import { createDispatchOwner, SOURCE_TOOL_GATE } from '../tools/dispatch.js';
import { CONNECTOR_ENVELOPES } from '../connectors/index.js';
import { MATTERMOST_PERSON_TOOLS } from '../connectors/mattermost.js';
import { sha256 } from '../tools/canonical.js';

const RUN = 'run:w13';
const ENDPOINT = { id: 'mattermost-synthetic', url: 'https://mattermost.example.invalid/mcp', account: 'synthetic-account', resource: 'mattermost', credentialRef: null };
const SCHEMA_DIGEST = 'synthetic-schema-digest';
const DECODED = { content: [{ type: 'text', text: 'synthetic' }], isError: false };
const WIRE = JSON.stringify(DECODED);
const WIRE_SHA256 = createHash('sha256').update(WIRE).digest('hex');
const WIRE_BYTES = Buffer.byteLength(WIRE);

function port(refusal?: { state: 'refused' | 'unknown'; reason: string }) {
  const expiresAt = Date.now() + 60_000;
  return {
    async call(request: { endpointId: string; toolName: string; generation: number; account: string; resource: string }) {
      if (refusal) return refusal;
      return {
        state: 'completed' as const, decodedResult: DECODED,
        payload: { state: 'available' as const, handle: 'synthetic', sha256: WIRE_SHA256, byteLength: WIRE_BYTES, expiresAt, encoding: 'http-response-entity' as const },
        source: { endpointId: request.endpointId, toolName: request.toolName, url: ENDPOINT.url, generation: request.generation, account: request.account, resource: request.resource, schemaDigest: SCHEMA_DIGEST },
        coverage: { completeCorpus: false, basis: 'single-tool-result', remoteSideEffects: 'unverified' },
        projection: {}, freshness: { receivedAt: Date.now() }, receivedAt: Date.now(),
      };
    },
    readSlice() { return { state: 'available' as const, bytes: new TextEncoder().encode(WIRE), byteLength: WIRE_BYTES, sha256: WIRE_SHA256, expiresAt }; },
  };
}

/** The live-session history row the gate's content classification reads; without it the gate refuses to classify and the reason is masked. */
function seedClassifiedSession(store: Store): void {
  store.transaction(tx => {
    tx.run('INSERT INTO live_sessions(live_session_id,owner_assistant_id,authority_epoch,idempotency_key,fingerprint,client_id,audit_id,profile_identity,prompt_identity,lifecycle,dispatch_intent,ready,journal_events,journal_bytes,journal_complete,consumer_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [RUN, store.assistantId, store.authorityEpoch, 'synthetic-key', 'synthetic-fingerprint', 'synthetic-client', 'synthetic-audit', 'synthetic-profile', 'synthetic-prompt', 'active', 0, 1, 0, 0, 1, 'attached', 0, 0]);
    tx.run('INSERT INTO history_sessions(live_session_id,owner_id,data_class,revision,created_at) VALUES(?,?,?,?,?)', [RUN, store.assistantId, 'ordinary', 1, 0]);
  });
}

/** One real capture-gate dispatch of `toolName` for a connector whose published read list is `toolNames`. */
async function dispatchThroughGate(store: Store, connector: string, toolNames: readonly string[], toolName: string,
  options: { arguments?: Record<string, unknown>; refusal?: { state: 'refused' | 'unknown'; reason: string } } = {}): Promise<Record<string, unknown>> {
  const executionId = `exec:${connector}:${toolName}`;
  store.transaction(tx => { tx.run("INSERT INTO tool_calls(owner_id,run_id,execution_id,intent_json,state) VALUES(?,?,?,?,'intent')", [store.assistantId, RUN, executionId, '{}']); });
  const owner = createDispatchOwner({ store, port: port(options.refusal) as never, ownerId: store.assistantId, current: () => true, failure: () => {} });
  const policy = {
    schemaVersion: 1 as const, ownerId: store.assistantId, connectionId: connector, generation: 1, enabled: true, connector,
    endpoint: ENDPOINT, toolNames, schemaDigest: SCHEMA_DIGEST,
    sourcePolicy: { id: 'owner-trusted-reads', revision: 1, unknownClass: 'ordinary' as const, allowedClasses: ['ordinary'] as const },
    route: { identity: 'synthetic-owner', allowedClasses: ['ordinary'] as const },
    bounds: { maxQueryChars: 80, maxSearchLimit: 50, maxGetIds: 50, maxEntityBytes: 4096, maxResultBytes: 4096 },
  };
  const bound = { connectionId: connector, generation: 1, sha256: 'a'.repeat(64), policy };
  const call = { runId: RUN, actorId: 'synthetic-actor', authorityEpoch: store.authorityEpoch, revision: 1, executionId, toolName, argumentsHash: 'f'.repeat(64) };
  const request = { endpointId: ENDPOINT.id, toolName, arguments: options.arguments ?? {}, generation: 1, account: ENDPOINT.account, resource: ENDPOINT.resource };
  await owner.run({ call, bound, snapshotSha256: 'b'.repeat(64), allowedClasses: ['ordinary'] as const }, () => owner.port.call(request));
  return store.transaction(tx => tx.get('SELECT * FROM tool_dispatches WHERE tool_name=?', [toolName])) as unknown as Record<string, unknown>;
}

function openStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'didi-dispatch-gate-'));
  const store = new Store(dir, hostMigrations);
  seedClassifiedSession(store);
  return { store, dir };
}

test('a Mattermost person read is admitted by the capture gate and captured, exactly like the chat reads beside it', async () => {
  const { store, dir } = openStore();
  try {
    const envelope = CONNECTOR_ENVELOPES['mattermost']!;
    const control = await dispatchThroughGate(store, 'mattermost', envelope, 'mattermost_search');
    assert.equal(control.reason, 'captured_complete_v1', 'the control read proves this harness reaches the capture path');
    assert.equal(control.state, 'completed');
    for (const toolName of MATTERMOST_PERSON_TOOLS) {
      const row = await dispatchThroughGate(store, 'mattermost', envelope, toolName);
      assert.equal(row.reason, 'captured_complete_v1', `${toolName} must be admitted and captured, never refused as unsupported_source_tool`);
      assert.equal(row.state, 'completed');
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

// The structural half: both sides are derived from the connector modules' own exports
// (CONNECTOR_ENVELOPES maps each connector to its published read list), never a hand-copied array,
// so a tool added to any connector cannot be silently refused by the capture gate.
test('every read tool a connector module publishes is in the capture gate list', () => {
  const connectors = Object.keys(CONNECTOR_ENVELOPES);
  assert.ok(connectors.length > 0, 'the connector modules publish read envelopes');
  for (const connector of connectors) {
    const published = CONNECTOR_ENVELOPES[connector]!;
    const admitted = SOURCE_TOOL_GATE[connector] ?? [];
    assert.ok(admitted.length > 0, `${connector} publishes ${published.length} read tools but the capture gate has no list for it`);
    for (const tool of published) {
      assert.ok(admitted.includes(tool), `${connector} publishes ${tool} but the capture gate refuses it as unsupported_source_tool`);
    }
  }
});

// C-STORE-RETENTION unit D (STATE.md S-07): a connector that refuses a read names why, and the
// dispatch row must carry that code. Collapsing it into the state threw the one field a debugger
// needs when Naya's person read came back empty.
test('a refused connector read keeps the connector reason code beside its outcome', async () => {
  const { store, dir } = openStore();
  try {
    const envelope = CONNECTOR_ENVELOPES['mattermost']!;
    const row = await dispatchThroughGate(store, 'mattermost', envelope, 'mattermost_resolve_person',
      { arguments: { name: 'ada' }, refusal: { state: 'refused', reason: 'cancelled-before-dispatch' } });
    assert.equal(row.state, 'unavailable');
    assert.equal(row.source_outcome, 'refused', 'the outcome class stays the closed token it always was');
    assert.equal(row.reason, 'cancelled-before-dispatch', 'the connector own reason code survives the seal');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

// C-STORE-RETENTION unit D (STATE.md S-03): the argument record is projected per key, so one
// non-scalar value costs that value and not the whole record, and the key names are always kept.
test('a nested argument costs one value, and the sorted key names are always recorded', async () => {
  const { store, dir } = openStore();
  try {
    const envelope = CONNECTOR_ENVELOPES['mattermost']!;
    const row = await dispatchThroughGate(store, 'mattermost', envelope, 'mattermost_resolve_person',
      { arguments: { name: 'ada', nested: { deep: 1 } } });
    assert.equal(row.arguments_fidelity, 'partial_v1');
    assert.deepEqual(JSON.parse(String(row.arguments_json)), { name: 'ada' }, 'the scalar key keeps its value');
    assert.equal(row.arguments_keys, '["name","nested"]', 'the closed key vocabulary is kept whatever the values are');
    assert.equal(row.arguments_key_count, 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

// The two mongoose composite reads were published without a field-list entry, so every one of
// their dispatches read as hash_only_unsupported_v1 (S-03): the entry is what makes them complete.
test('a mattermost person resolve keeps complete argument fidelity', async () => {
  const { store, dir } = openStore();
  try {
    const envelope = CONNECTOR_ENVELOPES['mattermost']!;
    const row = await dispatchThroughGate(store, 'mattermost', envelope, 'mattermost_resolve_person', { arguments: { name: 'ada' } });
    assert.equal(row.arguments_fidelity, 'complete_v1');
    assert.deepEqual(JSON.parse(String(row.arguments_json)), { name: 'ada' });
    assert.equal(row.arguments_keys, '["name"]');
    assert.equal(row.arguments_sha256, sha256('{"name":"ada"}'), 'the identity hash is the full argument bytes');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
