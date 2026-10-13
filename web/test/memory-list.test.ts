import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryDeleteControl, deleteMemoryAndReload, memoryListMarkup, filterMemoryItems, memoryItemKind, memoryItemSource } from '../src/memory-list.ts';
import type { MemoryListItem } from '../src/memory-list.ts';

const fixture = (overrides: Partial<MemoryListItem> = {}): MemoryListItem => ({
  id: 'entry-1',
  text: 'Remember the synthetic blue notebook',
  role: 'user',
  capturedAt: '2026-10-11T16:00:00.000Z',
  sourceRefs: [{ label: 'live-voice live-1', provider: 'live-voice', accountId: 'live-1', externalId: 'x', sourceTimestamp: '2026-10-11T16:00:00.000Z', availability: 'present', note: 'kind:fact' }],
  ...overrides,
});

test('memory list renders kind, source and local created time from a payload entry', () => {
  const markup = memoryListMarkup([fixture()]);
  assert.match(markup, /class="memory-kind"[^>]*>fact</);
  assert.match(markup, /class="memory-source"[^>]*>Live voice via remember_note</);
  assert.match(markup, /data-delete-memory="entry-1"/);
  const local = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date('2026-10-11T16:00:00.000Z'));
  assert.ok(markup.includes(local), `expected local created time ${local} in markup`);
  assert.ok(!markup.includes('>2026-10-11T16:00:00.000Z<'), 'raw ISO time must not be shown as text');
});

test('memory item kind prefers the domain kind note and falls back to the role', () => {
  assert.equal(memoryItemKind(fixture()), 'fact');
  assert.equal(memoryItemKind(fixture({ sourceRefs: [], role: 'assistant' })), 'assistant');
});

test('memory list renders no kind badge for a role-only entry', () => {
  const markup = memoryListMarkup([fixture({ sourceRefs: [], role: 'user' })]);
  assert.doesNotMatch(markup, /class="memory-kind"/, 'a role is not a kind and must not render a badge');
  assert.match(markup, /<time datetime="2026-10-11T16:00:00\.000Z">/, 'the date still renders without a kind');
});

test('memory list renders a badge for a real remember_note kind', () => {
  assert.match(memoryListMarkup([fixture({ sourceRefs: [{ note: 'kind:preference' }] })]), /class="memory-kind"[^>]*>preference</);
});

test('memory item source names Live voice and other providers honestly', () => {
  assert.equal(memoryItemSource(fixture()), 'Live voice via remember_note');
  assert.equal(memoryItemSource(fixture({ sourceRefs: [{ label: 'Chat', provider: 'chat' }] })), 'Chat');
  assert.equal(memoryItemSource(fixture({ sourceRefs: [] })), null);
});

test('filter narrows the visible list by text and is case-insensitive', () => {
  const items = [fixture({ id: 'a', text: 'blue notebook' }), fixture({ id: 'b', text: 'green mug' })];
  assert.deepEqual(filterMemoryItems(items, 'BLUE').map(i => i.id), ['a']);
  assert.deepEqual(filterMemoryItems(items, 'Mug').map(i => i.id), ['b']);
  assert.deepEqual(filterMemoryItems(items, '   ').map(i => i.id), ['a', 'b']);
  assert.deepEqual(filterMemoryItems(items, 'nothing here').map(i => i.id), []);
  const markup = memoryListMarkup(items, { filter: 'blue' });
  assert.match(markup, /data-memory-id="a"/);
  assert.doesNotMatch(markup, /data-memory-id="b"/);
  assert.match(markup, /class="memory-filter"/);
});

test('memory list shows its count and an honest empty state', () => {
  assert.match(memoryListMarkup([fixture(), fixture({ id: 'b' })]), /2 memories/);
  assert.match(memoryListMarkup([fixture()]), /1 memory/);
  assert.match(memoryListMarkup([]), /Didi remembers nothing yet\./);
  assert.match(memoryListMarkup([fixture()], { filter: 'absent' }), /No memories match your filter\./);
});

test('memory list is newest first', () => {
  const older = fixture({ id: 'old', capturedAt: '2026-10-10T16:00:00.000Z' });
  const newer = fixture({ id: 'new', capturedAt: '2026-10-12T16:00:00.000Z' });
  const markup = memoryListMarkup([older, newer]);
  assert.ok(markup.indexOf('data-memory-id="new"') < markup.indexOf('data-memory-id="old"'), 'newest entry must render first');
});

test('delete controls identify the server entry and escape ids', () => {
  assert.match(memoryDeleteControl('server-id'), /data-delete-memory="server-id"/);
  assert.match(memoryDeleteControl('"<', true), /&quot;&lt;/);
  assert.match(memoryDeleteControl('server-id', true), /disabled/);
});

test('delete applies only the reloaded server payload after confirmation', async () => {
  let payload = ['deleted', 'kept'];
  const calls: string[] = [];
  let resolveDelete!: () => void;
  const pending = new Promise<void>(resolve => { resolveDelete = resolve; });
  const operation = deleteMemoryAndReload('deleted', {
    confirm: () => { calls.push('confirm'); return true; },
    remove: async id => { calls.push(`DELETE:${id}`); await pending; },
    reload: async () => { calls.push('GET'); return ['server-retained']; },
    apply: value => { payload = value; calls.push('apply'); },
  });
  assert.deepEqual(payload, ['deleted', 'kept']);
  assert.deepEqual(calls, ['confirm', 'DELETE:deleted']);
  resolveDelete();
  assert.equal(await operation, true);
  assert.deepEqual(payload, ['server-retained']);
  assert.deepEqual(calls, ['confirm', 'DELETE:deleted', 'GET', 'apply']);
});

test('cancel does not delete or reload', async () => {
  assert.equal(await deleteMemoryAndReload('entry', {
    confirm: () => false,
    remove: async () => assert.fail('cancel must not delete'),
    reload: async () => assert.fail('cancel must not reload'),
    apply: () => assert.fail('cancel must not replace payload'),
  }), false);
});

for (const failure of ['delete', 'reload']) {
  test(`${failure} failure keeps the displayed server payload`, async () => {
    await assert.rejects(deleteMemoryAndReload('entry', {
      confirm: () => true,
      remove: async () => { if (failure === 'delete') throw new Error('refused'); },
      reload: async () => { throw new Error('reload failed'); },
      apply: () => assert.fail('failure must not replace payload'),
    }));
  });
}


for (const retained of [true, false]) {
  test(`delete confirmation honestly reports current Live retention: ${retained}`, async () => {
    const notices: string[] = [];
    await deleteMemoryAndReload('entry', {
      confirm: () => true,
      remove: async () => ({ liveSessionRetainsUntilRebuild: retained }),
      reload: async () => [],
      apply: () => {},
      deleted: (message: string) => notices.push(message),
    });
    assert.deepEqual(notices, [retained
      ? "Naya's current live conversation still has this note until it reconnects or ends."
      : 'Memory deleted.']);
  });
}
