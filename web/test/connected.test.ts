import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as markdown from '../src/markdown.ts';
import { chatEntryMarkup } from '../src/markdown.ts';
import { composerIntent, draftHeightPx } from '../src/composer.ts';
import type { ToolEvidence } from '../src/protocol.ts';

// Missing evidence rendering is the base behavior, represented as an empty projection.
const render = (markdown as typeof markdown & { renderToolEvidence?: (evidence: readonly ToolEvidence[]) => string }).renderToolEvidence ?? (() => '');
const answer = (markdown as typeof markdown & { answerMarkup?: (text: string) => string }).answerMarkup ?? (() => '');

test('a saved answer with a bullet list and a numbered list renders ul and ol inside a div, not a p', () => {
  const html = answer('- milk\n- eggs\n\n1. pay rent\n2. call bank');
  assert.match(html, /^<div class="markdown">/);
  assert.match(html, /<ul><li>milk<\/li><li>eggs<\/li><\/ul>/);
  assert.match(html, /<ol><li>pay rent<\/li><li>call bank<\/li><\/ol>/);
  assert.equal(/<p>/.test(html), false, 'a saved answer body is a div, never a p');
});

test('chat evidence lists the items the answer used and the sources row carries the links', () => {
  const evidence = [{ name: 'gmail_list', markdown: '**ACCEPTED** [unsafe](javascript:alert) <script>REJECTED-HTML</script>', sources: [{ title: 'Inbox evidence', url: 'https://example.org/mail' }, { title: 'Local citation' }, { title: 'Unsafe source', url: 'javascript:alert(1)' }] }];
  const html = render(evidence);
  assert.match(html, /chat-evidence/);
  assert.match(html, /Gmail/);
  assert.doesNotMatch(html, /gmail_list|Gated tool result/);
  assert.match(html, /ACCEPTED/);
  assert.match(html, /unsafe/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;/);
  const chips = sources(evidence);
  assert.match(chips, /href="https:\/\/example.org\/mail"/);
  assert.match(chips, /Local citation/);
  assert.match(chips, /rel="noopener noreferrer"/);
  assert.doesNotMatch(chips, /href="javascript:/i);
});

test('chat evidence and sources are bounded, deduped, and empty evidence has no invented card', () => {
  assert.equal(render([]), '');
  assert.equal(sources([]), '');
  const evidence = Array.from({ length: 20 }, () => ({ name: 'read', markdown: 'a'.repeat(5000) + 'TAIL-SENTINEL', sources: Array.from({ length: 12 }, (_, i) => ({ title: `source ${i}` })) }));
  const html = render(evidence);
  assert.equal((html.match(/class="chat-evidence-source"/g) ?? []).length, 1, 'one section per source label');
  assert.equal((html.match(/class="chat-evidence-item"/g) ?? []).length, 6, 'six items at most per source');
  assert.doesNotMatch(html, /TAIL-SENTINEL/);
  const chips = sources(evidence);
  assert.equal(chips.match(/source \d+/g)?.length, 3, 'three chips');
  assert.match(chips, /\+9/, 'the rest is a count');
  assert.doesNotMatch(chips, /source 8/);
});

test('the owner-facing evidence card never carries the model-only omission note (C1-R1)', () => {
  const note = '[omitted: 4 more messages; final, this tool has no paging argument]';
  const evidence = [{ name: 'mattermost_get_channel_history',
    markdown: `- chan | alice | 2026-01-01T00:00:00Z | hello\n- chan | bob | 2026-01-01T00:01:00Z | hi\n\n${note}`,
    sources: [{ title: 'Channel', url: 'https://example.org/c' }] }];
  const html = render(evidence);
  assert.doesNotMatch(html, /\[omitted:/);
  assert.match(html, /hello/);
  assert.match(html, /Mattermost/);
  assert.match(sources(evidence), /href="https:\/\/example\.org\/c"/);
});

test('the owner-facing evidence card strips the calendar and handle bracket notes (C1-R1 F1)', () => {
  const html = render([{ name: 'gcal_events',
    markdown: '- 10:00, Standup [id e1]\n- 11:00, Review [id e2] [+40 chars]\n- mail from: alice | [id m9]',
    sources: [] }]);
  assert.doesNotMatch(html, /\[id /);
  assert.doesNotMatch(html, /\[\+\d+ chars\]/);
  assert.match(html, /Standup/);
  assert.match(html, /Review/);
});

test('the chat lane labels nobody: the owner speaks in the shared bubble, Naya answers as markdown (V3 items 4 and 9)', () => {
  const mine = chatEntryMarkup('user', 'what should I focus on?');
  assert.match(mine, /^<article class="entry user"><p class="bubble">what should I focus on\?<\/p><\/article>$/);
  const hers = chatEntryMarkup('assistant', '**Start** here');
  assert.match(hers, /^<article class="entry assistant"><div class="markdown"><p><strong>Start<\/strong> here<\/p><\/div><\/article>$/);
  assert.equal(/>You<|>Naya</.test(mine + hers), false, 'no speaker labels in the chat lane');
});

test('Enter sends the draft and Shift+Enter inserts a newline (V3 item 5)', () => {
  assert.equal(composerIntent({ key: 'Enter' }), 'send');
  assert.equal(composerIntent({ key: 'Enter', shiftKey: true }), undefined, 'Shift+Enter is a newline');
  assert.equal(composerIntent({ key: 'Enter', isComposing: true }), undefined, 'an IME commit never sends');
  assert.equal(composerIntent({ key: 'a' }), undefined);
});

test('the composer grows with the draft up to 40 percent of the lane, then scrolls inside (V3 item 5)', () => {
  assert.equal(draftHeightPx(40, 800), 56, 'never smaller than the 56 px pill');
  assert.equal(draftHeightPx(100, 800), 100, 'grows with the draft');
  assert.equal(draftHeightPx(400, 800), 320, 'capped at 40 percent of the lane height');
  assert.equal(draftHeightPx(400, 0), 400, 'no lane measurement means no cap');
});

test('a failed run states in plain words what happened and what to do next (M1)', () => {
  const runFailureWords = markdown.runFailureWords;
  const words = runFailureWords('outcome_unknown', true);
  assert.equal(words.includes('outcome_unknown'), false, 'the raw outcome code never reaches the panel');
  assert.match(words, /interrupted before it could save an answer/);
  assert.match(words, /Ask again/);
  assert.match(words, /Content may have been sent before it stopped\./);
  assert.equal(runFailureWords('cancelled', false).includes('may have been sent'), false, 'a cancel does not claim content was sent');
  assert.equal(runFailureWords('input_too_large', false).includes('unknown'), false);
});
