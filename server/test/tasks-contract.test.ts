import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { documentResult, rankedResult, failed } from '../tasks/results.js';
import { createRegistry, validateArguments } from '../tasks/tools.js';
import { FakeAuthority } from '../tasks/authority.js';
import type { InferRequest } from '../tasks/worker.js';

test('opened documents are whole up to 24000 with explicit continuation', () => {
  const body = 'x'.repeat(25000);
  const first = documentResult(body, 'synthetic');
  assert.equal(first.text.length, 24000);
  assert.equal(first.status, 'partial');
  assert.equal(typeof first.next_cursor, 'string');
  assert.equal(documentResult(body, 'synthetic', '24000').status, 'failed', 'bare offsets are not proof of a captured version');
  assert.equal(documentResult(body + 'changed', 'synthetic', first.next_cursor!).status, 'failed', 'a continuation cannot read another source version');
  const other = documentResult(body, 'another-document', first.next_cursor!);
  assert.equal(other.status, 'failed', 'identical bytes from another document do not share a continuation');
  assert.match(other.repair!, /restart/i);
  const rest = documentResult(body, 'synthetic', first.next_cursor!);
  assert.equal(first.text + rest.text, body);
  assert.equal(rest.next_cursor, null);
  assert.equal(documentResult('whole', 'synthetic').text, 'whole');
});
test('ranked no match does not present neighbours as matches or open them', () => {
  const result = rankedResult('Orchid', [{ id: 'a', title: 'Cedar', text: 'nearby' }]);
  assert.equal(result.status, 'no_match');
  assert.equal(result.references[0]?.match, 'neighbour');
  assert.doesNotMatch(result.text, /nearby/);
  assert.equal(rankedResult('Orchid', [{ id: 'b', title: 'Orchid', text: 'yes' }]).status, 'ok');
  assert.equal(rankedResult('Orchid', []).status, 'empty');
  assert.ok(failed('Try a different id.').repair);
});
test('SOURCE DEFECT task declaration: strict provider parameters must require every field including nullable recurrence', async () => {
  const calls: unknown[] = [];
  const authority = new FakeAuthority();
  const registry = createRegistry({ execute: async (name, args) => { calls.push({ name, args }); return documentResult('done', 'fixture'); }, authority });
  for (const tool of registry.values()) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.parameters.properties as object).sort(), [...tool.parameters.required as string[]].sort());
    const visit = (value: unknown): void => {
      if (typeof value === 'number') assert.ok(Number.isInteger(value));
      if (value && typeof value === 'object') {
        const schema = value as Record<string, unknown>;
        if (schema['properties'] && typeof schema['properties'] === 'object') {
          assert.deepEqual(Object.keys(schema['properties']).sort(), [...schema['required'] as string[]].sort(), `${tool.name}: every nested object property is required`);
          assert.equal(schema['additionalProperties'], false);
        }
        Object.values(value).forEach(visit);
      }
    };
    visit(tool.parameters);
  }
  const recurrence = (registry.get('alarm_create')!.parameters.properties as Record<string, { type: unknown }>).recurrence!;
  assert.ok(Array.isArray(recurrence.type) && recurrence.type.includes('null'), 'strict recurrence remains nullable');
  assert.ok([...registry.keys()].some(name => name.startsWith('chat_')), 'new Mattermost reads are included in the same strict traversal');
  const search = registry.get('search_mail')!;
  assert.equal(validateArguments(search, { query: 'after:2026/01/01', cursor: null, extra: true }).ok, false);
  assert.equal(validateArguments(search, { query: 'after:2026/01/01', cursor: null }).ok, true);
  const read = registry.get('read_mail')!;
  assert.deepEqual(validateArguments(read, { id: 'm1', cursor: null }), { ok: true, args: { id: 'm1', cursor: null } });
  await registry.get('delete_event')!.run({ id: 'e1' }, { task_id: 't', task_revision: 1, operation_id: 'o', connection_generation: 1 }, new AbortController().signal);
  assert.equal(authority.requests.length, 1);
  assert.equal(calls.length, 1);
});

test('both provider ports carry strict typed calls and return a final answer without network', async () => {
  const { createModelPort, DEFAULT_WORKER_MODEL } = await import('../tasks/model.js');
  assert.equal(DEFAULT_WORKER_MODEL, 'gpt-6.1-terra');
  for (const provider of ['openai', 'gemini'] as const) {
    let calls = 0;
    const registry = createRegistry({ execute: async () => documentResult('whole', 'fixture'), authority: new FakeAuthority() });
    const infer = createModelPort({ role: { provider, model: provider === 'openai' ? DEFAULT_WORKER_MODEL : 'gemini-fixture', effort: 'low', keyReference: 'fixture-reference' }, credentials: { resolve: async reference => { assert.equal(reference, 'fixture-reference'); return 'synthetic-key'; } },
      transport: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        assert.ok(body.tools.length);
        assert.doesNotMatch(JSON.stringify(body.tools), /"type":"STRING,NULL"/);
        calls++;
        const call = { name: 'read_mail', args: { id: 'm', cursor: null } };
        const payload = provider === 'openai'
          ? { status: 'completed', output: calls === 1 ? [{ type: 'function_call', call_id: 'c', name: call.name, arguments: JSON.stringify(call.args) }] : [{ type: 'message', content: [{ type: 'output_text', text: 'verified final' }] }] }
          : { candidates: [{ finishReason: 'STOP', content: { parts: calls === 1 ? [{ functionCall: call }] : [{ text: 'verified final' }] } }] };
        return new Response(JSON.stringify(payload));
      } });
    const { runWorker } = await import('../tasks/worker.js');
    const result = await runWorker({ registry, infer, identity: { task_id: 't', task_revision: 1, connection_generation: 1 }, input: 'fixture', signal: new AbortController().signal });
    assert.equal(result.text, 'verified final'); assert.equal(calls, 2);
  }
});

test('Gmail operators narrow synthetic fixture results and read returns the whole body', async () => {
  const testRoot = process.env.DIDI_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('../../test/', import.meta.url));
  const fixtures = await import(pathToFileURL(resolve(testRoot, '../../scripts/eval-worker-replay.mjs')).href);
  const all = fixtures.searchMail({ query: 'after:2000/01/01' });
  const none = fixtures.searchMail({ query: 'after:2099/01/01' });
  assert.ok(JSON.stringify(all).includes('m_'));
  assert.ok(!JSON.stringify(none).includes('m_'));
  const first = fixtures.MAIL[0];
  assert.equal(fixtures.readMail({ id: first.id }).body, first.body);
});

test('connector projection is structural and no_match never opens a neighbour', async () => {
  const { projectTaskPayload } = await import('../tasks/connectors.js');
  const body = 'body '.repeat(4500);
  const result = projectTaskPayload('read_mail', { content: [{ type: 'text', text: JSON.stringify({ data: { body } }) }] }, { id: 'm' });
  assert.equal(result.text, body.trim());
  const ranked = projectTaskPayload('search_company', { results: [{ id: 'near', title: 'Cedar', body: 'must not be opened' }] }, { query: 'Orchid' });
  assert.equal(ranked.status, 'no_match'); assert.equal(ranked.references[0]?.match, 'neighbour');
  assert.doesNotMatch(ranked.text, /must not/);
  assert.equal(projectTaskPayload('search_mail', { unexpected: 'x' }, { query: 'x' }).status, 'failed');
  assert.equal(projectTaskPayload('search_mail', { messages: [] }, { query: 'x' }).status, 'empty');
});

test('provider continuations retain encrypted reasoning and Gemini thought signatures', async () => {
  const { createModelPort } = await import('../tasks/model.js');
  const { runWorker } = await import('../tasks/worker.js');
  for (const provider of ['openai', 'gemini'] as const) {
    let hop = 0;
    const registry = createRegistry({ execute: async () => documentResult('verified', 'm'), authority: new FakeAuthority() });
    const infer = createModelPort({ role: { provider, model: 'fixture-model', effort: 'low', keyReference: 'fixture' }, credentials: { resolve: async () => 'fixture-key' }, transport: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      if (hop++ === 1) {
        assert.match(JSON.stringify(body), provider === 'openai' ? /encrypted-fixture/ : /thought-fixture/);
        return new Response(JSON.stringify(provider === 'openai' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"status":"no_action"}' }] }] } : { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"status":"no_action"}' }] } }] }));
      }
      return new Response(JSON.stringify(provider === 'openai'
        ? { status: 'completed', output: [{ type: 'reasoning', encrypted_content: 'encrypted-fixture' }, { type: 'function_call', call_id: 'call', name: 'read_mail', arguments: '{"id":"m","cursor":null}' }] }
        : { candidates: [{ finishReason: 'STOP', content: { parts: [{ thoughtSignature: 'thought-fixture', functionCall: { name: 'read_mail', args: { id: 'm', cursor: null } } }] } }] }));
    } });
    assert.equal((await runWorker({ registry, infer, identity: { task_id: 't', task_revision: 1, connection_generation: 1 }, input: 'fixture', signal: new AbortController().signal })).status, 'no_action');
  }
});

test('real connector wire shapes retain thread bodies, event times and ranked Markdown labels', async () => {
  const { projectTaskPayload } = await import('../tasks/connectors.js');
  const thread = projectTaskPayload('read_thread', { posts: { p: { id: 'p', user_id: 'u', message: 'whole thread body', create_at: '2026-01-01' } }, order: ['p'] }, { ref: 'p' });
  assert.match(thread.text, /whole thread body/);
  const event = projectTaskPayload('calendar_events', { events: [{ id: 'e', summary: 'Synthetic meeting', start: { dateTime: '2026-01-01T10:00:00Z' }, end: { dateTime: '2026-01-01T11:00:00Z' } }] }, {});
  assert.match(event.text, /Synthetic meeting/); assert.match(event.text, /10:00:00Z/);
  const ranked = projectTaskPayload('search_knowledge', '**#42** [PATTERN] Orchid', { query: 'Orchid' });
  assert.equal(ranked.references[0]?.match, 'exact');
  const neighbour = projectTaskPayload('search_knowledge', '**#42** [PATTERN] Orchid', { query: 'Cedar' });
  assert.equal(neighbour.status, 'no_match'); assert.equal(neighbour.text, '');
});

test('configured schemas reject floats but accept integer bounds', () => {
  const ports = { execute: async () => documentResult('fixture', 'f'), authority: new FakeAuthority() };
  assert.throws(() => createRegistry(ports, [{ outside: false, name: 'fixture_float', description: 'fixture', fields: { value: { type: 'number', minimum: 0.1 } } }]), /Non-integer/);
  assert.ok(createRegistry(ports, [{ outside: false, name: 'fixture_integer', description: 'fixture', fields: { value: { type: 'integer', minimum: 1 } } }]).has('fixture_integer'));
});

test('configured connector executor forwards query operators and whole read bodies', async () => {
  const { connectorExecutor, configuredCompanyTools } = await import('../tasks/connectors.js');
  const { declarations } = await import('../tasks/model.js');
  const { CONNECTOR_DESCRIPTORS } = await import('../connectors/index.js');
  const policy: import('../tools/types.js').ConnectionPolicy = {
    schemaVersion: 1, ownerId: 'fixture', connectionId: 'fixture', generation: 1, enabled: true, connector: 'google',
    endpoint: { id: 'fixture', url: 'https://fixture.example.test/mcp', account: 'fixture', resource: 'fixture', credentialRef: null },
    toolNames: ['gmail_search_messages', 'gmail_read_message'], schemaDigest: 'fixture',
    sourcePolicy: { id: 'fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] }, route: { identity: 'fixture', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 4000, maxSearchLimit: 25, maxGetIds: 10, maxEntityBytes: 100000, maxResultBytes: 100000 },
  };
  const seen: { name: string; args: Record<string, unknown> }[] = [];
  const reader: import('../connectors/index.js').ConnectorReader = { call: async (name, args) => {
    seen.push({ name, args });
    return { state: 'completed', decodedResult: name === 'gmail_search_messages' ? { messages: [{ id: 'm', subject: 'Synthetic' }] } : { body: 'whole '.repeat(2000) } } as unknown as import('../connectors/index.js').ConnectorEvidence;
  } };
  const execute = connectorExecutor([{ connector: 'google', policy, reader }]);
  assert.equal((await execute('search_mail', { query: 'after:2026/01/01 before:2026/02/01' }, new AbortController().signal)).status, 'ok');
  assert.deepEqual(seen[0], { name: 'gmail_search_messages', args: { q: 'after:2026/01/01 before:2026/02/01' } });
  assert.ok((await execute('read_mail', { id: 'm' }, new AbortController().signal)).text.length > 10000);
  assert.equal((await connectorExecutor([])('read_mail', { id: 'm' }, new AbortController().signal)).status, 'failed');
  const companyPolicy = { ...policy, connector: 'mongoose', endpoint: { ...policy.endpoint, resource: 'mongoose:knowledge' } };
  const configured = configuredCompanyTools([{ connector: 'mongoose', policy: companyPolicy, reader }]);
  const registry = createRegistry({ execute, authority: new FakeAuthority() }, configured);
  assert.ok(registry.has('query_company'));
  const source = CONNECTOR_DESCRIPTORS.mongoose!.declarations(companyPolicy).find(tool => tool.name === 'search')!;
  assert.ok(source);
  const filters = Object.fromEntries(Object.keys(source.parameters.properties as object).map(key => [key, key === 'query' ? 'Orchid' : null]));
  assert.equal(validateArguments(registry.get('query_company')!, { resource: 'search', filters }).ok, true);
  assert.equal(validateArguments(registry.get('query_company')!, { resource: 'search', filters: { ...filters, invented: 'no' } }).ok, false);
  const request = { instructions: '', input: '', outputs: [], turns: [], tools: [...registry.values()], model: 'fixture', effort: 'low' };
  for (const provider of ['openai', 'gemini'] as const) {
    const converted = declarations(request, provider);
    assert.equal(converted.length, registry.size);
    const visit = (value: unknown): void => { if (typeof value === 'number') assert.ok(Number.isInteger(value)); if (value && typeof value === 'object') Object.values(value).forEach(visit); };
    converted.forEach(visit);
  }
});

test('default model and effort are applied without provider-specific caller code', async () => {
  const { createModelPort, DEFAULT_WORKER_MODEL } = await import('../tasks/model.js');
  const infer = createModelPort({ role: { keyReference: 'fixture' }, credentials: { resolve: async () => 'fixture' }, transport: async (_url, init) => {
    const body = JSON.parse(String(init.body)); assert.equal(body.model, DEFAULT_WORKER_MODEL); assert.equal(body.reasoning.effort, 'low');
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'fixture' }] }] }));
  } });
  assert.equal((await infer({ instructions: '', input: '', outputs: [], turns: [], tools: [], model: DEFAULT_WORKER_MODEL, effort: 'low' }, new AbortController().signal)).text, 'fixture');
});

test('review-owned worker instructions are short and preserve absence after widening', async () => {
  const { WORKER_INSTRUCTIONS } = await import('../tasks/instructions.js');
  // 10.11: the mandated worker rules re-pin the block to its measured size (TR-R5).
assert.ok(WORKER_INSTRUCTIONS.length <= 4267);
  assert.match(WORKER_INSTRUCTIONS, /speech recognition/);
  assert.match(WORKER_INSTRUCTIONS, /Absence\./);
});

test('CORE-F1: worker consumes a second Gmail page with a distinct read-cache key', async () => {
  const { connectorExecutor } = await import('../tasks/connectors.js');
  const { runWorker } = await import('../tasks/worker.js');
  const policy: import('../tools/types.js').ConnectionPolicy = {
    schemaVersion: 1, ownerId: 'fixture', connectionId: 'fixture', generation: 1, enabled: true, connector: 'google',
    endpoint: { id: 'fixture', url: 'https://fixture.example.test/mcp', account: 'fixture', resource: 'fixture', credentialRef: null },
    toolNames: ['gmail_search_messages'], schemaDigest: 'fixture',
    sourcePolicy: { id: 'fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] }, route: { identity: 'fixture', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 4000, maxSearchLimit: 25, maxGetIds: 10, maxEntityBytes: 100000, maxResultBytes: 100000 },
  };
  const dispatched: Record<string, unknown>[] = [];
  const reader: import('../connectors/index.js').ConnectorReader = { call: async (name, args) => {
    assert.equal(name, 'gmail_search_messages'); dispatched.push(args);
    const data = args.pageToken === 'page-2' ? { messages: [{ id: 'm2', subject: 'Second page' }] } : { messages: [{ id: 'm1', subject: 'First page' }], nextPageToken: 'page-2' };
    return { state: 'completed', decodedResult: { data } } as unknown as import('../connectors/index.js').ConnectorEvidence;
  } };
  const registry = createRegistry({ authority: new FakeAuthority(), execute: connectorExecutor([{ connector: 'google', policy, reader }]) });
  const tool = registry.get('search_mail')!;
  assert.deepEqual(validateArguments(tool, { query: 'fixture', cursor: null }), { ok: true, args: { query: 'fixture', cursor: null } });
  let hop = 0;
  const result = await runWorker({ registry, identity: { task_id: 'fixture', task_revision: 1, connection_generation: 1 }, input: 'fixture', signal: new AbortController().signal,
    infer: async request => {
      if (++hop === 1) return { text: '', calls: ['a', 'b'].map(id => ({ id, name: 'search_mail', args: { query: 'fixture', cursor: null } })) };
      if (hop === 2) {
        assert.equal(request.outputs[0]?.result.status, 'partial');
        assert.equal(request.outputs[0]?.result.references[0]?.id, 'm1');
        return { text: '', calls: [{ id: 'c', name: 'search_mail', args: { query: 'fixture', cursor: request.outputs[0]?.result.next_cursor } }] };
      }
      assert.equal(request.outputs.filter(output => output.result.references.some(reference => reference.id === 'm2')).length, 1);
      assert.equal(request.outputs[2]?.result.next_cursor, null);
      return { text: 'Both pages verified', calls: [] };
    } });
  assert.equal(result.status, 'complete');
  assert.deepEqual(dispatched, [{ q: 'fixture' }, { q: 'fixture', pageToken: 'page-2' }]);
  assert.equal(result.findings.filter(finding => finding.references.some(reference => reference.id === 'm2')).length, 1);
});

test('CORE-F1: unsupported calendar and search cursors are not offered', async () => {
  const { projectTaskPayload, connectorExecutor } = await import('../tasks/connectors.js');
  const registry = createRegistry({ authority: new FakeAuthority(), execute: connectorExecutor([]) });
  const calendar = registry.get('calendar_events')!;
  assert.equal(validateArguments(calendar, { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' }).ok, true);
  assert.equal(validateArguments(calendar, { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z', cursor: 'page-2' }).ok, false);
  const calendarPage = projectTaskPayload('calendar_events', { events: [{ id: 'e1', summary: 'fixture' }], nextPageToken: 'page-2' }, {});
  assert.equal(calendarPage.status, 'partial'); assert.equal(calendarPage.next_cursor, null);
  assert.match(calendarPage.coverage, /not exposed/);
  const unsupported = projectTaskPayload('search_drive', { files: [{ id: 'f1', name: 'fixture' }], nextPageToken: 'page-2' }, { query: 'fixture' });
  assert.equal(unsupported.status, 'partial'); assert.equal(unsupported.next_cursor, null);
  assert.match(unsupported.coverage, /not exposed/); assert.doesNotMatch(unsupported.coverage, /continue with/);
});

test('every read declares exposure and local calendar and memory stay clean', () => {
  const registry = createRegistry({ authority: new FakeAuthority(), execute: async () => failed('fixture') });
  for (const tool of registry.values()) if (tool.effect === 'none') assert.equal(typeof tool.outside_text, 'boolean', tool.name);
  assert.equal(registry.get('calendar_events')!.outside_text, false);
  assert.equal(registry.get('read_memory')!.outside_text, false);
  assert.equal(registry.get('read_mail')!.outside_text, true);
  assert.equal(registry.get('search_web')!.outside_text, true);
});

import { resolveTaskModels } from '../config/tasks.js';
test('task model roles default independently to Terra low and support Gemini explicitly', () => {
  const defaults = resolveTaskModels(undefined);
  assert.equal(defaults.worker.model, 'gpt-6.1-terra'); assert.equal(defaults.effect_check.model, 'gpt-6.1-terra');
  assert.equal(defaults.worker.effort, 'low'); assert.equal(defaults.effect_check.effort, 'low');
  const selected = resolveTaskModels({ worker: { provider: 'gemini', model: 'gemini-3.8-flash' } });
  assert.equal(selected.worker.provider, 'gemini'); assert.equal(selected.worker.model, 'gemini-3.8-flash');
  assert.equal(selected.effect_check.model, 'gpt-6.1-terra');
  assert.throws(() => resolveTaskModels({ worker: { effort: 'unbounded' } }));
  assert.throws(() => resolveTaskModels({ worker: { tools: ['send'] } }));
});

test('R29 native chat capabilities have distinct outside-read schemas, not action-dependent modes', () => {
  const registry = createRegistry({ execute: async () => documentResult('native result', 'fixture'), authority: new FakeAuthority() });
  for (const [name, selector] of [
    ['chat_attention', 'days'], ['chat_person', 'person'], ['chat_channel', 'channel'],
    ['chat_group', 'people'], ['chat_overview', 'person'],
    ['chat_person_topics', 'person'], ['chat_channel_topics', 'channel'],
  ]) {
    const tool = registry.get(name!);
    assert.ok(tool, `the helper can select ${name}`);
    assert.equal(tool.outside_text, true);
    assert.equal(tool.effect, 'none');
    const fields = tool.parameters.properties as Record<string, unknown>;
    assert.ok(Object.hasOwn(fields, selector!));
    assert.equal(Object.hasOwn(fields, 'mode'), false);
    assert.equal(Object.hasOwn(fields, 'intent'), false);
    if (selector === 'person' || selector === 'channel') assert.equal(Object.hasOwn(fields, selector === 'person' ? 'channel' : 'person'), false);
  }
});

test('worker inference receives public instructions followed by presentation style, never lore', async () => {
  const { runWorker } = await import('../tasks/worker.js');
  const { WORKER_INSTRUCTIONS } = await import('../tasks/instructions.js');
  const profile = { schemaVersion: 1 as const, kind: 'profile' as const, ownerId: 'synthetic', profileVersion: '1', displayName: 'Synthetic Owner',
    style: { text: 'SYNTHETIC STYLE', dataClass: 'private' as const }, lore: { text: 'SYNTHETIC LORE', dataClass: 'sensitive' as const } };
  let received = '';
  const options = { registry: new Map(), identity: { task_id: 'fixture', task_revision: 1, connection_generation: 1 },
    input: 'synthetic', signal: new AbortController().signal, profile,
    infer: async (request: InferRequest) => { received = request.instructions; return { text: 'complete', calls: [] }; } };
  await runWorker(options);
  assert.ok(received.startsWith(`${WORKER_INSTRUCTIONS}\n\n`));
  assert.match(received, /SYNTHETIC STYLE/);
  assert.doesNotMatch(received, /SYNTHETIC LORE/);
  received = '';
  const { profile: omittedProfile, ...withoutProfile } = options;
  assert.ok(omittedProfile);
  await runWorker(withoutProfile);
  assert.equal(received, WORKER_INSTRUCTIONS);
});

test('company search preserves the native ref rather than a numeric record id', async () => {
  const { projectTaskPayload } = await import('../tasks/connectors.js');
  const result = projectTaskPayload('search_company', { results: [{ id: 63, ref: 'ticket:63', title: 'Synthetic' }] }, { query: 'Synthetic' });
  assert.equal(result.references[0]?.id, 'ticket:63');
  const plain = projectTaskPayload('search_company', { results: [{ id: 'ticket:64', title: 'Synthetic' }] }, { query: 'Synthetic' });
  assert.equal(plain.references[0]?.id, 'ticket:64');
});

test('company continuation sends native cursor and depth and preserves remote coverage', async () => {
  const { connectorExecutor } = await import('../tasks/connectors.js');
  const policy: import('../tools/types.js').ConnectionPolicy = {
    schemaVersion: 1, ownerId: 'fixture', connectionId: 'fixture', generation: 1, enabled: true, connector: 'mongoose',
    endpoint: { id: 'fixture', url: 'https://fixture.example.test/mcp', account: 'fixture', resource: 'mongoose:knowledge', credentialRef: null },
    toolNames: ['read'], schemaDigest: 'fixture',
    sourcePolicy: { id: 'fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] }, route: { identity: 'fixture', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 4000, maxSearchLimit: 25, maxGetIds: 10, maxEntityBytes: 100000, maxResultBytes: 100000 },
  };
  const seen: Record<string, unknown>[] = [];
  const reader: import('../connectors/index.js').ConnectorReader = { call: async (_name, args) => {
    seen.push(args);
    return { state: 'completed', decodedResult: args.cursor ? { text: 'second page', coverage: { complete: true } } : { text: 'first page', next_cursor: 'native-page-2', coverage: { complete: false } } } as unknown as import('../connectors/index.js').ConnectorEvidence;
  } };
  const execute = connectorExecutor([{ connector: 'mongoose', policy, reader }]);
  const first = await execute('read_company', { ref: 'ticket:63', depth: 'all' }, new AbortController().signal);
  assert.equal(first.status, 'partial');
  assert.equal(first.next_cursor, 'native-page-2');
  const next = await execute('read_company', { ref: 'ticket:63', depth: 'all', cursor: first.next_cursor }, new AbortController().signal);
  assert.deepEqual(seen[1], { ref: 'ticket:63', depth: 'all', cursor: 'native-page-2' });
  assert.equal(next.text, 'second page');
  assert.equal(next.next_cursor, null);
});

class TaskTestClock {
  time = 0;
  callbacks = new Map<() => void, number>();
  now = (): number => this.time;
  timer = (callback: () => void, ms: number): (() => void) => { this.callbacks.set(callback, this.time + ms); return () => { this.callbacks.delete(callback); }; };
  advance(ms: number): void {
    this.time += ms;
    for (const [callback, due] of [...this.callbacks]) if (due <= this.time) { this.callbacks.delete(callback); callback(); }
  }
}
function taskDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('revision joins a still-running read without aborting it', async () => {
  const { runWorker } = await import('../tasks/worker.js');
  const reads = new Map<string, import('../tasks/results.js').ToolResult>();
  const started = taskDeferred<void>(), response = taskDeferred<import('../tasks/results.js').ToolResult>();
  let executions = 0, readAborted = false;
  const registry = createRegistry({ authority: new FakeAuthority(), execute: async (_name, _args, signal) => {
    executions++; signal.addEventListener('abort', () => { readAborted = true; }); started.resolve(); return response.promise;
  } });
  const { TaskController, FakeDelivery } = await import('../tasks/controller.js');
  const controller = new TaskController(new FakeDelivery());
  const old = controller.finalize('synthetic first fragment', 1);
  const clock = new TaskTestClock();
  const makeInfer = (): import('../tasks/worker.js').Infer => { let hop = 0; return async () => ++hop === 1 ? { text: '', calls: [{ id: 'read', name: 'search_memory', args: { query: 'synthetic' } }] } : { text: 'Local evidence', calls: [] }; };
  const common = { registry, reads, clock, input: 'synthetic' };
  const first = runWorker({ ...common, identity: { task_id: 'fixture', task_revision: 1, connection_generation: 1 }, signal: old.signal, infer: makeInfer() });
  await started.promise;
  const next = controller.finalize('synthetic continuation', 1);
  const second = runWorker({ ...common, identity: { task_id: 'fixture', task_revision: 2, connection_generation: 1 }, signal: next.signal, infer: makeInfer() });
  response.resolve(documentResult('Synthetic finding', 'memory:1'));
  assert.equal((await first).status, 'cancelled');
  const answer = await second;
  assert.equal(executions, 1);
  assert.equal(readAborted, false);
  assert.equal(answer.findings[0]?.text, 'Synthetic finding');
});

test('deadline composes completed evidence without tools and gives composition 24 seconds', async () => {
  const { runWorker } = await import('../tasks/worker.js');
  const clock = new TaskTestClock(), localDone = taskDeferred<void>(), webStarted = taskDeferred<void>(), composing = taskDeferred<void>();
  const composition = taskDeferred<import('../tasks/worker.js').Inference>();
  const registry = createRegistry({ authority: new FakeAuthority(), execute: async name => {
    if (name === 'search_memory') return documentResult('Synthetic local finding', 'memory:1');
    webStarted.resolve(); return new Promise(() => {});
  } });
  const reads = new Map<string, import('../tasks/results.js').ToolResult>();
  reads.set = (key, value) => { Map.prototype.set.call(reads, key, value); localDone.resolve(); return reads; };
  let hop = 0;
  const work = runWorker({ registry, reads, clock, identity: { task_id: 'fixture', task_revision: 1, connection_generation: 1 }, input: 'synthetic', signal: new AbortController().signal,
    infer: async request => {
      if (++hop === 1) return { text: '', calls: [{ id: 'local', name: 'search_memory', args: { query: 'synthetic' } }, { id: 'web', name: 'search_web', args: { query: 'synthetic' } }] };
      assert.equal(request.tools.length, 0);
      assert.ok(request.outputs.some(output => output.result.text === 'Synthetic local finding'));
      assert.ok(request.outputs.some(output => output.name === 'search_web' && output.result.status === 'failed'));
      composing.resolve(); return composition.promise;
    } });
  await Promise.all([localDone.promise, webStarted.promise]);
  clock.advance(36000);
  await Promise.race([composing.promise, work.then(() => { throw new Error('Worker returned without composing completed evidence'); })]);
  clock.advance(13000);
  composition.resolve({ text: 'Synthetic local finding. Web did not finish.', calls: [] });
  const answer = await work;
  assert.equal(answer.status, 'incomplete');
  assert.equal(answer.text, 'Synthetic local finding. Web did not finish.');
  assert.equal(answer.findings.length, 1);
});


test('reader failures carry actionable closed categories without exception text', async () => {
  const { connectorExecutor } = await import('../tasks/connectors.js');
  const { attachHostLogSink } = await import('../tools/host-events.js');
  const { safeEvent } = await import('../host/log.js');
  const events: unknown[] = [];
  const detach = attachHostLogSink({ event: raw => { const safe = safeEvent(raw); if (safe) events.push(safe); } });
  const policy: import('../tools/types.js').ConnectionPolicy = {
    schemaVersion: 1, ownerId: 'fixture', connectionId: 'fixture', generation: 1, enabled: true, connector: 'mongoose',
    endpoint: { id: 'fixture', url: 'https://fixture.example.test/mcp', account: 'fixture', resource: 'mongoose:knowledge', credentialRef: null },
    toolNames: ['read'], schemaDigest: 'fixture',
    sourcePolicy: { id: 'fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] }, route: { identity: 'fixture', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 4000, maxSearchLimit: 25, maxGetIds: 10, maxEntityBytes: 100000, maxResultBytes: 100000 },
  };
  let throws = false;
  const reader: import('../connectors/index.js').ConnectorReader = { call: async () => {
    if (throws) throw new Error('SECRET_SENTINEL_763');
    return { state: 'refused', reason: 'not_found' } as unknown as import('../connectors/index.js').ConnectorEvidence;
  } };
  try {
    const execute = connectorExecutor([{ connector: 'mongoose', policy, reader }]);
    const missing = await execute('read_company', { ref: 'ticket:63' }, new AbortController().signal);
    assert.equal(Reflect.get(missing, 'failure_category'), 'not_found');
    assert.match(missing.repair!, /search_company/);
    assert.match(missing.repair!, /ref.*verbatim/i);
    throws = true;
    const secret = await execute('read_company', { ref: 'ticket:63' }, new AbortController().signal);
    assert.equal(Reflect.get(secret, 'failure_category'), 'upstream_error');
    assert.ok(events.some(event => Reflect.get(event as object, 'category') === 'not_found'));
    assert.doesNotMatch(JSON.stringify([missing, secret, events]), /SECRET_SENTINEL_763/);
  } finally { detach(); }
});

test('tool execution telemetry is closed and includes duration and cache joins', async () => {
  const { runWorker } = await import('../tasks/worker.js');
  const { attachHostLogSink } = await import('../tools/host-events.js');
  const { safeEvent } = await import('../host/log.js');
  const clock = new TaskTestClock();
  const events: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { const safe = safeEvent(raw); if (safe?.event === 'task_tool') events.push(safe); } });
  const registry = createRegistry({ authority: new FakeAuthority(), execute: async () => { clock.advance(7); return documentResult('PRIVATE_RESULT', 'local'); } });
  let hop = 0;
  try {
    await runWorker({ registry, clock, identity: { task_id: 'fixture', task_revision: 1, connection_generation: 1 }, input: 'PRIVATE_WORDS', signal: new AbortController().signal,
      infer: async () => ++hop === 1 ? { text: '', calls: ['a', 'b'].map(id => ({ id, name: 'search_memory', args: { query: 'PRIVATE_QUERY' } })) } : { text: 'done', calls: [] } });
    assert.equal(events.length, 2);
    assert.equal(events[0]?.tool, 'search_memory');
    assert.equal(events[0]?.durationMs, 7);
    assert.ok(events.some(event => event.cache === 'join'));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
    assert.equal(safeEvent({ ...events[0], args: { secret: 'PRIVATE_QUERY' } }), undefined);
  } finally { detach(); }
});

test('task cancellation still aborts reads and emits a cancelled terminal event', async () => {
  const { runWorker } = await import('../tasks/worker.js');
  const { attachHostLogSink } = await import('../tools/host-events.js');
  const { safeEvent } = await import('../host/log.js');
  const events: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { const safe = safeEvent(raw); if (safe?.event === 'task_tool') events.push(safe); } });
  const started = taskDeferred<AbortSignal>(), reply = taskDeferred<import('../tasks/results.js').ToolResult>();
  const registry = createRegistry({ authority: new FakeAuthority(), execute: async (_name, _args, signal) => { started.resolve(signal); return reply.promise; } });
  const abort = new AbortController(), clock = new TaskTestClock();
  const work = runWorker({ registry, clock, identity: { task_id: 'fixture', task_revision: 1, connection_generation: 1 }, input: 'synthetic', signal: abort.signal,
    infer: async () => ({ text: '', calls: [{ id: 'read', name: 'search_memory', args: { query: 'synthetic' } }] }) });
  try {
    const signal = await started.promise;
    abort.abort();
    assert.equal(signal.aborted, true);
    assert.equal((await work).status, 'cancelled');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.ok(events.some(event => event.category === 'cancelled'));
  } finally { reply.resolve(documentResult('synthetic', 'entry:1')); await work; detach(); }
});

test('invalid insight identifiers name search_knowledge and valid insight ids reach the reader', async () => {
  const { connectorExecutor } = await import('../tasks/connectors.js');
  const policy: import('../tools/types.js').ConnectionPolicy = {
    schemaVersion: 1, ownerId: 'fixture', connectionId: 'fixture', generation: 1, enabled: true, connector: 'lux-knowledge',
    endpoint: { id: 'fixture', url: 'https://fixture.example.test/mcp', account: 'fixture', resource: 'fixture', credentialRef: null },
    toolNames: ['get_insight'], schemaDigest: 'fixture',
    sourcePolicy: { id: 'fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] }, route: { identity: 'fixture', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 4000, maxSearchLimit: 25, maxGetIds: 10, maxEntityBytes: 100000, maxResultBytes: 100000 },
  };
  const seen: Record<string, unknown>[] = [];
  const reader: import('../connectors/index.js').ConnectorReader = { call: async (_name, args) => { seen.push(args); return { state: 'completed', decodedResult: { text: 'synthetic insight' } } as unknown as import('../connectors/index.js').ConnectorEvidence; } };
  const execute = connectorExecutor([{ connector: 'lux-knowledge', policy, reader }]);
  const invalid = await execute('read_knowledge', { id: 'memory:synthetic' }, new AbortController().signal);
  assert.equal(invalid.failure_category, 'invalid_argument');
  assert.match(invalid.repair!, /search_knowledge/);
  assert.equal(seen.length, 0);
  const valid = await execute('read_knowledge', { id: '63' }, new AbortController().signal);
  assert.equal(valid.text, 'synthetic insight');
  assert.deepEqual(seen[0], { ids: [63] });
});

test('a no-tool answer with no completed reads can compose for thirteen seconds', async () => {
  const { runWorker } = await import('../tasks/worker.js');
  const clock = new TaskTestClock();
  const response = taskDeferred<import('../tasks/worker.js').Inference>();
  const entered = taskDeferred<AbortSignal>();
  const registry = createRegistry({ authority: new FakeAuthority(), execute: async () => { throw new Error('No tool should run'); } });
  const work = runWorker({ registry, clock, identity: { task_id: 'long-answer', task_revision: 1, connection_generation: 1 }, input: 'synthetic long composition', signal: new AbortController().signal,
    infer: async (_request, signal) => { entered.resolve(signal); return response.promise; } });
  const signal = await entered.promise;
  clock.advance(13000);
  response.resolve({ text: 'Synthetic long answer without source reads.', calls: [] });
  const answer = await work;
  assert.equal(signal.aborted, false);
  assert.equal(answer.status, 'complete');
  assert.equal(answer.text, 'Synthetic long answer without source reads.');
  assert.deepEqual(answer.findings, []);
});

for (const provider of ['openai', 'gemini'] as const) for (const text of ['', ' ', '\n']) test(`C-SILENCE: ${provider} empty text parts are trimmed ${JSON.stringify(text)}`, async () => {
  const { createModelPort } = await import('../tasks/model.js');
  const infer = createModelPort({ role: { provider, model: 'synthetic-model', effort: 'low', keyReference: 'synthetic-reference' }, credentials: { resolve: async () => 'synthetic-key' },
    transport: async () => new Response(JSON.stringify(provider === 'openai'
      ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
      : { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] })) });
  const answer = await infer({ instructions: 'Synthetic instructions', input: 'Synthetic ask', outputs: [], turns: [], tools: [], model: 'synthetic-model', effort: 'low' }, new AbortController().signal);
  assert.equal(answer.text, ''); assert.deepEqual(answer.calls, []);
});
