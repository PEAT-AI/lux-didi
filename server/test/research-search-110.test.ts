import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bareWebTopic, compileMailQuery, coverageLine, fallbackSelection, guardMailSenders, isSourceNameWord, mailQueryShape, mailSearchPhrase,
  mailWidenLadder, mailWidenedPhrase, skipReasonOf, companySubs, unsearchedReasonOf, type CoverageSearched, type CoverageUnsearched,
} from '../tools/research.js';
import { publicQueryOf } from '../tools/web-search.js';
import { renderMongooseTool } from '../tools/mongoose.js';

// C-SEARCH 10.10: a real call on 10.9 lost a voice request three ways. These are the synthetic fixtures
// of that call, with the name replaced: the owner says "Dana Smith", speech-to-text gets the surname
// wrong, and the mail he means exists in the fixture under another surname.
const NOW = Date.parse('2026-10-21T05:30:00Z');
const ZONE = 'Asia/Kolkata';
const ASK = 'Find the email from Dana Smith and look her up on the web';

// 1. A mail query never carries a sender clause built from a source name.
test('SEARCH-110: a source name is never a sender, however the query was written', () => {
  for (const name of ['data', 'mail', 'mongoose', 'drive', 'memory', 'web']) {
    assert.equal(isSourceNameWord(name), true, name);
    const authored = `from:${name} OR to:${name} dana smith`;
    const q = compileMailQuery(ASK, authored, NOW, ZONE, ASK);
    assert.doesNotMatch(q, new RegExp(`(?:from|to):${name}`, 'iu'), `the junk sender left the query: ${q}`);
    assert.doesNotMatch(q, /\b(?:from|to):(?:data|mail|mongoose|drive|memory|web)\b/iu, q);
  }
});

test('SEARCH-110: the sender clause a person in the question names is kept, and so is dictated syntax', () => {
  // Paired valid case: the same authored shape with the name the owner spoke still reaches Gmail.
  const personQuery = compileMailQuery(ASK, 'from:dana OR to:dana smith', NOW, ZONE, ASK);
  assert.match(personQuery, /from:dana OR to:dana/u, personQuery);
  // The owner's own Gmail syntax is never rewritten.
  assert.equal(compileMailQuery('search from:acme newer_than:7d', undefined, NOW, ZONE, 'search from:acme newer_than:7d'), 'from:acme newer_than:7d');
  assert.equal(guardMailSenders('search from:acme newer_than:7d', 'from:acme newer_than:7d'), 'from:acme newer_than:7d');
});

test('SEARCH-110: a query the guard empties is compiled from the question, never sent bare', () => {
  const q = compileMailQuery(ASK, 'from:data OR to:data', NOW, ZONE, ASK);
  assert.notEqual(q, '');
  assert.doesNotMatch(q, /(?:from|to):data/iu, q);
});

// 2 and 3. A person search widens instead of giving up, and the window rides every step.
test('SEARCH-110: the widening ladder is full name, first name as sender, surname, first name, window kept', () => {
  const q = compileMailQuery('Find the email from Dana Smith in the last two days', undefined, NOW, ZONE, 'Find the email from Dana Smith in the last two days');
  assert.equal(mailQueryShape(q).window, 'newer_than:7d', q);
  assert.deepEqual(mailWidenLadder('Find the email from Dana Smith in the last two days', q), [
    'from:dana OR to:dana newer_than:7d',
    'smith newer_than:7d',
    'dana newer_than:7d',
  ]);
  // A question that names no person keeps the plain broadener and no ladder.
  assert.equal(mailWidenLadder('Find the email about the invoice', 'invoice newer_than:14d'), undefined);
});

test('SEARCH-110: a hit from a widened step says so in plain words', () => {
  const phrase = mailWidenedPhrase('dana newer_than:7d');
  assert.match(phrase, /^the closest I found came from widening/u, phrase);
  assert.match(phrase, /dana/u, phrase);
  assert.match(phrase, /in the last week/u, 'the window the owner named rides the phrase too');
  assert.match(phrase, /is that it\?/u, phrase);
  // The narrow phrase never claims the full name matched.
  assert.equal(mailSearchPhrase('dana newer_than:7d').includes('is that it'), false);
});

// 4. A web read failure keeps its real closed code, and a refused query retries with the bare topic.
test('SEARCH-110: a locally refused web query keeps its own closed code in the log and the header', () => {
  assert.equal(unsearchedReasonOf('web_private_question'), 'query_refused');
  assert.equal(skipReasonOf('web_private_question', 'unavailable'), 'query_refused');
  // Paired valid cases: the codes that really are outages keep theirs.
  assert.equal(unsearchedReasonOf('web_timeout'), 'timed_out');
  assert.equal(skipReasonOf('timeout', 'timeout'), 'timeout');
  const searched: CoverageSearched[] = [];
  const unsearched: CoverageUnsearched[] = [{ source: 'web', reason: 'query_refused' }];
  const line = coverageLine(searched, unsearched, 4096);
  assert.match(line, /web query_refused/u, line);
  assert.match(line, /refused before it left the host/u, line);
  assert.doesNotMatch(line, /provider_failed/u, line);
});

test('SEARCH-110: the bare topic of a mixed question passes the egress check', () => {
  const mixed = 'from:dana.smith@example.com OR to:dana.smith@example.com find the email from Dana Smith and look her up on the web';
  assert.equal(publicQueryOf(mixed), undefined, 'the compiled query is what the check refused on 10.9');
  const bare = bareWebTopic(mixed);
  assert.equal(bare, 'dana smith');
  assert.equal(publicQueryOf(bare ?? ''), 'dana smith', 'the retry query passes, with the protections untouched');
  // The protections themselves are unchanged.
  assert.equal(publicQueryOf('is rob@example.com free on Friday'), undefined);
  assert.equal(publicQueryOf('order 123456789012'), undefined);
});

// 5. A knowledge no_match is that, in one line, with no read-through of neighbours.
test('SEARCH-110: a knowledge no_match says nothing on this name in this source', () => {
  const text = renderMongooseTool({ outcome: 'no_match', suggestions: ['Dana Soto Consulting', 'Acme Agro'] }).text;
  assert.match(text, /^no_match: nothing on this name in this source/u, text);
  assert.doesNotMatch(text, /Dana Soto/u, text);
  assert.doesNotMatch(text, /Acme Agro/u, text);
});

// 6. A capability read runs only on a real coverage question, and never on a route word as a country.
test('SEARCH-110: the capability router is asked only about coverage, never about a plain company ask', () => {
  const capability = (question: string): boolean => companySubs('Acme Agro', question).some(call => call.name === 'check_data_capability');
  assert.equal(capability('What does Acme Agro sell, and who runs it?'), false);
  assert.equal(capability('Find the email from Dana Smith about the data'), false, 'a route word is not a coverage question');
  // Paired valid cases: a real coverage question still asks, with the country the owner named.
  assert.equal(capability('Do we have district level data for Kenya?'), true);
  const args = companySubs('Acme Agro', 'Do we have district level data for Kenya?')[0]!.args;
  assert.deepEqual(args['countries'], ['Kenya'], JSON.stringify(args));
  assert.equal(companySubs('Acme Agro', 'what does the data in Data say')[0]?.name === 'check_data_capability', false);
});

// 7. Calendar joins only on a time, a meeting, a day or the calendar.
test('SEARCH-110: a mail or company question with no schedule word reads no calendar', () => {
  const kinds = (question: string): string[] => fallbackSelection(question, ['knowledge', 'calendar', 'mail', 'chat', 'mongoose', 'data', 'web'], NOW)
    .actions.map(action => String(action.kind));
  assert.equal(kinds('Find the email from Dana Smith about the pricing').includes('calendar_window'), false);
  assert.equal(kinds('What does Acme Agro sell?').includes('calendar_window'), false);
  assert.equal(kinds('Are they free this week about Acme Agro').includes('calendar_window'), false);
  // Paired valid cases: an ask that names a meeting, a day or the calendar still reads it.
  assert.equal(kinds('What meetings do I have tomorrow?').includes('calendar_window'), true);
  assert.equal(kinds('What is on my calendar on Friday?').includes('calendar_window'), true);
});
