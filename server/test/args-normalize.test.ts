import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTOR_COMPOSED_TOOLS } from '../connectors/index.js';
import { argumentViolations, argumentViolationsOf } from '../tools/declarations.js';
import { normalizeArguments, type ToolDeclaration } from '../tools/normalize.js';
import { claimsEmptyResult } from '../live/index.js';

/** The real `mattermost_chat` declaration, exactly as the connector publishes it: no copy in the test. */
const chat = CONNECTOR_COMPOSED_TOOLS['mattermost']!.find(tool => tool.name === 'mattermost_chat')!;
const declaration: ToolDeclaration = {
  name: chat.name, effect: 'read', parameters: { type: 'object', ...chat.parameters },
};

/** C-ARGS test 1: the call the realtime model made on 10-31, all twelve optional keys beside the person's name. */
test('the twelve-key person read normalizes and dispatches instead of refusing', () => {
  const sent = {
    intent: 'person', person: 'Maya', people: [] as string[], channel: '', query: '', post_id: '',
    order: 'newest', from_date: '2026-10-01', to_date: '2026-10-31', sides: 'both', offset: 0, limit: 8,
  };
  const { args, dropped } = normalizeArguments(declaration, sent);
  assert.equal(dropped.includes('people:not_read'), true, 'the group-chat key is another intent\'s');
  assert.equal(dropped.includes('post_id:not_read'), true, 'the thread key is another intent\'s');
  assert.equal(dropped.includes('channel:not_read'), true, 'the channel key is another intent\'s');
  assert.equal(chat.rejection!(args), undefined, 'nothing a person read does not read may refuse it');
  assert.deepEqual(Object.keys(args).sort(), ['from_date', 'intent', 'limit', 'offset', 'order', 'person', 'sides', 'to_date']);
  assert.equal(args['person'], 'Maya', 'the value the intent reads is never rewritten');
});

test('a non-empty value of a key the intent reads is kept and refused, and every violation is listed', () => {
  const sent = { intent: 'person', person: 'Maya', limit: 100, from_date: 'yesterday' };
  const { args } = normalizeArguments(declaration, sent);
  assert.equal(args['limit'], 100);
  assert.equal(args['from_date'], 'yesterday');
  const violations = argumentViolationsOf(chat, args);
  assert.deepEqual(violations, ['from_date:format', 'limit:range'], 'both violations come back in one answer');
  const fields = argumentViolations(`Invalid arguments for mattermost_chat. Rejected arguments: ${violations.join(', ')}. Expected an object with intent (string).`);
  assert.deepEqual(fields, [{ field: 'from_date', reason: 'format' }, { field: 'limit', reason: 'range' }]);
  assert.equal(JSON.stringify(violations).includes('yesterday'), false, 'a violation carries a rule, never a value');
  assert.equal(JSON.stringify(violations).includes('100'), false);
});

/** C-ARGS test 5: an empty-result claim over a lookup that never ran is corrected, a real empty result is not. */
test('the claim guard flags an empty result only after a rejected lookup, never after a real empty result', () => {
  for (const said of ['It came back empty.', 'Nothing found.', 'There are no results.', 'I found nothing.']) {
    assert.equal(claimsEmptyResult(said, true), true, `${said} is a claim over a read that never ran`);
    assert.equal(claimsEmptyResult(said, false), false, `${said} after a real empty result is the truth, not a claim`);
  }
  assert.equal(claimsEmptyResult('I found three messages from Maya.', true), false, 'a real finding is never corrected');
});
