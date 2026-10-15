import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../src/markdown.ts';

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

test('empty input renders nothing', () => {
  assert.equal(renderMarkdown(''), '');
});

test('renders an ordered list', () => {
  assert.match(renderMarkdown('1. one\n2. two'), /<ol><li>one<\/li><li>two<\/li><\/ol>/);
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
