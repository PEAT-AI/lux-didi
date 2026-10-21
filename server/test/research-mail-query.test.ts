import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ResearchLedger, broaderMailQuery, compileMailQuery, mailQueryShape, mailSearchPhrase, runResearch,
  type ResearchDeps, type ResearchSourceLog,
} from '../tools/research.js';
import { shapeGmailList } from '../tools/live-shape.js';
import { safeEvent } from '../host/log.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

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
  { question: 'did Priya send the renewal contract draft for the March board deck?', q: 'from:priya OR to:priya renewal contract draft board after:2026/02/28 before:2026/04/01' },
  // F1/F2 from the review: the question's own time words are answered, never deleted, and instruction
  // words spend no term slot.
  { question: 'did anyone email me about the electricity bill in September', q: 'electricity bill after:2026/08/31 before:2026/10/01' },
  { question: 'the invoice from the design agency from before October', q: 'invoice design agency before:2026/10/01' },
  { question: 'show me mail about the flat inspection next Monday', q: 'flat inspection after:2026/10/25 before:2026/10/27' },
  { question: 'emails mentioning the offsite venue', q: 'offsite venue newer_than:14d' },
  { question: 'find the thread where Ravi shared the deployment checklist', q: 'ravi deployment checklist newer_than:14d' },
  { question: "what's the latest from my accountant", q: 'accountant newer_than:14d' },
  { question: 'after:', q: 'in:inbox newer_than:14d' },
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
  assert.match(q, /(?:newer_than:\d+d|before:\d{4}\/\d{2}\/\d{2})$/u, 'a window is always appended when the question gave none');
});

test('E5: the one broader retry drops a term, else widens the window once', () => {
  assert.equal(broaderMailQuery('landlord lease newer_than:60d'), 'landlord newer_than:60d', 'the least salient term is dropped');
  assert.equal(broaderMailQuery('from:sana OR to:sana signed nda newer_than:14d'), 'from:sana OR to:sana nda newer_than:14d', 'a verb goes before the acronym it names');
  assert.equal(broaderMailQuery('offsite venue inspection newer_than:14d'), 'offsite venue newer_than:14d', 'a trailing short modifier goes before its noun');
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
  assert.equal(mailSearchPhrase('invoice design agency before:2026/10/01'), ' for "invoice design agency" before 2026/10/01', 'a single bound is voiced as one');
});

// --- The compiler and the retry on the routed wire ----------------------------------------------

function mailHarness(execute: (subs: readonly IntentSubCall[]) => Promise<IntentSubResult[]>): { deps: ResearchDeps; sources: ResearchSourceLog[] } {
  const sources: ResearchSourceLog[] = [];
  const deps: ResearchDeps = {
    now: () => 0,
    configured: ['mail'],
    execute,
    emit: () => {},
    log: () => {},
    logRouted: () => {},
    logSubcall: () => {},
    logSource: event => sources.push(event),
    ledger: new ResearchLedger(),
  };
  return { deps, sources };
}

const mailPage = (ids: readonly string[]): Partial<IntentSubResult> =>
  shapeGmailList({ messages: ids.map(id => ({ id, headers: [{ name: 'Subject', value: 'Invoice' }, { name: 'From', value: 'Dana' }] })) });

test('E4: a prose mail lookup is sent as Gmail syntax, never the spoken sentence', async () => {
  const sent: string[] = [];
  const h = mailHarness(async subs => subs.map(call => {
    sent.push(String(call.args['q'] ?? call.name));
    return { key: call.key, name: call.name, ok: true, ...mailPage(['m1']) } as IntentSubResult;
  }));
  await runResearch(h.deps, {
    action: 'start', question: 'What did Dana send me about the invoice?',
    lookups: [{ source: 'mail', query: 'could you look for the email where Dana sent the invoice?' }],
  }, new AbortController().signal);
  assert.deepEqual(sent, ['from:dana OR to:dana invoice newer_than:14d'], 'one compiled query on the wire, never the sentence');
});

test('E5: a search that matched nothing runs exactly one broader retry and logs both shapes', async () => {
  const sent: string[] = [];
  const h = mailHarness(async subs => subs.map(call => {
    sent.push(String(call.args['q'] ?? call.name));
    const found = sent.length > 1;
    return { key: call.key, name: call.name, ok: true, ...mailPage(found ? ['m9'] : []) } as IntentSubResult;
  }));
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'What did Dana send me about the invoice?',
    lookups: [{ source: 'mail', query: 'What did Dana send me about the invoice?' }],
  }, new AbortController().signal);
  assert.deepEqual(sent, ['from:dana OR to:dana invoice newer_than:14d', 'from:dana OR to:dana invoice newer_than:30d'], 'the query, then exactly one broader retry');
  const receipt = h.sources.filter(entry => entry.source === 'mail').at(-1)!;
  assert.deepEqual(receipt.mail, {
    terms: 1, operators: ['from', 'to', 'newer_than'], window: 'newer_than:14d',
    retried: { terms: 1, operators: ['from', 'to', 'newer_than'], window: 'newer_than:30d' },
  }, 'both queries by shape: term count, operators and window, never the words');
  assert.equal(JSON.stringify(receipt).includes('invoice'), false, 'no query word reaches the receipt');
  const safe = safeEvent(receipt);
  assert.ok(safe !== undefined, 'the host log keeps the receipt with both shapes');
  assert.deepEqual((safe['mail'] as Record<string, unknown>)['retried'], { terms: 1, operators: ['from', 'to', 'newer_than'], window: 'newer_than:30d' });
  assert.ok((reply['findings'] as unknown[]).length > 0, 'what the broader search found reaches the reply');
});

test('E5: an empty retry says how it searched, naming the window it used', async () => {
  const sent: string[] = [];
  const h = mailHarness(async subs => subs.map(call => {
    sent.push(String(call.args['q'] ?? call.name));
    return { key: call.key, name: call.name, ok: true, ...mailPage([]) } as IntentSubResult;
  }));
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'What did Dana send me about the invoice?',
    lookups: [{ source: 'mail', query: 'What did Dana send me about the invoice?' }],
  }, new AbortController().signal);
  assert.equal(sent.length, 2, 'exactly one retry, never a loop');
  const note = String(reply['note'] ?? '');
  assert.match(note, /I searched your mail for "invoice" in the last month and found nothing matching/, 'the reply says what it matched and the window it used');
});

test('E5: the host log accepts the mail shape only as counts and closed tokens, never words', () => {
  const receipt: ResearchSourceLog = {
    event: 'research_source', researchId: 'r1', source: 'mail', outcome: 'empty', ms: 5, deadlineMs: 12_000, coalesced: 1,
    mail: { terms: 1, operators: ['from', 'to', 'newer_than'], window: 'newer_than:14d', retried: { terms: 1, operators: ['from', 'newer_than'], window: 'newer_than:30d' } },
  };
  assert.ok(safeEvent(receipt) !== undefined, 'the receipt with both shapes is kept');
  const kept = safeEvent(receipt)!;
  assert.deepEqual(kept['mail'], receipt.mail);
  const freeText = (mail: unknown): Record<string, unknown> => ({ ...receipt, mail });
  assert.equal(safeEvent(freeText({ terms: 1, operators: ['from'], window: 'from:dana' })), undefined, 'a window that carries words is refused');
  assert.equal(safeEvent(freeText({ terms: 1, operators: ['dana'] })), undefined, 'an operator outside the closed set is refused');
  assert.equal(safeEvent(freeText({ terms: 1, operators: ['from'], q: 'from:dana invoice' })), undefined, 'any extra key is refused');
  assert.equal(safeEvent(freeText({ terms: 1, operators: ['from'], retried: { terms: 1, operators: ['invoice'] } })), undefined, 'the retry shape is held to the same rule');
  assert.equal(safeEvent(freeText('from:dana invoice')), undefined, 'the field itself is never a string');
  // Other receipts are unchanged: no mail key still passes, and an unknown top-level key still fails.
  const plain: ResearchSourceLog = { event: 'research_source', researchId: 'r1', source: 'knowledge', outcome: 'ok', ms: 5, deadlineMs: 12_000, coalesced: 1 };
  assert.deepEqual(safeEvent(plain)?.['mail'], undefined);
  assert.equal(safeEvent({ ...plain, extra: 1 }), undefined, 'the top-level key list is still closed');
});
