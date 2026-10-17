import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeEvent } from '../host/log.js';
import { NativeActionBus, OPEN_TOOLS, OPEN_TOOL_NAMES, openParameters, receiptDetail, validateOpen } from '../tools/open.js';

const RUN = 'live-open-1';

test('the three open tools declare one string argument and say they only open things', () => {
  assert.deepEqual(OPEN_TOOLS.map(tool => tool.name), ['open_url', 'open_file', 'open_app']);
  assert.deepEqual([...OPEN_TOOL_NAMES].sort(), ['open_app', 'open_file', 'open_url']);
  for (const tool of OPEN_TOOLS) {
    assert.match(tool.description, /only open things: they never type, click, send or change anything\./);
    const parameters = openParameters(tool) as { required: string[]; additionalProperties: boolean };
    assert.deepEqual(parameters.required, [tool.parameter]);
    assert.equal(parameters.additionalProperties, false);
  }
});

test('the declared argument shapes accept what the allowlist allows and refuse the rest', () => {
  const url = OPEN_TOOLS[0]!, file = OPEN_TOOLS[1]!, app = OPEN_TOOLS[2]!;
  assert.equal(validateOpen({ url: 'https://example.test/doc' }, url), true);
  assert.equal(validateOpen({ url: 'http://example.test/doc' }, url), false, 'http is refused host-side too');
  assert.equal(validateOpen({ url: 'https://example.test/doc', extra: 'x' }, url), false);
  assert.equal(validateOpen({ path: '~/notes/a.md' }, file), true);
  assert.equal(validateOpen({ path: '/Users/rob/notes/a.md' }, file), true);
  assert.equal(validateOpen({ path: '' }, file), false);
  assert.equal(validateOpen({ name: 'Safari.app' }, app), true);
  assert.equal(validateOpen({ name: '' }, app), false);
});

test('the receipt names the scheme or extension and never the URL path or file name', () => {
  assert.equal(receiptDetail('open_url', 'https://example.test/private/plan.pdf'), 'https');
  assert.equal(receiptDetail('open_file', '/Users/rob/notes/private-plan.pdf'), 'pdf');
  assert.equal(receiptDetail('open_file', '/Users/rob/notes/LICENSE'), 'none');
  assert.equal(receiptDetail('open_app', 'Safari'), 'app');
  const receipt = safeEvent({ event: 'native_action', action: 'open_file', code: 'opened', detail: 'pdf' });
  assert.deepEqual(receipt, { event: 'native_action', action: 'open_file', code: 'opened', detail: 'pdf' });
  assert.equal(safeEvent({ event: 'native_action', action: 'open_file', code: 'opened', detail: 'private-plan.pdf' }), undefined, 'the whitelist refuses a file name');
  assert.equal(safeEvent({ event: 'native_action', action: 'open_file', code: 'opened', detail: 'pdf', target: '/Users/rob/notes/private-plan.pdf' }), undefined, 'the whitelist refuses a target');
});

test('a round trip with a fake native peer returns the ack code and keeps the frame closed', async () => {
  const bus = new NativeActionBus(1000);
  const seen: unknown[] = [];
  const forget = bus.bind(RUN, frame => { seen.push(frame); return true; });
  const pending = bus.dispatch(RUN, 'open_url', 'https://example.test/a');
  assert.deepEqual(seen, [{ type: 'native_action', id: (seen[0] as { id: string }).id, action: 'open_url', target: 'https://example.test/a' }]);
  const id = (seen[0] as { id: string }).id;
  assert.equal(bus.settle('live-other', { type: 'native_action_result', id, ok: true, code: 'opened' }), false, 'another session cannot settle this wait');
  assert.equal(bus.settle(RUN, { type: 'native_action_result', id, ok: true, code: 'opened' }), true);
  assert.equal(await pending, 'opened');
  assert.equal(bus.settle(RUN, { type: 'native_action_result', id, ok: true, code: 'opened' }), false, 'a duplicate ack settles nothing');
  forget();
});

test('an unknown code is reported as failed and a missing ack or peer never passes', async () => {
  const bus = new NativeActionBus(50);
  const forget = bus.bind(RUN, () => true);
  const unanswered = bus.dispatch(RUN, 'open_app', 'Safari');
  assert.equal(await bus.dispatch('live-unbound', 'open_app', 'Safari'), 'failed', 'no socket is a failed action');
  assert.equal(await unanswered, 'failed', 'an unanswered action fails after the bounded wait');
  // A hostile ack cannot smuggle a code outside the closed set.
  const frames: { id: string }[] = [];
  const own = bus.bind('live-hostile', frame => { frames.push(frame); return true; });
  const hostile = bus.dispatch('live-hostile', 'open_file', '/tmp/x');
  assert.equal(bus.settle('live-hostile', { type: 'native_action_result', id: frames[0]!.id, ok: true, code: 'pwned' }), true);
  assert.equal(await hostile, 'failed');
  assert.equal(bus.settle('live-hostile', { type: 'native_action_result', id: frames[0]!.id, ok: true, code: 'opened', target: '/tmp/x' }), false, 'an ack with an extra key is refused');
  own(); forget();
});
