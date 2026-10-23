import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESEARCH, ResearchLedger, ResearchScheduler, candidateSubs, compileMailQuery, mailQueryShape, mailSearchPhrase, runResearch,
  type ResearchDeps, type ResearchRunLog, type ResearchSourceLog,
} from '../tools/research.js';
import { shapeGmailList } from '../tools/live-shape.js';
import { safeEvent } from '../host/log.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

// E4: the owner asks in prose and the research layer sent the sentence as the Gmail `q`, which ANDs
// every word and matched nothing. These are synthetic questions in the shape the owner really asks;
// the compiler reduces one to at most four salient terms plus a window, and never rewrites Gmail syntax.
const NOW = Date.parse('2026-10-21T05:30:00Z'); // 11:00 in the owner's zone
const ZONE = 'Asia/Kolkata';

const FIXTURES: readonly { question: string; authored?: string; q: string; topic: string }[] = [
  { question: 'What did Dana send me about the invoice?', q: 'from:dana OR to:dana invoice', topic: 'invoice' },
  { question: 'Any emails from Priya about the contract this week?', q: 'from:priya OR to:priya contract newer_than:7d', topic: 'contract' },
  { question: 'Show me the latest messages in my inbox', q: 'in:inbox newer_than:14d', topic: '' },
  { question: 'did Sam email me the budget yesterday?', q: 'from:sam OR to:sam budget newer_than:2d', topic: 'budget' },
  { question: 'what did the landlord say about the lease last month', q: 'landlord lease newer_than:60d', topic: 'landlord lease' },
  { question: 'Any unread mail from the bank?', q: 'is:unread bank', topic: 'bank' },
  { question: 'What did we decide about the Q4 roadmap?', q: 'decide q4 roadmap', topic: 'decide q4 roadmap' },
  {
    question: 'what did Acme say about the renewal',
    authored: 'Can you look for the email where Acme confirmed the renewal terms?',
    q: 'acme confirmed renewal terms', topic: 'acme confirmed renewal terms' },
  { question: 'anything from the bank', authored: 'from:alerts@bank.example subject:statement newer_than:30d', q: 'from:alerts@bank.example subject:statement newer_than:30d', topic: '' },
  { question: 'board deck', authored: 'subject:"board deck" newer_than:30d', q: 'subject:"board deck" newer_than:30d', topic: '' },
  { question: 'did I reply to Priya about the launch?', q: 'from:priya OR to:priya launch', topic: 'launch' },
  { question: 'What did Sam send on 2026-10-15?', q: 'from:sam OR to:sam after:2026/10/14 before:2026/10/16', topic: 'OR' },
  { question: 'Any mail from Neha on Friday?', q: 'from:neha OR to:neha after:2026/10/22 before:2026/10/24', topic: 'OR' },
  { question: 'Check my email for anything from the city council about parking this morning', q: 'city council parking newer_than:1d', topic: 'city council parking' },
  { question: 'did Priya send the renewal contract draft for the March board deck?', q: 'from:priya OR to:priya renewal contract draft board after:2026/02/28 before:2026/04/01', topic: 'renewal contract draft board' },
  // F1/F2 from the review: the question's own time words are answered, never deleted, and instruction
  // words spend no term slot.
  { question: 'did anyone email me about the electricity bill in September', q: 'electricity bill after:2026/08/31 before:2026/10/01', topic: 'electricity bill' },
  { question: 'the invoice from the design agency from before October', q: 'invoice design agency before:2026/10/01', topic: 'invoice design agency' },
  { question: 'show me mail about the flat inspection next Monday', q: 'flat inspection after:2026/10/25 before:2026/10/27', topic: 'flat inspection' },
  { question: 'emails mentioning the offsite venue', q: 'offsite venue', topic: 'offsite venue' },
  { question: 'find the thread where Ravi shared the deployment checklist', q: 'ravi deployment checklist', topic: 'ravi deployment checklist' },
  { question: "what's the latest from my accountant", q: 'accountant', topic: 'accountant' },
  { question: 'after:', q: 'in:inbox newer_than:14d', topic: '' },
  // The three shapes the 04:06Z call really sent (described, never quoted from the log): a bare first
  // name with no window, a long natural-language sentence, and one with a person and a time word.
  { question: 'Davian', q: 'davian', topic: 'davian' },
  { question: 'could you check whether anything important came in from Priya about the security review this week?', q: 'is:important from:priya OR to:priya security review newer_than:7d', topic: 'security review' },
  { question: 'I think there was something in my inbox earlier this week about the new pricing sheet from the finance team, can you find it?', q: 'pricing sheet finance newer_than:7d', topic: 'pricing sheet finance' },
];

test('E4: a prose question becomes at most four Gmail terms and the window it names', () => {
  for (const { question, authored, q, topic } of FIXTURES) {
    assert.equal(compileMailQuery(question, authored, NOW, ZONE, topic), q, question);
  }
});

// ROUTE-1022 K6: the owner's own name is never a person to filter mail by. "what did rob's team send
// about hawk" reached Gmail as `from:rob's OR to:rob's` and matched nothing, twice, for 8.2 s.
test('ROUTE-1022 K6: a possessive of the owner is dropped, never a from: or to: filter', () => {
  const q = compileMailQuery("what did rob's team send about hawk", undefined, NOW, ZONE, 'team hawk');
  assert.equal(/rob/u.test(q), false, `no owner name in the query (${q})`);
  assert.equal(/from:|to:/u.test(q), false, 'and no direction filter at all');
  assert.match(q, /hawk/, 'the content terms survive');
  assert.equal(compileMailQuery("find Rob's mail about the invoice", undefined, NOW, ZONE, 'invoice').includes('from:rob'), false);
});

test('ROUTE-1022 K6: a question with its own terms adds no implicit two weeks', () => {
  const july = compileMailQuery('find the agricon mail from july', undefined, NOW, ZONE, 'agricon');
  assert.equal(july.includes('newer_than'), false, 'the July thread is not hidden behind a fortnight');
  assert.match(july, /agricon/u);
  assert.match(july, /after:2026\/06\/30 before:2026\/08\/01/u, 'the month the question named is still resolved');
  assert.equal(compileMailQuery('Show me the latest messages in my inbox', undefined, NOW, ZONE), 'in:inbox newer_than:14d', 'a bare inbox scan keeps its rolling window');
});

test('E4: an authored Gmail query is never rewritten, and compiling twice changes nothing', () => {
  const q = compileMailQuery('what did Dana send me about the invoice?', undefined, NOW, ZONE, 'Dana invoice');
  assert.equal(compileMailQuery('what did Dana send me about the invoice?', q, NOW, ZONE, 'Dana invoice'), q, 'the compiled query is already Gmail syntax');
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
    action: 'start', question: 'What did Dana send me about the invoice?', topic: 'What did Dana send me about the invoice?',
    lookups: [{ source: 'mail', query: 'could you look for the email where Dana sent the invoice?' }],
  }, new AbortController().signal);
  assert.deepEqual(sent, ['from:dana OR to:dana invoice'], 'one compiled query on the wire, never the sentence');
});

test('MAILQ 4: a search that matched nothing is reported empty, with no retry', async () => {
  const sent: string[] = [];
  const h = mailHarness(async subs => subs.map(call => {
    sent.push(String(call.args['q'] ?? call.name));
    return { key: call.key, name: call.name, ok: true, ...mailPage([]) } as IntentSubResult;
  }));
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'What did Dana send me about the invoice?', topic: 'invoice',
    lookups: [{ source: 'mail', query: 'invoice' }],
  }, new AbortController().signal);
  assert.deepEqual(sent, ['from:dana OR to:dana invoice'], 'one query, no drop-a-term retry');
  const receipt = h.sources.filter(entry => entry.source === 'mail').at(-1)!;
  assert.deepEqual(receipt.mail, { terms: 1, operators: ['from', 'to'] }, 'the one query by shape, never the words');
  assert.equal(JSON.stringify(receipt).includes('invoice'), false, 'no query word reaches the receipt');
  assert.equal(safeEvent(receipt) !== undefined, true, 'the host log keeps the receipt');
  assert.match(String(reply['note'] ?? ''), /I searched your mail/u, 'the empty search is reported as empty');
});

test('MAILQ 4: an empty search says how it searched, naming the window it used', async () => {
  const h = mailHarness(async subs => subs.map(call => ({ key: call.key, name: call.name, ok: true, ...mailPage([]) }) as IntentSubResult));
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'What did Dana send me about the invoice this week?', topic: 'invoice',
    lookups: [{ source: 'mail', query: 'invoice' }],
  }, new AbortController().signal);
  assert.match(String(reply['note'] ?? ''), /I searched your mail for "invoice" in the last week and found nothing matching/u);
});

test('E5: the host log accepts the mail shape only as counts and closed tokens, never words', () => {
  const receipt: ResearchSourceLog = {
    event: 'research_source', researchId: 'r1', source: 'mail', outcome: 'empty', ms: 5, deadlineMs: 12_000, coalesced: 1,
    mail: { terms: 1, operators: ['from', 'to', 'newer_than'], window: 'newer_than:14d' },
  };
  assert.ok(safeEvent(receipt) !== undefined, 'the receipt with its shape is kept');
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

// W12-R1 / behaviour 3: the answered-run half of the coalescing rule. A run whose answer named a source
// unavailable is not the same research when the identical start repeats inside the coalesce window, so
// the owner is never handed a stale outage; a clean answer still coalesces, as E7 requires.
test('W12-R1: an answered run that named a source unavailable is never coalesced', async () => {
  const start = {
    action: 'start' as const, question: 'What did Dana send me about the invoice?', topic: 'What did Dana send me about the invoice?',
    lookups: [{ source: 'mail' as const, query: 'invoice' }],
  };
  const down = mailHarness(async () => []);
  const downScheduler = new ResearchScheduler({ ...down.deps, unavailableNow: () => ['mail'] });
  const first = await downScheduler.call(start, new AbortController().signal);
  assert.deepEqual(first['unavailable'], { mail: 'connector_unavailable' }, 'the first answer names mail unavailable');
  const again = await downScheduler.call(start, new AbortController().signal);
  assert.notEqual(String(again['researchId']), String(first['researchId']), 'an answer that named a source unavailable is read again, never reused');

  const clean = mailHarness(async subs => subs.map(call => ({ key: call.key, name: call.name, ok: true, ...mailPage(['m1']) } as IntentSubResult)));
  const cleanScheduler = new ResearchScheduler(clean.deps);
  const answered = await cleanScheduler.call(start, new AbortController().signal);
  assert.equal(answered['unavailable'], undefined, 'a clean answer names no unavailable source');
  const joined = await cleanScheduler.call(start, new AbortController().signal);
  assert.equal(String(joined['researchId']), String(answered['researchId']), 'and a clean answer still coalesces');
});

// ROUTE-R2: the run log says why a source was skipped, so a grant gap is never read as an outage.
test('ROUTE-R2: a gmail endpoint that failed its proof is logged as an endpoint outage', async () => {
  let dispatched = 0;
  const h = mailHarness(async subs => { dispatched += 1; return subs.map(call => ({ key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0, ...mailPage(['m1']) })); });
  const logs: ResearchRunLog[] = [];
  h.deps.log = event => logs.push(event);
  h.deps.unavailableNow = () => [{ source: 'mail', reason: 'identity_unverified' }];
  const reply = await runResearch(h.deps, { action: 'start', question: 'what did Dana email me about the invoice', topic: 'what did Dana email me about the invoice' }, new AbortController().signal);
  assert.equal(dispatched, 0, 'a dead endpoint is never dispatched to');
  assert.deepEqual(h.sources.map(entry => entry.outcome), ['unavailable'], 'the source log states the dead endpoint once');
  const row = logs.at(-1)!.sources.find(entry => entry.kind === 'mail')!;
  assert.deepEqual({ disposition: row.disposition, reason: row.reason }, { disposition: 'skipped', reason: 'endpoint_unavailable' });
  assert.ok(safeEvent(logs.at(-1)!) !== undefined, 'the host log keeps that sub-reason');
  assert.match(String(reply['note'] ?? ''), /could not reach mail/u, 'and the reply still says mail was not reached');
});

test('ROUTE-R2: the host log keeps a skip reason only from the closed set', () => {
  const receipt = {
    event: 'research_run', researchId: 'r1', questionClass: 'cross_source', rounds: 1, perRound: [], stopReason: 'answered', status: 'answered', ops: 1,
    elapsedMs: 1, deadAirMs: 0, selectorMs: 0, fallbackUsed: true, replyBytes: 1, unchecked: [], canContinue: false, findingChars: [],
    sources: [{ kind: 'calendar', disposition: 'skipped', latencyMs: 0, reason: 'not_granted' }],
  };
  const kept = safeEvent(receipt);
  assert.ok(kept !== undefined, 'a skipped row keeps its closed reason');
  assert.deepEqual((kept['sources'] as Record<string, unknown>[])[0], { kind: 'calendar', disposition: 'skipped', latencyMs: 0, reason: 'not_granted' });
  assert.equal(safeEvent({ ...receipt, sources: [{ kind: 'calendar', disposition: 'skipped', latencyMs: 0, reason: 'identity_unverified' }] }), undefined, 'an open word is refused');
  const window = { kind: 'calendar', disposition: 'skipped', latencyMs: 0, reason: 'window_unparsed' };
  assert.deepEqual((safeEvent({ ...receipt, sources: [window] })?.['sources'] as Record<string, unknown>[])[0], window, 'release 4: the window reason is a closed member of the set');
  assert.equal(safeEvent({ ...receipt, sources: [{ kind: 'calendar', disposition: 'completed', latencyMs: 4, reason: 'timeout' }] }), undefined, 'a served row carries no skip reason');
});

// --- F2: one pagination per query, continuation from the cursor, honest coverage -----------------

const pageOf = (page: number, count: number, more: boolean): Partial<IntentSubResult> => shapeGmailList({
  messages: Array.from({ length: count }, (_, n) => ({ id: `m${page}-${n}`, headers: [{ name: 'Subject', value: `Invoice ${page}-${n}` }, { name: 'From', value: 'Dana' }] })),
  ...(more ? { nextPageToken: `p${page + 1}` } : {}),
});

test('F2: one mail query pages once to its cap with a stable page size, and the same query on a follow-up reads no page again', async () => {
  const sent: { page: string; maxResults: unknown }[] = [];
  const h = mailHarness(async subs => subs.map(call => {
    const token = call.args['pageToken'];
    const page = typeof token === 'string' ? Number(token.slice(1)) : 1;
    sent.push({ page: `${page}`, maxResults: call.args['maxResults'] });
    return { key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0, ...pageOf(page, page < 4 ? 25 : 4, page < 4) };
  }));
  h.deps.memo = { calendar: new Map() };
  const start = { action: 'start' as const, question: 'which invoices did I get', topic: 'which invoices did I get', lookups: [{ source: 'mail' as const, mail: { q: 'invoice newer_than:14d', maxResults: 25 } }] };
  const first = await runResearch(h.deps, start, new AbortController().signal);
  assert.deepEqual(sent.map(entry => entry.page), ['1', '2', '3', '4'], 'the 79 matches take four pages, one dispatch each');
  assert.deepEqual([...new Set(sent.map(entry => entry.maxResults))], [25], 'one stable page size for the query');
  assert.equal((first['mailCoverage'] as Record<string, unknown>)['received'], 79, 'all 79 matches came back');
  const afterFirst = sent.length;
  const second = await runResearch(h.deps, { ...start, lookups: [{ source: 'mail', mail: { q: 'invoice newer_than:14d', maxResults: 10 } }] }, new AbortController().signal);
  assert.equal(sent.length, afterFirst, 'the follow-up continues the session read instead of paging from page 1');
  assert.equal((second['mailCoverage'] as Record<string, unknown>)['received'], 79, 'and it still holds every message the session already read');
});

test('F2: a rate-limited page waits once and then closes the read, and page 1 is never read again', async () => {
  const sent: string[] = [];
  let waits = 0;
  const h = mailHarness(async subs => subs.map(call => {
    const token = call.args['pageToken'];
    const page = typeof token === 'string' ? token : 'first';
    sent.push(page);
    if (page === 'p2') return { key: call.key, name: call.name, ok: false, text: 'provider failure: http 429 rateLimitExceeded', originalCharacters: 0, omittedCharacters: 0, code: 'connector_error' };
    return { key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0, ...pageOf(1, 25, true) };
  }));
  h.deps.memo = { calendar: new Map() };
  // RUN-R8: only the rate-limit wait is driven here. A read's own deadline is a timer on this same seam, so
  // it stays inert and cancellable instead of firing at once and closing the read before its retry.
  h.deps.schedule = (callback, delayMs) => {
    if (delayMs !== RESEARCH.rateLimitRetryMs) return { unref: () => {}, cancel: () => {} };
    waits += 1;
    const timer = setTimeout(callback, 0);
    return { unref: () => { timer.unref(); }, cancel: () => { clearTimeout(timer); } };
  };
  let reading: Promise<void> | undefined;
  h.deps.background = done => { reading = done; };
  const reply = await runResearch(h.deps, { action: 'start', question: 'which invoices did I get', topic: 'which invoices did I get', lookups: [{ source: 'mail', mail: { q: 'invoice newer_than:14d', maxResults: 25 } }] }, new AbortController().signal);
  await reading;
  assert.deepEqual(sent, ['first', 'p2', 'p2'], 'the failed page is retried once after a wait, and page 1 is never refetched');
  assert.equal(waits, 1, 'exactly one delayed retry');
  const receipt = h.sources.filter(entry => entry.source === 'mail').at(-1)!;
  assert.equal(receipt.outcome, 'ok', 'a read that delivered its pages keeps them, even when a later page stopped');
  assert.equal(receipt.partial, 'pages_failed', 'and the source result says partial with the page it lost');
  assert.equal(receipt.failedPages, 1, 'the count of pages it lost');
  assert.match(String(reply['note']), /Still reading: mail|mail search stopped/u, 'the answer never claims the mailbox was read to the end');
});

test('F2: a rate limit on the first page leaves a closed failure and a plain coverage note', async () => {
  let waits = 0;
  const sent: string[] = [];
  const h = mailHarness(async subs => subs.map(call => {
    sent.push('call');
    return { key: call.key, name: call.name, ok: false, text: 'provider failure: http 429 rateLimitExceeded', originalCharacters: 0, omittedCharacters: 0, code: 'connector_error' };
  }));
  h.deps.memo = { calendar: new Map() };
  // RUN-R8: only the rate-limit wait is driven here. A read's own deadline is a timer on this same seam, so
  // it stays inert and cancellable instead of firing at once and closing the read before its retry.
  h.deps.schedule = (callback, delayMs) => {
    if (delayMs !== RESEARCH.rateLimitRetryMs) return { unref: () => {}, cancel: () => {} };
    waits += 1;
    const timer = setTimeout(callback, 0);
    return { unref: () => { timer.unref(); }, cancel: () => { clearTimeout(timer); } };
  };
  const reply = await runResearch(h.deps, { action: 'start', question: 'which invoices did I get', topic: 'which invoices did I get', lookups: [{ source: 'mail', mail: { q: 'invoice newer_than:14d' } }] }, new AbortController().signal);
  assert.equal(sent.length, 2, 'the page is asked once, then once more after the wait');
  assert.equal(waits, 1, 'exactly one delayed retry');
  const receipt = h.sources.filter(entry => entry.source === 'mail').at(-1)!;
  assert.equal(receipt.outcome, 'failed');
  assert.match(String(reply['note']), /mail search stopped before the end/u, 'the reply says the mailbox was not read');
});

// --- F9: a refusal names what to change -------------------------------------

test('F9: each refusal code names the fix, and the generic line stays the fallback', async () => {
  const { researchRepair } = await import('../tools/research.js');
  const length = researchRepair('lookup_query_length');
  assert.match(String(length['guidance']), /keep it under \d+ characters/u, 'the length refusal names the limit');
  assert.match(String(length['guidance']), /shorten/u, 'and says what to do');
  const mail = researchRepair('lookup_mail');
  assert.match(String(mail['guidance']), /\{"source":"mail","mail":\{"q"/u, 'the mail refusal names the accepted search shape');
  assert.match(String(mail['guidance']), /maxResults/u);
  assert.match(String(mail['guidance']), /no query beside|carries no query/u, 'and the shape it must not use');
  assert.match(String(researchRepair('root_type')['guidance']), /No lookup started/u, 'an unmapped reason keeps the generic line');
});

// --- MAILQ: what came in, and the topic as the only search text -------------------------------

/** The 40-word instruction paragraph the model really writes, with the host's topic beside it. */
const PROSE = 'Please explain what the prior discussion said about this, identify the people who need a reaction, verify the exact numbers requiring attention before the review, and tell me what is relevant since Monday.';

test('MAILQ 1: only the topic terms reach the search text, for mail and knowledge', () => {
  const base = { question: PROSE, topic: 'Wilmar pilot', configured: ['mail', 'knowledge'] as const, evidence: new Map(), nowMs: NOW, timeZone: ZONE };
  const mail = candidateSubs('mail_search', { ...base, query: PROSE });
  assert.equal(mail[0]?.args['q'], 'wilmar pilot', 'the topic words, and no instruction word');
  const knowledge = candidateSubs('knowledge_search', base);
  assert.equal(knowledge[0]?.args['query'], 'wilmar pilot', 'the topic again, for the ranker');
  for (const word of ['explain', 'prior', 'discussion', 'identify', 'reaction', 'relevant', 'since']) {
    assert.equal(JSON.stringify([mail, knowledge]).includes(word), false, `${word} never reaches a search`);
  }
});

test('MAILQ 3 and F3: an operator name outside the closed set is a word with a colon, not an operator', () => {
  assert.equal(compileMailQuery('check the inbox', 'in:inbox remaining:metadata business-relevant newer_than:14d', NOW, ZONE, ''), 'in:inbox newer_than:14d');
  assert.deepEqual(mailQueryShape('in:inbox remaining:metadata newer_than:14d'), { terms: 1, operators: ['in', 'newer_than'], window: 'newer_than:14d' });
});

test('MAILQ 3: a model-written Gmail query keeps its operators and loses its prose', () => {
  assert.equal(
    compileMailQuery('Has anything important come in?', 'in:inbox newer_than:14d remaining metadata business-relevant', NOW, ZONE, ''),
    'in:inbox newer_than:14d',
    'the operators the host recognises survive, the prose words do not',
  );
});

const triageMessage = (index: number): Record<string, unknown> => ({
  id: `m${index}`, threadId: `t${index}`,
  headers: [
    { name: 'Subject', value: `Thread ${index}` },
    { name: 'From', value: `Sender ${index} <s${index}@example.com>` },
    { name: 'Date', value: `Mon, 19 Oct 2026 0${index}:00:00 +0000` },
  ],
});

test('MAILQ 2: a "what came in" ask scans the unread inbox and counts what came in', async () => {
  const sent: string[] = [];
  const h = mailHarness(async subs => subs.map(call => {
    const q = String(call.args['q'] ?? '');
    sent.push(q);
    const messages = Array.from({ length: 10 }, (_, index) => triageMessage(9 - index));
    return { key: call.key, name: call.name, ok: true, ...shapeGmailList({ messages }) } as IntentSubResult;
  }));
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'Has anything important come in that needs a reaction?', topic: 'unread mail',
    lookups: [{ source: 'mail', query: 'Has anything important come in?' }],
  }, new AbortController().signal);
  assert.deepEqual(sent, ['in:inbox is:unread is:important newer_than:2d', 'in:inbox is:unread newer_than:2d'], 'the fixed scan, important first, and no prose word');
  const text = (reply['findings'] as { text: string }[])[0]?.text ?? '';
  assert.match(text, /^mail: 10 of 10 shown$/mu, 'the reply says how many came in and that nothing was held back');
  assert.match(text, /Sender 9 \| Thread 9 \| Mon, 19 Oct 2026/u, 'newest first, with sender and date');
  assert.equal(text.includes('Thread 0'), true, 'the oldest of the ten is there too');
  assert.equal(text.split('\n').filter(line => line.startsWith('Sender') && line.includes('Thread 5')).length, 1, 'a thread both reads returned is listed once');
});
