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

test('chat evidence cards render names, bounded safe markdown and permitted sources', () => {
  const html = render([{ name: 'gmail_list', markdown: '**ACCEPTED** [unsafe](javascript:alert) <script>REJECTED-HTML</script>', sources: [{ title: 'Inbox evidence', url: 'https://example.org/mail' }, { title: 'Local citation' }, { title: 'Unsafe source', url: 'javascript:alert(1)' }] }]);
  assert.match(html, /tool-evidence/);
  assert.match(html, /Gmail/);
  assert.doesNotMatch(html, /gmail_list|Gated tool result/);
  assert.match(html, /<strong>ACCEPTED<\/strong>/);
  assert.match(html, /unsafe/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="https:\/\/example.org\/mail"/);
  assert.match(html, /Local citation/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('chat cards enforce display bounds and empty evidence has no invented card', () => {
  assert.equal(render([]), '');
  const html = render(Array.from({ length: 20 }, () => ({ name: 'read', markdown: 'a'.repeat(5000) + 'TAIL-SENTINEL', sources: Array.from({ length: 12 }, (_, i) => ({ title: `source ${i}` })) })));
  assert.equal((html.match(/class="tool-evidence"/g) ?? []).length, 16);
  assert.doesNotMatch(html, /TAIL-SENTINEL|source 8/);
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
