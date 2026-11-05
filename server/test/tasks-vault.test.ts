import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTaskPayload } from '../tasks/connectors.js';

export const vaultEnvelope = `# Knowledge Search: 'orchid watering'

_confidence: medium · mode: reranked · low_confidence: yes_ · top score: 0.45 · relevant candidate: yes · top ranker score: 0.45

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

test('vault semantic hits retain evidence and are successful without exact titles', () => {
  const result = projectTaskPayload('search_knowledge', vaultEnvelope, { query: 'orchid watering' });
  assert.equal(result.status, 'ok');
  for (const evidence of ['_confidence: medium', 'low_confidence: yes', 'sensitive rows excluded', '[PATTERN]', 'valid from 2026-02-01', 'once a week', 'Score: 0.518', 'superseded', '#90213']) {
    assert.ok(result.text.includes(evidence), evidence);
  }
  assert.deepEqual(result.references.map(ref => ref.id), ['115', '89969']);
  assert.ok(result.text.indexOf('#115') < result.text.indexOf('#89969'));
});

test('vault absence is empty while malformed source text is not evidence of absence', () => {
  assert.equal(projectTaskPayload('search_knowledge', '# Knowledge Search\n\nNo results found.', { query: 'absent' }).status, 'empty');
  assert.notEqual(projectTaskPayload('search_knowledge', 'upstream response missing', { query: 'absent' }).status, 'empty');
});

test('vault shaping is bounded and does not change company exact-name matching', () => {
  const result = projectTaskPayload('search_knowledge', vaultEnvelope + 'x'.repeat(100000), { query: 'orchid watering' });
  assert.ok(result.text.length <= 24000);
  assert.equal(projectTaskPayload('search_company', vaultEnvelope, { query: 'orchid watering' }).status, 'no_match');
});

test('vault exposes only the reviewed read catalogue with bounded valid lookup arguments', async () => {
  const { CONNECTOR_DESCRIPTORS } = await import('../connectors/index.js');
  const policy = { bounds: { maxSearchLimit: 25, maxGetIds: 10 } } as import('../tools/types.js').ConnectionPolicy;
  const descriptor = CONNECTOR_DESCRIPTORS['lux-knowledge']!;
  assert.deepEqual([...descriptor.envelope], ['search_knowledge', 'get_insight', 'list_meetings', 'get_meeting', 'list_insights']);
  const tools = descriptor.declarations(policy);
  for (const [name, valid, invalid] of [
    ['list_meetings', { participant: 'Synthetic', date_from: '2026-01-01', limit: 10 }, { date_from: '2026-02-30' }],
    ['get_meeting', { meeting_id: 'synthetic', limit: 10 }, { limit: 10 }],
    ['list_insights', { count_only: true, limit: 10 }, { limit: 100000 }],
  ] as const) {
    const tool = tools.find(tool => tool.name === name);
    assert.ok(tool, name);
    assert.equal(tool.validate(valid), true, name);
    assert.equal(tool.validate(invalid), false, name);
  }
});

test('fresh vault source defaults sensitive without widening another connector or an explicit class', async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadMcpEndpoints } = await import('../config/mcp.js');
  const dir = mkdtempSync(join(tmpdir(), 'vault-default-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { url: 'https://fixture.invalid/mcp', account: 'fixture', resource: 'fixture', credentialRef: null, enabled: true, allowEgress: true };
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
  const policy = {
    connector: 'lux-knowledge', toolNames: ['search_knowledge', 'get_insight'],
    bounds: { maxSearchLimit: 25, maxGetIds: 10 },
  } as import('../tools/types.js').ConnectionPolicy;
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const read = '#89969 Old watering plan\n⚠ superseded by #90213\nLinked rationale: #90213 Current watering plan\nSYNTHETIC PRIVATE ROW';
  const execute = connectorExecutor([{ connector: 'lux-knowledge', policy, reader: { async call(tool, args) {
    seen.push({ tool, args });
    return { state: 'completed', decodedResult: tool === 'search_knowledge' ? vaultEnvelope : read } as import('../connectors/index.js').ConnectorResult;
  } } }]);
  const registry = createRegistry({ execute, authority: new FakeAuthority() });
  let hop = 0, size = 0;
  const started = performance.now();
  const result = await runWorker({ registry, identity: { task_id: 'fixture-vault', task_revision: 1, connection_generation: 1 },
    input: 'orchid watering', signal: new AbortController().signal,
    infer: async request => {
      if (++hop === 1) return { text: '', calls: [{ id: 'search', name: 'search_knowledge', args: { query: 'orchid watering' } }] };
      if (hop === 2) {
        assert.equal(request.outputs[0]?.result.status, 'ok');
        assert.match(request.outputs[0]!.result.text, /Score: 0.518/);
        size = Buffer.byteLength(JSON.stringify(request.outputs[0]!.result));
        return { text: '', calls: [{ id: 'read', name: 'read_knowledge', args: { ids: [115, 89969, 90213], include_links: true, cursor: null } }] };
      }
      assert.match(request.outputs[1]!.result.text, /SYNTHETIC PRIVATE ROW/);
      assert.match(request.outputs[1]!.result.text, /superseded by #90213/);
      return { text: 'The old plan was replaced by the current weekly schedule.', calls: [] };
    } });
  assert.equal(result.status, 'complete');
  assert.deepEqual(seen, [
    { tool: 'search_knowledge', args: { query: 'orchid watering', limit: 6, detail: 'voice', snippet_chars: 600 } },
    { tool: 'get_insight', args: { ids: [115, 89969, 90213], include_links: true } },
  ]);
  console.info('VAULT_FIXTURE_METRICS', JSON.stringify({ helperTurnMs: performance.now() - started, searchShapedBytes: size, searchSourceChars: vaultEnvelope.length }));
});
