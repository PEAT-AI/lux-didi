import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { hostTaskFactory } from '../tasks/host.js';
import { resolveTaskModels } from '../config/tasks.js';
import { FakeDelivery } from '../tasks/controller.js';
import type { ComposeDispatch, ComposeOutcome } from '../tools/types.js';
async function fixture(t: TestContext, configured = true) {
  const directory = mkdtempSync(join(tmpdir(), 'task-draft-synthetic-')), store = new Store(directory, domainMigrations);
  const calls: { input: Parameters<ComposeDispatch['draftChat']>[0]; scope: readonly string[] | undefined }[] = [];
  const options = { store, credentials: { resolve: async () => undefined }, models: resolveTaskModels(undefined), bindings: () => [], contentAllowed: () => false, timeZone: 'UTC',
    ...(configured ? { draftChat: async (input: Parameters<ComposeDispatch['draftChat']>[0], scope?: readonly string[]): Promise<ComposeOutcome> => {
      calls.push({ input, scope }); return { state: 'done', response: { saved: true, draftId: 'synthetic-remote-draft', destination: 'Mattermost', sent: false } };
    } } : {}), effectCheck: async () => true };
  const runtime = hostTaskFactory(options)('synthetic-draft-call', new FakeDelivery(), ['synthetic-mattermost-connection']);
  const revision = runtime.begin('Create a Mattermost draft with the synthetic body', 1, 1);
  t.after(() => { runtime.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { calls, run: (target: string) => runtime.runTool('draft_chat', { target, text: 'Synthetic draft body' }, { ...revision.identity, operation_id: 'synthetic-draft-operation' }, new AbortController().signal) };
}
test('VOICE-R19: chat drafts reach the configured connector and return its receipt rather than a local note', async t => {
  const f = await fixture(t); const result = await f.run('@synthetic-user');
  assert.equal(f.calls.length, 1, 'the existing Mattermost draft connector must run');
  assert.equal(f.calls[0]!.input.person, 'synthetic-user');
  assert.equal(f.calls[0]!.input.message, 'Synthetic draft body');
  assert.ok(f.calls[0]!.input.clientRequestId); assert.deepEqual(f.calls[0]!.scope, ['synthetic-mattermost-connection']);
  assert.match(JSON.stringify(result), /synthetic-remote-draft/);
});
test('VOICE-R19: a thread draft supplies its exact channel and root to the existing connector', async t => {
  const f = await fixture(t); await f.run('thread:synthetic-channel:synthetic-root');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.input.channel, 'synthetic-channel'); assert.equal(f.calls[0]!.input.rootId, 'synthetic-root');
});
test('VOICE-R19: unavailable Mattermost drafts return a plain repair, never a synthetic local success', async t => {
  const f = await fixture(t, false); const result = await f.run('@synthetic-user');
  assert.match(JSON.stringify(result), /not configured/i); assert.doesNotMatch(JSON.stringify(result), /saved locally/i);
});
test('VOICE-R19: a named channel reaches the existing Mattermost draft port', async t => {
  const f = await fixture(t); const result = await f.run('#synthetic-team');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.input.channel, 'synthetic-team');
  assert.equal(f.calls[0]!.input.message, 'Synthetic draft body'); assert.match(JSON.stringify(result), /synthetic-remote-draft/);
});
test('VOICE-R19: an unresolved target repairs without guessing or calling the draft port', async t => {
  const f = await fixture(t); const result = await f.run('ambiguous synthetic target');
  assert.equal(f.calls.length, 0); assert.match(JSON.stringify(result), /exact Mattermost/i);
});
