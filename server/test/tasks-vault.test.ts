import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTaskPayload } from '../tasks/connectors.js';

export const vaultEnvelope = `# Knowledge Search: 'orchid watering'

_confidence: medium · mode: reranked · candidate_match: yes_ · top score: 0.45 · relevant candidate: yes · top ranker score: 0.45

_sensitive rows excluded from this search; pass include_sensitive=true to include them_

*Use get_insight(ids=[...]) to fetch full content*

**#115** [PATTERN] Orchid | Care | Watering schedule
  valid from 2026-02-01 · current
  · unknown
  Orchids are watered once a week in the shade house...
  Score: 0.518

**#89969** [TECHNICAL_DECISION] Old watering plan
  ⚠ superseded by a confirmed current replacement, retained for historical context (see #90213)
  valid from 2026-10-15 · superseded by #90213 (2026-10-17)
  Twice a week was the earlier rule...
  Score: 0.348
`;

/** The synthetic daemon's discovered reads: the annotations admit them and the schema is the declaration. */
const luxToolList = [
  { name: 'search_insights', annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer' }, detail: { type: 'string', enum: ['snippets', 'bodies', 'voice'] }, mode: { type: 'string', enum: ['fast', 'full', null], nullable: true } } } },
  { name: 'get_insight', annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', required: ['insight_ids'], properties: { insight_ids: { type: 'array', items: { type: 'integer' } }, include_links: { type: 'boolean' } } } },
];
const luxReadBinding = (policy: import('../tools/types.js').ConnectionPolicy, reader: unknown) =>
  ({ connector: 'lux-knowledge', policy, reader: { ...(reader as Record<string, unknown>), discovery: () => luxToolList } });
const twelveHitEnvelope = vaultEnvelope + Array.from({ length: 10 }, (_, index) =>
  `
**#${200 + index}** [PATTERN] Synthetic candidate ${index + 3}
  valid from 2026-02-01 · current
  Synthetic evidence for candidate ${index + 3}.
  Score: 0.500
`.padEnd(300, ' ')).join('');

test('vault semantic hits retain evidence and are successful without exact titles', () => {
  const result = projectTaskPayload('search_insights', vaultEnvelope, { query: 'orchid watering' });
  assert.equal(result.status, 'ok');
  for (const evidence of ['_confidence: medium', 'candidate_match: yes', 'sensitive rows excluded', '[PATTERN]', 'valid from 2026-02-01', 'once a week', 'Score: 0.518', 'Score: 0.348', 'superseded', '#90213']) {
    assert.ok(result.text.includes(evidence), evidence);
  }
  // The discovered payload is returned as one document now, so the ids live in its bytes, not in parsed rows.
  assert.deepEqual(result.references.map(ref => ref.id), ['search_insights']);
  assert.ok(result.text.indexOf('#115') < result.text.indexOf('#89969'));
});

test('the discovered payload is never re-read for a phrase, so its prose is not evidence of absence', () => {
  const empty = projectTaskPayload('search_insights', '# Knowledge Search\n\nNo results found.', { query: 'absent' });
  assert.equal(empty.status, 'ok', 'the daemon owns its own emptiness, the host never parses prose');
  assert.match(empty.text, /No results found/);
  assert.notEqual(projectTaskPayload('search_insights', 'upstream response missing', { query: 'absent' }).status, 'empty');
});

test('vault shaping is bounded and does not change company exact-name matching', () => {
  const result = projectTaskPayload('search_insights', vaultEnvelope + 'x'.repeat(100000), { query: 'orchid watering' });
  assert.ok(result.text.length <= 24000);
  assert.equal(projectTaskPayload('search_company', vaultEnvelope, { query: 'orchid watering' }).status, 'no_match');
});

test('the vault descriptor synthesizes no read catalogue; discovery alone publishes the reads', async () => {
  const { CONNECTOR_DESCRIPTORS } = await import('../connectors/index.js');
  const policy = { bounds: { maxSearchLimit: 25, maxGetIds: 10 } } as import('../tools/types.js').ConnectionPolicy;
  const descriptor = CONNECTOR_DESCRIPTORS['lux-knowledge']!;
  assert.deepEqual([...descriptor.envelope], [], 'no fixed read envelope survives discovery');
  assert.deepEqual(descriptor.declarations(policy), [], 'every helper declaration is the daemon own published schema');
});

test('fresh vault source defaults sensitive without widening another connector or an explicit class', async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadMcpEndpoints } = await import('../config/mcp.js');
  const dir = mkdtempSync(join(tmpdir(), 'vault-default-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { transport: 'streamable-http', url: 'https://fixture.invalid/mcp', account: 'fixture', resource: 'fixture', credentialRef: null, enabled: true, allowEgress: true };
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, endpoints: [
    { ...base, id: 'vault', connector: 'lux-knowledge' },
    { ...base, id: 'other', connector: 'synthetic' },
    { ...base, id: 'explicit', connector: 'lux-knowledge', unknownClass: 'ordinary' },
  ] }), { mode: 0o600 });
  const loaded = loadMcpEndpoints({ configDir: dir });
  assert.equal(loaded.state, 'configured');
  if (loaded.state !== 'configured') return;
  assert.equal(loaded.catalog.endpoints[0]?.unknownClass, 'sensitive');
  assert.equal(loaded.catalog.endpoints[1]?.unknownClass, null);
  assert.equal(loaded.catalog.endpoints[2]?.unknownClass, 'ordinary');
});

test('a bounded fixture helper turn reads semantic candidates and their replacement in one batch', async () => {
  const { connectorExecutor } = await import('../tasks/connectors.js');
  const { createRegistry } = await import('../tasks/tools.js');
  const { FakeAuthority } = await import('../tasks/authority.js');
  const { runWorker } = await import('../tasks/worker.js');
  const policy: import('../tools/types.js').ConnectionPolicy = {
    schemaVersion: 1, ownerId: 'fixture', connectionId: 'fixture', generation: 1, enabled: true,
    connector: 'lux-knowledge', toolNames: ['search_insights', 'get_insight'], schemaDigest: 'fixture',
    endpoint: { id: 'fixture', url: 'https://fixture.invalid/mcp', account: 'fixture', resource: 'fixture', credentialRef: null },
    sourcePolicy: { id: 'fixture', revision: 1, unknownClass: 'sensitive', allowedClasses: ['sensitive'] },
    route: { identity: 'fixture', allowedClasses: ['sensitive'] },
    bounds: { maxSearchLimit: 25, maxGetIds: 10, maxQueryChars: 4000, maxEntityBytes: 100000, maxResultBytes: 100000 },
  };
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const read = '#89969 Old watering plan\n⚠ superseded by #90213\nLinked rationale: #90213 Current watering plan\nSYNTHETIC PRIVATE ROW';
  const luxBinding = luxReadBinding(policy, { async call(tool: string, args: Record<string, unknown>) {
    seen.push({ tool, args });
    return { state: 'completed', decodedResult: tool === 'search_insights' ? twelveHitEnvelope : read } as import('../connectors/index.js').ConnectorResult;
  } }) as unknown as import('../tasks/connectors.js').BoundConnector;
  const execute = connectorExecutor([luxBinding]);
  const { configuredCompanyTools } = await import('../tasks/connectors.js');
  const registry = createRegistry({ execute, authority: new FakeAuthority() }, configuredCompanyTools([luxBinding]));
  let hop = 0, size = 0;
  const started = performance.now();
  const result = await runWorker({ registry, identity: { task_id: 'fixture-vault', task_revision: 1, connection_generation: 1 },
    input: 'orchid watering', signal: new AbortController().signal,
    infer: async request => {
      if (++hop === 1) return { text: '', calls: [{ id: 'search', name: 'search_insights', args: { query: 'orchid watering' } }] };
      if (hop === 2) {
        assert.equal(request.outputs[0]?.result.status, 'ok');
        assert.match(request.outputs[0]!.result.text, /Score: 0.518/);
        assert.equal(request.outputs[0]!.result.references.length, 1, 'the payload is one document');
        assert.equal((request.outputs[0]!.result.text.match(/\*\*#\d+\*\*/g) ?? []).length, 12, 'every ranked row stays visible');
        assert.match(request.outputs[0]!.result.text, /#208/, 'rank 11 remains visible');
        size = Buffer.byteLength(JSON.stringify(request.outputs[0]!.result));
        assert.ok(size < 8000, 'twelve roughly 300-byte rows stay bounded');
        return { text: '', calls: [{ id: 'read', name: 'get_insight', args: { insight_ids: [115, 89969, 90213], include_links: true } }] };
      }
      assert.match(request.outputs[1]!.result.text, /SYNTHETIC PRIVATE ROW/);
      assert.match(request.outputs[1]!.result.text, /superseded by #90213/);
      return { text: 'The old plan was replaced by the current weekly schedule.', calls: [] };
    } });
  assert.equal(result.status, 'complete');
  // The model's own arguments reach the wire unchanged; the daemon's defaults fill the rest.
  assert.deepEqual(seen, [
    { tool: 'search_insights', args: { query: 'orchid watering' } },
    { tool: 'get_insight', args: { insight_ids: [115, 89969, 90213], include_links: true } },
  ]);
  console.info('VAULT_FIXTURE_METRICS', JSON.stringify({ helperTurnMs: performance.now() - started, searchShapedBytes: size, searchSourceChars: twelveHitEnvelope.length }));
});

test('real short weak-candidate rows retain their id and rank without invented evidence', () => {
  const wire = '**#115** [PATTERN] Current plan\n  Score: 0.518\n- **#89969** [TECHNICAL_DECISION] Old watering plan · superseded by #90213';
  const result = projectTaskPayload('search_insights', wire, { query: 'orchid watering' });
  assert.equal(result.text, wire, 'the wire bytes reach the model unchanged');
  assert.deepEqual(result.references.map(ref => ref.id), ['search_insights'], 'the payload is one document, never re-parsed into rows');
  assert.doesNotMatch(result.text, /Score: 0\.348/, 'a short remote row has no per-hit score to reconstruct');
});

test('existing lux write transport sends LK6 provenance and preserves candidate receipts', async () => {
  const { createLuxWriteTransport } = await import('../adapters/lux-write/client.js');
  const calls: Record<string, unknown>[] = [];
  const transport = createLuxWriteTransport({ url: 'http://127.0.0.1:8765/mcp' }, async (_url, init) => {
    const call = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(call);
    const result = call.method === 'tools/call'
      ? { structuredContent: { disposition: 'created', insight_id: 42, candidates: [{ insight_id: 9 }] } }
      : call.method === 'tools/list'
        ? { tools: [{ name: 'create_insight', description: 'Create an insight', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
          inputSchema: { type: 'object', required: ['content', 'insight_title'], properties: { content: { type: 'string' }, insight_title: { type: 'string' }, insight_type: { type: 'string' },
            project: { type: 'string' }, source_kind: { type: 'string' }, source_ref: { type: 'object' }, idempotency_key: { type: 'string' }, quote: { type: 'string' },
            follow_up_state: { type: 'string' }, insight_id: { type: 'integer' } } } }] }
        : {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }), { status: 200 });
  });
  const receipt = await transport.write('create_insight', {
    content: 'Synthetic owner fact. Speaker: owner. Confidence: 1.', insight_title: 'Synthetic fact',
    insight_type: 'PATTERN', source_kind: 'voice_call',
    source_ref: { app: 'lux-didi', session_id: 'synthetic-session', turn_start_id: '7', turn_end_id: '7', spoken_at: '2026-11-07T00:00:00Z' },
    quote: 'Please save this synthetic fact.', idempotency_key: 'synthetic-session:7:7', follow_up_state: 'open',
  });
  assert.equal(receipt.disposition, 'created');
  assert.equal(receipt.insight_id, 42);
  assert.deepEqual(receipt.candidates, [{ insight_id: 9 }]);
  const call = calls.find(entry => entry['method'] === 'tools/call');
  assert.equal((call?.['params'] as Record<string, unknown>)['name'], 'create_insight');
  assert.equal(((call?.['params'] as Record<string, unknown>)['arguments'] as Record<string, unknown>)['idempotency_key'], 'synthetic-session:7:7');
  assert.ok(calls.some(entry => entry['method'] === 'tools/list'), 'the write client re-reads the discovery before it writes');
});

test('existing lux write transport refuses destructive tool names without dispatch', async () => {
  const { createLuxWriteTransport } = await import('../adapters/lux-write/client.js');
  let dispatched = false;
  const transport = createLuxWriteTransport({ url: 'http://127.0.0.1:8765/mcp' }, async () => { dispatched = true; throw Error('must not dispatch'); });
  const receipt = await transport.write('purge_insight', { insight_ids: [42] });
  assert.equal(receipt.disposition, 'refused');
  assert.equal(dispatched, false);
});

test('helper writes require persisted owner consent, retain update ids and bound writes per call', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('../runtime/store.js');
  const { domainMigrations } = await import('../domain/schema.js');
  const { liveMigrations } = await import('../live/schema.js');
  const { VaultWriter } = await import('../tools/vault-write.js');
  const directory = mkdtempSync(join(tmpdir(), 'm23-vault-'));
  const store = new Store(directory, [...domainMigrations, ...liveMigrations]);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.transaction(tx => {
    for (let id = 1; id <= 14; id++) tx.run('INSERT INTO history_turns(id,live_session_id,journal_first,journal_last,role,text,at) VALUES(?,?,?,?,?,?,?)',
      [id, 'synthetic-call', id, id, id === 1 ? 'assistant' : 'owner', 'Please save this synthetic fact.', 1794009600000]);
  });
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const writer = new VaultWriter({ store, now: () => 1794009600000, log: () => {}, transport: {
    save: async () => ({ outcome: 'failed' }),
    write: async (tool, args) => { calls.push({ tool, args }); return { disposition: tool === 'create_insight' ? 'created' : 'updated', insight_id: Number(args.insight_id ?? 42) }; },
  } });
  const args = { payload: { insight_title: 'Synthetic title', content: 'Synthetic fact', insight_type: 'PATTERN', follow_up_state: 'open' } };
  // The host selects the operation by discovered schema; the model supplies only the nested payload.
  const createSchema = { type: 'object', required: ['content', 'insight_title'], properties: { content: { type: 'string' }, insight_title: { type: 'string' }, insight_type: { type: 'string' }, follow_up_state: { type: 'string' }, source_kind: { type: 'string' }, source_ref: { type: 'object' }, idempotency_key: { type: 'string' } } };
  const updateSchema = { type: 'object', required: ['insight_id'], properties: { insight_id: { type: 'integer', minimum: 1 }, content: { type: 'string' }, follow_up_state: { type: 'string' }, source_kind: { type: 'string' }, source_ref: { type: 'object' }, revision_reason: { type: 'string' } } };
  const run = (turn: string, sessionId = 'synthetic-call') => writer.writeTask({ sessionId, tool: 'vault_save', operation: 'create_insight', inputSchema: createSchema, maxPayloadBytes: 100000, authorized: () => true, args: { ...args, requested_turn_id: turn } });
  assert.equal((await run('1')).disposition, 'refused');
  assert.equal((await run('999')).disposition, 'refused');
  assert.equal((await run('2', 'other-call')).disposition, 'refused');
  assert.equal(calls.length, 0, 'non-owner, missing and cross-session turns never reach lux');
  assert.equal((await run('2')).insight_id, 42);
  assert.equal(calls[0]?.args.idempotency_key, 'synthetic-call:2:2');
  assert.deepEqual(calls[0]?.args.source_ref, { app: 'lux-didi', session_id: 'synthetic-call', turn_start_id: '2', turn_end_id: '2', spoken_at: new Date(1794009600000).toISOString() });
  assert.match(String(calls[0]?.args.content), /speaker=owner; confidence=1/);
  assert.equal((await run('2')).disposition, 'refused', 'one write per turn');
  const updated = await writer.writeTask({ sessionId: 'synthetic-call', tool: 'vault_update', operation: 'update_insight', inputSchema: updateSchema, maxPayloadBytes: 100000, authorized: () => true, args: { requested_turn_id: '3', payload: { insight_id: 42, content: 'Corrected synthetic fact', follow_up_state: 'closed' } } });
  assert.equal(updated.insight_id, 42, 'correction keeps the stored id');
  assert.equal(calls[1]?.args.follow_up_state, 'closed');
  for (let id = 4; id <= 11; id++) assert.equal((await run(String(id))).disposition, 'created');
  assert.equal((await run('12')).disposition, 'refused', 'ten writes per call');
});
