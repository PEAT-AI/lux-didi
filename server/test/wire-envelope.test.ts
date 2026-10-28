import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pcm, ready } from './live-voice-fixture.js';
import { hostNote } from '../live/index.js';

/**
 * The wire envelope: what the host hands the provider adapter, frame by frame. Release 8 sent host notes
 * to the model as ordinary user turns, so the model argued with the host and credited it to the owner.
 * The host-note channel is the fix: host-originated text is marked, and every emitter of it is listed in
 * the registry below with the test that covers it. A new emitter, or a moved one, fails this file until
 * it is registered, and the adapter test proves the mark survives to the wire while client audio stays
 * the only unmarked user input the adapter itself produces.
 */

/** The channel's shape, as the host writes it and as the model is told to read it. */
const HOST_NOTE_MARK = '[host note, not the owner] ';

interface UserItem { kind: 'audio' | 'text'; text?: string; frame: unknown }

/** Every user-role item in one outbound frame: client audio, client text, or a host line. */
function userItems(frames: readonly unknown[]): UserItem[] {
  const items: UserItem[] = [];
  for (const frame of frames) {
    if (typeof frame !== 'object' || frame === null) continue;
    const record = frame as { realtimeInput?: { audio?: unknown; text?: unknown }; clientContent?: { turns?: { role?: string; parts?: { text?: string }[] }[] } };
    const audio = record.realtimeInput?.audio;
    if (audio !== undefined) items.push({ kind: 'audio', frame });
    if (typeof record.realtimeInput?.text === 'string') items.push({ kind: 'text', text: record.realtimeInput.text, frame });
    for (const turn of record.clientContent?.turns ?? []) {
      if (turn.role !== 'user') continue;
      for (const part of turn.parts ?? []) if (typeof part.text === 'string') items.push({ kind: 'text', text: part.text, frame });
    }
  }
  return items;
}

/** The one thing the wire must never carry: text that reads as the owner's words but came from the host. */
const unmarkedUserText = (items: readonly UserItem[]): UserItem[] => items.filter(item => item.kind === 'text' && !(item.text ?? '').startsWith(HOST_NOTE_MARK));

test('a host note reaches the wire marked, and client audio is the only unmarked user item', async t => {
  const { f, session } = await ready(t);
  session.sendAudio({ pcm, dataClass: 'ordinary' });
  session.sendText({ text: `${HOST_NOTE_MARK}the lookup finished, say what it found` });
  await f.frame(3);

  const items = userItems(f.frames);
  assert.equal(items.filter(item => item.kind === 'audio').length, 1, 'the client audio frame is sent as audio, never as text the adapter wrote');
  const texts = items.filter(item => item.kind === 'text');
  assert.deepEqual(texts.map(item => item.text), [`${HOST_NOTE_MARK}the lookup finished, say what it found`], 'the host line reaches the wire verbatim, mark included');
  assert.deepEqual(unmarkedUserText(items), [], 'no user-role text on the wire reads as the owner without the host-note mark');
  assert.equal(f.frames.length, 3, 'the adapter adds no user-role frame of its own');
});

test('a failed Lux save is a marked host note on the provider wire', async t => {
  const { f, session } = await ready(t);
  const code = 'payload_changed';
  const text = hostNote(`The note was not saved (${code}). Say plainly that it was not saved.`);
  session.sendText({ text });
  await f.frame(2);
  assert.deepEqual(userItems(f.frames).filter(item => item.kind === 'text').map(item => item.text), [text]);
  assert.deepEqual(unmarkedUserText(userItems(f.frames)), []);
});

test('the envelope check has teeth: an unmarked host line is caught', () => {
  const frames = [{ realtimeInput: { audio: { data: 'AAAA' } } }, { realtimeInput: { text: 'the lookup finished' } }, { realtimeInput: { text: `${HOST_NOTE_MARK}done` } }];
  const caught = unmarkedUserText(userItems(frames));
  assert.equal(caught.length, 1, 'plain host text is exactly the frame release 8 shipped');
  assert.equal(caught[0]!.text, 'the lookup finished');
});

/**
 * Every place the live host hands text to the provider adapter, with the channel it speaks on and the
 * test that covers it. `host` rows are host-originated guidance, `owner` rows are the owner's own words.
 */
const EMITTERS: readonly { expression: string; count: number; channel: 'host' | 'owner'; covers: readonly { file: string; title: string }[] }[] = [
  {
    expression: 'hostNote(`The note was not saved (${code', count: 1, channel: 'host',
    covers: [{ file: 'wire-envelope.test.ts', title: 'a failed Lux save is a marked host note on the provider wire' }],
  },
  {
    expression: 'hostNote(correction.text)', count: 1, channel: 'host',
    covers: [{ file: 'live-session.test.ts', title: 'OPEN2-5: an open claim the turn did not make gets one correction, never two' }],
  },
  {
    expression: 'hostNote(line)', count: 2, channel: 'host',
    covers: [
      { file: 'live-memory-note.test.ts', title: 'a mismatch says the note was not saved and asks for one sentence' },
      { file: 'live-session.test.ts', title: 'R6: a source that settles after the first answer is appended once, and said once on a quiet turn' },
    ],
  },
  {
    expression: 'MUTED_OFFER_TEXT', count: 1, channel: 'host',
    covers: [{ file: 'live-mute.test.ts', title: 'an answer that arrives while muted is held, never played, and offered once after two silent seconds' }],
  },
  {
    expression: 'hostNote(CLAIM_WITHOUT_CALL_LINE)', count: 1, channel: 'host',
    covers: [{ file: 'live-session.test.ts', title: 'C-TURN8: ${progress} with no call gets exactly one correction, and only once per owner turn' }],
  },
  {
    expression: 'hostNote(text)', count: 1, channel: 'host',
    covers: [
      { file: 'live-session.test.ts', title: '#660: a stalled delegation with nothing in flight delivers the unspoken result once' },
    ],
  },
  {
    expression: 'text', count: 1, channel: 'owner',
    covers: [
      { file: 'live-session.test.ts', title: 'typed text reaches the adapter as a realtime text turn and journals a You turn' },
    ],
  },
];

test('every host-note emitter in the shipped live host is registered and covered by a named test', () => {
  // The compiled module is the shipped code for this commit, so the registry moves with what runs.
  const shipped = readFileSync(new URL('../live/index.js', import.meta.url), 'utf8');
  const found = new Map<string, number>();
  for (const line of shipped.split('\n')) {
    if (!line.includes('sendText(')) continue;
    const match = /sendText\(\{\s*text(?::\s*(.+?))?\s*\}\)/u.exec(line);
    assert.ok(match !== null, `every sendText call passes its text as written here: ${line.trim()}`);
    const expression = (match[1] ?? 'text').trim();
    found.set(expression, (found.get(expression) ?? 0) + 1);
  }
  const registered = new Map(EMITTERS.map(row => [row.expression, row.count]));
  assert.deepEqual([...found.entries()].sort(), [...registered.entries()].sort(), 'the host hand-off sites are exactly the registered ones, so a new emitter cannot reach the model unlisted');

  for (const row of EMITTERS) {
    assert.ok(row.covers.length > 0, `${row.expression} names the test that covers it`);
    for (const cover of row.covers) {
      const source = readFileSync(new URL(`../../test/${cover.file}`, import.meta.url), 'utf8');
      assert.ok(source.includes(`test('${cover.title}'`) || source.includes('test(`' + cover.title + '`'), `${row.expression} is covered by ${cover.file}: ${cover.title}`);
    }
  }
});
