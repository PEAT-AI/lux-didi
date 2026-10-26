// C-STORE-RETENTION unit C: owner content expires in place at 30 days, debug metadata (ids,
// hashes, sizes, key names, timings, reasons) lives 90 days and is never nulled with content.
// Every assertion here is red at base 8249d156: the DELETE trigger aborts, the UPDATE guard
// aborts, and the CHECK refuses a null body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { toolsMigrations } from '../tools/schema.js';
import { domainMigrations } from '../domain/schema.js';
import { liveMigrations } from '../live/schema.js';
import type { SQLValue } from '../contracts/storage.js';
import { sha256 } from '../tools/canonical.js';
import { pruneTraceContent } from '../trace/record.js';
import { resultBodyState } from '../tools/diagnostics.js';
import { projectionAuthentic } from '../tools/diagnostic-input.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const OWNER = 'owner';
const RUN = 'run-1';
const SOURCE = '{"items":[{"id":"a"}]}';
const ARGUMENTS = '{"calendarId":"primary","calendarIds":["a","b"]}';

function withStore(body: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'didi-store-retention-'));
  const store = new Store(dir, toolsMigrations);
  try { body(store); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

/** One sealed connector dispatch under an active call row, with a real body and real arguments. */
function seedDispatch(store: Store, dispatchId: string, executionId: string, startedAt: number,
  options: { fidelity?: string; parentCreatedAt?: number } = {}): void {
  store.transaction(tx => {
    tx.run(`INSERT INTO tool_calls(owner_id,run_id,execution_id,call_id,intent_json,state,created_at) VALUES(?,?,?,?,?,'intent',?)`,
      [OWNER, RUN, executionId, `call-${executionId}`, JSON.stringify({ toolName: 'calendar_list_events' }), options.parentCreatedAt ?? startedAt]);
    tx.run(`INSERT INTO tool_dispatches(dispatch_id,owner_id,run_id,execution_id,ordinal,connector,connection_id,
      policy_sha256,run_snapshot_sha256,binding_digest,schema_digest,source_policy_id,source_policy_revision,account_id,
      resource_id,session_revision,session_class,source_class,authority_epoch,endpoint_id,tool_name,generation,
      arguments_json,arguments_sha256,arguments_fidelity,arguments_key_count,arguments_keys,started_at,started_mono_ms,
      clock_domain,state,completed_at,completed_mono_ms,completed_clock_domain,reason,source_outcome,wire_state,wire_at,
      wire_mono_ms,wire_clock_domain,entity_sha256,entity_bytes,source_json,source_sha256,source_bytes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [dispatchId, OWNER, RUN, executionId, 1, 'google', 'connection', 'p'.repeat(64), 's'.repeat(64), 'b'.repeat(64),
        'd'.repeat(64), 'owner-trusted-reads', 1, 'account', 'resource', 1, 'ordinary', 'ordinary', 'epoch', 'endpoint',
        'calendar_list_events', 1, ARGUMENTS, sha256(ARGUMENTS), options.fidelity ?? 'partial_v1', 2, '["calendarId","calendarIds"]',
        startedAt, 0, 'host', 'completed', startedAt + 10, 10, 'host', 'cancelled-before-dispatch', 'refused', 'observed',
        startedAt + 5, 5, 'host', sha256('entity'), 4, SOURCE, sha256(SOURCE), Buffer.byteLength(SOURCE)]);
  });
}

function dispatchRow(store: Store, dispatchId: string): Record<string, unknown> {
  return store.transaction(tx => tx.get('SELECT * FROM tool_dispatches WHERE dispatch_id=?', [dispatchId])) as Record<string, unknown>;
}

test('a 31 day old dispatch loses its content in place and keeps every metadata claim', () => {
  withStore(store => {
    seedDispatch(store, 'd-old', 'exec-old', T0);
    const report = store.transaction(tx => pruneTraceContent(tx, T0 + 31 * DAY));
    assert.ok(report.dispatches >= 1, 'the pruner reports the dispatch whose content it nulled');
    const row = dispatchRow(store, 'd-old');
    assert.equal(row.source_json, null, 'the connector body is owner content and is gone');
    assert.equal(row.arguments_json, null, 'the argument values are owner content and are gone');
    assert.ok(row.content_pruned_at, 'the row records when its content was pruned');
    assert.equal(row.source_sha256, sha256(SOURCE), 'the body hash outlives the body');
    assert.equal(row.source_bytes, Buffer.byteLength(SOURCE), 'the body size outlives the body');
    assert.equal(row.arguments_sha256, sha256(ARGUMENTS), 'the argument identity hash outlives the values');
    assert.equal(row.arguments_key_count, 2);
    assert.equal(row.arguments_keys, '["calendarId","calendarIds"]', 'the key names outlive the values');
    assert.equal(row.reason, 'cancelled-before-dispatch', 'the connector reason code outlives the body');
    assert.equal(row.started_at, T0, 'the timing outlives the body');
    assert.equal(row.entity_bytes, 4);
  });
});

test('a 10 day old dispatch is untouched', () => {
  withStore(store => {
    seedDispatch(store, 'd-young', 'exec-young', T0 + 21 * DAY);
    store.transaction(tx => pruneTraceContent(tx, T0 + 31 * DAY));
    const row = dispatchRow(store, 'd-young');
    assert.equal(row.source_json, SOURCE);
    assert.equal(row.arguments_json, ARGUMENTS);
    assert.equal(row.content_pruned_at, null);
  });
});

test('a 31 day old chat call loses its result and input in place and keeps its hashes', () => {
  withStore(store => {
    const result = '{"answer":"hello"}';
    store.transaction(tx => {
      tx.run(`INSERT INTO tool_calls(owner_id,run_id,execution_id,call_id,intent_json,state,result_id,result_json,
        result_sha256,input_json,input_sha256,input_fidelity,input_key_count,created_at)
        VALUES(?,?,?,?,?,'completed',?,?,?,?,?,'complete_v1',?,?)`,
        [OWNER, RUN, 'exec-call', 'call-1', JSON.stringify({ toolName: 'search_knowledge' }), 'result-1', result,
          sha256(result), '{"query":"x"}', sha256('{"query":"x"}'), 1, T0]);
    });
    store.transaction(tx => pruneTraceContent(tx, T0 + 31 * DAY));
    const row = store.transaction(tx => tx.get("SELECT * FROM tool_calls WHERE execution_id='exec-call'")) as Record<string, unknown>;
    assert.equal(row.result_json, null);
    assert.equal(row.input_json, null);
    assert.ok(row.content_pruned_at);
    assert.equal(row.result_sha256, sha256(result));
    assert.equal(row.input_sha256, sha256('{"query":"x"}'));
    assert.equal(row.created_at, T0, 'the call row carries the time it can be aged by');
  });
});

test('a 91 day old metadata row is deleted and a 40 day old one is kept', () => {
  withStore(store => {
    const event = (seq: number, at: number): void => {
      store.transaction(tx => tx.run(`INSERT INTO trace_event(live_session_id,kind,source,at,mono_ms,received_at,
        schema_version,detail) VALUES('session-1',?, 'host',?,?,?,1,'{}')`, [`kind-${seq}`, at, seq, at]));
    };
    event(1, T0 - 51 * DAY);
    event(2, T0);
    store.transaction(tx => pruneTraceContent(tx, T0 + 40 * DAY));
    const rows = store.transaction(tx => tx.all('SELECT kind FROM trace_event ORDER BY seq'));
    assert.deepEqual(rows.map(row => row.kind), ['kind-2'], 'metadata is deleted at 90 days, never at 30');
  });
});

test('the triggers refuse a non-null content write and any metadata change', () => {
  withStore(store => {
    seedDispatch(store, 'd-guard', 'exec-guard', T0);
    const refuse = (sql: string, params: unknown[]): void => {
      assert.throws(() => store.transaction(tx => { tx.run(sql, params as never[]); }), /_immutable|_forbidden/, `the guard aborts: ${sql}`);
    };
    refuse("UPDATE tool_dispatches SET source_json='{}' WHERE dispatch_id='d-guard'", []);
    refuse("UPDATE tool_dispatches SET arguments_json='{}' WHERE dispatch_id='d-guard'", []);
    refuse("UPDATE tool_dispatches SET source_json=NULL, reason='rewritten' WHERE dispatch_id='d-guard'", []);
    refuse("UPDATE tool_dispatches SET source_json=NULL, started_at=0 WHERE dispatch_id='d-guard'", []);
    refuse("UPDATE tool_dispatches SET content_pruned_at=1, source_bytes=1 WHERE dispatch_id='d-guard'", []);
    refuse("DELETE FROM tool_dispatches WHERE dispatch_id='d-guard'", []);
  });
});

test('a pruned row reads as pruned, never as a hash mismatch', () => {
  const stored = { result_json: null, result_sha256: sha256('body'), content_pruned_at: T0 };
  assert.equal(resultBodyState(stored, sha256('body')), 'pruned');
  assert.equal(resultBodyState({ ...stored, result_json: 'body', content_pruned_at: null }, sha256('body')), 'ok');
  assert.equal(resultBodyState({ ...stored, result_json: 'tampered', content_pruned_at: null }, sha256('body')), 'mismatch');
});

test('a partial projection is authentic: its values were dropped at write time, so the identity hash never matches', () => {
  const all = ARGUMENTS;
  assert.equal(projectionAuthentic('complete_v1', all, sha256(all)), true);
  assert.equal(projectionAuthentic('complete_v1', '{"calendarId":"primary"}', sha256(all)), false, 'a complete row whose bytes changed is not current');
  assert.equal(projectionAuthentic('partial_v1', '{"calendarId":"primary"}', sha256(all)), true,
    'a partial row is authentic by construction: the hash names the full bytes, which are never retained');
});

test('a 31 day old transcript keeps its row and loses only its text', () => {
  withStore(store => {
    store.transaction(tx => {
      tx.run(`INSERT INTO trace_turn(turn_id,live_session_id,turn_index,origin,opened_at,mono_ms,attribution_uncertain)
        VALUES('t-1','session-1',1,'owner',?,0,0)`, [T0]);
      tx.run(`INSERT INTO trace_utterance(turn_id,role,at,final,text) VALUES('t-1','owner',?,1,'hello')`, [T0]);
    });
    const report = store.transaction(tx => pruneTraceContent(tx, T0 + 31 * DAY));
    assert.equal(report.utterances, 1, 'the pruner reports the transcript it nulled');
    const row = store.transaction(tx => tx.get("SELECT * FROM trace_utterance WHERE turn_id='t-1'")) as Record<string, unknown>;
    assert.equal(row.text, null, 'the transcript row is kept so its turn, role and timing still describe the call');
    assert.ok(row.content_pruned_at);
  });
});

test('the pruner bounds each batch and repeats until the work is done', () => {
  withStore(store => {
    for (let index = 0; index < 3; index += 1) seedDispatch(store, `d-${index}`, `exec-${index}`, T0);
    const report = store.transaction(tx => pruneTraceContent(tx, T0 + 31 * DAY, { batch: 1 }));
    assert.equal(report.dispatches, 3, 'a batch of one still prunes every eligible row');
    const open = store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS n FROM tool_dispatches WHERE source_json IS NOT NULL')!.n));
    assert.equal(open, 0);
  });
});

// L1-review F1: requirement 1 removes the no-delete guard on `tool_calls` and requirement 2 deletes
// the deletable metadata rows at 90 days. A dispatch row is the exception (an audit record), and the
// foreign key is what keeps a call row that still owns one.
test('a 91 day old chat call is deleted unless it still owns a dispatch row', () => {
  withStore(store => {
    seedDispatch(store, 'd-keep', 'exec-keep', T0);
    store.transaction(tx => {
      tx.run("INSERT INTO tool_calls(owner_id,run_id,execution_id,call_id,intent_json,state,created_at) VALUES(?,?,?,?,?,'intent',?)",
        [OWNER, RUN, 'exec-gone', 'call-gone', JSON.stringify({ toolName: 'search_knowledge' }), T0]);
    });
    store.transaction(tx => pruneTraceContent(tx, T0 + 91 * DAY));
    const calls = store.transaction(tx => tx.all('SELECT execution_id FROM tool_calls ORDER BY execution_id').map(row => row['execution_id']));
    assert.deepEqual(calls, ['exec-keep'], 'the call row with no dispatch is deleted at 90 days, the one that owns an audit row is kept');
    assert.equal(dispatchRow(store, 'd-keep').dispatch_id, 'd-keep');
  });
});

// L1-review F3: requirement 2 says bounded batches. Every write the pruner issues carries its own
// LIMIT, including the two that touch the live journal and the accepted prompt snapshot.
test('every prune write is a bounded batch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-store-retention-live-'));
  const store = new Store(dir, [...domainMigrations, ...liveMigrations]);
  try {
    const issued: string[] = [];
    store.transaction(tx => pruneTraceContent({
      run: (sql: string, params: readonly SQLValue[] = []) => { issued.push(sql); return Number(tx.run(sql, params)); },
      all: (sql: string, params: readonly SQLValue[] = []) => tx.all(sql, params),
    }, Date.now()));
    assert.ok(issued.length > 3, 'the pruner issued its passes');
    for (const sql of issued) {
      if (!/^\s*(UPDATE|DELETE)\b/i.test(sql)) continue;
      assert.match(sql, /LIMIT \?/, `unbounded prune write: ${sql.slice(0, 80)}`);
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

// L1-review F5: the fidelity token decides whether a stored projection is hash-verified, so it has
// to be one of the four the code writes, not any string a future writer invents.
test('the fidelity columns accept only the declared tokens', () => {
  withStore(store => {
    assert.throws(() => store.transaction(tx => tx.run(
      "INSERT INTO tool_calls(owner_id,run_id,execution_id,intent_json,state,input_fidelity) VALUES('o','r','exec-fidelity','{}','intent','made_up_v1')")),
    /CHECK constraint failed/, 'an undeclared chat input fidelity is refused');
    assert.throws(() => seedDispatch(store, 'd-fidelity', 'exec-fidelity', T0, { fidelity: 'made_up_v1' }), /CHECK constraint failed/,
      'an undeclared dispatch arguments fidelity is refused');
  });
});
