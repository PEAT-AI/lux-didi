import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectorExecutor } from '../tasks/connectors.js';
import type { BoundConnector } from '../tasks/connectors.js';
import type { ConnectorEvidence } from '../connectors/index.js';

// Synthetic envelopes from mongoose/backend/src/mongoose/models.py:
// SearchEnvelope, ReadEnvelope, RestrictionBlock, NextToolRef and ReadCoverage.
const policy: BoundConnector['policy'] = {
  schemaVersion: 1, ownerId: 'fixture', connectionId: 'fixture', generation: 1, enabled: true, connector: 'mongoose',
  endpoint: { id: 'fixture', url: 'https://fixture.example.test/mcp', account: 'fixture', resource: 'mongoose:knowledge', credentialRef: null },
  toolNames: ['search', 'read'], schemaDigest: 'fixture',
  sourcePolicy: { id: 'fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
  route: { identity: 'fixture', allowedClasses: ['ordinary'] },
  bounds: { maxQueryChars: 4000, maxSearchLimit: 25, maxGetIds: 10, maxEntityBytes: 100000, maxResultBytes: 100000 },
};
async function call(name: string, envelope: unknown, extra: Record<string, unknown> = {}) {
  const execute = connectorExecutor([{ connector: 'mongoose', policy, reader: { call: async () => ({
    state: 'completed', decodedResult: envelope, ...extra,
  }) as unknown as ConnectorEvidence } }]);
  return execute(name, name === 'read_company' ? { ref: 'knowledge:synthetic', depth: 'all' } : { query: 'synthetic' }, new AbortController().signal);
}

test('company no match and suggestions are a normal outcome, not a connector failure', async () => {
  const result = await call('search_company', { outcome: 'no_match', items: [], next_cursor: null, next_tool: null, restriction: null });
  assert.notEqual(result.status, 'failed');
  assert.match(result.text, /no_match/);
});
test('company restricted read without a body retains the restriction', async () => {
  const result = await call('read_company', { outcome: 'restricted', ref: 'knowledge:synthetic', depth: 'all', items: [], restriction: { code: 'access_denied', message: 'This record is restricted.' } });
  assert.notEqual(result.status, 'failed');
  assert.match(result.text, /access_denied/);
});
test('company native read items and incomplete coverage preserve the opaque cursor', async () => {
  const result = await call('read_company', { outcome: 'evidence', ref: 'knowledge:synthetic', depth: 'all', items: [{ ref: 'knowledge:synthetic', text: 'Synthetic source body' }], coverage: { depth: 'all', complete: false, empty_sections: [] }, next_cursor: 'opaque/native:2' });
  assert.notEqual(result.status, 'failed');
  assert.match(result.text, /Synthetic source body/);
  assert.equal(result.next_cursor, 'opaque/native:2');
  assert.match(result.coverage, /incomplete/i);
});
test('company handoff preserves the native endpoint and arguments as a normal outcome', async () => {
  const result = await call('search_company', { outcome: 'handoff', items: [], next_tool: { endpoint: 'data', url: 'https://fixture.example.test/mcp/data', tool: 'ask_data_agent', arguments: { question: 'Synthetic metric' } } });
  assert.notEqual(result.status, 'failed');
  assert.match(result.text, /ask_data_agent/);
});
test('company transport failure remains a failure', async () => {
  const execute = connectorExecutor([{ connector: 'mongoose', policy, reader: { call: async () => { throw new Error('synthetic transport failure'); } } }]);
  assert.equal((await execute('search_company', { query: 'synthetic' }, new AbortController().signal)).status, 'failed');
});
