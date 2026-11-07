import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { liveMigrations } from '../live/schema.js';
import { LUX_TOOLS, LUX_PARAMS as P } from '../connectors/lux-names.js';
import { VaultWriter, type VaultWriteResult, type VaultTransport } from '../tools/vault-write.js';

const inputSchema = { type: 'object', properties: Object.fromEntries(Object.values(P).map(key => [key, {}])), additionalProperties: false };
function harness(t: TestContext, write: NonNullable<VaultTransport['write']>) {
  const directory = mkdtempSync(join(tmpdir(), 'helper-ledger-'));
  const store = new Store(directory, [...domainMigrations, ...liveMigrations]);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.transaction(tx => {
    for (let id = 1; id <= 12; id++) tx.run('INSERT INTO history_turns(id,live_session_id,journal_first,journal_last,role,text,at) VALUES(?,?,?,?,?,?,?)', [id, 'synthetic-call', id, id, id === 12 ? 'assistant' : 'owner', 'Save this synthetic fact.', 1000]);
  });
  const log: Record<string, unknown>[] = [];
  const writer = () => new VaultWriter({ store, now: () => 1000, log: event => { log.push(event); }, transport: { save: async () => ({ outcome: 'failed' }), write } });
  const args = (turn: string) => ({ requested_turn_id: turn, payload: { [P.title]: 'Synthetic title', [P.content]: 'Synthetic fact', [P.category]: 'PATTERN', [P.followUpState]: 'open' } });
  return { store, writer, args, log };
}

test('helper mutation is durably claimed before dispatch and its receipt settles the same row', async t => {
  let finish!: (value: VaultWriteResult) => void;
  const response = new Promise<VaultWriteResult>(resolve => { finish = resolve; });
  let forwarded: Record<string, unknown> | undefined;
  const h = harness(t, async (_tool, args) => { forwarded = args; return response; });
  const writer = h.writer();
  const pending = writer.writeTask({ sessionId: 'synthetic-call', tool: 'vault_save', operation: LUX_TOOLS.create, inputSchema, maxPayloadBytes: 65536, authorized: () => true, args: h.args('1') });
  const claimed = h.store.transaction(tx => tx.get("SELECT state,operation,live_session_id,utterance_id FROM vault_writes WHERE utterance_id='helper:1'"));
  assert.equal(claimed?.state, 'dispatched', 'a lost process must leave a durable uncertain outcome, not an unjournaled mutation');
  assert.equal(claimed?.operation, LUX_TOOLS.create);
  assert.equal(claimed?.live_session_id, 'synthetic-call');
  assert.equal(forwarded?.[P.idempotencyKey], 'synthetic-call:1:1');
  assert.deepEqual(forwarded?.[P.sourceRef], { app: 'lux-didi', session_id: 'synthetic-call', turn_start_id: '1', turn_end_id: '1', spoken_at: new Date(1000).toISOString(), speaker: 'owner' });
  finish({ disposition: 'created', insight_id: 42, candidates: [{ insight_id: 9 }] });
  assert.deepEqual((await pending).candidates, [{ insight_id: 9 }], 'host never merges or discards candidates');
  const settled = h.store.transaction(tx => tx.get("SELECT state,insight_id FROM vault_writes WHERE utterance_id='helper:1'"));
  assert.equal(settled?.state, 'confirmed');
  assert.equal(settled?.insight_id, '42');
  const restarted = h.writer();
  assert.equal((await restarted.writeTask({ sessionId: 'synthetic-call', tool: 'vault_save', operation: LUX_TOOLS.create, inputSchema, maxPayloadBytes: 65536, authorized: () => true, args: h.args('1') })).disposition, 'refused', 'a new writer cannot reuse an already claimed owner turn');
});

test('helper owner validation and the ten-write budget persist across writer instances', async t => {
  let calls = 0;
  const h = harness(t, async () => { calls++; return { disposition: 'created', insight_id: 42 }; });
  const run = (writer: VaultWriter, turn: string, authorized = true) => writer.writeTask({ sessionId: 'synthetic-call', tool: 'vault_save', operation: LUX_TOOLS.create, inputSchema, maxPayloadBytes: 65536, authorized: () => authorized, args: h.args(turn) });
  assert.equal((await run(h.writer(), '12')).disposition, 'refused');
  assert.equal((await run(h.writer(), '999')).disposition, 'refused');
  assert.equal((await run(h.writer(), '1', false)).disposition, 'refused');
  assert.equal(calls, 0);
  for (let id = 1; id <= 10; id++) assert.equal((await run(h.writer(), String(id))).disposition, 'created');
  assert.equal((await run(h.writer(), '11')).disposition, 'refused');
  assert.equal(calls, 10);
  assert.ok(h.log.every(event => !Object.hasOwn(event, 'content') && !Object.hasOwn(event, 'payload')));
});

test('a failed helper write is settled without retry and keeps its uncertain outcome', async t => {
  let calls = 0;
  const h = harness(t, async () => { calls++; throw Error('synthetic transport cut'); });
  const result = await h.writer().writeTask({ sessionId: 'synthetic-call', tool: 'vault_save', operation: LUX_TOOLS.create, inputSchema, maxPayloadBytes: 65536, authorized: () => true, args: h.args('1') });
  assert.equal(result.reason, 'outcome_unknown');
  assert.equal(h.store.transaction(tx => tx.get("SELECT state FROM vault_writes WHERE utterance_id='helper:1'"))?.state, 'uncertain');
  await h.writer().recovery;
  assert.equal(calls, 1, 'restart must not replay an unknown helper mutation');
});
