import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResearchAdmission, ResearchLedger, RESEARCH, RESEARCH_READ_CEILING, sameOwnerQuestion, VoiceReplyBook, VOICE_CURSOR_ERROR, VOICE_REPLY_CUT, capVoiceReply, runResearch, stillSearchingOf, type ResearchDeps } from '../tools/research.js';
import { answersTheAsk } from '../live/index.js';
import type { IntentSubResult } from '../tools/intent.js';
import { lateCommentarySilence } from '../live/index.js';

const signal = (): AbortSignal => new AbortController().signal;

function continuationFixture(): { deps: ResearchDeps; executed: string[] } {
  const executed: string[] = [];
  const deps: ResearchDeps = {
    now: () => 0, configured: ['knowledge'], ledger: new ResearchLedger(),
    emit() {}, log() {}, step() {}, logSource() {}, logSubcall() {}, logRouted() {},
    execute: async subs => subs.map(call => {
      executed.push(call.name);
      return { key: call.key, name: call.name, ok: true, text: '### Release scope (DECISION | 2026-10-17) [id 12]', originalCharacters: 48, omittedCharacters: 0 } as IntentSubResult;
    }),
  };
  return { deps, executed };
}

// ROUTE-1022 (D6): a continuation the run cannot serve told the model nothing, so the model answered
// with an empty "continue" and went silent. The reply now says what to do instead.
test('ROUTE-1022: a cursor the run does not hold answers with a note that says what to do next', async () => {
  const h = continuationFixture();
  const started = await runResearch(h.deps, { action: 'start', question: 'what is the release scope', topic: 'release scope', lookups: [{ source: 'knowledge', query: 'release scope' }] }, signal());
  const researchId = String(started['researchId']);
  const reply = await runResearch(h.deps, { action: 'continue', researchId, cursor: 'a-cursor-this-run-never-issued' }, signal());
  assert.equal(reply['error'], 'continuation_unavailable');
  assert.equal(reply['canContinue'], false, 'the model is told this continuation is over');
  const note = String(reply['note'] ?? '');
  assert.match(note, /fresh research question/, 'the note names the one action that gets the answer moving again');
  assert.match(note, /no longer available/, 'and it says why the earlier result is gone');
});

// TOPIC (#565) and MAILQ-AUTHOR F3: a continuation carries no topic of its own, so a read the run
// already made is never dispatched a second time and no other words reach a source.
test('TOPIC 5 (#565): a continuation takes no new topic and re-reads no completed source', async () => {
  const h = continuationFixture();
  const started = await runResearch(h.deps, {
    action: 'start', question: 'what is the release scope', topic: 'release scope',
    lookups: [{ source: 'knowledge', query: 'release scope' }],
  }, signal());
  const researchId = String(started['researchId']);
  const before = h.executed.length;
  const reply = await runResearch(h.deps, {
    action: 'continue', researchId, question: 'explain the prior discussion and identify the relevant blocker',
    topic: 'an entirely different topic',
  }, signal());
  assert.equal(reply['error'], undefined, 'the continuation is served');
  assert.equal(h.executed.length, before, 'the continuation dispatched no new read of a completed source');
});

// C-CONTINUITY T-11: a research reply delivered into a voice session is capped at
// RESEARCH.voiceReplyChars after serialization, findings first and marked, and the rest of the
// answer is read with the cursor it hands back, never by re-running the search.
function longReply(): Record<string, unknown> {
  const lines: string[] = [];
  let size = 0;
  for (let index = 0; size < 11_294; index += 1) {
    const line = `knowledge: LAT-${1023 + index} release scope and the owner's decision, sentence ${index}`;
    lines.push(line);
    size += line.length + 1;
  }
  return { researchId: 'r-1', status: 'answered', canContinue: false, sources: ['knowledge'], findings: [{ source: 'knowledge', text: lines.join('\n') }] };
}

test('C-CONTINUITY T-11: an 11,294-character reply delivers at most 3,000 characters and a cursor', () => {
  const reply = longReply();
  assert.ok(JSON.stringify(reply).length > 11_000, 'the fixture is the size the live call really produced');
  const book = new VoiceReplyBook();
  const page = capVoiceReply(reply, book);
  const wire = JSON.stringify(page);
  assert.ok(wire.length <= RESEARCH.voiceReplyChars, `the delivered reply is ${wire.length} characters`);
  assert.equal(page['cut'], VOICE_REPLY_CUT, 'the cut is marked');
  assert.equal(String(page['researchId']), 'r-1', 'the envelope the caller reads is unchanged');
  assert.equal(page['status'], 'answered');
  assert.match(String((page['findings'] as { text: string }[])[0]!.text), /^knowledge: LAT-1023 /u, 'the findings come first');
  assert.ok(typeof page['pageCursor'] === 'string' && page['pageCursor'] !== '', 'the page pointer reads the rest');
  const text = String((page['findings'] as { text: string }[])[0]!.text);
  assert.ok(!/\S\u2026/u.test(text) || /\s\u2026$/u.test(text), 'no cut lands mid-word');
});

test('C-CONTINUITY T-11: a continue with that cursor pages the stored reply and runs no search', async () => {
  const h = continuationFixture();
  const book = new VoiceReplyBook();
  h.deps.voicePages = book;
  const reply = longReply();
  const first = capVoiceReply(reply, book);
  const cursor = String(first['pageCursor']);
  const before = h.executed.length;
  const second = await runResearch(h.deps, { action: 'continue', researchId: 'r-1', pageCursor: cursor }, signal());
  assert.equal(second['error'], undefined, 'the page is served');
  assert.equal(h.executed.length, before, 'paging the stored answer dispatched no read and no new search');
  assert.ok(JSON.stringify(second).length <= RESEARCH.voiceReplyChars, 'every page obeys the cap');
  // Every page reads on until the answer is spent, and each one stays inside the cap.
  const parts = [String((first['findings'] as { text: string }[])[0]!.text),
    String((second['findings'] as { text: string }[])[0]!.text)];
  let page: Record<string, unknown> = second;
  let pages = 2;
  while (page['pageCursor'] !== undefined && pages < 20) {
    page = await runResearch(h.deps, { action: 'continue', researchId: 'r-1', pageCursor: String(page['pageCursor']) }, signal());
    assert.equal(page['error'], undefined, 'the next page is served');
    assert.ok(JSON.stringify(page).length <= RESEARCH.voiceReplyChars, 'every page obeys the cap');
    parts.push(String((page['findings'] as { text: string }[])[0]!.text));
    pages += 1;
  }
  assert.equal(h.executed.length, before, 'the whole answer was paged from the host, never re-researched');
  assert.equal(page['canContinue'], false, 'the last page says the answer is spent');
  const whole = parts.join('\n');
  const original = String(((reply['findings'] as { text: string }[])[0]!).text);
  assert.ok(whole.includes('LAT-1023'), 'the answer starts where it started');
  const lastLine = original.split('\n').pop()!;
  assert.ok(whole.includes(lastLine), 'and it reads all the way to the last line the host stored');
});

test('C-CONTINUITY T-11: a cursor this call does not hold is a closed error, never a new search', async () => {
  const h = continuationFixture();
  h.deps.voicePages = new VoiceReplyBook();
  const before = h.executed.length;
  const reply = await runResearch(h.deps, { action: 'continue', researchId: 'r-1', pageCursor: 'vpage-00000000-0000-0000-0000-000000000000' }, signal());
  assert.equal(reply['error'], VOICE_CURSOR_ERROR, 'the error is closed and named');
  assert.equal(h.executed.length, before, 'an expired cursor starts nothing');
});

// C-CONTINUITY T-11: a body page is a research result too, so it obeys the same cap. Its slices are cut at a whole
// word, the reader's offsets stay exact, and the remainder is paged from the call's own store.
test('C-CONTINUITY T-11: a body of more than a hundred pages never overruns the cap on any page', () => {
  // W1-R5: the remaining count is measured at the width it will really be named at, so a count that grows past two
  // digits can no longer push a page over its cap. This body is wide enough for well over a hundred pages.
  const body = 'Lux received evidence. '.repeat(12_000) + 'LUX_LOCAL_TAIL';
  const reply = { researchId: 'r-wide', status: 'partial', bodyProjection: 'preview', canContinue: true, cursor: 'wide-cursor',
    bodySlices: [{ source: 'knowledge', tool: 'get_insight', text: body, offset: 0, end: body.length, total: body.length }] };
  const book = new VoiceReplyBook();
  let current = capVoiceReply(reply, book);
  let joined = '', pages = 0;
  for (;;) {
    pages += 1;
    assert.ok(JSON.stringify(current).length <= RESEARCH.voiceReplyChars,
      `page ${pages} is ${JSON.stringify(current).length} characters, over the ${RESEARCH.voiceReplyChars} cap`);
    for (const slice of (current['bodySlices'] as { text: string; offset: number; end: number }[])) {
      assert.equal(slice.offset, joined.length, 'the pages are contiguous'); joined += slice.text;
    }
    const cursor = current['pageCursor'];
    if (cursor === undefined) break;
    assert(pages < 200, 'the body arrives in bounded pages');
    current = book.take(String(cursor))!;
  }
  assert(pages > 100, `the body arrives in more than a hundred pages, and took ${pages}`);
  assert.equal(joined, body, 'and every page together is the body, byte for byte');
});

test('C-CONTINUITY T-11: a body page is capped and pages its slices with exact offsets', () => {
  const body = 'Lux received evidence. '.repeat(1_400) + 'LUX_LOCAL_TAIL';
  const reply = { researchId: 'r-body', status: 'partial', bodyProjection: 'preview', canContinue: true, cursor: 'body-cursor',
    bodySlices: [{ source: 'knowledge', tool: 'get_insight', text: body, offset: 0, end: body.length, total: body.length }] };
  assert.ok(JSON.stringify(reply).length > RESEARCH.voiceReplyChars, 'the fixture is wider than the cap');
  const book = new VoiceReplyBook();
  const page = capVoiceReply(reply, book);
  assert.ok(JSON.stringify(page).length <= RESEARCH.voiceReplyChars, `the body page is ${JSON.stringify(page).length} characters`);
  assert.equal(page['bodyProjection'], 'preview', 'the shape a body reader expects is kept');
  assert.equal(String(page['researchId']), 'r-body');
  assert.ok(Array.isArray(page['bodySlices']), 'the slices survive the cap');
  const first = (page['bodySlices'] as { text: string; offset: number; end: number }[])[0]!;
  assert.equal(first.offset, 0, 'the first slice still starts at the top of the body');
  assert.ok(first.end <= body.length, 'and it ends where it says it does');
  assert.equal(body.slice(first.offset, first.end), first.text, 'the coordinates are the body’s own');
  // The rest is read from the store, one page at a time, and the text reassembles byte for byte.
  let reassembled = first.text;
  let current: Record<string, unknown> = page;
  let pages = 1;
  while (current['pageCursor'] !== undefined && pages < 30) {
    current = book.take(String(current['pageCursor']))!;
    assert.ok(current !== undefined, 'the next body page is held by the call');
    assert.ok(JSON.stringify(current).length <= RESEARCH.voiceReplyChars, 'every body page obeys the cap');
    const slice = (current['bodySlices'] as { text: string; offset: number; end: number }[])[0]!;
    assert.equal(body.slice(slice.offset, slice.end), slice.text, 'the offsets stay exact from page to page');
    reassembled += slice.text;
    pages += 1;
  }
  // W1-R3/R4: the reply's own canContinue is copied unchanged onto every page, so the page-level end of the
  // body is the absence of the page pointer and of its remaining count, which is the field this page names.
  assert.equal(current['pageCursor'], undefined, 'the last body page names no further page');
  assert.equal(current['pagesRemaining'], undefined, 'and owes no further pages');
  assert.equal(reassembled, body, 'the whole body is readable through the pages, and nothing was handed over uncapped');
});

// --- #1028: a late finding is parked by work the host did, never by room speech ---------------------

test('#1028: room speech after the answer does not park a late finding', () => {
  const answeredAt = 1_000;
  assert.equal(lateCommentarySilence({ now: 5_000, answeredAt, alreadySpoken: false, ownerWords: 9, inputAt: 2_000, newerWorkAt: 500 }), null,
    'no research start and no tool call after the answer, so the finding is offered');
  assert.equal(lateCommentarySilence({ now: 3_000, answeredAt, alreadySpoken: false, ownerWords: 0, newerWorkAt: 2_000 }), 'new_question',
    'a research operation that started after the answer parks it');
});

// G1 (call 8be5d80f): the page cap counts evidence first. The reply's citation links alone ran to 8,860 characters,
// so a 3,000-char page carried no evidence line at all and said only "fetch the next page".
function citedReply(): Record<string, unknown> {
  const lines: string[] = [];
  for (let index = 0; index < 40; index += 1) lines.push(`web: the council approved the budget on reading ${index}`);
  const web = Array.from({ length: 40 }, (_, index) => ({
    title: `Result ${index}`,
    url: `https://news.example${(index % 7) + 1}.com/politics/local-government/2026/10/30/long-article-slug-${index}?utm_source=feed`,
  }));
  return {
    researchId: 'r-web', status: 'answered', canContinue: false, sources: ['web'],
    findings: [{ source: 'web', text: lines.join('\n') }],
    markdown: web.map(source => `- [${source.title}](${source.url})`).join('\n'),
    webSources: web, webAttribution: [],
  };
}

test('G1: a cited 9.8k reply pages evidence first, and paging walks every line', () => {
  const reply = citedReply();
  assert.ok(JSON.stringify(reply).length > 9_000, `the fixture is the size the owner's call produced (${JSON.stringify(reply).length})`);
  assert.ok(JSON.stringify(reply['webSources']).length > 3_000, 'its links alone are wider than a page');
  const book = new VoiceReplyBook();
  const lines: string[] = [];
  let page: Record<string, unknown> | undefined = capVoiceReply(reply, book);
  const pages: Record<string, unknown>[] = [];
  while (page !== undefined && pages.length < 30) {
    pages.push(page);
    assert.ok(JSON.stringify(page).length <= RESEARCH.voiceReplyChars, `every page obeys the cap (${JSON.stringify(page).length})`);
    const text = (page['findings'] as { text: string }[])[0]?.text ?? '';
    assert.notEqual(text.trim(), '', 'no page with evidence to give is empty');
    assert.ok(!JSON.stringify(page).includes('https://'), 'a spoken page names sites, never whole links');
    lines.push(...text.split('\n').filter(line => line !== ''));
    const cursor: unknown = page['pageCursor'];
    page = typeof cursor === 'string' ? book.take(cursor) : undefined;
  }
  assert.match(String((pages[0]!['findings'] as { text: string }[])[0]!.text), /^web: the council approved/u,
    'page 1 carries evidence, not a page of citation links');
  assert.match(JSON.stringify(pages[0]), /\[\d+\] news\.example\d\.com/u, 'the citations are domains plus an index');
  assert.equal(lines.length, 40, 'paging walks all of it, with no line lost and none repeated');
  for (let index = 0; index < 40; index += 1) assert.ok(lines.some(line => line.includes(`reading ${index}`)), `line ${index} was paged`);
});

test('G6: a page note never says nothing more to fetch while it still owes lines', () => {
  const reply = { ...longReply(), note: RESEARCH.completeNote };
  const book = new VoiceReplyBook();
  const first = capVoiceReply(reply, book);
  const note = String(first['note'] ?? '');
  assert.match(note, /more lines/u, 'the page says how much it owes');
  assert.doesNotMatch(note, /nothing more to fetch/iu, 'and never contradicts itself in the same line');
});

test('G8: a direction extends the run instead of cancelling it, and an unread source says so', async () => {
  const h = continuationFixture();
  const started = await runResearch(h.deps, {
    action: 'start', question: 'what is the release scope', topic: 'release scope',
    lookups: [{ source: 'knowledge', query: 'release scope' }],
  }, signal());
  const researchId = String(started['researchId']);
  const extended = await runResearch(h.deps, { action: 'continue', researchId, direction: 'go deeper on the lighthouse budget vote' }, signal());
  assert.equal(extended['error'], undefined, 'the direction is served from the run itself');
  const run = h.deps.ledger.find(researchId);
  assert.ok(run !== undefined, 'the run the owner was already promised survives');
  assert.equal(run!.cancelled, false, 'it was never cancelled');
  assert.equal(run!.direction, 'go deeper on the lighthouse budget vote', 'the direction is the run\'s next round');
  // A direction naming a source this run never read is the #654 case: it starts fresh and says so, rather than
  // being served as a continuation of a run that cannot read it.
  const other = await runResearch(h.deps, { action: 'continue', researchId, direction: 'also check the calendar for it' }, signal());
  assert.match(String(other['note'] ?? ''), /fresh lookup, not a continuation/u, 'the one ask the run cannot honour says so');
  assert.notEqual(String(other['researchId']), researchId, 'and it runs under its own id');
});

// B-1 (review finding, requirement 1): it is not only citation links that can fill a page. A mail-shaped reply
// carries its message ids and coverage map in the same envelope, so the invariant is asserted against that shape too.
test('B-1: an adversarial mail envelope still pages evidence inside the cap', () => {
  const lines: string[] = [];
  for (let index = 0; index < 40; index += 1) lines.push(`mail: the renewal thread agreed the Friday date, item ${index}`);
  const reply: Record<string, unknown> = {
    researchId: 'r-mail', status: 'answered', canContinue: false, sources: ['mail'],
    findings: [{ source: 'mail', text: lines.join('\n') }],
    mailMessages: Array.from({ length: 60 }, (_, index) => ({ id: `m-${index}`, threadId: `t-${index}`, internalDate: 1_700_000_000_000 + index })),
    mailCoverage: { view: 'metadata', metadataTruncated: true, received: 60, shown: 40 },
    receipts: Array.from({ length: 20 }, (_, index) => ({ key: `receipt-${index}`, detail: 'x'.repeat(80) })),
  };
  assert.ok(JSON.stringify(reply).length > 6_000, `the fixture is bulk-heavy (${JSON.stringify(reply).length})`);
  const book = new VoiceReplyBook();
  const first = capVoiceReply(reply, book);
  const wire = JSON.stringify(first);
  assert.ok(wire.length <= RESEARCH.voiceReplyChars, `the page obeys the cap (${wire.length})`);
  const text = (first['findings'] as { text: string }[])[0]?.text ?? '';
  assert.match(text, /^mail: the renewal thread agreed the Friday date, item 0/u, 'page 1 carries evidence');
  assert.equal(first['mailMessages'], undefined, 'bulk the page has no room for is dropped, not left to starve it');
});

// B-2 (review finding, requirement 3): the exact sequence of call 8be5d80f, rebuild then quip then retry.
test('B-3: a source whose findings are in the ledger is never called still searching', () => {
  const reading = ['mail', 'chat'] as const;
  const run = (done: string[], landed: (string | null)[]) => ({
    sourcesDone: new Set(done) as ReadonlySet<'mail' | 'chat'>,
    ledger: new Map(landed.map((source, index) => [`entry-${index}`, { source: source as 'mail' | 'chat' | null }])),
  });
  assert.deepEqual(stillSearchingOf(reading, run([], [])), ['mail', 'chat'], 'nothing landed, both are still searching');
  assert.deepEqual(stillSearchingOf(reading, run([], ['mail'])), ['chat'], 'a landed source is never said to be pending');
  assert.deepEqual(stillSearchingOf(reading, run(['mail', 'chat'], ['mail'])), [], 'a finished read is never pending either');
});

test('B-2: rebuild, quip, retry, and the retry is not refused as answered', () => {
  const admission = new ResearchAdmission();
  admission.ownerTurn();
  assert.deepEqual(admission.admit('start', false, false, 'what is the release scope'), { admitted: true });
  admission.delivered('r-1');
  // The rebuilt session speaks a quip: an opening turn is never the answer, so the turn is not spent.
  assert.equal(answersTheAsk(true, 'So, where were we?'), false);
  if (answersTheAsk(true, 'So, where were we?')) admission.answered();
  const retry = admission.admit('start', false, false, 'what is the release scope');
  const refusedAsAnswered = retry.admitted === false && retry.reason === 'answer_already_given';
  assert.equal(refusedAsAnswered, false, 'the quip never made the turn answered');
  // The owner says "I need a moment to try again", which grants the retry its own operation.
  admission.ownerTurn();
  assert.deepEqual(admission.admit('start', false, false, 'what is the release scope'), { admitted: true },
    'the retry of the same ask is admitted');
  // A real answer still spends the turn, which is the mark G3 must not weaken.
  admission.delivered('r-2');
  if (answersTheAsk(false, 'The council approved the budget on Tuesday.')) admission.answered();
  assert.deepEqual(admission.admit('start', false, false, 'what is the release budget'),
    { admitted: false, reason: 'answer_already_given' });
});

// C-RESEARCH #107: one host-owned job per owner question, and a continue never spends the turn.
test('#107: a start then two continues are one job, and no continue is a spent turn', () => {
  const admission = new ResearchAdmission();
  admission.ownerTurn();
  assert.deepEqual(admission.admit('start', false, false, 'what is the release scope'), { admitted: true });
  const job = admission.jobId();
  assert.equal(typeof job, 'string', 'the admitted start opens one job');
  admission.delivered('run-1');
  assert.deepEqual(admission.admit('continue'), { admitted: true }, 'the first continue attaches');
  assert.deepEqual(admission.admit('continue'), { admitted: true }, 'the second continue is not a spent turn');
  assert.equal(admission.jobId(), job, 'both continues attach to the same job');
  assert.equal(admission.readsSpent(), 0, 'a continue spends no read budget');
});

test('#107: a paraphrased second start attaches to the same owner ask', () => {
  const admission = new ResearchAdmission();
  admission.ownerTurn();
  assert.deepEqual(admission.admit('start', false, false, 'what changed in the release notes'), { admitted: true });
  const job = admission.jobId();
  assert.deepEqual(admission.admit('start', false, false, 'what has changed in the release notes?'), { admitted: true, attach: true },
    'the model paraphrase is the same owner ask, so it attaches instead of being a spent turn');
  assert.equal(admission.jobId(), job, 'the paraphrase joins the job, it never opens a second one');
});

test('#107: a distinct owner question after the answer starts a new job', () => {
  const admission = new ResearchAdmission();
  admission.ownerTurn();
  assert.deepEqual(admission.admit('start', false, false, 'what changed in the release notes'), { admitted: true });
  const first = admission.jobId();
  admission.delivered('run-1');
  admission.answered();
  admission.ownerTurn();
  assert.deepEqual(admission.admit('start', false, false, 'when is the dentist appointment'), { admitted: true });
  assert.notEqual(admission.jobId(), first, 'a new owner question is a new job');
});

test('#107: a rebuild mid-job keeps the job and does not refill its read budget', () => {
  const admission = new ResearchAdmission();
  admission.ownerTurn();
  assert.deepEqual(admission.admit('start', false, false, 'what is the release scope'), { admitted: true });
  const job = admission.jobId();
  assert.equal(admission.takeReads(RESEARCH_READ_CEILING), RESEARCH_READ_CEILING, 'one task may read to its ceiling');
  assert.equal(admission.takeReads(1), 0, 'and not one read past it');
  // A provider rebuild never touches this object, which is exactly why the job and its budget survive it.
  assert.equal(admission.jobId(), job, 'the job is the same job across a rebuild');
  assert.equal(admission.readsLeft(), 0, 'a rebuild does not refill the budget');
  admission.ownerTurn();
  assert.deepEqual(admission.admit('start', false, false, 'and what about the roadmap'), { admitted: true });
  assert.equal(admission.readsLeft(), RESEARCH_READ_CEILING, 'a new owner question gets fresh budget inside the ceiling');
});

// C-RESEARCH #107 (R-R2): identity must not merge a distinct owner question into the running job.
test('#107: a distinct question that shares a topic is not the same owner ask', () => {
  assert.equal(sameOwnerQuestion('who owns Acme Seeds', 'Acme Seeds revenue'), false,
    'a topic word in common is not the same ask');
  assert.equal(sameOwnerQuestion('what changed in the release notes', 'what has changed in the release notes?'), true,
    'a reworded repeat of the same ask is the same ask');
  const admission = new ResearchAdmission();
  admission.ownerTurn();
  assert.deepEqual(admission.admit('start', false, false, 'who owns Acme Seeds'), { admitted: true });
  const job = admission.jobId();
  assert.deepEqual(admission.admit('start', false, false, 'Acme Seeds revenue'), { admitted: true },
    'a distinct question is admitted as its own ask, never as an attach');
  assert.notEqual(admission.jobId(), job, 'the distinct question opens its own job');
});

// C-RESEARCH #107 (R-R2): a web read the task ceiling cut says so, and is never dispatched as an outage.
test('#107: a web read cut by the ceiling names the ceiling and never reaches the port', async () => {
  const searched: string[] = [];
  const deps: ResearchDeps = {
    now: () => 0, configured: ['web'], ledger: new ResearchLedger(),
    emit() {}, log() {}, step() {}, logSource() {}, logSubcall() {}, logRouted() {},
    execute: async subs => subs.map(call => ({ key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0 })),
    readsLeft: () => 0,
    web: { search: async request => { searched.push(request.query); return { ok: false as const, code: 'web_unavailable' as const }; } },
  };
  const reply = await runResearch(deps, { action: 'start', question: 'synthetic web ceiling', lookups: [{ source: 'web', query: 'synthetic ceiling' }] }, signal());
  assert.deepEqual(searched, [], 'a read past the ceiling is never dispatched');
  assert.match(JSON.stringify(reply), /read ceiling/u, `the cut names its cause: ${JSON.stringify(reply).slice(0, 400)}`);
  assert.doesNotMatch(JSON.stringify(reply), /web unavailable|is not connected/u, 'the cut is never reported as an outage');
});
