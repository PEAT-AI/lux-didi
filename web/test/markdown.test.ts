import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown, TRANSCRIPT_MARKDOWN } from '../src/markdown.ts';

test('renders bold text', () => {
  assert.match(renderMarkdown('**Answer** here'), /<strong>Answer<\/strong>/);
});

test('renders an http link as an anchor with safe rel and target', () => {
  const html = renderMarkdown('see [source](https://example.org)');
  assert.match(html, /<a href="https:\/\/example\.org" target="_blank" rel="noopener noreferrer">source<\/a>/);
});

test('refuses a javascript: link and renders it as plain text', () => {
  const html = renderMarkdown('[x](javascript:alert(1))');
  assert.equal(html.includes('<a'), false);
  assert.match(html, /javascript:alert\(1\)/);
});

test('refuses a data: link', () => {
  const html = renderMarkdown('[x](data:text/html,<b>hi</b>)');
  assert.equal(html.includes('<a'), false);
});

test('escapes raw html instead of passing it through', () => {
  const html = renderMarkdown('<img src=x onerror=1>');
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
});

test('escapes html inside link text but keeps the anchor', () => {
  const html = renderMarkdown('[<b>x</b>](https://example.org)');
  assert.equal(html.includes('<b>'), false);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /<a href="https:\/\/example\.org"/);
});

test('renders headings, lists, code spans and fenced code', () => {
  const html = renderMarkdown('# Title\n\n- one\n- two\n\n`code`\n\n```\nraw <b>\n```');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<pre><code>raw &lt;b&gt;<\/code><\/pre>/);
});

test('code spans are not re-parsed as emphasis', () => {
  assert.match(renderMarkdown('`a * b`'), /<code>a \* b<\/code>/);
});

test('a paragraph after a list is a sibling, not nested in the list', () => {
  const html = renderMarkdown('1. one\n2. two\n\nAfter the list');
  assert.match(html, /<\/ol>\n<p>After the list<\/p>/);
  assert.equal(/<li>[^<]*After the list/.test(html), false);
});

test('empty input renders nothing', () => {
  assert.equal(renderMarkdown(''), '');
});

test('renders an ordered list', () => {
  assert.match(renderMarkdown('1. one\n2. two'), /<ol><li>one<\/li><li>two<\/li><\/ol>/);
});

test('ordered lists keep their numbering across blank lines and paragraphs (V3 item 7)', () => {
  const html = renderMarkdown('1. a\n\npara\n\n2. b\n\npara\n\n3. c');
  const starts = [...html.matchAll(/<ol(?: start="(\d+)")?>/g)].map(match => Number(match[1] ?? 1));
  assert.deepEqual(starts, [1, 2, 3], 'each item keeps the number it was written with');
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
  assert.match(renderMarkdown('3. third'), /<ol start="3">/);
});

test('an indented paragraph stays in its item, so it aligns with the item text (V3 items 7 and 9)', () => {
  const html = renderMarkdown('1. a\n\n   an indented paragraph\n\n2. b');
  assert.equal(html, '<ol><li>a<p>an indented paragraph</p></li><li>b</li></ol>', 'one list, the paragraph nested in its item');
  assert.equal((html.match(/<li>/g) ?? []).length, 2);
});

test('renders a blockquote', () => {
  assert.match(renderMarkdown('> quoted'), /<blockquote>quoted<\/blockquote>/);
});

test('renders script and img onerror inert, never as markup', () => {
  const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=1>');
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('never emits a style attribute or an inline event handler', () => {
  const html = renderMarkdown('<p style="color:red">x</p> [y](https://example.org)');
  assert.equal(/<[a-z][^>]*\sstyle\s*=/i.test(html), false);
  assert.match(html, /&lt;p style=/);
});

test('refuses javascript:, data:, file: and vbscript: links in any case', () => {
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:msgbox(1)']) {
    assert.equal(renderMarkdown(`[x](${href})`).includes('<a'), false, href);
  }
});

test('an attribute breakout inside a link destination is escaped', () => {
  const html = renderMarkdown('[x](https://example.org/"onmouseover="alert(1))');
  assert.equal(html.includes('onmouseover="'), false);
});

test('a bare url is left as text, never autolinked', () => {
  assert.equal(renderMarkdown('see https://example.org/a').includes('<a'), false);
});

test('a transcript answer clamps an H1 and H2 to the bubble top level', () => {
  const html = renderMarkdown('# Knowledge Search\n\n## Hits\n\n### detail', TRANSCRIPT_MARKDOWN);
  assert.equal(/<h1>|<h2>/.test(html), false, 'no h1/h2 inside a transcript bubble');
  assert.match(html, /<h3>Knowledge Search<\/h3>/);
  assert.match(html, /<h3>Hits<\/h3>/);
  assert.match(html, /<h3>detail<\/h3>/);
});

test('a transcript answer renders a bare url as a named chip', () => {
  const html = renderMarkdown('see https://www.google.com/calendar/event?eid=abc', TRANSCRIPT_MARKDOWN);
  assert.match(html, /<a class="answer-source" href="https:\/\/www\.google\.com\/calendar\/event\?eid=abc" target="_blank" rel="noopener noreferrer">google\.com\/calendar<\/a>/);
});

test('the default renderer still leaves a bare url as plain text', () => {
  assert.equal(renderMarkdown('see https://example.org/a').includes('<a'), false);
});
