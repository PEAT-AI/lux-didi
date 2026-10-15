import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INTENT_TOOL_NAMES, INTERNAL, calendarIds, intentDeclarations, isIntentTool, planIntent, validateIntent, type IntentSubResult } from '../tools/intent.js';
import { LIVE_RESULT_CHARS } from '../tools/live-shape.js';

const result = (name: string, ok: boolean, text: string): IntentSubResult => ({ key: '0', name, ok, text, originalCharacters: text.length, omittedCharacters: 0 });

test('the Live surface declares exactly five coarse intent tools', () => {
  const names = intentDeclarations().map(declaration => declaration.name);
  assert.deepEqual(names, [...INTENT_TOOL_NAMES]);
  for (const name of INTENT_TOOL_NAMES) assert.equal(isIntentTool(name), true);
  assert.equal(isIntentTool('search_knowledge'), false, 'the fine-grained tool is not an intent');
});

test('each intent schema matches its validator: valid args accepted, invalid refused', () => {
  assert.equal(validateIntent('search', { query: 'lux didi' }), true);
  assert.equal(validateIntent('search', {}), false, 'search needs a query');
  assert.equal(validateIntent('search', { query: '  ' }), false, 'blank query refused');
  assert.equal(validateIntent('search', { query: 'x', limit: 3 }), false, 'an undeclared key is refused at the boundary');
  assert.equal(validateIntent('mail', { query: 'is:unread' }), true);
  assert.equal(validateIntent('mail', { id: '18c' }), true);
  assert.equal(validateIntent('mail', {}), false, 'mail needs a query or an id');
  assert.equal(validateIntent('mail', { query: 'x', id: 'y' }), false, 'exactly one of query or id');
  assert.equal(validateIntent('calendar', {}), true);
  assert.equal(validateIntent('calendar', { calendarId: 'primary' }), false, 'calendar takes no parameters');
  assert.equal(validateIntent('chat', { query: 'release' }), true);
  assert.equal(validateIntent('chat', {}), false);
  assert.equal(validateIntent('brief', {}), true);
});

test('search is one call that already answers the question', () => {
  const plan = planIntent('search', { query: 'lux didi' });
  assert.deepEqual(plan.calls.map(call => call.name), [INTERNAL.knowledgeSearch]);
});

test('mail lists by query, or reads one message by id', () => {
  assert.deepEqual(planIntent('mail', { query: 'is:unread' }).calls.map(call => call.name), [INTERNAL.mailList]);
  assert.deepEqual(planIntent('mail', { id: '18c' }).calls.map(call => call.name), [INTERNAL.mailRead]);
});

test('calendar enumerates the calendars and reads events from every one in phase two', () => {
  const plan = planIntent('calendar', {});
  assert.deepEqual(plan.calls.map(call => call.name), [INTERNAL.calendars]);
  const follow = plan.follow!([
    result(INTERNAL.calendars, true, '- Work [work@example.com]\n- Home [home]'),
  ]);
  assert.deepEqual(follow.map(call => call.name), [INTERNAL.calendarList, INTERNAL.calendarList]);
  assert.deepEqual(follow.map(call => call.args), [{ calendarId: 'work@example.com' }, { calendarId: 'home' }]);
});

test('calendar ids are deduplicated and bounded to eight', () => {
  const text = Array.from({ length: 12 }, (_v, n) => `- C${n} [cal${n}]`).join('\n') + '\n- Dup [cal0]';
  const ids = calendarIds(text);
  assert.equal(ids.length, 8);
  assert.deepEqual(ids.slice(0, 2), ['cal0', 'cal1']);
});

test('chat searches the team chat in one call', () => {
  assert.deepEqual(planIntent('chat', { query: 'release' }).calls.map(call => call.name), [INTERNAL.chatSearch]);
});

test('brief fans out over calendar, mail, chat and open loops in parallel', () => {
  const names = planIntent('brief', {}).calls.map(call => call.name);
  assert.deepEqual(names, [INTERNAL.calendars, INTERNAL.mailList, INTERNAL.chatSearch, INTERNAL.knowledgeSearch]);
});

test('one failing source never sinks the turn, and the digest names it', () => {
  const plan = planIntent('brief', {});
  const digest = plan.combine([
    result(INTERNAL.calendars, true, 'Board deck at 10:00.'),
    result(INTERNAL.mailList, false, ''),
    result(INTERNAL.chatSearch, true, 'Asha shipped the release.'),
    result(INTERNAL.knowledgeSearch, false, ''),
  ]);
  assert.match(digest.text, /Board deck at 10:00/);
  assert.match(digest.text, /Asha shipped the release/);
  assert.match(digest.text, /Timed out or unavailable: mail, knowledge\./);
  assert.doesNotMatch(digest.text, /error/i, 'no raw error text is read aloud');
});

test('the combined result is capped at the Live ceiling', () => {
  const plan = planIntent('search', { query: 'x' });
  const digest = plan.combine([result(INTERNAL.knowledgeSearch, true, 'a'.repeat(LIVE_RESULT_CHARS * 3))]);
  assert.ok(digest.text.length <= LIVE_RESULT_CHARS + 80, `capped, got ${digest.text.length}`);
  assert.equal(digest.partial, true);
  assert.match(digest.text, /\[omitted \d+ characters/);
});
