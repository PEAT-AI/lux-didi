import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpRegistry } from '../adapters/mcp/registry.js';
import type { CallRequest, CallResult, McpPort, ToolDefinition } from '../adapters/mcp/port.js';
import { createLuxKnowledgeReader, type LuxKnowledgeConfig } from '../connectors/lux-knowledge.js';
import type { ConnectionPolicy } from '../tools/types.js';
import { createRegistry } from '../tasks/tools.js';
import { configuredCompanyTools, connectorExecutor, type BoundConnector } from '../tasks/connectors.js';
import { documentResult } from '../tasks/results.js';
import { FakeAuthority } from '../tasks/authority.js';

// FR5: the vault search's own two modes. `fast` is keyword-only titles and snippets; `full` is the
// ranked hybrid search the owner's server runs by default.
const tools: ToolDefinition[] = [
  { name: 'search_insights', annotations: { readOnlyHint: true, destructiveHint: false }, description: 'Synthetic search; mode fast is keyword titles and snippets, mode full is the ranked hybrid default', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, mode: { type: 'string', enum: ['fast', 'full', null], nullable: true } }, required: ['query'] } },
  { name: 'get_insight', annotations: { readOnlyHint: true, destructiveHint: false }, description: 'Synthetic by-id read', inputSchema: { type: 'object', properties: { insight_ids: { type: 'array', items: { type: 'integer' } } }, required: ['insight_ids'] } },
];
const CONFIG: LuxKnowledgeConfig = { endpointId: 'vault', account: 'account-a', resource: 'resource-a', generation: 1, maxSearchLimit: 25, maxGetIds: 8, maxQueryChars: 200 };

function vault() {
  const registry = new McpRegistry();
  registry.register({ id: 'vault', url: 'https://vault.example.test/mcp', account: 'account-a', resource: 'resource-a' });
  registry.enable('vault'); registry.allowEgress('vault');
  const schemaDigest = registry.observed('vault', tools, registry.revision('vault'));
  registry.approve({ endpointId: 'vault', schemaDigest, toolNames: ['search_insights', 'get_insight'], effect: 'read', account: 'account-a', resource: 'resource-a', generation: 1 });
  const calls: CallRequest[] = [];
  const result = (): CallResult => ({
    state: 'completed', decodedResult: { content: [] },
    source: { endpointId: 'vault', url: 'https://vault.example.test/mcp', schemaDigest, toolName: 'search_insights', generation: 1, account: 'account-a', resource: 'resource-a' },
    coverage: { completeCorpus: false, basis: 'single-tool-result', remoteSideEffects: 'unverified' },
    freshness: { receivedAt: 1, sourceVersion: 'unknown' },
    projection: { text: 'synthetic hit', omitted: false, originalCharacters: 12, omittedCharacters: 0 },
    payload: { state: 'unavailable', reason: 'capacity' },
  });
  const port: McpPort = {
    discover: async () => ({ state: 'unavailable', reason: 'fixture' }),
    visibleTools: () => tools,
    call: async request => { calls.push(request); return result(); },
    readSlice: () => ({ state: 'refused', reason: 'fixture' }),
    whenSuspended: async () => {},
    close: async () => {},
  };
  const reader = createLuxKnowledgeReader({ port, registry, config: { ...CONFIG } });
  return { calls, reader };
}

test('the reader forwards mode fast and full and sends no mode when none is chosen', async () => {
  const { calls, reader } = vault();
  assert.equal((await reader.call('search_insights', { query: 'orchard plan', limit: 3, mode: 'fast' })).state, 'completed');
  assert.equal(calls.at(-1)!.arguments['mode'], 'fast');
  assert.equal((await reader.call('search_insights', { query: 'orchard plan', limit: 3, mode: 'full' })).state, 'completed');
  assert.equal(calls.at(-1)!.arguments['mode'], 'full');
  // The server's own default is full, so an unstated mode travels as no field at all.
  assert.equal((await reader.call('search_insights', { query: 'orchard plan', limit: 3 })).state, 'completed');
  assert.equal(Object.hasOwn(calls.at(-1)!.arguments, 'mode'), false);
  assert.deepEqual(calls.map(call => call.toolName), ['search_insights', 'search_insights', 'search_insights']);
});

test('search refuses any mode other than fast or full before dispatch', async () => {
  const { calls, reader } = vault();
  const refused = await reader.call('search_insights', { query: 'orchard plan', limit: 3, mode: 'quick' });
  // The published schema owns the two modes now, so an invented one is refused as invalid arguments.
  assert.deepEqual(refused, { state: 'refused', reason: 'invalid_arguments' });
  assert.equal(calls.length, 0, 'a refused mode never reaches the wire');
});

test('the helper tool declares mode, and a mode the model chose reaches the connector', async () => {
  const binding = { connector: 'lux-knowledge', policy: { toolNames: tools.map(tool => tool.name), endpoint: { account: 'account-a', resource: 'resource-a' } },
    reader: { discovery: () => tools, call: async () => ({ state: 'completed', decodedResult: {} }) } } as unknown as BoundConnector;
  const registry = createRegistry({ execute: async () => documentResult('fixture', 'f'), authority: new FakeAuthority() }, configuredCompanyTools([binding]));
  const parameters = registry.get('search_insights')!.parameters.properties as Record<string, { type: unknown; enum?: unknown[] }>;
  assert.deepEqual(parameters['mode']!.enum, ['fast', 'full', null]);
  assert.match(registry.get('search_insights')!.description, /fast/i);

  const policy: ConnectionPolicy = {
    schemaVersion: 1, ownerId: 'fixture', connectionId: 'fixture', generation: 1, enabled: true, connector: 'lux-knowledge',
    endpoint: { id: 'vault', url: 'https://vault.example.test/mcp', account: 'account-a', resource: 'resource-a', credentialRef: null },
    toolNames: ['search_insights'], schemaDigest: 'fixture',
    sourcePolicy: { id: 'fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] }, route: { identity: 'fixture', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 4000, maxSearchLimit: 25, maxGetIds: 10, maxEntityBytes: 100000, maxResultBytes: 100000 },
  };
  const seen: { name: string; args: Record<string, unknown> }[] = [];
  const reader = { discovery: () => tools, call: async (name: string, args: Record<string, unknown>) => {
    seen.push({ name, args });
    return { state: 'completed', decodedResult: { hits: [{ id: 89820, title: 'Orchard irrigation plan' }] } } as unknown as import('../connectors/index.js').ConnectorEvidence;
  } };
  const searchBinding = { connector: 'lux-knowledge', policy, reader } as unknown as BoundConnector;
  const tasks = createRegistry({ execute: connectorExecutor([searchBinding]), authority: new FakeAuthority() }, configuredCompanyTools([searchBinding]));
  const search = tasks.get('search_insights')!;
  const identity = { task_id: 'synthetic-search', task_revision: 1, operation_id: 'synthetic-search', connection_generation: 1 };
  const signal = new AbortController().signal;
  const run = (mode: unknown) => search.run({ query: 'orchard plan', limit: 4, mode }, identity, signal);
  assert.notEqual((await run('fast')).status, 'failed', 'a chosen fast mode is forwarded, not refused');
  assert.equal(seen.at(-1)!.args['mode'], 'fast');
  // An unstated mode arrives as the declared null, is pruned, and keeps the ranked default.
  assert.notEqual((await run(null)).status, 'failed');
  assert.equal(Object.hasOwn(seen.at(-1)!.args, 'mode'), false, 'no chosen mode keeps the ranked default');
  assert.equal((await run('quick')).status, 'failed', 'an invented mode is refused, never forwarded');
  assert.equal(seen.length, 2, 'the refused mode never reached the connector');
});
