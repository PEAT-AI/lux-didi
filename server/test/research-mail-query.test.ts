import assert from 'node:assert/strict';
import { test } from 'node:test';
import { broaderMailQuery, compileMailQuery, mailQueryShape, mailSearchPhrase } from '../tools/research.js';

// E4: the owner asks in prose and the research layer sent the sentence as the Gmail `q`, which ANDs
// every word and matched nothing. These are synthetic questions in the shape the owner really asks;
// the compiler reduces one to at most four salient terms plus a window, and never rewrites Gmail syntax.
const NOW = Date.parse('2026-10-21T05:30:00Z'); // 11:00 in the owner's zone
const ZONE = 'Asia/Kolkata';

const FIXTURES: readonly { question: string; authored?: string; q: string }[] = [
  { question: 'What did Dana send me about the invoice?', q: 'from:dana OR to:dana invoice newer_than:14d' },
  { question: 'Any emails from Priya about the contract this week?', q: 'from:priya OR to:priya contract newer_than:7d' },
  { question: 'Show me the latest messages in my inbox', q: 'in:inbox newer_than:14d' },
  { question: 'did Sam email me the budget yesterday?', q: 'from:sam OR to:sam budget newer_than:2d' },
  { question: 'what did the landlord say about the lease last month', q: 'landlord lease newer_than:60d' },
  { question: 'Any unread mail from the bank?', q: 'is:unread bank newer_than:14d' },
  { question: 'What did we decide about the Q4 roadmap?', q: 'decide q4 roadmap newer_than:14d' },
  {
    question: 'what did Acme say about the renewal',
    authored: 'Can you look for the email where Acme confirmed the renewal terms?',
    q: 'acme confirmed renewal terms newer_than:14d',
  },
  { question: 'anything from the bank', authored: 'from:alerts@bank.example subject:statement newer_than:30d', q: 'from:alerts@bank.example subject:statement newer_than:30d' },
  { question: 'board deck', authored: 'subject:"board deck" newer_than:30d', q: 'subject:"board deck" newer_than:30d' },
  { question: 'did I reply to Priya about the launch?', q: 'from:priya OR to:priya launch newer_than:14d' },
  { question: 'What did Sam send on 2026-10-15?', q: 'from:sam OR to:sam after:2026/10/14 before:2026/10/16' },
  { question: 'Any mail from Neha on Friday?', q: 'from:neha OR to:neha after:2026/10/22 before:2026/10/24' },
  { question: 'Check my email for anything from the city council about parking this morning', q: 'city council parking newer_than:1d' },
  { question: 'did Priya send the renewal contract draft for the March board deck?', q: 'from:priya OR to:priya renewal contract draft board newer_than:14d' },
  // The three shapes the 04:06Z call really sent (described, never quoted from the log): a bare first
  // name with no window, a long natural-language sentence, and one with a person and a time word.
  { question: 'Davian', q: 'davian newer_than:14d' },
  { question: 'could you check whether anything important came in from Priya about the security review this week?', q: 'is:important from:priya OR to:priya security review newer_than:7d' },
  { question: 'I think there was something in my inbox earlier this week about the new pricing sheet from the finance team, can you find it?', q: 'pricing sheet finance newer_than:7d' },
];

test('E4: a prose question becomes at most four Gmail terms and a window', () => {
  for (const { question, authored, q } of FIXTURES) {
    assert.equal(compileMailQuery(question, authored, NOW, ZONE), q, question);
  }
});

test('E4: an authored Gmail query is never rewritten, and compiling twice changes nothing', () => {
  const q = compileMailQuery('what did Dana send me about the invoice?', undefined, NOW, ZONE);
  assert.equal(compileMailQuery('what did Dana send me about the invoice?', q, NOW, ZONE), q, 'the compiled query is already Gmail syntax');
  for (const operator of ['from:', 'to:', 'subject:', 'after:', 'before:', 'newer_than:', 'older_than:', 'is:', 'has:', 'label:']) {
    const authored = `${operator}token newer_than:30d`;
    assert.equal(compileMailQuery('anything at all from the bank', authored, NOW, ZONE), authored, operator);
  }
  assert.equal(compileMailQuery('board deck', 'subject:"board deck"', NOW, ZONE), 'subject:"board deck"', 'a quoted phrase survives untouched');
});

test('E4: at most four terms survive, a sentence never becomes the query', () => {
  const q = compileMailQuery('could you please look through my email and find everything Priya wrote about the renewal contract draft and the March board deck?', undefined, NOW, ZONE);
  const bare = q.split(/\s+/).filter((token: string) => !token.includes(':') && token.toUpperCase() !== 'OR');
  assert.ok(bare.length <= 4, `bounded to four terms: ${q}`);
  assert.equal(q.includes('?'), false);
  assert.match(q, /newer_than:14d$/u, 'a window is always appended when the question gave none');
});

test('E5: the one broader retry drops a term, else widens the window once', () => {
  assert.equal(broaderMailQuery('landlord lease newer_than:60d'), 'landlord newer_than:60d', 'the least salient term is dropped');
  assert.equal(broaderMailQuery('from:dana OR to:dana invoice newer_than:14d'), 'from:dana OR to:dana invoice newer_than:30d', 'one term left widens the window by one step');
  assert.equal(broaderMailQuery('newer_than:60d'), undefined, 'nothing left to widen is no retry');
  assert.equal(broaderMailQuery('from:plantix'), undefined, 'an authored filter with no terms has nothing to broaden');
});

test('E5: the search shape is counts and operators, never the words', () => {
  assert.deepEqual(mailQueryShape('from:dana OR to:dana invoice newer_than:14d'),
    { terms: 1, operators: ['from', 'to', 'newer_than'], window: 'newer_than:14d' });
  assert.deepEqual(mailQueryShape('landlord lease newer_than:60d'), { terms: 2, operators: ['newer_than'], window: 'newer_than:60d' });
  const shape = mailQueryShape('from:neha OR to:neha after:2026/10/22 before:2026/10/24');
  assert.equal(shape.window, 'after:2026/10/22');
  assert.equal(shape.terms, 0);
});

test('E5: the reply says how it searched: the words and the window, never an operator', () => {
  assert.equal(mailSearchPhrase('from:dana OR to:dana invoice newer_than:14d'), ' for "invoice" in the last two weeks');
  assert.equal(mailSearchPhrase('in:inbox newer_than:1d'), ' with a keyword filter in the last day');
  assert.equal(mailSearchPhrase('from:neha OR to:neha after:2026/10/22 before:2026/10/24'), ' with a keyword filter between 2026/10/22 and 2026/10/24');
});
