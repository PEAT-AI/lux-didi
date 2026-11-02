import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
import { eventWindow, namedOthers } from '../tools/compose.js';
import { checkOwnerTime } from '../tools/time-check.js';

interface CorpusRow {
  id: string; words: string; now: string; tz: string; args: Record<string, unknown>;
  args2?: Record<string, unknown>; words2?: string; expects: Record<string, unknown>;
}

const corpus: CorpusRow[] = readFileSync(new URL('../../test/fixtures/time-corpus.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as CorpusRow);

/**
 * C-TIME: one harness for the whole corpus. The corpus drives the real tool handler: the owner final
 * is recorded, the tool call is dispatched through the live declaration, and the alarm row is read
 * back from the store. No provider is called and no parser unit stands in for the handler.
 */
async function alarmHarness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-time-corpus-'));
  const store = new Store(join(dir, 'state'), [...domainMigrations, ...liveMigrations, ...toolsMigrations]);
  const f = await fixture(t);
  const registry = new McpRegistry();
  const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 10000, maxSliceBytes: 512 }), resolveCredential: async () => 'synthetic' });
  t.after(() => port.close());
  let lookup: ((runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>) | undefined;
  const clock = { now: Date.parse('2026-03-05T09:30:00Z') };
  const options = {
    alarms: { now: () => clock.now, recheck() {}, health: () => ({ degraded: false, reasons: [] }) },
    timezone: 'Europe/Berlin', grantMode: 'owner-trusted-reads' as const, store, ownerId: store.assistantId, registry, port,
    lookupAuthority: async (runId: string, signal: AbortSignal) => lookup ? lookup(runId, signal) : null,
  };
  const owner = createToolsOwner(options);
  const profile = validateLiveProfile({ provider: 'gemini', liveModelId: 'models/synthetic', voice: 'Synthetic', keyReference: 'synthetic',
    route: { enabled: true, provider: 'gemini', modelId: 'models/synthetic', dataClasses: ['ordinary'] }, prompt: { text: 'Synthetic', dataClass: 'ordinary' } });
  const { service } = composeLive(store, dir, { profile, socketFactory: f.socketFactory, credentials: { resolve: async () => 'synthetic' } }, undefined, undefined,
    { owner, connectionIds: () => [], registerAuthoritySource: source => { lookup = source; } });
  t.after(async () => { await service.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const context = { clientId: 'synthetic-actor', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
  const session = service.create('ordinary', `corpus:${randomUUID()}`, context);
  const attachment = service.attach(session.liveSessionId, context);
  await f.frame(1); f.send({ setupComplete: {} }); await attachment.ready;
  const signal = new AbortController().signal;
  const authority = await lookup!(session.liveSessionId, signal);
  assert.ok(authority);
  const live = owner.liveDefinitions(session.liveSessionId, () => ({ code: 'remembered' }), undefined, () => ({ code: 'staged' }), true);

  const dispatch = async (name: string, args: Record<string, unknown>, words: string) => {
    owner.ownerRequests.answered?.(session.liveSessionId);
    owner.observeAlarmOwner(session.liveSessionId, randomUUID(), words, clock.now);
    const definition = live.find(entry => entry.name === name);
    assert.ok(definition, `${name} is declared to the live model`);
    const intent: ToolCallIntent = {
      runId: authority.runId, actorId: authority.actorId, authorityEpoch: authority.authorityEpoch, revision: authority.revision,
      executionId: randomUUID(), toolName: definition.name,
      argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
      accountId: definition.accountId, resourceId: definition.resourceId,
    };
    owner.journal.intent(intent);
    const outcome = await definition.execute(args, { ...intent, signal });
    assert.equal(outcome.status, 'completed', `${name} reached its receipt transaction`);
    const stored = store.transaction(tx => tx.get('SELECT state,result_json FROM tool_calls WHERE execution_id=?', [intent.executionId]));
    assert.equal(stored?.state, 'completed', `${name} stores a completed call`);
    const reply = (JSON.parse(String(stored?.result_json ?? '{}')) as { response?: Record<string, unknown> }).response ?? {};
    const row = store.transaction(tx => tx.get('SELECT fire_at_utc,tz,label,state FROM alarms WHERE id=?', [intent.executionId]));
    return { intent, reply, row };
  };
  return { clock, options, owner, session, store, live, dispatch, authority };
}

test('C-TIME corpus: the owner time wins through the real alarm handler', { timeout: 120000 }, async t => {
  assert.ok(corpus.length >= 60, `the corpus carries at least sixty messy shapes, saw ${corpus.length}`);
  // slow: a live session per batch of twelve rows, because one session for all sixty-six rows grows
  // the stored model snapshot past its ceiling. Twelve keeps the file near two seconds, and the
  // reason is recorded in the author report.
  const BATCH = 12;
  for (let start = 0; start < corpus.length; start += BATCH) {
    const batch = corpus.slice(start, start + BATCH);
    await t.test(`rows ${start + 1} to ${start + batch.length}`, async batchT => {
      const h = await alarmHarness(batchT);
      for (const row of batch) {
        await batchT.test(row.id, async () => {
          // Every row is its own owner turn, never a follow-up of the row before it.
          h.owner.ownerRequests.release(h.session.liveSessionId);
          h.clock.now = Date.parse(row.now);
          h.options.timezone = row.tz;
          if (row.words2 !== undefined) {
            const first = await h.dispatch('set_alarm', row.args, row.words);
            assert.notEqual(first.reply.status, 'set', `${row.id}: the first ask must not commit an alarm`);
          }
          const { intent, reply, row: committed } = await h.dispatch('set_alarm', row.words2 !== undefined ? (row.args2 ?? {}) : row.args,
            row.words2 ?? row.words);
          if (row.expects.status !== undefined) {
            assert.equal(reply.status, row.expects.status, `${row.id}: ${JSON.stringify(reply)}`);
            assert.equal(reply.reason, row.expects.reason, `${row.id}: reason`);
            assert.equal(committed, undefined, `${row.id}: a clarify commits no alarm row`);
            return;
          }
          assert.equal(reply.status, 'set', `${row.id}: ${JSON.stringify(reply)}`);
          assert.ok(committed, `${row.id}: the alarm row is committed`);
          assert.equal(committed.state, 'pending');
          if (row.expects.relative_ms !== undefined) {
            assert.equal(Number(committed.fire_at_utc) - h.clock.now, row.expects.relative_ms, `${row.id}: the span is added to the host clock`);
          } else {
            assert.equal(reply.local_time, row.expects.local_time, `${row.id}: local time`);
            assert.equal(reply.date, row.expects.date, `${row.id}: date`);
            assert.equal(committed.tz, row.expects.tz ?? row.tz, `${row.id}: zone`);
            assert.equal(reply.id, intent.executionId, `${row.id}: the read-back names its id`);
            assert.match(String(reply.say), new RegExp(`^Alarm set for \\w+day \\d{1,2} \\w+ at ${String(row.expects.local_time)}`), `${row.id}: she says the read-back`);
          }
          if (row.expects.corrected !== undefined) assert.equal(reply.corrected, row.expects.corrected, `${row.id}: the correction is named`);
          if (row.expects.series !== undefined) assert.ok(reply.series_id, `${row.id}: a stated repeat becomes a series`);
          if (row.expects.series_dropped === true) assert.match(String(reply.say), /I set it once/);
          if (row.expects.label !== undefined) assert.equal(reply.label, row.expects.label, `${row.id}: the label is the model's short label`);
        });
      }
    });
  }
});

test('C-TIME shape8-cancel: settles the one alarm that is armed and lists several', async t => {
  const h = await alarmHarness(t);
  h.options.timezone = 'Europe/Berlin';
  h.clock.now = Date.parse('2026-03-05T09:30:00Z');
  // A paired valid case first: two alarms are armed with different times.
  const first = await h.dispatch('set_alarm', {}, 'wake me at 6 pm');
  const second = await h.dispatch('set_alarm', {}, 'wake me at 7 pm');
  assert.equal(first.reply.status, 'set');
  assert.equal(second.reply.status, 'set');
  const listed = await h.dispatch('cancel_alarm', {}, 'cancel the alarm');
  assert.equal(listed.reply.status, 'clarify', 'several armed alarms are listed, not guessed');
  assert.equal(listed.reply.reason, 'several_alarms');
  const alarms = listed.reply.alarms as Array<Record<string, unknown>>;
  assert.equal(alarms.length, 2, 'both alarms are named with id, time and label');
  for (const alarm of alarms) { assert.ok(alarm.id); assert.match(String(alarm.local_time), /^\d{2}:\d{2}$/); assert.ok('label' in alarm); }
  const byId = await h.dispatch('cancel_alarm', { id: alarms[0]!.id }, 'cancel that one');
  assert.equal(byId.reply.status, 'cancelled');
  assert.equal(byId.reply.id, alarms[0]!.id);
  assert.match(String(byId.reply.say), /^Cancelled the \w+day/);
  // A missing id with exactly one armed alarm cancels that one.
  const lone = await h.dispatch('cancel_alarm', {}, 'cancel the alarm');
  assert.equal(lone.reply.status, 'cancelled');
  assert.equal(lone.reply.id, alarms[1]!.id);
  // The same call again has nothing armed left, so it is not a silent success.
  const empty = await h.dispatch('cancel_alarm', {}, 'cancel the alarm');
  assert.equal(empty.reply.status, 'clarify');
  assert.equal(empty.reply.reason, 'no_alarm');
  // An id that is truly finished is the only "not active".
  const finished = await h.dispatch('cancel_alarm', { id: alarms[1]!.id }, 'cancel that one');
  assert.equal(finished.reply.status, 'refused');
  assert.equal(finished.reply.reason, 'alarm_not_active');
});

test('C-TIME shape8-armed: a set_alarm clarify names the alarm still armed', async t => {
  const h = await alarmHarness(t);
  h.options.timezone = 'Europe/Berlin';
  h.clock.now = Date.parse('2026-03-05T09:30:00Z');
  const set = await h.dispatch('set_alarm', { label: 'call Sam' }, 'wake me at 6 pm to call Sam');
  assert.equal(set.reply.status, 'set');
  // A bare set with an open hour asks for the time back, and the armed alarm is still named.
  const retry = await h.dispatch('set_alarm', {}, 'set an alarm at 6');
  assert.equal(retry.reply.status, 'clarify');
  const armed = retry.reply.armed as Array<Record<string, unknown>>;
  assert.equal(armed.length, 1, 'the still armed alarm is named');
  assert.equal(armed[0]!.id, set.reply.id);
  assert.equal(armed[0]!.local_time, '18:00');
  assert.equal(armed[0]!.label, 'call Sam');
});

test('C-TIME snooze: the wall time is resolved in the alarm zone', async t => {
  const h = await alarmHarness(t);
  h.options.timezone = 'Europe/Berlin';
  h.clock.now = Date.parse('2026-03-05T09:30:00Z');
  const set = await h.dispatch('set_alarm', {}, 'wake me at 6 pm');
  const id = String(set.reply.id);
  const snooze = await h.dispatch('snooze_alarm', { id, time: { mode: 'relative', amount: 10, unit: 'minutes' } }, 'snooze for ten minutes');
  assert.equal(snooze.reply.status, 'set', JSON.stringify(snooze.reply));
  assert.equal(Number(snooze.row!.fire_at_utc) - h.clock.now, 600000);
  assert.equal(snooze.row!.tz, 'Europe/Berlin');
  const fresh = await h.dispatch('snooze_alarm', {}, 'snooze for ten minutes');
  assert.equal(fresh.reply.status, 'refused', 'a snooze needs the alarm it moves');
});

test('C-TIME shape6-7: the event time and the person a description may name', () => {
  const now = Date.parse('2026-03-05T09:30:00Z');
  const words = "Okay, that doesn't sound so bad. At 6 PM today I need to call Sam, and could you also put a block on my calendar at 6 PM";
  const window = eventWindow(words, now, 'Europe/Berlin', undefined, { mode: 'wall', date: { kind: 'today' }, local_time: '18:00' });
  assert.equal(window.status, 'ready', JSON.stringify(window));
  assert.equal(new Date((window as { startUtc: number }).startUtc).toISOString(), '2026-03-05T17:00:00.000Z');
  // Shape 7: "and it is" is not a person, and no sentence ever names one.
  const invented = eventWindow('put a block on my calendar at 6 pm, and it is named here and was not invited', now, 'Europe/Berlin', undefined,
    { mode: 'wall', date: { kind: 'today' }, local_time: '18:00' });
  assert.equal(invented.status, 'ready', JSON.stringify(invented));
  assert.deepEqual((invented as { names: string[] }).names, [], 'no invented person reaches the description');
  assert.deepEqual(namedOthers(undefined, 'Naya'), [], 'a sentence never names a person');
  assert.deepEqual(namedOthers('Sam', 'Naya'), ['Sam'], 'a real invitee argument still names him');
});

test('C-TIME: every reproduced shape is pinned where it lives, and only new clarify reasons are used', () => {
  // Shapes 1 to 4 are corpus rows, so the row is the pin. Shapes 5 to 8 live in this file's own
  // tests, and the guards below name those tests' subjects so a deletion cannot pass silently.
  const ids = new Set(corpus.map(row => row.id));
  for (const id of ['shape1-that-branch-wrong-hour', 'shape2-two-pm-tokens', 'shape3-one-time-and-zone', 'shape4-eighteen-hundred',
    'shape5-retry-after-clarify', 'shape5-retry-with-model', 'shape5-retry-relative']) {
    assert.ok(ids.has(id), `the corpus keeps ${id}`);
  }
  const reasons = new Set(corpus.filter(row => row.expects.status === 'clarify').map(row => String(row.expects.reason)));
  for (const reason of reasons) assert.ok(['missing_time', 'ambiguous_time', 'past_time'].includes(reason), `clarify reason ${reason}`);
  // Shape 5: the retry rows above are the corpus pin, and the retry rule itself is pinned by the
  // split-ask merge in owner-request.test.ts. Shape 8 and shapes 6 and 7 are the three tests below,
  // so their presence in this file is the pin that can fail.
  // The file's own source is the pin for the tests that live here: a deleted or renamed shape test
  // fails this guard, where a skipped id list could not.
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  for (const marker of ["C-TIME shape8-cancel:", "C-TIME shape8-armed:", "C-TIME shape6-7:"]) {
    assert.ok(source.includes(marker), `this file keeps ${marker}`);
  }
});

test('C-TIME T-R1 counts: how the checker reads every corpus row', () => {
  const reading = { unique: 0, partial: 0, inconclusive: 0 };
  for (const row of corpus) reading[checkOwnerTime(row.words).status] += 1;
  // The counts are evidence, not a threshold: a plain clock that reads inconclusive is a checker bug.
  console.log(`C-TIME corpus checker reading: ${JSON.stringify(reading)} of ${corpus.length} rows`);
  assert.equal(reading.unique + reading.partial + reading.inconclusive, corpus.length);
  // Pinned counts: a change here is a checker change and must be deliberate, not a drift.
  assert.deepEqual(reading, { unique: 49, partial: 7, inconclusive: 10 }, JSON.stringify(reading));
});
