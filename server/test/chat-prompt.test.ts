// Chat evidence now reaches the helper through typed task tools, not a research wrapper.
// These tests prove instruction and evidence delivery, not what a model will say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../tasks/tools.js';
import { FakeAuthority } from '../tasks/authority.js';
import { documentResult, failed, type ToolResult } from '../tasks/results.js';
import { WORKER_INSTRUCTIONS } from '../tasks/instructions.js';
import { NAYA_WORK_DELIVERY } from '../prompt/live-persona.js';

async function searchChat(query: string, result: ToolResult) {
  const calls: { name: string; query: unknown }[] = [];
  const registry = createRegistry({ authority: new FakeAuthority(), execute: async (name, args) => {
    calls.push({ name, query: args['query'] });
    return result;
  } });
  const returned = await registry.get('search_chat')!.run({ query },
    { task_id: 'synthetic-chat', task_revision: 1, operation_id: 'synthetic-read', connection_generation: 1 }, new AbortController().signal);
  return { returned, calls };
}

test('C-CHAT: the helper receives the person, group or channel query as asked', async () => {
  const query = 'messages from @fixture.user in #fixture-room after:2026-09-25 before:2026-10-01';
  const { calls } = await searchChat(query, documentResult('Synthetic result', 'synthetic-chat'));
  assert.deepEqual(calls, [{ name: 'search_chat', query }]);
  assert.match(WORKER_INSTRUCTIONS, /after: and before:, for mail and for chat alike/);
  assert.match(NAYA_WORK_DELIVERY, /You have no tools and no sight of those sources yourself/);
  assert.match(NAYA_WORK_DELIVERY, /MUST be handed off in the same turn/);
});

test('C-CHAT: source identity, time window and count survive the typed tool result', async () => {
  const evidence = documentResult('Source: #fixture-room. Window: 2026-09-25 to 2026-10-01. Count: 2. Synthetic messages.', 'synthetic-chat');
  const { returned } = await searchChat('#fixture-room after:2026-09-25 before:2026-10-01', evidence);
  assert.deepEqual(returned, evidence);
  assert.match(WORKER_INSTRUCTIONS, /Keep names, numbers and dates exact/);
  assert.match(NAYA_WORK_DELIVERY, /keeping every name, number, date and qualification/);
});

test('C-CHAT: an ambiguous name remains a failed result, not an empty successful read', async () => {
  const evidence = failed('ambiguous_target');
  const { returned } = await searchChat('messages from fixture', evidence);
  assert.deepEqual(returned, evidence);
  assert.notEqual(returned.status, 'ok');
  assert.match(WORKER_INSTRUCTIONS, /A shared first name is not a match by itself/);
});

test('C-CHAT: a missing capability remains a failure instead of a stock line to recite', async () => {
  const evidence = failed('capability_unavailable');
  const { returned } = await searchChat('@fixture.user', evidence);
  assert.deepEqual(returned, evidence);
  assert.match(WORKER_INSTRUCTIONS, /A tool's refusal or failure is a fact/);
  assert.doesNotMatch(WORKER_INSTRUCTIONS, /Say once:/);
});
