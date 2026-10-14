import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryDeleteControl, deleteMemoryAndReload, memoryListMarkup, filterMemoryItems, memoryItemKind, memoryItemOrigin } from '../src/memory-list.ts';
import type { MemoryListItem } from '../src/memory-list.ts';

const fixture = (overrides: Partial<MemoryListItem> = {}): MemoryListItem => ({
  id: 'entry-1',
  text: 'Remember the synthetic blue notebook',
  role: 'user',
  kind: 'fact',
  origin: 'live-voice',
  capturedAt: '2026-10-11T16:00:00.000Z',
  ...overrides,
});

test('memory list renders kind, origin and local created time from a payload entry', () => {
  const markup = memoryListMarkup([fixture()]);
  assert.match(markup, /class="memory-kind"[^>]*>fact</);
  assert.match(markup, /class="memory-source"[^>]*>Live voice via remember_note</);
  assert.match(markup, /data-delete-memory="entry-1"/);
  const local = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date('2026-10-11T16:00:00.000Z'));
  assert.ok(markup.includes(local), `expected local created time ${local} in markup`);
  assert.ok(!markup.includes('>2026-10-11T16:00:00.000Z<'), 'raw ISO time must not be shown as text');
});

test('memory item kind is the explicit domain kind, note when none was given', () => {
  assert.equal(memoryItemKind(fixture()), 'fact');
  assert.equal(memoryItemKind(fixture({ kind: undefined })), 'note');
});

test('memory list renders no kind badge for a note and still shows an origin line', () => {
  const markup = memoryListMarkup([fixture({ kind: 'note', origin: 'unknown' })]);
  assert.doesNotMatch(markup, /class="memory-kind"/, 'note is not a real kind and must not render a badge');
  assert.match(markup, /class="memory-source"[^>]*>Origin unknown</);
  assert.match(markup, /<time datetime="2026-10-11T16:00:00\.000Z">/, 'the date still renders without a kind');
});

test('memory list renders a badge for a real kind', () => {
  assert.match(memoryListMarkup([fixture({ kind: 'preference' })]), /class="memory-kind"[^>]*>preference</);
});

test('memory item origin names where the entry came from for every value', () => {
  assert.equal(memoryItemOrigin(fixture()), 'Live voice via remember_note');
  assert.equal(memoryItemOrigin(fixture({ origin: 'chat' })), 'Saved from chat');
  assert.equal(memoryItemOrigin(fixture({ origin: 'page' })), 'Saved from the page');
  assert.equal(memoryItemOrigin(fixture({ origin: 'unknown' })), 'Origin unknown');
  assert.equal(memoryItemOrigin(fixture({ origin: undefined })), 'Origin unknown');
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

test('a conversation summary renders as a memory item with its origin and a delete control', () => {
  const summary = fixture({ id: 'summary-1', kind: undefined, origin: 'conversation summary',
    text: 'The owner asked about their plate; Naya found two meetings.', capturedAt: '2026-10-14T18:00:00.000Z' });
  assert.equal(memoryItemOrigin(summary), 'Conversation summary');
  const markup = memoryListMarkup([summary]);
  assert.match(markup, /class="memory-source"[^>]*>Conversation summary</);
  assert.match(markup, /data-delete-memory="summary-1"/);
  assert.doesNotMatch(markup, /class="memory-kind"/, 'a summary carries no remember kind badge');
});

test('a cascade summary delete reports how many summaries were removed', async () => {
  const notices: string[] = [];
  await deleteMemoryAndReload('summary-1', {
    confirm: () => true,
    remove: async () => ({ deletedIds: ['summary-1', 'summary-2', 'summary-3'], notFound: false }),
    reload: async () => [],
    apply: () => {},
    deleted: (message: string) => notices.push(message),
  });
  assert.deepEqual(notices, ['Deleted 3 conversation summaries.']);
});
