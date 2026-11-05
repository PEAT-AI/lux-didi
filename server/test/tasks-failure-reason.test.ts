import './model-port-provider-errors.test.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REASON_CODES, reasonCodeFor, failed, documentResult, rankedResult, type ReasonCode } from '../tasks/results.js';
import { createRegistry } from '../tasks/tools.js';
import { TaskRuntime } from '../tasks/runtime.js';
import { FakeDelivery } from '../tasks/controller.js';
import { Authority } from '../tasks/authority.js';
import { Store } from '../runtime/store.js';
import { safeEvent } from '../host/log.js';
import { TOOL_FAILURE_CODES } from '../adapters/model/types.js';
import { parsePeople, installPeople, peopleLookupResult } from '../people/index.js';

const REQUIRED: readonly ReasonCode[] = ['no_access', 'sign_in_needed', 'not_found', 'wrong_id', 'bad_argument', 'timeout',
  'rate_limited', 'source_down', 'empty_content', 'not_configured', 'cancelled', 'invalid_result', 'unknown'];
const identity = { task_id: 'synthetic-task', task_revision: 1, connection_generation: 1, operation_id: 'synthetic-operation' };
const signal = (): AbortSignal => new AbortController().signal;

/** Every connector refusal code and reason string the executors and descriptors hand a reader today. */
const CONNECTOR_REASONS = ['not_granted', 'restricted', 'endpoint_not_allowed', 'unauthorized', 'not_allowed', 'not_owner_words',
  'not_signed_in', 'auth_failed', 'credential_revoked', 'credential_mismatch', 'rate_limited', 'native_timeout', 'timed out waiting for the source',
  'channel_not_found', 'no_content', 'unavailable', 'child_exited', 'pipe_closed', 'connector_error', 'open_web_failed', 'result_store_unavailable',
  'sdk_protocol_rejected', 'result_store_full', 'result_store_oversize', 'kind_mismatch', 'no_open_intent', 'executor_intent_mismatch',
  'unknown_connector', 'not_configured', 'wrong_source_id', 'cursor_stale', 'invalid_arguments'];

test('FAIL-R1: every closed tool failure code and every connector refusal names a specific reason, never unknown', () => {
  assert.deepEqual([...REASON_CODES].sort(), [...REQUIRED].sort(), 'the reason list is the closed council list');
  for (const code of TOOL_FAILURE_CODES) assert.notEqual(reasonCodeFor(code), 'unknown', `tool failure code ${code} keeps its meaning`);
  for (const reason of CONNECTOR_REASONS) assert.notEqual(reasonCodeFor(reason), 'unknown', `connector refusal ${reason} keeps its meaning`);
  // Paired valid case: a success word is not a failure and is never read as one, and prose with no meaning stays unknown.
  assert.equal(reasonCodeFor('ok'), 'unknown');
  assert.equal(reasonCodeFor('a sentence with no known marker'), 'unknown');
});

test('FAIL-R2: the map keeps distinct meanings apart instead of folding them into one', () => {
  const expected: Record<string, ReasonCode> = {
    not_granted: 'no_access', unauthorized: 'no_access', not_signed_in: 'sign_in_needed', credential_revoked: 'sign_in_needed',
    not_found: 'not_found', channel_not_found: 'not_found', wrong_source_id: 'wrong_id', invalid_arguments: 'bad_argument',
    timeout: 'timeout', rate_limited: 'rate_limited', unavailable: 'source_down', child_exited: 'source_down',
    empty_content: 'empty_content', not_configured: 'not_configured', cancelled: 'cancelled', invalid_result: 'invalid_result' };
  for (const [token, reason] of Object.entries(expected)) assert.equal(reasonCodeFor(token), reason, token);
});

test('FAIL-R3: a failed result carries a closed reason code that survives serialisation, and a success carries none', () => {
  const refused = failed('Ask the owner to sign in to this source.', 'unauthorized', 'sign_in_needed');
  assert.equal(refused.status, 'failed');
  assert.equal(refused.reason_code, 'sign_in_needed');
  assert.match(refused.repair ?? '', /sign in/);
  assert.equal(JSON.parse(JSON.stringify(refused)).reason_code, 'sign_in_needed', 'a plain key, not a symbol, so JSON keeps it');
  // Paired valid case: a resolved read has no reason code at all.
  assert.equal(documentResult('Synthetic body', 'synthetic-id').reason_code, undefined);
});

test('FAIL-R4: every failure path of the task registry yields a closed reason code', async () => {
  const registry = createRegistry({ authority: { authorize: async (_intent: unknown, body: () => Promise<unknown>) => body() } as never,
    execute: async (name: string) => name === 'read_mail'
      ? failed('Check the mail connection, then retry.', 'unauthorized', 'no_access')
      : failed('This source is not reachable right now.', 'unavailable', 'source_down') });
  const seen: string[] = [];
  const record = (result: { status: string; reason_code?: string }): void => {
    if (result.status !== 'failed') return;
    assert.ok(result.reason_code && REASON_CODES.includes(result.reason_code as ReasonCode), `closed reason on ${JSON.stringify(result)}`);
    seen.push(result.reason_code!);
  };
  const run = async (name: string, args: Record<string, unknown>): Promise<{ status: string; reason_code?: string }> => {
    const tool = registry.get(name);
    if (!tool) return failed('Unknown tool.', 'invalid_argument', 'bad_argument');
    return tool.run(args, identity, signal());
  };
  record(await run('no_such_tool', {}));
  record(await run('read_mail', {}));
  record(await run('read_mail', { id: 'synthetic', cursor: null }));
  record(await run('read_thread', { ref: 'synthetic-thread', cursor: null }));
  const aborted = new AbortController(); aborted.abort();
  record(await registry.get('read_mail')!.run({ id: 'synthetic', cursor: null }, identity, aborted.signal));
  assert.ok(seen.includes('no_access') && seen.includes('bad_argument') && seen.includes('source_down'), `paths: ${[...new Set(seen)].join(',')}`);
});

test('FAIL-R5: an empty read is a failure with empty_content while an empty search is only an empty search', () => {
  const blank = documentResult('', 'synthetic-id');
  assert.equal(blank.status, 'failed');
  assert.equal(blank.reason_code, 'empty_content');
  // Paired valid case: a read with text is not a failure.
  assert.equal(documentResult('Synthetic body', 'synthetic-id').status, 'ok');
  const none = rankedResult('Priya Example', []);
  assert.notEqual(none.status, 'failed');
  assert.equal(none.status, 'empty');
  assert.equal(none.reason_code, undefined);
  // Paired valid case: candidates that are not an exact title are still not a failure, and the labels stay as they are.
  const neighbours = rankedResult('Priya Example', [{ id: 'synthetic-person', title: 'Priya Other' }]);
  assert.equal(neighbours.status, 'no_match');
  assert.equal(neighbours.reason_code, undefined);
  assert.match(neighbours.coverage, /1 ranked candidates; 0 exact name matches/);
});

test('FAIL-R6: the answer carries its failures and the next task sees them in its status', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-failure-status-'));
  const store = new Store(directory);
  const inputs: string[] = [];
  const runtime = new TaskRuntime({ store, delivery: new FakeDelivery(),
    authority: new Authority({ checkEffect: async () => true, log: () => {}, journal: store.taskEffectJournal() }),
    execute: async (name: string) => {
      if (name === 'read_mail') return failed('Ask the owner to sign in to the mail source, then retry.', 'unauthorized', 'sign_in_needed');
      throw new Error('synthetic executor fault');
    },
    infer: async request => {
      inputs.push(request.input);
      if (inputs.length === 1) return { text: '', calls: [{ id: 'synthetic-call', name: 'read_mail', args: { id: 'synthetic', cursor: null } }] };
      if (inputs.length === 3) return { text: '', calls: [{ id: 'synthetic-call-2', name: 'read_thread', args: { ref: 'synthetic-thread', cursor: null } }] };
      return { text: 'The source was not readable.', calls: [] };
    } });
  try {
    const first = runtime.finalize('Read the synthetic message', 1);
    const answer = await first.result;
    assert.deepEqual(answer.failures, [{ tool: 'read_mail', reason_code: 'sign_in_needed' }]);
    const second = runtime.finalize('So what happened there', 1);
    const answer2 = await second.result;
    const status = JSON.parse(JSON.parse(inputs.at(-1)!).verified_status) as { failures?: unknown };
    assert.deepEqual(status.failures, [{ tool: 'read_mail', reason_code: 'sign_in_needed' }], 'the next task reads the earlier failures');
    // A thrown executor error names the source as down instead of the old upstream blanket.
    assert.deepEqual(answer2.failures, [{ tool: 'read_thread', reason_code: 'source_down' }]);
  } finally { runtime.close(); store.close(); rmSync(directory, { recursive: true }); }
});

test('FAIL-R7: the operation row records the reason and host repair, and revision evidence records a count and size', () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-reason-store-'));
  const store = new Store(directory);
  try {
    const at = 1800000000000;
    store.saveTaskRevision(identity, ['synthetic owner words'], [], at);
    store.saveTaskOperation({ ...identity, tool: 'read_mail', effect: 'none', state: 'failed', args: { id: 'SYNTHETIC_ARGUMENT' },
      result: failed('Ask the owner to sign in to the mail source, then retry.', 'unauthorized', 'sign_in_needed') }, at);
    const row = store.transaction(tx => tx.get('SELECT result FROM task_operations'))!;
    const summary = JSON.parse(String(row.result)) as Record<string, unknown>;
    assert.equal(summary.reason_code, 'sign_in_needed');
    assert.match(String(summary.repair), /sign in/);
    assert.doesNotMatch(String(row.result), /SYNTHETIC_ARGUMENT/);
    // Paired valid case: a resolved read keeps its plain status and gains no reason code.
    store.saveTaskOperation({ ...identity, operation_id: 'synthetic-operation-ok', tool: 'read_mail', effect: 'none', state: 'committed', args: {},
      result: documentResult('Synthetic body', 'synthetic-id') }, at);
    const ok = JSON.parse(String(store.transaction(tx => tx.get("SELECT result FROM task_operations WHERE operation_id='synthetic-operation-ok'"))!.result)) as Record<string, unknown>;
    assert.equal(ok.category, 'ok');
    assert.equal(ok.reason_code, undefined);
    // Revision evidence is a count and a size, never a failure category it never measured.
    const evidence = JSON.parse(String(store.transaction(tx => tx.get('SELECT evidence FROM task_revisions'))!.evidence)) as Record<string, unknown>;
    assert.equal(evidence.category, undefined);
    assert.equal(evidence.reason_code, undefined);
    assert.equal(typeof evidence.count, 'number');
    assert.equal(typeof evidence.size_bytes, 'number');
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('FAIL-R8: task_tool accepts a closed reason and refuses anything open', () => {
  const base = { event: 'task_tool', taskId: 'synthetic-task', revision: 2, operationId: 'synthetic-operation', tool: 'read_mail', durationMs: 3, category: 'unauthorized', cache: 'miss' };
  assert.ok(safeEvent({ ...base, reason_code: 'no_access' }), 'a failed read logs its reason');
  assert.ok(safeEvent({ ...base, category: 'no_match', reason_code: null }), 'a search that matched nothing logs no reason');
  assert.equal(safeEvent({ ...base, reason_code: 'made_up_reason' }), undefined);
  assert.equal(safeEvent({ ...base, candidates: 'returned' }), undefined, 'the log no longer carries a ranked-search word');
  assert.equal(safeEvent({ ...base }), undefined, 'the closed shape still requires the reason field');
});

test('FAIL-R9: people_lookup asks the roster for the name it owns, so a configured person resolves', async () => {
  installPeople(parsePeople({ version: 1, people: [{ id: 'synthetic-person', name: 'Sandeep Example', aliases: ['Sandy'], role: 'synthetic role',
    circle: 'plantix', project: '', tier: 1, email: ['sandeep.example@example.test'], mattermost: 'sandy', note: '' }] }));
  try {
    const roster = peopleLookupResult({ name: 'Sandy' });
    assert.equal(roster.people[0]?.name, 'Sandeep Example');
    const dispatched: Record<string, unknown>[] = [];
    const registry = createRegistry({ authority: { authorize: async (_intent: unknown, body: () => Promise<unknown>) => body() } as never,
      execute: async (_name: string, args: Record<string, unknown>) => { dispatched.push(args); return peopleLookupResult(args).people.length
        ? { status: 'ok', text: 'Sandeep Example', references: [{ id: 'synthetic-person', title: 'Sandeep Example' }], next_cursor: null, coverage: '1 roster entry.', repair: null }
        : failed('No configured person matches that name.', 'not_found', 'not_found'); } });
    const lookup = registry.get('people_lookup')!;
    assert.deepEqual(Object.keys(lookup.parameters['properties'] as object), ['name'], 'the field is the one the roster tool accepts');
    const answered = await lookup.run({ name: 'Sandy' }, identity, signal());
    assert.equal(answered.status, 'ok');
    assert.deepEqual(dispatched, [{ name: 'Sandy' }], 'the roster receives the name it declared');
    // Paired refusal: the old field name is now refused before dispatch instead of failing upstream in a millisecond.
    const refused = await lookup.run({ query: 'Sandy' }, identity, signal());
    assert.equal(refused.status, 'failed');
    assert.equal(refused.reason_code, 'bad_argument');
    assert.equal(dispatched.length, 1, 'the refused call never reaches the roster');
  } finally { installPeople(null); }
});
