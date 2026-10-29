import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../dist/runtime/store.js';
import { createToolsOwner, toolsMigrations } from '../dist/tools/index.js';
import { attachHostLogSink } from '../dist/tools/host-events.js';
import { safeEvent } from '../dist/host/log.js';
import { sha256 } from '../dist/tools/canonical.js';
import { createMcpAdapter } from '../dist/adapters/mcp/adapter.js';
import { McpRegistry } from '../dist/adapters/mcp/registry.js';
import { MemoryResultStore } from '../dist/adapters/mcp/store.js';
import { noteGmailAccount } from '../dist/tools/open-handles.js';
import { GOOGLE_TOOLS } from '../dist/connectors/google.js';
const here = dirname(fileURLToPath(import.meta.url));
for (const failure of ['full', 'oversize']) {
test(`result store ${failure} is a specific owner failure and reaches the host log`, async () => {
  noteGmailAccount(undefined);
  const home = mkdtempSync(join(tmpdir(), 'didi-loud-errors-'));
  const child = join(here, 'fixtures', 'google-mcp-child.mjs');
  const args = [child, 'normal', join(home, 'child.pid')];
  const store = new Store(join(home, 'data'), toolsMigrations);
  const registry = new McpRegistry();
  const env = { HOME: join(home, 'home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' };
  registry.register({ id: 'gmail', transport: 'stdio', command: process.execPath, args, env, account: 'local', resource: 'google-fixture' });
  registry.enable('gmail'); registry.allowEgress('gmail');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore(failure === 'oversize' ? { maxBytes: 1 } : { maxEntries: 1 }), budgets: { timeoutMs: 4000 } });
  const seen = [];
  const detach = attachHostLogSink({ event: raw => { seen.push(raw); } });
  try {
    const discovery = await adapter.discover('gmail');
    assert.equal(discovery.state, 'discovered');
    if (discovery.state !== 'discovered') throw new Error('not discovered');
    const names = [...GOOGLE_TOOLS];
    let live = null;
    const owner = createToolsOwner({ store, ownerId: store.assistantId, registry, port: adapter, lookupAuthority: async () => live });
    const policy = {
      schemaVersion: 1, ownerId: store.assistantId, connectionId: 'gmail', generation: 1, enabled: true, connector: 'google',
      endpoint: { id: 'gmail', transport: 'stdio', command: process.execPath, args, env, account: 'local', resource: 'google-fixture', credentialRef: null },
      toolNames: names, schemaDigest: discovery.schemaDigest,
      sourcePolicy: { id: 'google-read', revision: 1, unknownClass: 'private', allowedClasses: ['private'] },
      route: { identity: 'voice', allowedClasses: ['private'] },
      bounds: { maxQueryChars: 80, maxSearchLimit: 3, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 },
    };
    owner.applyConnection(policy);
    // Applying a changed policy suspends the endpoint's approval, exactly as the host does; a fresh
    // discovery of the same catalog restores the digest the applied policy names.
    const again = await adapter.discover('gmail');
    assert.equal(again.state, 'discovered');
    registry.approve({ endpointId: 'gmail', schemaDigest: policy.schemaDigest, generation: 1, account: 'local', resource: 'google-fixture', toolNames: names, effect: 'read' });
    if (failure === 'full') {
      const pending = await adapter.call({ endpointId: 'gmail', toolName: 'gmail_search_messages', arguments: {}, generation: 1, account: 'local', resource: 'google-fixture' });
      assert.equal(pending.state, 'completed');
      assert.equal(pending.payload.state, 'available');
    }
    const acceptance = { ownerId: store.assistantId, actorId: 'actor', runId: 'run', authorityEpoch: store.authorityEpoch, revision: 1, route: { identity: 'voice', provider: 'gemini', modelId: 'gemini-2.5-flash', allowedClasses: ['private'] }, allowedClasses: ['private'], connectionIds: ['gmail'] };
    const accepted = store.transaction(tx => owner.snapshotRun(tx, acceptance));
    live = { ...acceptance, acceptedRunHash: accepted.sha256 };
    const callArgs = {};
    const intent = { runId: 'run', actorId: 'actor', authorityEpoch: store.authorityEpoch, revision: 1, executionId: 'run:1:0', toolName: 'gmail_search_messages', argumentsHash: sha256(JSON.stringify(callArgs)), callId: 'call', accountId: 'local', resourceId: 'google-fixture' };
    assert.equal(owner.journal.intent(intent), 'fresh');
    const definition = owner.definitions('run').find(candidate => candidate.name === 'gmail_search_messages');
    assert.ok(definition?.execute);
    const outcome = await definition.execute(callArgs, { ...intent, signal: new AbortController().signal });
    assert.deepEqual(outcome, { status: 'failed', code: `result_store_${failure}` });
    const rows = seen.filter(raw => typeof raw === 'object' && raw !== null && (raw).event === 'tool_classified_failure');
    assert.equal(rows.length, 1, 'exactly one classified-failure row reaches the host log');
    assert.deepEqual(rows[0], { event: 'tool_classified_failure', endpointId: 'gmail', connector: 'google', tool: 'gmail_search_messages', code: `result_store_${failure}` });
    assert.deepEqual(safeEvent(rows[0]), rows[0], 'the host log admits the row and keeps every field');
    assert.equal(safeEvent({ ...(rows[0]), args: { q: 'synthetic' } }), undefined, 'the host log refuses a row carrying arguments');
  } finally {
    detach();
    await adapter.close();
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

}
