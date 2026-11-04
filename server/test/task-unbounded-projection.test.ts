import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderGoogleTool } from '../tools/google.js';
test('helper evidence retains the complete received mail body instead of a spoken-size preview', () => {
  const body = Array.from({ length: 160 }, (_, index) => `Synthetic body segment ${index}: the complete received evidence remains available.`).join('\n') + '\nSYNTHETIC_FULL_BODY_TAIL';
  const result = renderGoogleTool('gmail_read_message', { headers: { Subject: 'Synthetic complete message', From: 'sender@example.invalid' }, body });
  assert.ok(result.text.includes('SYNTHETIC_FULL_BODY_TAIL'), 'the helper must see the received tail, not a voice preview');
  assert.equal(result.omittedCharacters, 0);
});
test('helper evidence retains every received mail-list row rather than a spoken item cap', () => {
  const messages = Array.from({ length: 13 }, (_, index) => ({ id: `synthetic-${index}`, headers: { Subject: `Synthetic subject ${index}`, From: 'sender@example.invalid' }, snippet: `Synthetic excerpt ${index}` }));
  const result = renderGoogleTool('gmail_search_messages', { messages });
  assert.ok(result.text.includes('Synthetic subject 12'), 'all received rows belong to the helper evidence');
});
