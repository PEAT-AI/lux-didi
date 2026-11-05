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

// Job and answer fields: mongoose/backend/src/mongoose/adapters/data_agent_protocol.py
// DataAgentJob.to_dict / DataAgentAnswer.to_dict; next_step from mcp_tools/data_agent.py.
import { mongoosePublishCatalogue } from '../connectors/mongoose.js';
import { configuredCompanyTools } from '../tasks/connectors.js';
const jobId = '0123456789abcdef0123456789abcdef';
const jobSchema = { type: 'object', properties: { job_id: { type: 'string' }, op: { type: 'string', enum: ['get', 'reply', 'correct', 'cancel'] } }, required: ['job_id'], additionalProperties: false };
function dataBinding(envelopes: unknown[], seen: { tool: string; args: Record<string, unknown> }[]): BoundConnector {
  mongoosePublishCatalogue('synthetic-data', [
    { name: 'ask_data_agent', description: 'Ask the data agent a question.', inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'], additionalProperties: false } },
    { name: 'data_agent_job', description: 'Follow a data-agent job.', inputSchema: jobSchema },
  ]);
  return { connector: 'mongoose', policy: { ...policy, connectionId: 'synthetic-data', endpoint: { ...policy.endpoint, id: 'synthetic-data', resource: 'mongoose:data' }, toolNames: ['ask_data_agent', 'data_agent_job'] }, reader: { call: async (tool, args) => {
    seen.push({ tool, args });
    return { state: 'completed', decodedResult: envelopes.shift() } as unknown as ConnectorEvidence;
  } } };
}
function job(status: string, answer: unknown = null) {
  return { job_id: jobId, status, answer, clarification: null, error: status === 'failed' ? 'Synthetic upstream rejection' : null, meta: { total_cost_usd: null, duration_ms: null, num_turns: null }, next_step: status === 'running' ? 'Call data_agent_job op get with this job_id again.' : 'Present the returned answer unchanged.' };
}
test('company data agent running job can be resumed later and answer is preserved without computation', async () => {
  const answer = { answer_number: null, answer_ranking: null, definition: 'No data for this period, not zero.', sql: null, tables: [], assumptions: [], clarification: null };
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const binding = dataBinding([job('running'), job('answered', answer)], seen), execute = connectorExecutor([binding]);
  const started = await execute('ask_data_agent', { question: 'Synthetic KPI' }, new AbortController().signal);
  assert.equal(started.status, 'partial'); assert.match(started.repair!, /still running/i);
  assert.equal(JSON.parse(started.text).job_id, jobId); assert.match(JSON.parse(started.text).next_step, /get/);
  const completed = await execute('data_agent_job', { job_id: jobId, op: 'get' }, new AbortController().signal);
  assert.deepEqual(JSON.parse(completed.text).answer, answer);
  assert.deepEqual(seen, [{ tool: 'ask_data_agent', args: { question: 'Synthetic KPI' } }, { tool: 'data_agent_job', args: { job_id: jobId, op: 'get' } }]);
});
test('company answered metric retains the exact server answer and never opens a lower-level tool', async () => {
  const answer = { answer_number: 17.25, answer_ranking: [{ label: 'Synthetic segment', value: 17.25 }], definition: 'Synthetic reported KPI', sql: 'synthetic server-owned query', tables: ['synthetic_table'], assumptions: ['Synthetic fixture'], clarification: null };
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const result = await connectorExecutor([dataBinding([job('answered', answer)], seen)])('data_agent_job', { job_id: jobId, op: 'get' }, new AbortController().signal);
  assert.deepEqual(JSON.parse(result.text).answer, answer);
  assert.deepEqual(seen.map(item => item.tool), ['data_agent_job']);
});
test('company job failure and clarification are native results, not empty ranked rows', async () => {
  for (const status of ['failed', 'needs_reply']) {
    const seen: { tool: string; args: Record<string, unknown> }[] = [];
    const envelope = { ...job(status), clarification: status === 'needs_reply' ? 'Which period?' : null };
    const result = await connectorExecutor([dataBinding([envelope], seen)])('data_agent_job', { job_id: jobId, op: 'get' }, new AbortController().signal);
    assert.notEqual(result.status, 'failed'); assert.deepEqual(JSON.parse(result.text), envelope);
  }
});
test('company job helper only exposes get and refuses mutation operations before dispatch', async () => {
  const seen: { tool: string; args: Record<string, unknown> }[] = [], binding = dataBinding([], seen);
  const tool = configuredCompanyTools([binding]).find(item => item.name === 'data_agent_job')!;
  assert.deepEqual(tool.fields.op!.enum, ['get']);
  const result = await connectorExecutor([binding])('data_agent_job', { job_id: jobId, op: 'cancel' }, new AbortController().signal);
  assert.equal(result.status, 'failed'); assert.equal(seen.length, 0);
});

test('company handoff reaches only the matching configured data endpoint', async () => {
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const data = dataBinding([job('running')], seen);
  const knowledge: BoundConnector = { connector: 'mongoose', policy, reader: { call: async () => ({ state: 'completed', decodedResult: { outcome: 'handoff', items: [], next_tool: { endpoint: 'data', url: 'https://fixture.example.test/mcp/data', tool: 'ask_data_agent', arguments: { question: 'Synthetic KPI' } } } }) as unknown as ConnectorEvidence } };
  const result = await connectorExecutor([knowledge, data])('search_company', { query: 'Synthetic KPI' }, new AbortController().signal);
  assert.equal(JSON.parse(result.text).job_id, jobId); assert.equal(seen[0]?.tool, 'ask_data_agent');
  const missing = await connectorExecutor([knowledge])('search_company', { query: 'Synthetic KPI' }, new AbortController().signal);
  assert.notEqual(missing.status, 'failed'); assert.match(missing.repair!, /endpoint data is not bound/);
});
test('company reader follow-up pages reach the helper and preserve final native coverage', async () => {
  const result = await call('search_company', { outcome: 'evidence', items: [{ ref: 'knowledge:synthetic' }] }, { followUp: { tool: 'read', pages: [
    { decodedResult: { outcome: 'evidence', items: [{ ref: 'knowledge:synthetic', text: 'page one' }], next_cursor: 'opaque:2', coverage: { depth: 'all', complete: false } } },
    { decodedResult: { outcome: 'evidence', items: [{ ref: 'knowledge:synthetic', text: 'page two' }], next_cursor: null, coverage: { depth: 'all', complete: true } } },
  ] } });
  assert.match(result.text, /page one/); assert.match(result.text, /page two/); assert.equal(result.next_cursor, null); assert.equal(result.status, 'ok');
});
// CapabilityAssessment from models.py; CRM link_status from mcp_tools/integrations.py get_company.
test('company coverage blockers and CRM customer lookup are typed native results', async () => {
  const schemas = [
    { name: 'check_data_capability', description: 'Check quantitative coverage.', inputSchema: { type: 'object', properties: { company_name: { type: 'string' } }, additionalProperties: false } },
    { name: 'get_company', description: 'Read CRM by slug or canonical name.', inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false } },
  ];
  const coverage = { decision: 'not_answerable', confidence: 'high', answerable_parts: [], missing_parts: ['synthetic region'], blocker_codes: ['coverage_missing'], suggested_tools: [], route: 'blocked', suggested_ticket: null, external_system: null };
  const crm = { company: 'Synthetic Company', link_status: { hubspot_company_id: null, hubspot_id_source: null, hubspot_id_verified_at: null, status: 'unresolved' } };
  const seen: string[] = [];
  const bindings = schemas.map((schema, index): BoundConnector => {
    const endpoint = index ? 'crm' : 'knowledge', id = `synthetic-${endpoint}`;
    mongoosePublishCatalogue(id, [schema]);
    return { connector: 'mongoose', policy: { ...policy, toolNames: [schema.name], endpoint: { ...policy.endpoint, id, resource: `mongoose:${endpoint}` } }, reader: { call: async (tool, args) => {
      seen.push(tool); if (index) assert.equal(args.ref, 'synthetic-company');
      return { state: 'completed', decodedResult: index ? crm : coverage } as unknown as ConnectorEvidence;
    } } };
  });
  const definitions = configuredCompanyTools(bindings); assert.ok(definitions.some(item => item.name === 'check_data_capability')); assert.ok(definitions.some(item => item.name === 'get_company'));
  const execute = connectorExecutor(bindings);
  assert.deepEqual(JSON.parse((await execute('check_data_capability', { company_name: 'Synthetic Company' }, new AbortController().signal)).text), coverage);
  assert.deepEqual(JSON.parse((await execute('get_company', { ref: 'synthetic-company' }, new AbortController().signal)).text), crm);
  assert.deepEqual(seen, ['check_data_capability', 'get_company']);
});

import { createHash } from 'node:crypto';
import { CONNECTOR_DESCRIPTORS } from '../connectors/index.js';
import type { McpPort } from '../adapters/mcp/port.js';
import { TASK_DISCLOSURE } from '../tasks/results.js';
/** Real descriptor policy and payload verification, with synthetic retained HTTP entities. */
function projectedBinding(selectedPolicy: BoundConnector['policy'], outcomes: unknown[], followPages: unknown[] = []): BoundConnector {
  const entities = new Map<string, Buffer>();
  const port = { readSlice: (input: { handle: string; offset: number; length: number }) => {
    const bytes = entities.get(input.handle);
    return bytes ? { state: 'available', bytes: bytes.subarray(input.offset, input.offset + input.length) } : { state: 'missing' };
  } } as unknown as McpPort;
  const retained = (outcome: unknown) => {
    const decodedResult = { content: [{ type: 'text', text: JSON.stringify(outcome) }] }, bytes = Buffer.from(JSON.stringify(decodedResult));
    const handle = `synthetic-${entities.size}`; entities.set(handle, bytes);
    return { decodedResult, payload: { state: 'available', handle, byteLength: bytes.length, encoding: 'http-response-entity', sha256: createHash('sha256').update(bytes).digest('hex'), expiresAt: Date.now() + 60_000 } };
  };
  return { connector: 'mongoose', policy: selectedPolicy, reader: { call: async tool => {
    const root = retained(outcomes.shift());
    return { state: 'completed', tool, decodedResult: root.decodedResult, response: root.payload,
      source: { endpointId: selectedPolicy.endpoint.id, generation: 1, account: 'fixture', resource: selectedPolicy.endpoint.resource },
      coverage: {}, projection: {}, ...(followPages.length ? { followUp: { tool: 'read', pages: followPages.map(retained) } } : {}),
    } as unknown as ConnectorEvidence;
  } }, project: evidence => ({ ...CONNECTOR_DESCRIPTORS.mongoose!.project(evidence, port, selectedPolicy), sourceDispatchRefs: [`dispatch-${selectedPolicy.endpoint.id}`], sourcePolicyRefs: [{ connectionId: selectedPolicy.connectionId, sha256: 'synthetic-policy-digest' }] }) };
}
test('F1 real projected company no_match preserves suggestions, status and authoritative disclosure', async () => {
  const result = await connectorExecutor([projectedBinding(policy, [{ outcome: 'no_match', items: [], suggestions: ['Synthetic narrower question'] }])])('search_company', { query: 'synthetic' }, new AbortController().signal);
  assert.equal(result.status, 'no_match'); assert.match(result.text, /Synthetic narrower question/);
  assert.deepEqual(result.dataClasses, ['ordinary']); assert.deepEqual(result[TASK_DISCLOSURE]?.sourceDispatchRefs, ['dispatch-fixture']);
  assert.deepEqual(result[TASK_DISCLOSURE]?.sourcePolicyRefs, [{ connectionId: 'fixture', sha256: 'synthetic-policy-digest' }]);
});
test('F1 real projected company page keeps refs, opaque cursor and complete continuation', async () => {
  const execute = connectorExecutor([projectedBinding(policy, [
    { outcome: 'evidence', items: [{ ref: 'knowledge:synthetic', text: 'Projected page one' }], next_cursor: 'opaque/projected:2', coverage: { depth: 'all', complete: false } },
    { outcome: 'evidence', items: [{ ref: 'knowledge:synthetic', text: 'Projected page two' }], next_cursor: null, coverage: { depth: 'all', complete: true } },
  ])]);
  const first = await execute('read_company', { ref: 'knowledge:synthetic', depth: 'all' }, new AbortController().signal);
  assert.equal(first.next_cursor, 'opaque/projected:2'); assert.equal(first.references[0]?.id, 'knowledge:synthetic');
  const second = await execute('read_company', { ref: 'knowledge:synthetic', depth: 'all', cursor: first.next_cursor }, new AbortController().signal);
  assert.equal(second.status, 'ok'); assert.match(second.text, /Projected page two/); assert.equal(second.next_cursor, null);
});
test('F1 real projected handoff reaches data and preserves continuation and exact answer', async () => {
  const knowledge = projectedBinding(policy, [{ outcome: 'handoff', items: [], next_tool: { endpoint: 'data', tool: 'ask_data_agent', arguments: { question: 'Synthetic KPI' }, url: 'https://fixture.example.test/mcp/data' } }]);
  const dataPolicy = dataBinding([], []).policy;
  const answer = { answer_number: 31.5, answer_ranking: null, definition: 'Synthetic KPI', sql: null, tables: [], assumptions: [], clarification: null };
  const execute = connectorExecutor([knowledge, projectedBinding(dataPolicy, [job('running'), job('answered', answer)])]);
  const first = await execute('search_company', { query: 'Synthetic KPI' }, new AbortController().signal);
  assert.equal(first.status, 'partial'); assert.equal(JSON.parse(first.text).job_id, jobId); assert.match(JSON.parse(first.text).next_step, /get/);
  assert.ok(first[TASK_DISCLOSURE]?.sourceDispatchRefs?.includes('dispatch-synthetic-data'));
  const second = await execute('data_agent_job', { job_id: jobId, op: 'get' }, new AbortController().signal);
  assert.deepEqual(JSON.parse(second.text).answer, answer); assert.deepEqual(second.dataClasses, ['ordinary']);
});
test('F1 real projected follow-up retains all admitted native pages', async () => {
  const result = await connectorExecutor([projectedBinding(policy, [{ outcome: 'evidence', items: [{ ref: 'knowledge:synthetic' }] }], [
    { outcome: 'evidence', items: [{ ref: 'knowledge:synthetic', text: 'Admitted follow-up one' }], next_cursor: 'native:2', coverage: { complete: false } },
    { outcome: 'evidence', items: [{ ref: 'knowledge:synthetic', text: 'Admitted follow-up two' }], next_cursor: null, coverage: { complete: true } },
  ])])('search_company', { query: 'synthetic' }, new AbortController().signal);
  assert.match(result.text, /Admitted follow-up one/); assert.match(result.text, /Admitted follow-up two/); assert.equal(result.next_cursor, null); assert.equal(result.references.length, 2);
});
