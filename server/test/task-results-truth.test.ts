import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documentResult, failed, outcomeLine, type ToolResult } from '../tasks/results.js';
import { createRegistry } from '../tasks/tools.js';
import { FakeAuthority } from '../tasks/authority.js';
import { runWorker, INFERENCE_DEADLINE_MS } from '../tasks/worker.js';
import { ProviderError } from '../tasks/model.js';
import { FakeDelivery } from '../tasks/controller.js';
import { resultCommentary } from '../tasks/delivery.js';
import { TaskRuntime } from '../tasks/runtime.js';
import { Authority } from '../tasks/authority.js';
import { Store } from '../runtime/store.js';

const identity = { task_id: 't', task_revision: 1, connection_generation: 1 };

class FakeClock {
  time = 0;
  now = (): number => this.time;
  timer = (): (() => void) => () => {};
}

/** One host line per action: successes counted, a failure with its reason, a call still in flight. */
test('the action line counts successes, names a failure reason and says what is still running', () => {
  assert.equal(outcomeLine([]), '');
  assert.equal(outcomeLine([
    { action: 'read_mail', outcome: 'succeeded' }, { action: 'read_mail', outcome: 'succeeded' },
    { action: 'search_knowledge', outcome: 'failed', reason: 'not_found' }, { action: 'open_page', outcome: 'running' },
  ]), 'Actions: read_mail succeeded (2); search_knowledge failed (not_found); open_page still running.');
});

test('two opens and one failed search read as mixed, never as a total failure or a total success', async () => {
  const registry = createRegistry({ authority: new FakeAuthority(), execute: async name =>
    name === 'search_knowledge' ? failed('Search again with an id the search returned.', 'not_found') : documentResult('opened the synthetic page', 'synthetic-open') });
  let hop = 0;
  const result = await runWorker({ registry, identity, input: 'open both synthetic pages and search', signal: new AbortController().signal, infer: async () => {
    return hop++ ? { text: 'Both pages are open; the search did not run.', calls: [] } : { text: '', calls: [
      { id: '1', name: 'read_mail', args: { id: 'first', cursor: null } },
      { id: '2', name: 'read_mail', args: { id: 'second', cursor: null } },
      { id: '3', name: 'search_knowledge', args: { query: 'synthetic', mode: null } },
    ] };
  } });
  assert.equal(result.status, 'complete');
  assert.match(result.text, /Both pages are open/);
  assert.doesNotMatch(result.text, /nothing worked|all failed/i);
  const commentary = resultCommentary(result);
  assert.match(commentary.content, /^Actions: read_mail succeeded \(2\); search_knowledge failed \(not_found\)\./);
  assert.match(commentary.content, /Both pages are open/);
  assert.equal(commentary.kind, 'partial', 'mixed work is partial, never a total failure and never a plain result');
  assert.equal(commentary.what_failed, 'search_knowledge');
});

test('a provider outage is retried once and the answer keeps its verified action', async () => {
  {
    const registry = createRegistry({ authority: new FakeAuthority(), execute: async () => documentResult('opened the synthetic page', 'synthetic-open') });
    let calls = 0;
    const result = await runWorker({ registry, identity, input: 'open the synthetic page', signal: new AbortController().signal, clock: new FakeClock(), infer: async () => {
      calls++;
      if (calls === 1) return { text: '', calls: [{ id: '1', name: 'read_mail', args: { id: 'page', cursor: null } }] };
      if (calls === 2) throw new ProviderError('provider_unavailable', 'synthetic outage');
      return { text: 'The synthetic page is open.', calls: [] };
    } });
    assert.equal(calls, 3, 'one provider call, one bounded retry');
    assert.equal(result.status, 'complete');
    assert.match(result.text, /synthetic page is open/);
    assert.equal(result.failure, undefined, 'the retried outage leaves no failure behind');
    const commentary = resultCommentary(result);
    assert.equal(commentary.kind, 'result');
    assert.equal(commentary.content, result.text, 'one verified action needs no host list in front of her answer');
  }
});

test('a provider outage with no time left is reported as failed, never as done', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const result = await runWorker({ registry: createRegistry({ authority: new FakeAuthority(), execute: async () => documentResult('synthetic', 'id') }), identity,
    input: 'open the synthetic page', signal: new AbortController().signal, clock, infer: async () => {
      calls++;
      clock.time = 36000 - INFERENCE_DEADLINE_MS + 1;
      throw new ProviderError('provider_unavailable', 'synthetic outage');
    } });
  assert.equal(calls, 1, 'no retry once the remaining time cannot hold one');
  assert.equal(result.status, 'incomplete');
  assert.equal(result.failure?.reason_code, 'provider_unavailable');
  assert.doesNotMatch(result.text, /done|complete/i);
  const commentary = resultCommentary(result);
  assert.equal(commentary.kind, 'failure');
  assert.equal(commentary.next_step, 'ask again');
});

test('a call that ends while its task is open settles the persisted task to a terminal state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-results-truth-'));
  const store = new Store(directory), delivery = new FakeDelivery();
  try {
    let entered!: () => void;
    const inFlight = new Promise<void>(resolve => { entered = resolve; });
    const runtime = new TaskRuntime({ store, delivery, execute: () => { entered(); return new Promise<ToolResult>(() => {}); },
      authority: new Authority({ checkEffect: async () => true, log: () => {}, journal: { get: async () => undefined, put: async () => {} } }),
      infer: async () => ({ text: '', calls: [{ id: '1', name: 'read_mail', args: { id: 'page', cursor: null } }, { id: '2', name: 'search_knowledge', args: { query: 'synthetic', mode: null } }] }) });
    const { result } = runtime.finalize('open the synthetic page', 1);
    const row = () => store.transaction(tx => tx.get('SELECT status FROM tasks'));
    await inFlight;
    assert.equal(row()?.status, 'running');
    runtime.close();
    const answer = await result;
    assert.equal(answer.status, 'cancelled');
    assert.deepEqual(answer.actions?.map(action => action.outcome), ['running', 'running'], 'a dispatched call that never answered is still running');
    assert.match(resultCommentary(answer).content, /^Actions: read_mail still running; search_knowledge still running\./,
      'a call that never answered is named as running, never as done and never as failed');
    assert.equal(row()?.status, 'cancelled', 'the row of a task whose call ended is terminal, never running');
    assert.match(String(store.transaction(tx => tx.get('SELECT failure FROM tasks'))?.failure), /cancelled/);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('a task that settled before the call ended keeps its own final state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-results-settled-'));
  const store = new Store(directory), delivery = new FakeDelivery();
  try {
    const runtime = new TaskRuntime({ store, delivery, execute: async () => documentResult('synthetic', 'id'),
      authority: new Authority({ checkEffect: async () => true, log: () => {}, journal: { get: async () => undefined, put: async () => {} } }),
      infer: async () => ({ text: 'Synthetic answer.', calls: [] }) });
    const { result } = runtime.finalize('synthetic ask', 1);
    assert.equal((await result).status, 'complete');
    runtime.close();
    assert.equal(store.transaction(tx => tx.get('SELECT status FROM tasks'))?.status, 'complete', 'session end only settles what is still open');
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('a lone failure with nothing said stays silent, and a lone success is spoken without a host list', () => {
  const failedOnly = { status: 'incomplete' as const, text: '', findings: [], failures: [{ tool: 'search_knowledge', reason_code: 'source_down' as const }],
    actions: [{ action: 'search_knowledge', outcome: 'failed' as const, reason: 'source_down' as const }] };
  assert.equal(resultCommentary(failedOnly).content, '', 'nothing verified, nothing said: the envelope stays empty');
  const succeededOnly = { status: 'complete' as const, text: 'Synthetic answer.', findings: [documentResult('synthetic', 'id')],
    actions: [{ action: 'read_mail', outcome: 'succeeded' as const }] };
  assert.equal(resultCommentary(succeededOnly).content, 'Synthetic answer.');
});
