import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_PHRASES, stepPhrase, toolPhrase, toolPhrases, toolConnector } from '../src/tool-phrases.ts';

/** Every current Live tool and the phrase it must render. */
const LIVE_TOOLS: readonly (readonly [string, string])[] = [
  ['search_knowledge', 'Looking in your knowledge base'],
  ['get_insight', 'Reading your knowledge base'],
  ['gmail_get_profile', 'Checking your mail profile'],
  ['gmail_list', 'Searching your mail'],
  ['gmail_read', 'Reading that email'],
  ['gcal_calendars', 'Checking your calendar'],
  ['gcal_list', 'Checking your calendar'],
  ['mattermost_whoami', 'Checking your Mattermost account'],
  ['mattermost_get_channel_history', 'Reading a Mattermost channel'],
  ['mattermost_get_thread', 'Reading a Mattermost thread'],
  ['mattermost_search', 'Searching Mattermost'],
  ['mattermost_list_channels', 'Listing your Mattermost channels'],
];

test('every Live tool maps to its human phrase', () => {
  for (const [name, phrase] of LIVE_TOOLS) assert.equal(toolPhrase(name), phrase, name);
});

test('no phrase exposes a raw tool id', () => {
  for (const [name] of LIVE_TOOLS) assert.doesNotMatch(toolPhrase(name), /_/, name);
  for (const name of Object.keys(TOOL_PHRASES)) assert.doesNotMatch(toolPhrase(name), /_|\(/, name);
});

test('an unknown tool reads Using <connector>, never the raw id', () => {
  assert.equal(toolPhrase('gmail_archive'), 'Using Gmail');
  assert.equal(toolPhrase('mongoose_list_tickets'), 'Using Mongoose');
  assert.equal(toolPhrase('mystery_tool'), 'Using Mystery');
  assert.doesNotMatch(toolPhrase('mystery_tool'), /mystery_tool/);
});

test('a batch of calls merges into one calm line', () => {
  assert.equal(toolPhrases(['gmail_list']), 'Searching your mail');
  assert.equal(toolPhrases(['gmail_list', 'mattermost_search']), 'Searching your mail and Mattermost');
  assert.equal(toolPhrases(['gmail_list', 'gmail_read']), 'Searching your mail and reading that email');
  assert.equal(toolPhrases(['gcal_calendars', 'gcal_list']), 'Checking your calendar');
  assert.equal(toolPhrases(['gmail_list', 'gmail_list']), 'Searching your mail');
});

test('toolConnector gives a readable connector', () => {
  assert.equal(toolConnector('mattermost_search'), 'Mattermost');
  assert.equal(toolConnector('gcal_list'), 'Calendar');
});

// U-k3: a live step reads as one line: what she is looking at, then what came back.
test('a live step reads as source, action and subject, then as its result', () => {
  assert.equal(stepPhrase({ source: 'chat', action: 'search', subject: 'release freeze, last 7 days', phase: 'start' }), 'Searching Mattermost: release freeze, last 7 days');
  assert.equal(stepPhrase({ source: 'mail', action: 'search', subject: 'release freeze', phase: 'start' }), 'Searching your mail: release freeze');
  assert.equal(stepPhrase({ source: 'calendar', action: 'read', subject: 'today', phase: 'start' }), 'Reading your calendar: today');
  assert.equal(stepPhrase({ source: 'knowledge', action: 'search', phase: 'start' }), 'Searching your knowledge base');
  assert.equal(stepPhrase({ source: 'chat', action: 'search', phase: 'end', resultCount: 13, ok: true }), 'Mattermost: 13 messages');
  assert.equal(stepPhrase({ source: 'chat', action: 'search', phase: 'end', resultCount: 1, ok: true }), 'Mattermost: 1 message');
  assert.equal(stepPhrase({ source: 'mail', action: 'search', phase: 'end', resultCount: 0, ok: true }), 'Mail: nothing found');
  assert.equal(stepPhrase({ source: 'calendar', action: 'read', phase: 'end', ok: false }), 'Calendar did not answer');
  assert.equal(stepPhrase({ source: 'unknownsource', action: 'use', phase: 'start' }), 'Using unknownsource');
});
