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
  const { TaskController, FakeDelivery } = await import('../tasks/controller.js');
  const controller = new TaskController(new FakeDelivery(), () => 'synthetic-superseded');
  const first = controller.finalize('synthetic first', 1);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const pending = runWorker({ registry: new Map(),
      identity: first.identity,
      input: 'synthetic request', signal: first.signal,
      infer: async () => { entered(); return new Promise(() => {}); },
      profile: { schemaVersion: 1, kind: 'profile', ownerId: 'synthetic', profileVersion: '1', displayName: 'Synthetic',
        style: { text: '', dataClass: 'ordinary' }, lore: { text: '', dataClass: 'ordinary' } } });
    await started;
    const second = controller.finalize('synthetic second', 1);
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.failure, undefined);
    assert.deepEqual(result.failures, []);
    assert.equal(rows.filter(row => row.event === 'task_inference_failed').length, 0);
    assert.equal(rows.filter(row => row.event === 'task_inference_superseded' && row.revision === 1).length, 1);
    const next = await runWorker({ registry: new Map(), identity: second.identity, input: 'synthetic next', signal: second.signal,
      infer: async () => ({ text: 'synthetic complete', calls: [] }) });
    assert.equal(second.identity.task_revision, 2);
    assert.equal(next.status, 'complete');
    assert.equal(next.failure, undefined);
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


test('inference deadline logs deadline, never superseded', async () => {
  const { attachHostLogSink } = await import('../tools/host-events.js');
  const { INFERENCE_DEADLINE_MS } = await import('../tasks/worker.js');
  const rows: any[] = [];
  const detach = attachHostLogSink({ event: row => rows.push(row) });
  const timers = new Map<number, () => void>();
  let now = 0;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const pending = runWorker({ registry: new Map(), identity: { task_id: 'synthetic-deadline', task_revision: 1, connection_generation: 1 },
      input: '', signal: new AbortController().signal,
      clock: { now: () => now, timer: (callback, ms) => { timers.set(ms, callback); return () => { timers.delete(ms); }; } },
      infer: async () => { entered(); return new Promise(() => {}); } });
    await started;
    now = INFERENCE_DEADLINE_MS;
    assert.ok(timers.has(INFERENCE_DEADLINE_MS));
    timers.get(INFERENCE_DEADLINE_MS)!();
    const result = await pending;
    assert.equal(result.failure?.reason_code, 'deadline');
    assert.equal(rows.filter(row => row.event === 'task_inference_superseded').length, 0);
    assert.equal(rows.filter(row => row.event === 'task_inference_failed' && row.reason_code === 'deadline').length, 1);
  } finally { detach(); }
});
