import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beginHandleSession, endHandleSession, exposeHandles, withOpenHandles } from '../tools/open-handles.js';
import { Authority, createTaskAuthority, type JournalRecord } from '../tasks/authority.js';
import { failed } from '../tasks/results.js';
import { parseAlarmTime } from '../tools/alarm.js';
import { openTarget, resolveWebOpen } from '../tools/open.js';

const corpus = JSON.parse(readFileSync(new URL('../../test/fixtures/owner-utterances.json', import.meta.url), 'utf8')) as {
  id: string; expectedSay?: string; resolve_code?: string; nativeCode?: string; now?: number; clarifyAfter?: number[]; finalOffsetsMs?: number[]; finals: string[]; call: Record<string, string | number | null> & { tool: string };
  code: string; fire_at_utc: number | null;
}[];
const now = Date.UTC(2026, 9, 30, 6);
for (const row of corpus) test(`owner utterance ${row.id}: ${row.finals.join(' / ')}`, async () => {
  const words = row.finals.join(' ');
  const journal = new Map<string, JournalRecord>();
  const owner = new Authority({ journal: { get: async id => journal.get(id), put: async (id, record) => { journal.set(id, record); } }, checkEffect: async () => false, log() {} });
  const kind = row.call.tool.startsWith('open_') ? 'open' : row.call.tool === 'set_alarm' ? 'set_alarm' : 'remember_note';
  if (row.finals.length === 0) {
    const port = createTaskAuthority(owner, { isCurrent: () => true, taskContext: () => undefined, hostUrls: () => [], registry: () => new Map() });
    let executions = 0;
    const result = await port.authorize({ task_id: row.id, task_revision: 1, operation_id: 'synthetic-operation', tool: 'remember_note', effect: 'local', args: {}, outside_text: false }, async () => { executions++; return failed('unexpected execution'); }, new AbortController().signal);
    assert.equal(result.status, 'failed', row.id);
    assert.equal(executions, 0, 'no finalized task means no executor invocation');
    assert.ok(result.repair, 'task refusal supplies a repair instead of a retired per-tool speech template');
    assert.equal(row.code, 'no_owner_request');
    return;
  }
  const decision = await owner.authorize({ task: { id: row.id, revision: 1, ownerWords: words }, effect: kind, arguments: row.call, validate: () => true });
  let code: string = decision.allow ? 'allowed' : decision.code;
  if (code === 'allowed' && kind === 'set_alarm') {
    // C-TIME: the fixture's model epoch is the model's structured time, read as a UTC wall clock.
    const modelEpoch = (row.call.fire_at_utc as number | undefined) ?? row.fire_at_utc ?? undefined;
    // C-TIME: the model states the wall clock and the zone he named, never a UTC epoch.
    const zone = /singapore/i.test(words) ? 'Asia/Singapore' : 'UTC';
    const wall = modelEpoch === undefined ? undefined : new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(modelEpoch);
    const partOf = (type: string) => wall?.find(part => part.type === type)?.value ?? '';
    const modelTime = wall === undefined ? undefined : { mode: 'wall' as const, date: { kind: 'iso' as const, value: `${partOf('year')}-${partOf('month')}-${partOf('day')}` }, local_time: `${partOf('hour')}:${partOf('minute')}`, timezone: zone };
    const parsed = parseAlarmTime(words, (row.now ?? now) + (row.finalOffsetsMs?.at(-1) ?? 0), 'UTC', modelTime);
    code = parsed.status === 'ready' ? 'ready' : parsed.reason;
    if (parsed.status === 'ready') assert.equal(parsed.fireAtUtc, row.fire_at_utc);
  } else if (code === 'allowed' && kind === 'open') {
    const { tool: name, ...args } = row.call;
    beginHandleSession(row.id);
    const shown = withOpenHandles({ text: 'Synthetic page', sources: [{ title: 'Synthetic page', url: 'https://docs.google.com/document/d/synthetic/edit', sourceType: 'web' as const }] });
    exposeHandles(shown.text);
    const result = name === 'open_web'
      ? await resolveWebOpen(args as unknown as Parameters<typeof resolveWebOpen>[0], words, new AbortController().signal)
      : openTarget(name, args as Record<string, string>, words);
    code = 'target' in result ? row.nativeCode ?? 'allowed' : result.code;
    endHandleSession(row.id);
  }
  // C-PERMTIER: there is no alarm cue to judge. A finalized owner turn is the authority, so the row's
  // own expectation is the whole assertion.
  assert.equal(code, row.resolve_code ?? row.code, `${row.id}: ${row.finals.join(' / ')}`);

});

// C-PERMTIER (P-R1): a model turn neither grants nor revokes. His finalized words are the authority,
// and only the exposure fence can hold a free write after them.
test('a completed answer neither grants nor revokes; the task exposure fence decides', async () => {
  const owner = new Authority({ journal: { get: async () => undefined, put: async () => {} }, checkEffect: async () => false, log() {} });
  const request = { task: { id: 'synthetic-task', revision: 1, ownerWords: 'at seven am' }, effect: 'set_alarm' as const, arguments: {}, validate: () => true };
  assert.deepEqual(await owner.authorize(request), { allow: true });
  owner.expose(request.task.id, 'mail');
  const refused = await owner.authorize(request);
  assert.equal(refused.allow, false);
  if (!refused.allow) assert.equal(refused.code, 'not_owner_asked');
});
