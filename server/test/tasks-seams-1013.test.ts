import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelPort } from '../tasks/model.js';
import { runWorker } from '../tasks/worker.js';
import { TaskDelivery } from '../tasks/delivery.js';
import type { TaskTool } from '../tasks/tools.js';
import { commentaryPart } from './commentary-test.js';

// W2 parses the model's JSON answer into Inference.exact; W3 renders WorkerResult.exact into the
// COMMENTARY header. This is the only test that runs both halves against each other.
test('10.13: a JSON final answer ends as a COMMENTARY header carrying the model exact list verbatim', async () => {
  const spoken = 'Thursday 5 November 09:00 CET is the slot the synthetic plan holds.';
  // The host extractor splits this phrase into "Thursday 5 November" and "09:00 CET"; only the model's
  // own list keeps it whole, so a passing assertion proves the exact list travelled as data.
  const exact = ['Thursday 5 November 09:00 CET'];
  const infer = createModelPort({ role: { keyReference: 'test' }, credentials: { resolve: async () => 'key' },
    transport: async () => Response.json({ status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ spoken, exact }) }] }] }) });
  const result = await runWorker({ registry: new Map<string, TaskTool>(),
    identity: { task_id: 'synthetic-1013-seams', task_revision: 1, connection_generation: 1 },
    input: 'When does the synthetic plan hold its slot?', signal: new AbortController().signal, infer,
    profile: { schemaVersion: 1, kind: 'profile', ownerId: 'synthetic-owner', profileVersion: '1', displayName: 'Synthetic Owner',
      style: { text: 'SYNTHETIC STYLE', dataClass: 'ordinary' }, lore: { text: 'SYNTHETIC SEAM LORE', dataClass: 'ordinary' } } });
  assert.equal(result.status, 'complete');
  assert.equal(result.text, spoken);
  const sent: { text: string; command: string }[] = [];
  const delivery = new TaskDelivery({ isCurrent: () => true,
    append: (_binding, text) => { const command = `command${sent.length + 1}`; sent.push({ text, command }); return command; }, state: () => {} });
  delivery.socket(1);
  delivery.deliver({ task_id: 'synthetic-1013-seams', task_revision: 1, connection_generation: 1 }, result);
  const item = sent.map(sent => commentaryPart(sent.text));
  assert.equal(item[0]!.section, 'header');
  assert.equal(item[0]!.kind, 'result');
  assert.deepEqual(item.filter(part => part.section === 'header').flatMap(part => part.exact), exact);
  delivery.accepted(sent[0]!.command);
  const spokenParts = sent.slice(1).map(sent => commentaryPart(sent.text)).filter(part => part.section === 'content').map(part => part.content).join(' ');
  assert.equal(spokenParts, spoken);
});

test('superseded inference is cancelled without a provider failure', async () => {
  const { attachHostLogSink } = await import('../tools/host-events.js');
  const rows: any[] = [];
  const detach = attachHostLogSink({ event: row => rows.push(row) });
  const abort = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const pending = runWorker({ registry: new Map(),
      identity: { task_id: 'synthetic-superseded', task_revision: 1, connection_generation: 1 },
      input: 'synthetic request', signal: abort.signal,
      infer: async () => { entered(); return new Promise(() => {}); },
      profile: { schemaVersion: 1, kind: 'profile', ownerId: 'synthetic', profileVersion: '1', displayName: 'Synthetic',
        style: { text: '', dataClass: 'ordinary' }, lore: { text: '', dataClass: 'ordinary' } } });
    await started;
    abort.abort();
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.failure, undefined);
    assert.deepEqual(result.failures, []);
    assert.equal(rows.filter(row => row.event === 'task_inference_failed').length, 0);
    assert.equal(rows.filter(row => row.event === 'task_inference_superseded').length, 1);
  } finally { detach(); }
});

test('provider diagnostics classify nested transport failures and bounded HTTP ids', async () => {
  const { ProviderError } = await import('../tasks/model.js');
  const { attachHostLogSink } = await import('../tools/host-events.js');
  const rows: any[] = [];
  const detach = attachHostLogSink({ event: row => rows.push(row) });
  const profile = { schemaVersion: 1 as const, kind: 'profile' as const, ownerId: 'synthetic', profileVersion: '1', displayName: 'Synthetic',
    style: { text: '', dataClass: 'ordinary' as const }, lore: { text: '', dataClass: 'ordinary' as const } };
  const request = { instructions: '', input: '', outputs: [], turns: [], tools: [], model: 'synthetic', effort: 'low' as const };
  try {
    for (const [transport, expected, status, requestId] of [
      [async () => { throw Object.assign(new Error('synthetic private message'), { cause: { code: 'ECONNRESET' } }); }, 'reset', undefined, undefined],
      [async () => new Response('', { status: 429, headers: { 'x-request-id': 'req_synthetic' } }), 'http_429', 429, 'req_synthetic'],
    ] as const) {
      const infer = createModelPort({ role: { keyReference: 'test' }, credentials: { resolve: async () => 'key' }, transport });
      await assert.rejects(() => infer(request, new AbortController().signal), error => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.error_class, expected);
        assert.equal(error.status, status);
        assert.equal(error.request_id, requestId);
        return true;
      });
      await runWorker({ registry: new Map(), identity: { task_id: 'synthetic-provider', task_revision: 1, connection_generation: 1 },
        input: '', signal: new AbortController().signal, infer, profile });
      const row = rows.find(row => row.event === 'task_inference_failed');
      assert.equal(row.provider_error_class, expected);
      assert.equal(row.http_status, status);
      assert.equal(row.request_id, requestId);
      assert.equal(JSON.stringify({ ...row, detail: undefined }).includes('synthetic private message'), false);
      rows.length = 0;
    }
    await runWorker({ registry: new Map(), identity: { task_id: 'synthetic-unknown', task_revision: 1, connection_generation: 1 },
      input: '', signal: new AbortController().signal, infer: async () => { throw new Error('synthetic'); }, profile });
    assert.equal(rows.find(row => row.event === 'task_inference_failed').provider_error_class, 'unknown');
  } finally { detach(); }
});
