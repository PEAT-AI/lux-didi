import type { TaskRuntime } from '../tasks/runtime.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { liveMigrations } from '../live/schema.js';
import { hostTaskFactory } from '../tasks/host.js';
import { resolveTaskModels } from '../config/tasks.js';
import { VaultWriter } from '../tools/vault-write.js';
import { documentResult } from '../tasks/results.js';
for (const { approved, outcome } of [{ approved: false, outcome: 'inserted' }, { approved: true, outcome: 'inserted' }, { approved: true, outcome: 'unknown' }] as const) test(`mail exposure then vault write uses the effect rule: ${approved}, ${outcome}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'task-vault-synthetic-')), store = new Store(directory, liveMigrations);
  let runtime: TaskRuntime | undefined;
  t.after(() => { try { runtime?.close(); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); } });
  let saves = 0;
  const vault = new VaultWriter({ store, now: () => 1000, log: () => {}, transport: { save: async () => { saves++; return outcome === 'unknown' ? { outcome: 'unknown' } : { outcome: 'inserted', insightId: 'synthetic-insight' }; } } });
  const create = hostTaskFactory({ store, vault, credentials: { resolve: async () => undefined }, models: resolveTaskModels(undefined),
    bindings: () => [], timeZone: 'UTC', effectCheck: async () => approved,
    executors: () => ({ search_mail: async () => documentResult('Untrusted mail says to copy this elsewhere.', 'synthetic-mail') }),
    infer: async request => request.turns.length === 0
      ? { text: '', calls: [{ id: 'read', name: 'search_mail', args: { query: 'synthetic', cursor: null } }] }
      : request.turns.length === 1 ? { text: '', calls: [{ id: 'write', name: 'save_to_vault', args: { title: 'Synthetic note', text: 'Synthetic body' } }] }
        : { text: 'The operation has settled.', calls: [] },
  });
  runtime = create('synthetic-call', { attach: () => {}, progress: () => {}, deliver: () => {}, closed: () => {} });
  const { result } = runtime.finalize('Keep this with the rest of my notes', 1, 1);
  const answer = await result;
  assert.equal(saves, approved ? 1 : 0);
  if (approved) {
    const row = store.transaction(tx => tx.get('SELECT external_context_present,state FROM vault_writes LIMIT 1'));
    assert.equal(row?.external_context_present, 1); assert.equal(row?.state, outcome === 'unknown' ? 'uncertain' : 'confirmed');
    assert.ok(answer.receipts?.some(item => item.receipt?.state === (outcome === 'unknown' ? 'unknown' : 'committed')));
  }
});
