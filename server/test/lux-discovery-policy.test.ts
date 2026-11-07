import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpRegistry } from '../adapters/mcp/registry.js';
import type { CallRequest, McpPort, ToolDefinition } from '../adapters/mcp/port.js';
import { createLuxKnowledgeReader, luxToolAdmitted, renderLuxText } from '../connectors/lux-knowledge.js';
import { LUX_TOOLS, LUX_WRITE_TOOLS, LUX_FORBIDDEN_TOOLS, LUX_PARAMS as P, luxWriteAdmitted } from '../connectors/lux-names.js';
import { configuredCompanyTools } from '../tasks/connectors.js';
import type { ConnectionPolicy } from '../tools/types.js';

const source = process.env.DIDI_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('../../test/', import.meta.url));
const fixture = JSON.parse(readFileSync(join(source, 'fixtures/lux-agent-discovery.json'), 'utf8')) as { tools: ToolDefinition[] };
function harness(effect: 'read' | 'read-write' = 'read-write') {
  const registry = new McpRegistry();
  const endpoint = { id: 'synthetic-lux', credentialRef: null, url: 'http://127.0.0.1:8765/mcp', account: 'synthetic-owner', resource: 'synthetic-vault' };
  registry.register(endpoint); registry.enable(endpoint.id); registry.allowEgress(endpoint.id);
  const digest = registry.observed(endpoint.id, fixture.tools, registry.revision(endpoint.id));
  const toolNames = fixture.tools.filter(luxToolAdmitted).map(tool => tool.name);
  registry.approve({ endpointId: endpoint.id, schemaDigest: digest, generation: 1, account: endpoint.account, resource: endpoint.resource, toolNames, effect });
  const calls: CallRequest[] = [];
  const port: McpPort = {
    discover: async () => ({ state: 'unavailable', reason: 'not-used' }), visibleTools: id => registry.visibleTools(id),
    call: async request => { calls.push(request); return { state: 'refused', reason: 'synthetic-stop-after-wire-capture' }; },
    readSlice: () => ({ state: 'refused', reason: 'not-used' }), whenSuspended: async () => {}, close: async () => {},
  };
  const policy: ConnectionPolicy = { bindingMode: 'connection', schemaVersion: 1, ownerId: 'synthetic-owner', connectionId: endpoint.id,
    generation: 1, enabled: true, connector: 'lux-knowledge', endpoint, toolNames, schemaDigest: digest,
    sourcePolicy: { id: 'synthetic', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary', 'sensitive'] },
    route: { identity: 'synthetic', allowedClasses: ['ordinary', 'sensitive'] },
    bounds: { maxQueryChars: 200, maxSearchLimit: 25, maxGetIds: 8, maxEntityBytes: 65536, maxResultBytes: 65536 } };
  const reader = createLuxKnowledgeReader({ port, registry, config: { endpointId: endpoint.id, account: endpoint.account, resource: endpoint.resource, generation: 1, ...policy.bounds } });
  return { reader, calls, policy };
}

test('central lux identities match an independent discovery fixture and its four mutation schemas', () => {
  const names = new Set(fixture.tools.map(tool => tool.name));
  for (const name of [...Object.values(LUX_TOOLS), ...LUX_FORBIDDEN_TOOLS]) assert.ok(names.has(name), `discovery drift: ${name}`);
  assert.deepEqual(fixture.tools.filter(luxWriteAdmitted).map(tool => tool.name).sort(), [...LUX_WRITE_TOOLS].sort());
  const properties = new Set(fixture.tools.flatMap(tool => Object.keys(tool.inputSchema.properties as Record<string, unknown>)));
  for (const name of Object.values(P)) assert.ok(properties.has(name), `parameter drift: ${name}`);
});

test('read admission follows annotations, while owner-only tools remain denied even with misleading hints', () => {
  assert.equal(luxToolAdmitted({ name: 'synthetic_future_reader', annotations: { readOnlyHint: true, destructiveHint: false } }), true);
  assert.equal(luxToolAdmitted({ name: 'synthetic_unannotated' }), false);
  assert.equal(luxToolAdmitted({ name: 'synthetic_destructive', annotations: { readOnlyHint: true, destructiveHint: true } }), false);
  for (const name of LUX_FORBIDDEN_TOOLS) assert.equal(luxToolAdmitted({ name, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }), false);
});

test('raw read preserves new wire keys and includes sensitive rows, without aliases or silent drops', async () => {
  const h = harness();
  await h.reader.call(LUX_TOOLS.search, { [P.query]: 'synthetic', [P.limit]: 5, project_boost: 'synthetic-project', include_sensitive: false });
  assert.deepEqual(h.calls[0]?.arguments, { [P.query]: 'synthetic', [P.limit]: 5, project_boost: 'synthetic-project', include_sensitive: true });
  const bad = await h.reader.call(LUX_TOOLS.get, { ids: [42] });
  assert.equal(bad.state, 'refused');
  if (bad.state === 'refused') assert.equal(bad.reason, 'unknown_wire_parameter');
  assert.equal((await h.reader.call('synthetic_missing_tool', {})).state, 'refused');
  assert.equal(h.calls.length, 1, 'no upstream call for an unknown key or missing tool');
});

test('a read-only grant never dispatches a discovered mutation', async () => {
  const h = harness('read');
  const result = await h.reader.call(LUX_TOOLS.update, { [P.insightId]: 42 });
  assert.equal(result.state, 'refused');
  if (result.state === 'refused') assert.equal(result.reason, 'write-grant-required');
  assert.equal(h.calls.length, 0);
});

test('helper read schemas and nested write payloads are the discovered schemas unchanged', () => {
  const h = harness();
  const definitions = configuredCompanyTools([{ connector: 'lux-knowledge', policy: h.policy,
    reader: { discovery: () => fixture.tools, call: async () => ({ state: 'refused', reason: 'not-used' }) } }]);
  const read = fixture.tools.find(tool => tool.name === LUX_TOOLS.search)!;
  assert.equal(definitions.find(tool => tool.name === read.name)?.parameters, read.inputSchema);
  const create = fixture.tools.find(tool => tool.name === LUX_TOOLS.create)!;
  const outer = definitions.find(tool => tool.name === 'vault_save')!.parameters!;
  assert.deepEqual(outer.required, ['requested_turn_id', 'payload']);
  assert.equal((outer.properties as Record<string, unknown>).payload, create.inputSchema);
  assert.ok(LUX_FORBIDDEN_TOOLS.every(name => !definitions.some(tool => tool.name === name)));
});

test('search header is opaque text, not parsed confidence or candidate fields', () => {
  const header = '# Synthetic search\n_confidence: medium · candidate_match: yes_\n\nSynthetic result #42';
  assert.equal(renderLuxText({ structuredContent: { ignored: 'alternate representation' }, content: [{ type: 'text', text: header }] }), header);
});
