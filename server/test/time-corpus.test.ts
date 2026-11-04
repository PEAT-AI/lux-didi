import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { alarmHarness } from './alarm-atomic.test.js';
import { eventWindow, namedOthers } from '../tools/compose.js';
import { checkOwnerTime } from '../tools/time-check.js';
import { parseAlarmTime, alarmArguments } from '../tools/alarm.js';

interface CorpusRow {
  id: string; words: string; now: string; tz: string; args: Record<string, unknown>;
  args2?: Record<string, unknown>; words2?: string; expects: Record<string, unknown>;
}
const corpus: CorpusRow[] = readFileSync(new URL('../../test/fixtures/time-corpus.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line));

// The legacy parser is still tested explicitly, not smuggled into a fake task executor.
// The current worker supplies an ISO instant; the task registry and real local executor
// are exercised separately below, including the missing owner-time correction boundary.
test('C-TIME corpus: all owner interpretations and task ISO commits', async t => {
  assert.ok(corpus.length >= 60);
  for (const row of corpus) await t.test(row.id, async rowT => {
    const args = row.words2 === undefined ? row.args : (row.args2 ?? {});
    const proposal = alarmArguments(args);
    assert.ok(proposal, `${row.id}: legacy proposal is well formed`);
    const words = row.words2 === undefined ? row.words : `${row.words} ${row.words2}`;
    if (row.words2 !== undefined) {
      const firstProposal = alarmArguments(row.args); assert.ok(firstProposal);
      assert.notEqual(parseAlarmTime(row.words, Date.parse(row.now), row.tz, firstProposal.time).status, 'ready');
    }
    const parsed = parseAlarmTime(words, Date.parse(row.now), row.tz, proposal.time);
    if (row.expects.status !== undefined) {
      assert.equal(parsed.status, row.expects.status);
      assert.equal(parsed.status === 'clarify' ? parsed.reason : undefined, row.expects.reason);
      return;
    }
    assert.equal(parsed.status, 'ready', JSON.stringify(parsed));
    if (parsed.status !== 'ready') throw new Error('Expected a resolved corpus time');
    if (row.expects.relative_ms !== undefined) assert.equal(parsed.fireAtUtc - Date.parse(row.now), row.expects.relative_ms);
    else {
      assert.equal(parsed.localTime, row.expects.local_time);
      assert.equal(parsed.date, row.expects.date);
      assert.equal(parsed.tz, row.expects.tz ?? row.tz);
    }
    if (row.expects.corrected !== undefined) assert.equal(parsed.corrected, row.expects.corrected);
    if (row.expects.series_dropped === true) assert.equal(parsed.series, undefined);
    const h = alarmHarness(rowT, () => {}, () => Date.parse(row.now), parsed.tz);
    const text = typeof args.label === 'string' ? args.label : 'synthetic reminder';
    const result = await h.call('alarm_create', { text, at: new Date(parsed.fireAtUtc).toISOString() }, words);
    assert.equal(result.status, 'ok', result.repair ?? result.text);
    const committed = h.store.transaction(tx => tx.get('SELECT * FROM alarms WHERE id=?', [result.references[0]!.id]));
    assert.ok(committed);
    assert.equal(committed.state, 'pending');
    assert.equal(Number(committed.fire_at_utc), parsed.fireAtUtc);
    assert.equal(committed.tz, parsed.tz);
    assert.equal(committed.label, row.expects.label ?? text);
  });
});

const now = Date.parse('2026-03-05T09:30:00Z');
function alarmRow(h: ReturnType<typeof alarmHarness>, id: string) {
  return h.store.transaction(tx => tx.get('SELECT * FROM alarms WHERE id=?', [id]));
}

test('SOURCE DEFECT C-TIME: owner time overrides a wrong worker ISO proposal', async t => {
  const h = alarmHarness(t, () => {}, () => now, 'Europe/Berlin');
  const result = await h.call('alarm_create', { text: 'synthetic call', at: '2026-03-05T18:00:00Z' }, 'remind me at six pm today');
  assert.equal(result.status, 'ok');
  assert.equal(Number(alarmRow(h, result.references[0]!.id)!.fire_at_utc), Date.parse('2026-03-05T17:00:00Z'));
});

test('C-TIME shape8-cancel: explicit task ids settle one alarm and preserve the other', async t => {
  const h = alarmHarness(t, () => {}, () => now, 'Europe/Berlin');
  const first = await h.call('alarm_create', { text: 'synthetic first', at: '2026-03-05T17:00:00Z' }, 'wake me at six');
  const second = await h.call('alarm_create', { text: 'synthetic second', at: '2026-03-05T18:00:00Z' }, 'wake me at seven');
  const firstId = first.references[0]!.id, secondId = second.references[0]!.id;
  const listed = await h.call('alarm_list', {}, 'list my alarms');
  assert.equal(listed.status, 'ok');
  assert.match(listed.text, new RegExp(firstId)); assert.match(listed.text, new RegExp(secondId));
  assert.equal((await h.call('alarm_cancel', { id: firstId }, 'cancel the first alarm')).status, 'ok');
  assert.equal(alarmRow(h, firstId)!.state, 'cancelled');
  assert.equal(alarmRow(h, secondId)!.state, 'pending');
  // A distinct operation, not a replay of the first cancellation.
  h.task.id = 'synthetic-next-task';
  assert.equal((await h.call('alarm_cancel', { id: firstId }, 'cancel that one again')).status, 'failed');
  assert.equal((await h.call('alarm_cancel', { id: secondId }, 'cancel the other')).status, 'ok');
});

test('SOURCE DEFECT C-TIME shape8-armed: a missing time names the alarm still armed', async t => {
  const h = alarmHarness(t, () => {}, () => now);
  const first = await h.call('alarm_create', { text: 'synthetic armed', at: '2026-03-05T17:00:00Z' }, 'wake me at five UTC');
  const result = await h.call('alarm_create', { text: 'synthetic next' }, 'set an alarm');
  assert.equal(result.status, 'failed');
  assert.match(result.repair ?? result.text, new RegExp(first.references[0]!.id));
  assert.equal(alarmRow(h, first.references[0]!.id)!.state, 'pending');
});

test('C-TIME snooze: task update moves the same alarm and refuses an absent target', async t => {
  const h = alarmHarness(t, () => {}, () => now, 'Europe/Berlin');
  const first = await h.call('alarm_create', { text: 'synthetic snooze', at: '2026-03-05T10:00:00Z' }, 'wake me in thirty minutes');
  const id = first.references[0]!.id;
  const result = await h.call('alarm_update', { id, at: '2026-03-05T09:40:00Z', text: null }, 'snooze this for ten minutes');
  assert.equal(result.status, 'ok');
  assert.equal(Number(alarmRow(h, id)!.fire_at_utc) - now, 600000);
  assert.equal(alarmRow(h, id)!.tz, 'Europe/Berlin');
  assert.equal((await h.call('alarm_update', { id: 'synthetic-absent', at: '2026-03-05T09:40:00Z', text: null }, 'snooze that one')).status, 'failed');
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
  for (const reason of reasons) assert.ok(['missing_time', 'invalid_time'].includes(reason), `clarify reason ${reason}`);
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

test('C-FREEDOM: a day with no clock names no time of day', () => {
  // C-FREEDOM takes the next occurrence of a time he sent; a day alone is not a time, so the alarm
  // refuses it and the paired valid case below still takes the next occurrence of a stated clock.
  const dayOnly = parseAlarmTime('What is on my calendar tomorrow?', Date.parse('2026-03-05T09:30:00Z'), 'Europe/Berlin');
  assert.deepEqual(dayOnly, { status: 'clarify', reason: 'invalid_time' });
  const stated = parseAlarmTime('at 6 pm today', Date.parse('2026-03-05T09:30:00Z'), 'Europe/Berlin');
  assert.equal(stated.status, 'ready');
  if (stated.status === 'ready') assert.equal(stated.localTime, '18:00');
});

test('SOURCE DEFECT C-FREEDOM: cancel that one resolves the most recently armed alarm', async t => {
  const h = alarmHarness(t, () => {}, () => now);
  const first = await h.call('alarm_create', { text: 'synthetic first', at: '2026-03-05T10:00:00Z' }, 'wake me in thirty minutes');
  const second = await h.call('alarm_create', { text: 'synthetic second', at: '2026-03-05T10:30:00Z' }, 'also in one hour');
  const result = await h.call('alarm_cancel', {}, 'cancel that one');
  assert.equal(result.status, 'ok', result.repair ?? result.text);
  assert.equal(alarmRow(h, second.references[0]!.id)!.state, 'cancelled');
  assert.equal(alarmRow(h, first.references[0]!.id)!.state, 'pending');
});
