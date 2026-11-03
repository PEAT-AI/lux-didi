import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { TaskRuntime } from '../tasks/runtime.js';
import { Authority } from '../tasks/authority.js';
import { taskDefinitions } from '../tasks/chat.js';
import { declarationsFor } from '../tools/declarations.js';
import { documentResult } from '../tasks/results.js';
import type { JsonObject } from '../adapters/model/types.js';
test('chat declarations execute one read and one write through the shared task registry', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'task-chat-synthetic-')), store = new Store(directory);
  let reads = 0, writes = 0;
  const runtime = new TaskRuntime({ store, contentAllowed: () => false,
    authority: new Authority({ checkEffect: async () => true, log: () => {}, journal: store.taskEffectJournal(() => false) }),
    infer: async () => { throw Error('The chat model, not a second helper inference, owns this turn.'); },
    execute: async name => { if (name === 'alarm_list') reads++; if (name === 'alarm_create') writes++; return documentResult('Synthetic acknowledged operation.', name); },
    delivery: { attach: () => {}, progress: () => {}, deliver: () => {}, closed: () => {} },
  });
  t.after(() => { try { runtime.close(); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); } });
  const revision = runtime.begin('Show my reminders, then add one for tomorrow', 1, 1);
  const results: JsonObject[] = [];
  const registry = taskDefinitions(runtime, revision.identity, { journal: { fail: () => { throw Error('successful isolated task must not fail'); } }, taskVisible: () => true, runTask: (_call, _args, body) => body(), taskIntent: (context, name) => { const { signal: _signal, ...execution } = context; return { ...execution, toolName: name, argumentsHash: 'synthetic' }; }, complete: (_call, response) => { results.push(response); return { id: `result-${results.length}`, sha256: 'a'.repeat(64) }; } });
  const { declarations } = declarationsFor(registry);
  assert.ok(declarations.some(tool => tool.name === 'alarm_list')); assert.ok(declarations.some(tool => tool.name === 'alarm_create'));
  assert.ok(!declarations.some(tool => tool.name.includes('research')));
  for (const [name, args] of [['alarm_list', {}], ['alarm_create', { text: 'Synthetic reminder', at: '2030-01-02T12:00:00Z' }]] as const) {
    const tool = registry.find(tool => tool.name === name)!;
    const result = await tool.execute({ ...args }, { runId: 'synthetic-chat', actorId: 'synthetic-client', authorityEpoch: 'synthetic-epoch', revision: 1,
      accountId: tool.accountId, resourceId: tool.resourceId, executionId: name, signal: new AbortController().signal });
    assert.equal(result.status, 'completed');
  }
  assert.equal(reads, 1); assert.equal(writes, 1); assert.equal(results.length, 2);
  assert.equal((results[1]?.receipt as JsonObject)?.state, 'committed');
});
