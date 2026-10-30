import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answersTheAsk, lateHoldMs, muteRebuildTrigger, refusedResponse, unspokenReply, ANSWER_AUDIO_HOLD_MS, SPEAKING_HOLD_MS } from '../live/index.js';
import { spokenPageOf } from '../tools/research.js';
import type { LiveToolResponse } from '../adapters/live-voice/types.js';

/**
 * The contracts of call 8be5d80f (2026-10-30): the rebuild digest, the answered-turn mark, the ambient rebuild,
 * the late-result hold and the pre-owner refusal. Each one is a decision this lane moved out of the session body,
 * so the exact failing sequence is asserted here without a provider.
 */

function cited(): Record<string, unknown> {
  const lines: string[] = [];
  for (let index = 0; index < 40; index += 1) lines.push(`web: the council approved the budget on reading ${index}`);
  const web = Array.from({ length: 40 }, (_, index) => ({
    title: `Result ${index}`,
    url: `https://news.example${(index % 7) + 1}.com/politics/2026/10/30/long-article-slug-${index}?utm_source=feed`,
  }));
  return {
    researchId: 'r-web', status: 'answered', canContinue: false, sources: ['web'],
    findings: [{ source: 'web', text: lines.join('\n') }],
    markdown: web.map(source => `- [${source.title}](${source.url})`).join('\n'),
    webSources: web, webAttribution: [],
  };
}

test('G2: a rebuild digest carries evidence lines, never the head of a JSON body', () => {
  const reply = cited();
  assert.ok(JSON.stringify(reply).length > 9_000, 'the fixture is the size the owner\'s call produced');
  const digest = unspokenReply([{ id: 'c1', name: 'research', response: reply }] as LiveToolResponse[]);
  assert.ok(digest !== undefined);
  assert.match(digest, /^web: the council approved the budget on reading 0/u, 'the evidence leads the digest');
  assert.equal(digest.includes('https://'), false, 'the digest carries sites, not whole links');
  assert.ok(digest.length <= 1_200, `the digest is bounded (${digest.length})`);
  const page = spokenPageOf(reply);
  const first = (page['findings'] as { text: string }[])[0]?.text ?? '';
  assert.notEqual(first.trim(), '', 'the compact page it is taken from carries evidence too');
});

test('G3: an opener, a filler or a quip after a rebuild never spends the turn', () => {
  assert.equal(answersTheAsk(true, 'So, the budget meeting, right?'), false, 'the opener of a rebuilt session is not the answer');
  assert.equal(answersTheAsk(false, 'One second.'), false, 'a filler answers nothing');
  assert.equal(answersTheAsk(false, 'The council approved the budget on Tuesday.'), true, 'a real answer is the answer');
});

test('G4: a rebuild that owes a tool result is never ambient', () => {
  assert.equal(muteRebuildTrigger({ owesAnswer: true, ownerWordsSinceModelOutput: false, ackAnsweredOwner: false }), 'no_output_after_owner',
    'a pending tool result keeps the rebuild out of the ambient case, however long the filler was');
  assert.equal(muteRebuildTrigger({ owesAnswer: false, ownerWordsSinceModelOutput: true, ackAnsweredOwner: false }), 'no_output_after_owner');
  assert.equal(muteRebuildTrigger({ owesAnswer: false, ownerWordsSinceModelOutput: false, ackAnsweredOwner: false }), 'no_output_after_ambient',
    'a call that owed nothing stays ambient, so a silent call is still a quiet rebuild');
});

test('G5: a result that lands while she speaks or while her answer plays is held, then offered', () => {
  assert.equal(lateHoldMs('owner_speaking'), SPEAKING_HOLD_MS);
  assert.equal(lateHoldMs('answer_playing'), ANSWER_AUDIO_HOLD_MS, 'her own answer audio holds the line on the same path');
  assert.equal(lateHoldMs('new_question'), undefined, 'a real new question still parks it');
  assert.equal(lateHoldMs(null), undefined);
});

test('G7: a refusal is recognised as one, so it is never said as a result', () => {
  assert.equal(refusedResponse({ error: 'answer_already_given', findings: [], canContinue: false }), true);
  assert.equal(refusedResponse({ status: 'unavailable', findings: [] }), true);
  assert.equal(refusedResponse({ status: 'answered', findings: [{ text: 'the budget passed' }] }), false);
});
