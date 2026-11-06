import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fakeReady } from './openai-live-voice-fixture.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { safeEvent } from '../host/log.js';

// Reject host notes accidentally becoming typed owner turns. These structural checks
// complement the adapter wire tests below; they do not simulate a whole alarm call.
const source = readFileSync(new URL('../../live/index.ts', import.meta.url), 'utf8');
for (const [name, start, end] of [
  ['alarm opening', '  announceAlarm(', '  #armAlarm('],
  ['mute offer', 'handle.mutedOfferTimer = this.#schedule(', 'handle.mutedOfferTimer.unref'],
  ['continuation', 'const ask = handle.session.', 'this.#scheduleDebt(handle, DEAD_AIR_CONTINUATION_MS'],
] as const) {
  test(`${name} uses session commentary rather than typed owner input`, () => {
    const offset = source.indexOf(start);
    const block = source.slice(offset, source.indexOf(end, offset + start.length));
    assert.match(block, /sendSessionCommentary/);
    assert.doesNotMatch(block, /sendText/);
  });
}

test('host commentary produces one null-delegation command and no response.create', async t => {
  const { socket, session } = await fakeReady(t);
  const before = socket.sent.length;
  assert.ok(session.sendSessionCommentary({ text: 'Synthetic host instruction' }));
  const commands = socket.sent.slice(before).map(frame => JSON.parse(frame));
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'session.commentary.append');
  assert.equal(commands[0].delegation_id, null);
});

test('typed owner input retains its current response commands, a known provider compatibility gap', async t => {
  const { socket, session } = await fakeReady(t);
  const before = socket.sent.length;
  session.sendText({ text: 'Synthetic typed input' });
  assert.deepEqual(socket.sent.slice(before).map(frame => JSON.parse(frame).type), ['response.item.create', 'response.create']);
});

test('provider rejection identifies the rejected command without its content', async t => {
  const { socket, session } = await fakeReady(t);
  const records: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { records.push(raw as Record<string, unknown>); } });
  t.after(detach);
  const id = session.sendSessionCommentary({ text: 'Synthetic private content' });
  socket.deliver({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_request_error', param: 'type', client_event_id: id } });
  const event = records.find(record => record.event === 'live_provider_error');
  assert.ok(event);
  assert.equal(event.clientEventId, id);
  assert.equal(event.commandType, 'session.commentary.append');
  assert.equal(safeEvent(event)?.commandType, 'session.commentary.append');
  assert.doesNotMatch(JSON.stringify(event), /Synthetic private content/);
});
