import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../dist/runtime/store.js';
import { createToolsOwner, toolsMigrations } from '../dist/tools/index.js';
import { sha256 } from '../dist/tools/canonical.js';
import { createMcpAdapter } from '../dist/adapters/mcp/adapter.js';
import { McpRegistry } from '../dist/adapters/mcp/registry.js';
import { MemoryResultStore } from '../dist/adapters/mcp/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function harness() {
  const home = mkdtempSync(join(tmpdir(), 'didi-store-mixed-'));
  const store = new Store(join(home, 'data'), toolsMigrations);
  const registry = new McpRegistry();
  let clock = Date.now(), puts = 0;
  const memory = new MemoryResultStore({ now: () => clock });
  const resultStore = { put(scope, bytes) { puts++; return memory.put(scope, bytes); }, read: (...args) => memory.read(...args) };
  const endpoints = [
    { id: 'chat', connector: 'mattermost', file: 'stdio-mattermost-people-child.mjs', mode: 'people' },
    { id: 'google', connector: 'google', file: 'google-mcp-child.mjs', mode: 'ok' },
    { id: 'knowledge', connector: 'lux-knowledge', file: 'stdio-store-knowledge-child.mjs', mode: 'ok' },
  ].map(entry => ({ ...entry, transport: 'stdio', command: process.execPath, args: [join(here, 'fixtures', entry.file), entry.mode], env: { HOME: home, PATH: '/usr/bin', LOGNAME: '', USER: '', SHELL: '', TERM: '', DIDI_FAKE_MATTERMOST_NOW: String(clock), DIDI_FAKE_MATTERMOST_LOAD: '20' }, account: 'local', resource: entry.id }));
  for (const entry of endpoints) { registry.register({ id: entry.id, transport: entry.transport, command: entry.command, args: entry.args, env: entry.env, account: entry.account, resource: entry.resource }); registry.enable(entry.id); registry.allowEgress(entry.id); }
  const adapter = createMcpAdapter({ registry, store: resultStore, budgets: { timeoutMs: 4000 } });
  let intercept = async (_request, result) => result;
  const port = { ...adapter, call: async (...args) => intercept(args[0], await adapter.call(...args)) };
  const authorities = new Map();
  const owner = createToolsOwner({ store, ownerId: store.assistantId, registry, port, lookupAuthority: async runId => authorities.get(runId) ?? null });
  try {
    const policies = [];
    for (const entry of endpoints) {
      const discovery = await adapter.discover(entry.id);
      assert.equal(discovery.state, 'discovered');
      const toolNames = discovery.tools.map(tool => tool.name).filter(name => !name.includes('post_message') && !name.includes('send_message'));
      const policy = { schemaVersion: 1, ownerId: store.assistantId, connectionId: entry.id, generation: 1, enabled: true, connector: entry.connector,
        endpoint: { id: entry.id, transport: entry.transport, command: entry.command, args: entry.args, env: entry.env, account: entry.account, resource: entry.resource, credentialRef: null },
        toolNames, schemaDigest: discovery.schemaDigest,
        sourcePolicy: { id: entry.id, revision: 1, unknownClass: 'private', allowedClasses: ['private'] }, route: { identity: 'voice', allowedClasses: ['private'] },
        bounds: { maxQueryChars: 200, maxSearchLimit: 50, maxGetIds: 10, maxEntityBytes: 128 * 1024, maxResultBytes: 128 * 1024 } };
      owner.applyConnection(policy); policies.push(policy);
    }
    for (const policy of policies) {
      assert.equal((await adapter.discover(policy.connectionId)).state, 'discovered');
      registry.approve({ endpointId: policy.connectionId, schemaDigest: policy.schemaDigest, generation: 1, account: 'local', resource: policy.connectionId, toolNames: policy.toolNames, effect: 'read' });
    }
    let execution = 0;
    function run(runId) {
      const acceptance = { ownerId: store.assistantId, actorId: 'actor', runId, authorityEpoch: store.authorityEpoch, revision: 1, route: { identity: 'voice', provider: 'gemini', modelId: 'gemini-2.5-flash', allowedClasses: ['private'] }, allowedClasses: ['private'], connectionIds: endpoints.map(entry => entry.id) };
      const accepted = store.transaction(tx => owner.snapshotRun(tx, acceptance));
      authorities.set(runId, { ...acceptance, acceptedRunHash: accepted.sha256 });
      return async (toolName, args) => {
        const id = execution++;
        const intent = { runId, actorId: 'actor', authorityEpoch: store.authorityEpoch, revision: 1, executionId: `${runId}:1:${id}`, toolName, argumentsHash: sha256(JSON.stringify(args)), callId: `call-${id}`, accountId: 'local', resourceId: toolName.startsWith('mattermost') ? 'chat' : toolName === 'search_knowledge' ? 'knowledge' : 'google' };
        assert.equal(owner.journal.intent(intent), 'fresh');
        const definition = owner.definitions(runId).find(tool => tool.name === toolName);
        assert.ok(definition?.execute, `missing ${toolName}`);
        const result = await definition.execute(args, { ...intent, signal: new AbortController().signal });
        assert.equal(result.status, 'completed', `${toolName}: ${JSON.stringify(result)}`);
        return result;
      };
    }
    return { adapter, memory, run, get puts() { return puts; }, get now() { return clock; }, advance() { clock += 1000; }, intercept(fn) { intercept = fn; }, async close() { await adapter.close(); store.close(); rmSync(home, { recursive: true, force: true }); } };
  } catch (error) { await adapter.close(); store.close(); rmSync(home, { recursive: true, force: true }); throw error; }
}

test('40 mixed owner reads in one fake minute, then one more of every kind', async () => {
  const h = await harness();
  try {
    const read = h.run('mixed');
    const start = h.now;
    const kinds = [
      ['person', 'mattermost_chat', { intent: 'person', person: 'Ada' }],
      ['overview', 'mattermost_chat', { intent: 'overview', person: 'Ada' }],
      ['attention', 'mattermost_attention_digest', {}],
      ['calendar', 'calendar_list_events', { calendarId: 'primary', timeMin: new Date(start).toISOString(), timeMax: new Date(start + 86400000).toISOString() }],
      ['search', 'drive_search_files', { query: 'synthetic' }],
      ['knowledge', 'search_knowledge', { query: 'synthetic' }],
    ];
    const seen = new Map();
    for (let index = 0; index < 46; index++) {
      const [kind, name, args] = kinds[index < 40 ? index % kinds.length : index - 40];
      const before = h.puts;
      await read(name, args);
      const entries = h.puts - before;
      assert.ok(entries > 0, `${kind} must reach the adapter`);
      if (kind === 'attention') assert.equal(entries, 20, 'real attention composition produces twenty stored child entities');
      seen.set(kind, (seen.get(kind) ?? 0) + 1);
      h.advance();
    }
    assert.equal(seen.size, 6);
    assert.ok(h.now - start < 60_000);
  } finally { await h.close(); }
});
