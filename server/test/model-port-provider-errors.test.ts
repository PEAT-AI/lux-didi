import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelPort } from '../tasks/model.js';
const request = { instructions: '', input: '', outputs: [], turns: [], tools: [], model: 'test', effort: 'low' };
for (const [status, reason] of [[400, 'provider_rejected'], [401, 'provider_auth'], [429, 'provider_rate_limited'], [503, 'provider_unavailable']] as const) {
  test(`provider ${status} retains bounded diagnostic cause`, async () => {
    const infer = createModelPort({ role: { keyReference: 'test' }, credentials: { resolve: async () => 'key' },
      transport: async () => new Response(JSON.stringify({ error: { message: 'uniqueItems ' + 'x'.repeat(3000) } }), { status, headers: { 'x-request-id': 'req-test' } }) });
    await assert.rejects(infer(request, new AbortController().signal), (error: any) => {
      assert.equal(error.name, 'ProviderError'); assert.equal(error.reason_code, reason);
      assert.equal(error.status, status); assert.equal(error.request_id, 'req-test');
      assert.match(error.detail, /uniqueItems/); assert.ok(error.detail.length <= 2000); return true;
    });
  });
}
for (const [body, reason] of [[{ status: 'incomplete' }, 'provider_incomplete'], [{ status: 'completed', output: [] }, 'provider_empty']] as const) {
  test(reason, async () => {
    const infer = createModelPort({ role: { keyReference: 'test' }, credentials: { resolve: async () => 'key' }, transport: async () => Response.json(body) });
    await assert.rejects(infer(request, new AbortController().signal), (error: any) => error.reason_code === reason);
  });
}
test('spoken final answer preserves exact strings as data', async () => {
  const infer = createModelPort({ role: { keyReference: 'test' }, credentials: { resolve: async () => 'key' }, transport: async () => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ spoken: 'Answer', exact: ['verbatim'] }) }] }] }) });
  const answer = await infer(request, new AbortController().signal);
  assert.equal(answer.text, 'Answer'); assert.deepEqual((answer as any).exact, ['verbatim']);
});
