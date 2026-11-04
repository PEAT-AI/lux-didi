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
  const tools = createRegistry({ authority: new FakeAuthority(), execute: connectorExecutor({ read: new Map() }) });
  const result = await tools.get('chat_person')!.run(personArgs(), identity, signal());
  assert.equal(result.status, 'failed');
  assert.match(result.repair ?? '', /not configured/);
  assert.equal(result.text, '');
  assert.deepEqual(result.references, []);
});
