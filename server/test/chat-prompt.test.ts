import { WORKER_INSTRUCTIONS } from '../tasks/instructions.js';
import { NAYA_WORK_DELIVERY } from '../prompt/live-persona.js';
// C-CHAT: helper guidance is in canonical typed declarations, not a host replybook.
// Real native target resolution, counting and pagination remain in the SDK reader suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAuthority } from '../tasks/authority.js';
import { connectorExecutor } from '../tasks/connectors.js';
import { createRegistry } from '../tasks/tools.js';
import { documentResult, failed, type ToolResult } from '../tasks/results.js';

const identity = { task_id: 'synthetic-chat', task_revision: 1, operation_id: 'read', connection_generation: 1 };
const signal = () => new AbortController().signal;
const registry = (result: ToolResult) => createRegistry({ authority: new FakeAuthority(), execute: async () => result });
function personArgs() { return { person: 'Synthetic Person', sides: null, from_date: null, to_date: null, offset: null, limit: null, order: null }; }

test('C-CHAT: canonical guidance exposes distinct attention, conversation and topic schemas', () => {
  const tools = registry(documentResult('Synthetic native result', 'chat'));
  const names = ['chat_attention', 'chat_person', 'chat_channel', 'chat_group', 'chat_overview', 'chat_person_topics', 'chat_channel_topics'];
  for (const name of names) {
    const tool = tools.get(name)!;
    assert.ok(tool.description.length > 20);
    assert.equal(tool.outside_text, true);
    const properties = tool.parameters.properties as Record<string, unknown>;
    assert.ok(!('intent' in properties) && !('action' in properties));
    assert.deepEqual([...tool.parameters.required as string[]].sort(), Object.keys(properties).sort());
  }
  assert.ok(!tools.has('mattermost_chat') && !tools.has('research'));
  for (const name of names.filter(name => name !== 'chat_attention')) {
    const properties = tools.get(name)!.parameters.properties as Record<string, unknown>;
    assert.ok(properties.from_date && properties.to_date);
  }
});

test('C-CHAT: the canonical read preserves a native header and true count without host narration', async () => {
  const header = 'read: Synthetic Person, 2026-09-25 through 2026-10-25\ncount: 31 messages\nSynthetic evidence.';
  const result = await registry(documentResult(header, 'native-chat')).get('chat_person')!.run(personArgs(), identity, signal());
  assert.equal(result.status, 'ok');
  assert.equal(result.text, header);
  // This proves no host rewrite; native count correctness is covered by the actual SDK suite.
});

test('C-CHAT: a typed ambiguous-person repair is preserved without a scripted ask-back wrapper', async () => {
  const repair = 'Two synthetic people match. Ask which person before reading their messages.';
  const result = await registry(failed(repair)).get('chat_person')!.run(personArgs(), identity, signal());
  assert.equal(result.status, 'failed');
  assert.equal(result.repair, repair);
  assert.equal(result.text, '');
});

test('C-CHAT: an unconfigured reader yields an explicit repair, not a fabricated empty conversation', async () => {
  const tools = createRegistry({ authority: new FakeAuthority(), execute: connectorExecutor([]) });
  const result = await tools.get('chat_person')!.run(personArgs(), identity, signal());
  assert.equal(result.status, 'failed');
  assert.match(result.repair ?? '', /not configured/);
  assert.equal(result.text, '');
  assert.deepEqual(result.references, []);
});

// Chat evidence now reaches the helper through typed task tools, not a research wrapper.
// These tests prove instruction and evidence delivery, not what a model will say.

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

test('C-PROMPT 10.11: the helper picks the source that answers and stops, and leaves conversation to her', () => {
  assert.match(WORKER_INSTRUCTIONS, /She speaks what you write, so you decide what he hears/);
  // REQUIRED 3a keeps the single-companion framing beside the new opening.
  assert.match(WORKER_INSTRUCTIONS, /To him there is one companion, never two\./);
  assert.match(WORKER_INSTRUCTIONS, /returns no_action, so that she answers it herself/);
  assert.match(WORKER_INSTRUCTIONS, /start with the smallest set that can answer it/);
  assert.match(WORKER_INSTRUCTIONS, /Stop as soon as the answer or action is verified/);
  assert.match(WORKER_INSTRUCTIONS, /Use a returned reference only with its own reader/);
  assert.match(WORKER_INSTRUCTIONS, /give all of it now/);
  assert.match(WORKER_INSTRUCTIONS, /answered only from verified host status and task evidence/);
  // The replaced wording must not linger beside the new rules.
  assert.doesNotMatch(WORKER_INSTRUCTIONS, /Start wide, then narrow/);
  assert.doesNotMatch(WORKER_INSTRUCTIONS, /read aloud to him word for word/);
  // Neither public text hands her a quoted line to repeat.
  assert.doesNotMatch(WORKER_INSTRUCTIONS, /"/);
});
