import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OwnerRequests } from '../tools/owner-request.js';
import { parseAlarmTime } from '../tools/alarm.js';
import { openTarget, resolveWebOpen } from '../tools/open.js';

const corpus = JSON.parse(readFileSync(new URL('../../test/fixtures/owner-utterances.json', import.meta.url), 'utf8')) as {
  id: string; finals: string[]; call: Record<string, string | number | null> & { tool: string };
  code: string; fire_at_utc: number | null;
}[];
const now = Date.UTC(2026, 9, 30, 6);
for (const row of corpus) test(`owner utterance ${row.id}: ${row.finals.join(' / ')}`, async () => {
  const owner = new OwnerRequests(() => 0);
  row.finals.forEach((words, i) => owner.observe('synthetic', `final-${i}`, words));
  const kind = row.call.tool.startsWith('open_') ? 'open' : row.call.tool === 'set_alarm' ? 'set_alarm' : 'lux_note';
  const authorization = owner.authorize('synthetic', kind, JSON.stringify(row.call));
  let code: string = authorization.code;
  if (code === 'allowed' && kind === 'set_alarm') {
    const parsed = parseAlarmTime(authorization.words ?? '', now, 'UTC', row.call.fire_at_utc as number | undefined ?? undefined);
    code = parsed.status === 'ready' ? 'ready' : parsed.reason;
    if (parsed.status === 'ready') assert.equal(parsed.fireAtUtc, row.fire_at_utc);
  } else if (code === 'allowed' && kind === 'open') {
    const { tool: name, ...args } = row.call;
    const result = name === 'open_web'
      ? await resolveWebOpen(args as unknown as Parameters<typeof resolveWebOpen>[0], authorization.words ?? '', new AbortController().signal)
      : openTarget(name, args as Record<string, string>, authorization.words ?? '');
    code = 'target' in result ? 'allowed' : result.code;
  }
  assert.equal(code, row.code);
});

test('a completed answer cannot authorize a spontaneous new action', () => {
  const owner = new OwnerRequests(() => 0);
  owner.observe('synthetic', 'final', 'at seven am');
  owner.answered('synthetic');
  assert.equal(owner.authorize('synthetic', 'set_alarm', 'new').code, 'no_owner_request');
});
