import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as markdown from '../src/markdown.ts';
import type { ToolEvidence } from '../src/protocol.ts';

// Missing evidence rendering is the base behavior, represented as an empty projection.
const render = (markdown as typeof markdown & { renderToolEvidence?: (evidence: readonly ToolEvidence[]) => string }).renderToolEvidence ?? (() => '');

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
