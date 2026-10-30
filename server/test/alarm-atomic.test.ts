import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { liveMigrations, validateLiveProfile } from '../live/index.js';
import { composeLive } from '../host/live.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { LiveAuthority } from '../tools/types.js';
import type { ToolCallIntent } from '../adapters/model/types.js';
import { fixture } from './live-voice-fixture.js';

test('alarm atomicity: crash after commit before confirmation leaves one alarm and its durable receipt', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-alarm-atomic-'));
  const migrations = [...domainMigrations, ...liveMigrations, ...toolsMigrations];
  const store = new Store(directory, migrations);
  const provider = await fixture(t);
  const registry = new McpRegistry();
  const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 10000, maxSliceBytes: 512 }), resolveCredential: async () => 'synthetic' });
  t.after(() => port.close());
  let lookup: ((runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>) | undefined;
  const owner = createToolsOwner({ store, ownerId: store.assistantId, registry, port, grantMode: 'owner-trusted-reads',
    lookupAuthority: (id, signal) => lookup?.(id, signal) ?? Promise.resolve(null),
    alarms: { now: Date.now, health: () => ({ degraded: true, reasons: ['shell_unreachable'] }), recheck: () => { throw Error('synthetic_crash_after_commit'); } } });
  const profile = validateLiveProfile({ provider: 'gemini', liveModelId: 'models/synthetic', voice: 'Synthetic', keyReference: 'synthetic',
    route: { enabled: true, provider: 'gemini', modelId: 'models/synthetic', dataClasses: ['ordinary'] }, prompt: { text: 'Synthetic', dataClass: 'ordinary' } });
  const { service } = composeLive(store, directory, { profile, socketFactory: provider.socketFactory, credentials: { resolve: async () => 'synthetic' } }, undefined, undefined,
    { owner, connectionIds: () => [], registerAuthoritySource: source => { lookup = source; } });
  t.after(async () => { await service.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const context = { clientId: 'synthetic-actor', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
  const session = service.create('ordinary', 'synthetic-crash', context);
  const attachment = await service.attach(session.liveSessionId, context);
  await provider.frame(1); provider.send({ setupComplete: {} }); await attachment.ready;
  const signal = new AbortController().signal;
  const authority = (await lookup!(session.liveSessionId, signal))!;
  owner.observeAlarmOwner(session.liveSessionId, 'synthetic-final-journal', 'wake me in one minute', Date.now());
  const tool = owner.liveDefinitions(session.liveSessionId, () => ({ code: 'remembered' })).find(tool => tool.name === 'set_alarm')!;
  const args = {};
  const intent: ToolCallIntent = { runId: authority.runId, actorId: authority.actorId, authorityEpoch: authority.authorityEpoch, revision: authority.revision,
    toolName: tool.name, executionId: randomUUID(), callId: randomUUID(),
    argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'), accountId: tool.accountId, resourceId: tool.resourceId };
  assert.equal(owner.journal.intent(intent), 'fresh');
  await assert.rejects(tool.execute(args, { ...intent, signal }), /synthetic_crash_after_commit/);
  assert.equal(store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 1);
  assert.equal(store.transaction(tx => tx.get('SELECT state FROM tool_calls WHERE execution_id=?', [intent.executionId])?.state), 'completed');
  const replay = await tool.execute(args, { ...intent, signal });
  const recorded = store.transaction(tx => tx.get('SELECT result_id,result_sha256 FROM tool_calls WHERE execution_id=?', [intent.executionId]))!;
  assert.deepEqual(replay, { status: 'completed', result: { id: recorded.result_id, sha256: recorded.result_sha256 } }, 'recorded execution returns the same durable result');
  assert.equal(store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 1, 'replay never creates another alarm');
  // C-RECUR: a replayed recurring set_alarm creates no second series, link or occurrence.
  const recurring: ToolCallIntent = { ...intent, executionId: randomUUID(), callId: randomUUID() };
  owner.observeAlarmOwner(session.liveSessionId, 'synthetic-recurring-journal', 'every saturday at ten remind me to do one hour of cardio', Date.now());
  assert.equal(owner.journal.intent(recurring), 'fresh');
  await assert.rejects(tool.execute(args, { ...recurring, signal }), /synthetic_crash_after_commit/);
  const counts = () => store.transaction(tx => [Number(tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), Number(tx.get('SELECT COUNT(*) AS n FROM alarm_series')?.n), Number(tx.get('SELECT COUNT(*) AS n FROM alarm_occurrences')?.n)]);
  assert.deepEqual(counts(), [2, 1, 1], 'one series with exactly one linked pending occurrence');
  await tool.execute(args, { ...recurring, signal });
  assert.deepEqual(counts(), [2, 1, 1], 'a replayed recurring set_alarm creates nothing');
  await service.shutdown(); store.close();
  const recovered = new Store(directory, migrations);
  try {
    // The reopened store still holds exactly the one-shot occurrence and the one series occurrence.
    assert.equal(recovered.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms WHERE id=?', [intent.executionId])?.n), 1);
    assert.equal(recovered.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarm_series')?.n), 1);
    assert.equal(recovered.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarm_occurrences')?.n), 1);
    assert.equal(recovered.transaction(tx => tx.get('SELECT state FROM tool_calls WHERE execution_id=?', [intent.executionId])?.state), 'completed');
  } finally { recovered.close(); }
});
