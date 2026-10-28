import assert from 'node:assert/strict';

/** Synthetic provider transcripts, not recordings or generated-model quality claims. */
export const hostConversationScenarios = [
  {
    name: 'host correction is guidance, not an owner correction',
    note: 'Correction: make the lookup now, or say that you are not checking anything.',
    reply: 'I am not checking anything. What would you like me to look up?',
    forbidden: /you(?:'|’)re right|you are right|I agree|thanks for (?:correcting|the correction)/iu,
    rejected: "You're right, I am not checking anything now.",
  },
  {
    name: 'late web finding belongs to the host source, not the owner',
    note: 'One more thing from web: the synthetic archive closes at six.',
    reply: 'The web result says the archive closes at six.',
    forbidden: /your snippet|you shared|you sent|you provided|thanks for (?:sharing|sending)/iu,
    rejected: 'Your snippet says the archive closes at six.',
  },
] as const;

export function assertHostConversationReply(item: Record<string, unknown>, reply: string, forbidden: RegExp): void {
  assert.equal(item['type'], 'message');
  assert.equal(item['role'], 'user');
  const content = item['content'] as { type: string; text: string }[];
  assert.equal(content[0]?.type, 'input_text');
  assert.ok(content[0]?.text.startsWith('[host note, not the owner] '));
  assert.ok(reply.trim(), 'an empty replay reply proves nothing');
  assert.doesNotMatch(reply, forbidden);
}

export function assertFreshProgressPhrases(phrases: readonly string[]): void {
  const keys = phrases.map(phrase => phrase.trim().toLowerCase());
  assert.equal(new Set(keys).size, keys.length, 'a progress phrase is never reused in a call');
}
