import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { FakeClock, fakeReady } from './openai-live-voice-fixture.js';
import { attachHostLogSink } from '../tools/host-events.js';

const quiet = () => new Promise<void>(resolve => setImmediate(resolve));
const delegated = (type: string, event: Record<string, unknown> = {}) => ({ type: 'response.event', delegation_id: 'synthetic-delegation', event: { type, ...event } });
const creates = (socket: { sent: string[] }) => socket.sent.map(frame => JSON.parse(frame) as { type: string; response?: { tool_choice?: string } }).filter(frame => frame.type === 'response.create');
async function continuation(t: TestContext) {
  const clock = new FakeClock();
  const opened = await fakeReady(t, { clock });
  opened.socket.deliver(delegated('response.created', { response: { id: 'synthetic-initial' } }));
  opened.socket.deliver(delegated('response.output_item.done', { item: { type: 'function_call', call_id: 'synthetic-call', name: 'research', arguments: '{}' } }));
  opened.socket.deliver(delegated('response.done', { response: { id: 'synthetic-initial', status: 'completed' } }));
  await quiet();
  opened.session.sendToolResponse({ responses: [{ id: 'synthetic-call', name: 'research', response: { ok: true } }] });
  opened.socket.deliver(delegated('response.created', { response: { id: 'synthetic-continuation' } }));
  await quiet();
  return { ...opened, clock };
}

test('SILENCE b-second: silent done immediately rescues without tools, once', async t => {
  const opened = await continuation(t);
  const before = creates(opened.socket).length;
  opened.socket.deliver(delegated('response.done', { response: { id: 'synthetic-continuation', status: 'completed' } }));
  await quiet();
  assert.equal(creates(opened.socket).length, before + 1);
  assert.equal(creates(opened.socket).at(-1)?.response?.tool_choice, 'none');
  opened.socket.deliver(delegated('response.created', { response: { id: 'synthetic-rescue' } }));
  opened.socket.deliver(delegated('response.done', { response: { id: 'synthetic-rescue', status: 'completed' } }));
  await quiet();
  assert.equal(creates(opened.socket).length, before + 1, 'no rescue loop');
});

test('SILENCE b: no item at five seconds requests the existing nudge without another create', async t => {
  const opened = await continuation(t);
  const before = creates(opened.socket).length;
  opened.clock.advance(4_999);
  await quiet();
  const nudges = () => opened.captured.filter(event => event.type === 'interactionStatus' && event.value === 'post_tool_no_output');
  assert.equal(nudges().length, 0);
  opened.clock.advance(1);
  await quiet();
  assert.equal(nudges().length, 1);
  assert.equal(creates(opened.socket).length, before, 'never overlaps an active response');
  opened.clock.advance(3_000);
  await quiet();
  assert.equal(nudges().length, 1);
});

test('SILENCE c: output item at 4.5 seconds prevents early nudge', async t => {
  const opened = await continuation(t);
  opened.clock.advance(4_500);
  opened.socket.deliver(delegated('response.output_item.added', { item: { type: 'message', id: 'synthetic-message' } }));
  opened.clock.advance(3_500);
  await quiet();
  assert.equal(opened.captured.some(event => event.type === 'interactionStatus' && event.value === 'post_tool_no_output'), false);
});

test('SILENCE chain: third tool round forces the fourth response to answer', async t => {
  const opened = await continuation(t);
  for (let round = 2; round <= 3; round++) {
    const id = `synthetic-call-${round}`;
    opened.socket.deliver(delegated('response.output_item.done', { item: { type: 'function_call', call_id: id, name: 'research', arguments: '{}' } }));
    opened.socket.deliver(delegated('response.done', { response: { status: 'completed' } }));
    await quiet();
    opened.session.sendToolResponse({ responses: [{ id, name: 'research', response: { ok: true } }] });
    if (round < 3) opened.socket.deliver(delegated('response.created', { response: { id: `synthetic-round-${round}` } }));
  }
  assert.equal(creates(opened.socket).at(-1)?.response?.tool_choice, 'none');
});

test('SILENCE timing: a terminal receipt contains all latency landmarks and a class', async t => {
  const logs: unknown[] = [];
  const detach = attachHostLogSink({ event: event => logs.push(event) });
  t.after(detach);
  const opened = await continuation(t);
  opened.clock.advance(200);
  opened.socket.deliver(delegated('response.output_item.done', { item: { type: 'message' } }));
  opened.socket.deliver(delegated('response.done', { response: { status: 'completed' } }));
  await quiet();
  const receipt = logs.find((event): event is Record<string, unknown> => typeof event === 'object' && event !== null && 'event' in event && event.event === 'live_continuation_timing');
  assert.ok(receipt);
  for (const key of ['toolOutputAt', 'createAt', 'createdAt', 'firstItemAt', 'firstAudioAt', 'class']) assert.ok(key in receipt, key);
  assert.equal(receipt['firstAudioAt'], null);
  assert.equal(receipt['class'], 'b-second');
});
