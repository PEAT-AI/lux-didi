import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResearchLedger, RESEARCH, VoiceReplyBook, VOICE_CURSOR_ERROR, VOICE_REPLY_CUT, capVoiceReply, runResearch, type ResearchDeps } from '../tools/research.js';
import type { IntentSubResult } from '../tools/intent.js';

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
  assert.ok(typeof page['cursor'] === 'string' && page['cursor'] !== '', 'the cursor pages the rest');
  const text = String((page['findings'] as { text: string }[])[0]!.text);
  assert.ok(!/\S\u2026/u.test(text) || /\s\u2026$/u.test(text), 'no cut lands mid-word');
});

test('C-CONTINUITY T-11: a continue with that cursor pages the stored reply and runs no search', async () => {
  const h = continuationFixture();
  const book = new VoiceReplyBook();
  h.deps.voicePages = book;
  const reply = longReply();
  const first = capVoiceReply(reply, book);
  const cursor = String(first['cursor']);
  const before = h.executed.length;
  const second = await runResearch(h.deps, { action: 'continue', researchId: 'r-1', cursor }, signal());
  assert.equal(second['error'], undefined, 'the page is served');
  assert.equal(h.executed.length, before, 'paging the stored answer dispatched no read and no new search');
  assert.ok(JSON.stringify(second).length <= RESEARCH.voiceReplyChars, 'every page obeys the cap');
  // Every page reads on until the answer is spent, and each one stays inside the cap.
  const parts = [String((first['findings'] as { text: string }[])[0]!.text),
    String((second['findings'] as { text: string }[])[0]!.text)];
  let page: Record<string, unknown> = second;
  let pages = 2;
  while (page['canContinue'] === true && pages < 20) {
    page = await runResearch(h.deps, { action: 'continue', researchId: 'r-1', cursor: String(page['cursor']) }, signal());
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
  const reply = await runResearch(h.deps, { action: 'continue', researchId: 'r-1', cursor: 'vpage-00000000-0000-0000-0000-000000000000' }, signal());
  assert.equal(reply['error'], VOICE_CURSOR_ERROR, 'the error is closed and named');
  assert.equal(h.executed.length, before, 'an expired cursor starts nothing');
});

// C-CONTINUITY T-11: a body page is a research result too, so it obeys the same cap. Its slices are cut at a whole
// word, the reader's offsets stay exact, and the remainder is paged from the call's own store.
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
  while (current['canContinue'] === true && pages < 30) {
    current = book.take(String(current['cursor']))!;
    assert.ok(current !== undefined, 'the next body page is held by the call');
    assert.ok(JSON.stringify(current).length <= RESEARCH.voiceReplyChars, 'every body page obeys the cap');
    const slice = (current['bodySlices'] as { text: string; offset: number; end: number }[])[0]!;
    assert.equal(body.slice(slice.offset, slice.end), slice.text, 'the offsets stay exact from page to page');
    reassembled += slice.text;
    pages += 1;
  }
  assert.equal(current['canContinue'], false, 'the last body page says the body is spent');
  assert.equal(reassembled, body, 'the whole body is readable through the pages, and nothing was handed over uncapped');
});
