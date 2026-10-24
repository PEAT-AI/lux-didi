import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResearchLedger, runResearch, type ResearchDeps } from '../tools/research.js';
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
