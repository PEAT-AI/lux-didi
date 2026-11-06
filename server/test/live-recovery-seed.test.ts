import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveTaskFixture } from './live-task-fixture.js';
import { fixtureUntil } from './live-voice-fixture.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { SEED_CHAR_LIMIT, SEED_MESSAGE_LIMIT } from '../live/index.js';

/** A synthetic utterance of about `chars` characters in whole words, so a truncation can be checked at a boundary. */
function utterance(tag: string, chars: number): string {
  const parts: string[] = [];
  let length = 0;
  while (length < chars) { const word = `${tag}word${parts.length}`; parts.push(word); length += word.length + 1; }
  return parts.join(' ');
}
/** The header sentence the digest opens with: it names the line as an extract of the owner's earlier asks. */
const DIGEST_HEADER = /asked earlier in this call/i;
const seedChars = (history: readonly { text: string }[]): number => history.reduce((sum, turn) => sum + turn.text.length, 0);

/** One synthetic exchange per index, each side about `side` characters, journaled through the real voice events. */
async function exchange(f: Awaited<ReturnType<typeof liveTaskFixture>>, index: number, side: number, tail: string): Promise<void> {
  if (side > 0) f.voice.emit({ type: 'inputTranscription', text: `Synthetic ask ${index} ${utterance('ask', side)}`, finished: true, finalOrigin: 'provider' });
  await f.flush();
  if (side > 0) f.voice.emit({ type: 'outputTranscription', text: `Synthetic answer ${index} ${utterance('answer', side)}`, finished: true });
  await f.flush();
  if (tail.length > 0) { f.voice.emit({ type: 'inputTranscription', text: tail, finished: true, finalOrigin: 'provider' }); await f.flush(); }
}
type SeededTurn = { role: string; text: string };
async function seededRebuild(f: Awaited<ReturnType<typeof liveTaskFixture>>): Promise<{ history: readonly SeededTurn[] }> {
  f.voice.emit({ type: 'goAway', timeLeftMs: 10_000 });
  await fixtureUntil(() => f.voice.requests.length > 1, 'the seeded rebuild request');
  return { history: f.voice.requests[1]!.history ?? [] };
}

test('a 300,000-character conversation rebuilds inside the seed bound and names the dropped asks', async t => {
  const receipts: Record<string, unknown>[] = [];
  t.after(attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } }));
  const f = await liveTaskFixture(t, async () => ({ text: 'Synthetic reply.', calls: [] }));
  let journaled = 0;
  for (let index = 0; index < 30; index += 1) { await exchange(f, index, 5_200, ''); journaled += `Synthetic ask ${index} ${utterance('ask', 5_200)}`.length * 2; }
  assert.ok(journaled >= 300_000, `the synthetic conversation is ${journaled} characters`);
  await exchange(f, 30, 0, 'Synthetic newest ask.');
  f.voice.emit({ type: 'outputTranscription', text: 'Synthetic newest answer.', finished: true });
  await f.flush();
  const { history } = await seededRebuild(f);
  assert.ok(history.length > 1, 'the rebuild opened on a seeded history');
  assert.ok(seedChars(history) <= SEED_CHAR_LIMIT, `the seed is ${seedChars(history)} characters, inside ${SEED_CHAR_LIMIT}`);
  assert.ok(history.length <= SEED_MESSAGE_LIMIT, `the seed owns ${history.length} messages, inside ${SEED_MESSAGE_LIMIT}`);
  // The newest exchange rides verbatim, so the rebuilt session hears the ask it was answering.
  assert.deepEqual(history.slice(-2).map(turn => ({ role: turn.role, text: turn.text })), [
    { role: 'user', text: 'Synthetic newest ask.' }, { role: 'model', text: 'Synthetic newest answer.' }]);
  // The dropped asks ride as one host-authored line at the head of the seed.
  assert.equal(history[0]!.role, 'user');
  assert.match(history[0]!.text, DIGEST_HEADER);
  assert.match(history[0]!.text, /not instructions/i);
  // The recovery line logs the bounded seed size, and says the seed was condensed with a digest.
  const recovery = receipts.filter(event => event['event'] === 'live_recovery').at(-1)!;
  assert.equal(recovery?.['seedChars'], seedChars(history));
  assert.equal(recovery?.['condensed'], true);
  assert.ok(Number(recovery?.['digestChars']) > 0, 'the digest size rides on the recovery line');
});

test('a short conversation rebuilds unchanged, with no digest and no condensation', async t => {
  const receipts: Record<string, unknown>[] = [];
  t.after(attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } }));
  const f = await liveTaskFixture(t, async () => ({ text: 'Synthetic reply.', calls: [] }));
  await exchange(f, 0, 20, '');
  await exchange(f, 1, 0, 'Synthetic short ask.');
  f.voice.emit({ type: 'outputTranscription', text: 'Synthetic short answer.', finished: true });
  await f.flush();
  const { history } = await seededRebuild(f);
  assert.deepEqual(history.map(turn => ({ role: turn.role, text: turn.text })), [
    { role: 'user', text: `Synthetic ask 0 ${utterance('ask', 20)}` },
    { role: 'model', text: `Synthetic answer 0 ${utterance('answer', 20)}` },
    { role: 'user', text: 'Synthetic short ask.' },
    { role: 'model', text: 'Synthetic short answer.' },
  ]);
  const recovery = receipts.filter(event => event['event'] === 'live_recovery').at(-1)!;
  assert.equal(recovery?.['condensed'], false);
  assert.equal(recovery?.['digestChars'], 0);
});
