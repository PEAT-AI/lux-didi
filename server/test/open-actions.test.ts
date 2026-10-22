import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeEvent } from '../host/log.js';
import { NativeActionBus, OPEN_GUIDANCE, OPEN_TOOLS, OPEN_TOOL_NAMES, openParameters, openTarget, receiptDetail, validateOpen } from '../tools/open.js';
import { beginHandleSession, endHandleSession, openDestination, resolveHandle } from '../tools/open-handles.js';
import { shapeGcalList, shapeGmailList, shapeLuxKnowledge } from '../tools/live-shape.js';

const RUN = 'live-open-1';

test('the model-facing open tools are the item tool, the home tool, a file and an app', () => {
  assert.deepEqual(OPEN_TOOLS.map(tool => tool.name), ['open_source', 'open_home', 'open_file', 'open_app']);
  assert.deepEqual([...OPEN_TOOL_NAMES].sort(), ['open_app', 'open_file', 'open_home', 'open_source']);
  assert.equal(OPEN_TOOL_NAMES.has('open_url'), false, 'a free https url is no longer a tool the model sees');
  for (const tool of OPEN_TOOLS) {
    assert.match(tool.description, /only open things: they never type, click, send or change anything\./);
    const parameters = openParameters(tool) as { required: string[]; additionalProperties: boolean };
    assert.deepEqual(parameters.required, [tool.parameter]);
    assert.equal(parameters.additionalProperties, false);
  }
});

test('the declared argument shapes accept what the allowlist allows and refuse the rest', () => {
  const source = OPEN_TOOLS[0]!, home = OPEN_TOOLS[1]!, file = OPEN_TOOLS[2]!, app = OPEN_TOOLS[3]!;
  assert.equal(validateOpen({ handle: 'L3' }, source), true);
  assert.equal(validateOpen({ handle: 'L12345' }, source), false, 'a handle is one to four digits');
  assert.equal(validateOpen({ handle: 'https://example.test/doc' }, source), false, 'a url is never a handle');
  assert.equal(validateOpen({ handle: 'L3', extra: 'x' }, source), false);
  assert.equal(validateOpen({ app: 'gmail' }, home), true);
  assert.equal(validateOpen({ app: 'slack' }, home), false, 'the schema refuses any home page but the three');
  assert.equal(validateOpen({ url: 'https://example.test/doc' }, home), false, 'open_home takes no url');
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

test('the destination policy parses the url, matches an exact host and keeps a viewer path', () => {
  assert.equal(openDestination('https://mail.google.com/mail/u/0/#inbox/19c')?.kind, 'gmail');
  assert.equal(openDestination('https://calendar.google.com/event?eid=e1')?.kind, 'calendar');
  assert.equal(openDestination('https://docs.google.com/document/d/ABC/edit')?.kind, 'docs');
  assert.equal(openDestination('https://docs.google.com/presentation/d/ABC/edit')?.kind, 'docs');
  assert.equal(openDestination('https://drive.google.com/file/d/ABC/view')?.kind, 'drive');
  assert.equal(openDestination('https://www.youtube.com/watch?v=abc')?.kind, 'youtube');
  assert.equal(openDestination('https://youtu.be/abc')?.kind, 'youtube');
  const refused = [
    'http://docs.google.com/document/d/ABC',
    'https://docs.google.com.evil.example/document/d/ABC',
    'https://docs.google.com/url?q=https://evil.example',
    'https://user:pw@docs.google.com/document/d/ABC',
    'https://docs.google.com:8443/document/d/ABC',
    'https://docs.google.com/document/d/ABC/export',
    'https://example.test/document/d/ABC',
    'https://docs.google.com.evil.example.evil/document/d/ABC',
  ];
  for (const url of refused) assert.equal(openDestination(url), undefined, `refused: ${url}`);
});

test('a shaped calendar result carries a handle and never a url in the model text', () => {
  const shaped = shapeGcalList({ events: [{ summary: 'Standup', start: { dateTime: '2024-01-01T09:00:00Z' }, htmlLink: 'https://calendar.google.com/event?eid=e1' }] });
  assert.equal(/https?:\/\//.test(shaped.text), false, 'the model text carries no url');
  const handle = /^open: (L\d+) = Calendar: Standup$/m.exec(shaped.text)?.[1];
  assert.ok(handle, 'the calendar item minted a handle line');
  const entry = resolveHandle(handle)!;
  assert.equal(entry.kind, 'calendar');
  assert.equal(entry.provenance, 'structured');
  assert.deepEqual(openTarget('open_source', { handle }), { target: { action: 'open_url', target: 'https://calendar.google.com/event?eid=e1', detail: 'calendar' } });
});

test('a gmail list mints one handle per thread and never more than three', () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, snippet: `note ${index}` }));
  const shaped = shapeGmailList({ messages });
  assert.equal(/https?:\/\//.test(shaped.text), false, 'the model text carries no url');
  const lines = shaped.text.match(/^open: L\d+ = Open in Gmail$/gm) ?? [];
  assert.equal(lines.length, 3, 'three handles are the cap for one result');
  const handle = /^open: (L\d+) =/m.exec(shaped.text)![1]!;
  assert.deepEqual(openTarget('open_source', { handle }), { target: { action: 'open_url', target: 'https://mail.google.com/mail/u/0/#inbox/m0', detail: 'gmail' } });
});

test('a knowledge body link mints a knowledge_body handle and every hostile shape mints none', () => {
  const shaped = shapeLuxKnowledge('get_insight', JSON.stringify({ id: 1, content: 'deck at https://docs.google.com/presentation/d/ABC/edit for review' }));
  const openLines = shaped.text.match(/^open: .*$/gm) ?? [];
  assert.equal(openLines.some(line => /https?:\/\//.test(line)), false, 'a handle line carries no url');
  assert.match(shaped.text, /^open: L\d+ = Slides \(from knowledge note\)$/m);
  const handle = /^open: (L\d+) =/m.exec(shaped.text)![1]!;
  assert.equal(resolveHandle(handle)?.provenance, 'knowledge_body');
  const hostile = ['https://docs.google.com.evil.example/document/d/ABC', 'https://docs.google.com/url?q=https://evil.example', 'http://docs.google.com/document/d/ABC', 'https://user:pw@docs.google.com/document/d/ABC'];
  for (const url of hostile) {
    const body = shapeLuxKnowledge('get_insight', JSON.stringify({ id: 1, content: `note ${url} end` }));
    assert.equal(/^open: /m.test(body.text), false, `no handle for ${url}`);
  }
});

test('an unknown handle is not_found with the sentence she says aloud', () => {
  assert.deepEqual(openTarget('open_source', { handle: 'L999' }), { code: 'not_found' });
  assert.equal(OPEN_GUIDANCE.not_found, 'I could not find that item.');
  assert.equal(OPEN_GUIDANCE.not_allowed, 'That link is not one I am allowed to open.');
});

test('a handle minted in one live session is not_found in the next', () => {
  beginHandleSession('run-a');
  const shaped = shapeGcalList({ events: [{ summary: 'Standup', start: { dateTime: '2024-01-01T09:00:00Z' }, htmlLink: 'https://calendar.google.com/event?eid=e9' }] });
  const handle = /^open: (L\d+) =/m.exec(shaped.text)![1]!;
  assert.ok(resolveHandle(handle));
  beginHandleSession('run-b');
  assert.equal(resolveHandle(handle), undefined, 'the last session cleared it');
  assert.deepEqual(openTarget('open_source', { handle }), { code: 'not_found' });
  endHandleSession('run-b');
});

test('open_home goes to the fixed destinations and open_url is not offered to the model', () => {
  const home = OPEN_TOOLS.find(tool => tool.name === 'open_home')!;
  const parameters = openParameters(home) as { properties: { app: { enum?: string[] } } };
  assert.deepEqual(parameters.properties.app.enum, ['gmail', 'calendar', 'mattermost']);
  assert.deepEqual(openTarget('open_home', { app: 'gmail' }), { target: { action: 'open_url', target: 'https://mail.google.com/mail/u/0/', detail: 'gmail' } });
  assert.deepEqual(openTarget('open_home', { app: 'calendar' }), { target: { action: 'open_url', target: 'https://calendar.google.com/', detail: 'calendar' } });
  assert.deepEqual(openTarget('open_url', { url: 'https://evil.example' }), { code: 'not_allowed' }, 'a name outside the four resolves nothing');
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
