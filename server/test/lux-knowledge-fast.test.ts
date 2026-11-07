import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpRegistry } from '../adapters/mcp/registry.js';
import type { CallRequest, CallResult, McpPort, ToolDefinition } from '../adapters/mcp/port.js';
import { createLuxKnowledgeReader, type LuxKnowledgeConfig } from '../connectors/lux-knowledge.js';
import type { ConnectionPolicy } from '../tools/types.js';
import { createRegistry } from '../tasks/tools.js';
import { connectorExecutor } from '../tasks/connectors.js';
import { documentResult } from '../tasks/results.js';
import { FakeAuthority } from '../tasks/authority.js';

// FR5: the vault search's own two modes. `fast` is keyword-only titles and snippets; `full` is the
// ranked hybrid search the owner's server runs by default.
const tools: ToolDefinition[] = [
  { name: 'search_knowledge', description: 'Synthetic search', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, mode: { type: 'string' } }, required: ['query'] } },
  { name: 'get_insight', description: 'Synthetic by-id read', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } } }, required: ['ids'] } },
];
const CONFIG: LuxKnowledgeConfig = { endpointId: 'vault', account: 'account-a', resource: 'resource-a', generation: 1, maxSearchLimit: 25, maxGetIds: 8, maxQueryChars: 200 };

function vault() {
  const registry = new McpRegistry();
  registry.register({ id: 'vault', url: 'https://vault.example.test/mcp', account: 'account-a', resource: 'resource-a' });
  registry.enable('vault'); registry.allowEgress('vault');
  const schemaDigest = registry.observed('vault', tools, registry.revision('vault'));
  registry.approve({ endpointId: 'vault', schemaDigest, toolNames: ['search_knowledge', 'get_insight'], effect: 'read', account: 'account-a', resource: 'resource-a', generation: 1 });
  const calls: CallRequest[] = [];
  const result = (): CallResult => ({
    state: 'completed', decodedResult: { content: [] },
    source: { endpointId: 'vault', url: 'https://vault.example.test/mcp', schemaDigest, toolName: 'search_knowledge', generation: 1, account: 'account-a', resource: 'resource-a' },
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

test('search forwards mode fast and full and keeps the old wire shape when no mode is given', async () => {
  const { calls, reader } = vault();
  assert.equal((await reader.search({ query: 'orchard plan', limit: 3, mode: 'fast' })).state, 'completed');
  assert.equal(calls.at(-1)!.arguments['mode'], 'fast');
  assert.equal((await reader.search({ query: 'orchard plan', limit: 3, mode: 'full' })).state, 'completed');
  assert.equal(calls.at(-1)!.arguments['mode'], 'full');
  // The server's own default is full, so an unstated mode travels as no field at all.
  assert.equal((await reader.search({ query: 'orchard plan', limit: 3 })).state, 'completed');
  assert.equal(Object.hasOwn(calls.at(-1)!.arguments, 'mode'), false);
  assert.deepEqual(calls.map(call => call.toolName), ['search_knowledge', 'search_knowledge', 'search_knowledge']);
});

test('search refuses any mode other than fast or full before dispatch', async () => {
  const { calls, reader } = vault();
  const refused = await reader.search({ query: 'orchard plan', limit: 3, mode: 'quick' } as never);
  assert.deepEqual(refused, { state: 'refused', reason: 'invalid-mode' });
  assert.equal(calls.length, 0, 'a refused mode never reaches the wire');
});

test('the helper tool declares mode, and a mode the model chose reaches the connector', async () => {
  const registry = createRegistry({ execute: async () => documentResult('fixture', 'f'), authority: new FakeAuthority() });
  const parameters = registry.get('search_knowledge')!.parameters.properties as Record<string, { type: unknown; enum?: unknown[] }>;
  assert.deepEqual(parameters['mode']!.enum, ['fast', 'full', null]);
  assert.match(registry.get('search_knowledge')!.description, /fast/i);

  const policy: ConnectionPolicy = {
    schemaVersion: 1, ownerId: 'fixture', connectionId: 'fixture', generation: 1, enabled: true, connector: 'lux-knowledge',
    endpoint: { id: 'vault', url: 'https://vault.example.test/mcp', account: 'account-a', resource: 'resource-a', credentialRef: null },
    toolNames: ['search_knowledge'], schemaDigest: 'fixture',
    sourcePolicy: { id: 'fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] }, route: { identity: 'fixture', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 4000, maxSearchLimit: 25, maxGetIds: 10, maxEntityBytes: 100000, maxResultBytes: 100000 },
  };
  const seen: { name: string; args: Record<string, unknown> }[] = [];
  const reader = { call: async (name: string, args: Record<string, unknown>) => {
    seen.push({ name, args });
    return { state: 'completed', decodedResult: { hits: [{ id: 89820, title: 'Orchard irrigation plan' }] } } as unknown as import('../connectors/index.js').ConnectorEvidence;
  } };
  const execute = connectorExecutor([{ connector: 'lux-knowledge', policy, reader }]);
  const signal = new AbortController().signal;
  assert.notEqual((await execute('search_knowledge', { query: 'orchard plan', limit: 4, mode: 'fast' }, signal)).status, 'failed', 'a chosen fast mode is forwarded, not refused');
  assert.equal(seen.at(-1)!.args['mode'], 'fast');
  // An unstated mode arrives as the declared null, is pruned, and keeps the ranked default.
  assert.notEqual((await execute('search_knowledge', { query: 'orchard plan', limit: 4, mode: null }, signal)).status, 'failed');
  assert.equal(Object.hasOwn(seen.at(-1)!.args, 'mode'), false, 'no chosen mode keeps the ranked default');
  assert.equal((await execute('search_knowledge', { query: 'orchard plan', limit: 4, mode: 'quick' }, signal)).status, 'failed', 'an invented mode is refused, never forwarded');
});
