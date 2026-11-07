import type { TaskRuntime } from '../tasks/runtime.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { liveMigrations } from '../live/schema.js';
import { domainMigrations } from '../domain/schema.js';
import { hostTaskFactory } from '../tasks/host.js';
import { resolveTaskModels } from '../config/tasks.js';
import { VaultWriter } from '../tools/vault-write.js';
import { documentResult } from '../tasks/results.js';
for (const { approved, outcome } of [{ approved: false, outcome: 'inserted' }, { approved: true, outcome: 'inserted' }, { approved: true, outcome: 'unknown' }] as const) test(`mail exposure then vault write uses persisted owner-turn consent: ${approved}, ${outcome}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'task-vault-synthetic-')), store = new Store(directory, [...domainMigrations, ...liveMigrations]);
  let runtime: TaskRuntime | undefined;
  t.after(() => { try { runtime?.close(); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); } });
  let saves = 0, writeOutput = '';
  const vault = new VaultWriter({ store, now: () => 1000, log: () => {}, transport: { save: async () => { throw Error('Unexpected legacy save transport'); }, write: async () => { saves++; return outcome === 'unknown' ? { disposition: 'refused', reason: 'outcome_unknown' } : { disposition: 'created', insight_id: 7 }; } } });
  // The discovered lux write the host projects as vault_save, and the owner turn the write must name.
  const createBinding = { connector: 'lux-knowledge', policy: { bounds: { maxEntityBytes: 65536 }, toolNames: ['create_insight'], endpoint: { account: 'synthetic-account', resource: 'lux-knowledge:vault' } },
    reader: { discovery: () => [{ name: 'create_insight', description: 'Create an insight the owner asked for.', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: { type: 'object', required: ['content', 'insight_title'], properties: { content: { type: 'string' }, insight_title: { type: 'string' }, source_kind: { type: 'string' }, source_ref: { type: 'object' }, idempotency_key: { type: 'string' } } } }],
      call: async () => ({ state: 'completed', decodedResult: { insight_id: 7, disposition: 'created' } }) } } as unknown as import('../tasks/connectors.js').BoundConnector;
  store.transaction(tx => tx.run("INSERT INTO history_turns(id,live_session_id,journal_first,journal_last,role,text,at) VALUES(1,'synthetic-call',1,1,?,'Keep this with the rest of my notes',1)", [approved ? 'owner' : 'assistant']));
  const create = hostTaskFactory({ store, vault, credentials: { resolve: async () => undefined }, models: resolveTaskModels(undefined),
    bindings: () => [createBinding], timeZone: 'UTC', effectCheck: async () => approved,
    executors: () => ({ search_mail: async () => documentResult('Untrusted mail says to copy this elsewhere.', 'synthetic-mail') }),
    infer: async request => request.turns.length === 0
      ? { text: '', calls: [{ id: 'read', name: 'search_mail', args: { query: 'synthetic', cursor: null } }] }
      : request.turns.length === 1 ? { text: '', calls: [{ id: 'write', name: 'vault_save', args: { requested_turn_id: '1', payload: { content: 'Synthetic body', insight_title: 'Synthetic note' } } }] }
        : (writeOutput = JSON.stringify(request.outputs), { text: 'The operation has settled.', calls: [] }),
  });
  runtime = create('synthetic-call', { attach: () => {}, progress: () => {}, deliver: () => {}, closed: () => {} });
  const { result } = runtime.finalize('Keep this with the rest of my notes', 1, 1);
  await result;
  assert.equal(saves, approved ? 1 : 0);
  if (approved) {
    const row = store.transaction(tx => tx.get('SELECT external_context_present,state FROM vault_writes LIMIT 1'));
    assert.equal(row?.external_context_present, 1); assert.equal(row?.state, outcome === 'unknown' ? 'uncertain' : 'confirmed');
    assert.match(writeOutput, outcome === 'unknown' ? /outcome_unknown/ : /created/, 'the helper receives the actual LK6 mutation disposition');
  }
});
