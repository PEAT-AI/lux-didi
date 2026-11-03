import test from 'node:test';
import assert from 'node:assert/strict';
import { documentResult, rankedResult, failed } from '../tasks/results.js';
import { createRegistry, validateArguments } from '../tasks/tools.js';
import { FakeAuthority } from '../tasks/authority.js';

test('opened documents are whole up to 24000 with explicit continuation', () => {
  const body = 'x'.repeat(25000);
  const first = documentResult(body, 'synthetic');
  assert.equal(first.text.length, 24000);
  assert.equal(first.status, 'partial');
  assert.equal(first.next_cursor, '24000');
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
test('strict schemas, null pruning and writes pass the one authority port', async () => {
  const calls: unknown[] = [];
  const authority = new FakeAuthority();
  const registry = createRegistry({ execute: async (name, args) => { calls.push({ name, args }); return documentResult('done', 'fixture'); }, authority });
  for (const tool of registry.values()) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.parameters.properties as object).sort(), [...tool.parameters.required as string[]].sort());
    const visit = (value: unknown): void => {
      if (typeof value === 'number') assert.ok(Number.isInteger(value));
      if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(tool.parameters);
  }
  const search = registry.get('search_mail')!;
  assert.equal(validateArguments(search, { query: 'after:2026/01/01', extra: true }).ok, false);
  assert.equal(validateArguments(search, { query: 'after:2026/01/01' }).ok, true);
  const read = registry.get('read_mail')!;
  assert.deepEqual(validateArguments(read, { id: 'm1', cursor: null }), { ok: true, args: { id: 'm1' } });
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
