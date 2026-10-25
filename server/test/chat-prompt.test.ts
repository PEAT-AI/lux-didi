// C-CHAT (W2b): what the voice is told about person, group and channel chat reads, pinned by content. The
// voice instruction may not grow (W5), so the guidance rides the research tool description and the reply
// clauses the voice reads: what was read and over which days, the count, and the one question to ask back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';
import { ResearchLedger, researchDeclaration, runResearch, type ResearchDeps } from '../tools/research.js';

function deps(text: string): ResearchDeps {
  const execute = async (subs: readonly IntentSubCall[]): Promise<IntentSubResult[]> => subs.map(call => ({
    key: call.key, name: call.name, ok: true, text: call.name === 'mattermost_chat' ? text : '', originalCharacters: text.length, omittedCharacters: 0,
  }));
  return { now: () => Date.parse('2026-10-25T09:00:00Z'), timeZone: 'UTC', configured: ['chat'], execute, emit: () => {}, log: () => {}, ledger: new ResearchLedger() };
}

test('C-CHAT: the research tool tells the model to keep the person, group or channel as the owner said it', () => {
  const text = JSON.stringify(researchDeclaration(['chat', 'mail']));
  assert.match(text, /chat: his team chat; keep the person, group or channel in the question as he said it/u);
  assert.match(text, /resolves the name strictly and its reply names what it read, over which days, or asks which one he means/u);
});

test('C-CHAT: the reply names whose messages it read and the window, and the header carries the true count', async () => {
  const posts = Array.from({ length: 8 }, (_, n) => `**ada.moss | ada.moss | 2026-10-2${n % 5}T08:00:00.000Z [post p${n}]**\nnote ${n}`).join('\n');
  const reply = await runResearch(deps(`read: direct messages from Ada Moss (@ada.moss) since 2026-10-19\nmatched: 11\n${posts}`), { action: 'start', question: 'what did Ada write me', topic: 'Ada' }, new AbortController().signal);
  assert.match(String(reply['note']), /I read direct messages from Ada Moss \(@ada\.moss\) since 2026-10-19\./u);
  assert.match(String(reply['coverage']), /chat truncated_to_budget 8 of 11 shown/u);
});

test('C-CHAT: an ambiguous name becomes one question to ask, never an empty chat', async () => {
  const reply = await runResearch(deps('read: a person called Lena\nclarify: Which Lena do you mean: Lena Berg (@lena.berg) or Lena Sand (@lena.sand)?'), { action: 'start', question: 'what did Lena write me', topic: 'Lena' }, new AbortController().signal);
  const note = String(reply['note']);
  assert.match(note, /Ask him: Which Lena do you mean: Lena Berg \(@lena\.berg\) or Lena Sand \(@lena\.sand\)\?/u);
  assert.doesNotMatch(note, /found nothing matching|I read a person/u);
  assert.match(String(reply['coverage']), /chat needs_clarification \(say: ask which one he means\)/u);
});

test('C-CHAT: a capability the child lacks is said once', async () => {
  const reply = await runResearch(deps('read: your direct messages with @ada.moss since 2026-09-25\nnote: person lookups by name need the newer chat archive\n**ada.moss | ada.moss | 2026-10-24T08:00:00.000Z [post p1]**\nhello'), { action: 'start', question: 'what did I discuss with ada.moss', topic: 'ada.moss' }, new AbortController().signal);
  const note = String(reply['note']);
  assert.equal(note.split('Say once: person lookups by name need the newer chat archive.').length - 1, 1);
});
