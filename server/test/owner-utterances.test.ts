import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beginHandleSession, endHandleSession, exposeHandles, withOpenHandles } from '../tools/open-handles.js';
import { OwnerRequests, requestRefusal } from '../tools/owner-request.js';
import { parseAlarmTime } from '../tools/alarm.js';
import { openTarget, resolveWebOpen } from '../tools/open.js';

const corpus = JSON.parse(readFileSync(new URL('../../test/fixtures/owner-utterances.json', import.meta.url), 'utf8')) as {
  id: string; resolve_code?: string; nativeCode?: string; now?: number; clarifyAfter?: number[]; finalOffsetsMs?: number[]; finals: string[]; call: Record<string, string | number | null> & { tool: string };
  code: string; fire_at_utc: number | null;
}[];
const now = Date.UTC(2026, 9, 30, 6);
for (const row of corpus) test(`owner utterance ${row.id}: ${row.finals.join(' / ')}`, async () => {
  const owner = new OwnerRequests(() => 0);
  const observe: (session: string, journalId: string, words: string, at?: number) => void = owner.observe.bind(owner);
  row.finals.forEach((words, i) => {
    observe('synthetic', `final-${i}`, words, (row.now ?? now) + (row.finalOffsetsMs?.[i] ?? 0));
    if (row.clarifyAfter?.includes(i)) { owner.clarify('synthetic', 'set_alarm', 'missing_time'); owner.answered('synthetic'); }
  });
  const kind = row.call.tool.startsWith('open_') ? 'open' : row.call.tool === 'set_alarm' ? 'set_alarm' : 'lux_note';
  const authorization = owner.authorize('synthetic', kind, JSON.stringify(row.call));
  let code: string = authorization.code;
  if (code === 'allowed' && kind === 'set_alarm') {
    const parsed = parseAlarmTime(authorization.words ?? '', ('observedAt' in authorization ? Number(authorization.observedAt) : row.now ?? now), 'UTC', row.call.fire_at_utc as number | undefined ?? undefined);
    code = parsed.status === 'ready' ? 'ready' : parsed.reason;
    if (parsed.status === 'ready') assert.equal(parsed.fireAtUtc, row.fire_at_utc);
  } else if (code === 'allowed' && kind === 'open') {
    const { tool: name, ...args } = row.call;
    beginHandleSession(row.id);
    const shown = withOpenHandles({ text: 'Synthetic page', sources: [{ title: 'Synthetic page', url: 'https://docs.google.com/document/d/synthetic/edit', sourceType: 'web' as const }] });
    exposeHandles(shown.text);
    const result = name === 'open_web'
      ? await resolveWebOpen(args as unknown as Parameters<typeof resolveWebOpen>[0], authorization.words ?? '', new AbortController().signal)
      : openTarget(name, args as Record<string, string>, authorization.words ?? '');
    code = 'target' in result ? row.nativeCode ?? 'allowed' : result.code;
    endHandleSession(row.id);
  }
  assert.equal(code, row.resolve_code ?? row.code);
  if (code === 'no_owner_request') {
    const refused = requestRefusal(code);
    assert.match(refused.say, /no current owner request/i);
    assert.doesNotMatch(refused.say, /I'll try|sure|\n/i);
  }
});

test('a completed answer cannot authorize a spontaneous new action', () => {
  const owner = new OwnerRequests(() => 0);
  owner.observe('synthetic', 'final', 'at seven am');
  owner.answered('synthetic');
  assert.equal(owner.authorize('synthetic', 'set_alarm', 'new').code, 'no_owner_request');
});
