import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createSourceFile, SyntaxKind, transpileModule, ModuleKind, ScriptTarget, type FunctionDeclaration } from 'typescript';
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

// #883 / MEMUI-R1: Memory shows saved entries with no conversation open, so a deletion there has to
// reload the same saved-entry read. The two functions under test are transpiled from the real
// main.ts, so a change that drops the branch is red here rather than only visible in a browser.
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const mainParsed = createSourceFile('main.ts', mainSource, ScriptTarget.Latest, true);
const underTest = ['loadEntries', 'deleteMemory', 'mutate', 'writable'];
const memoryDeletion = transpileModule(mainParsed.statements
  .filter((node): node is FunctionDeclaration => node.kind === SyntaxKind.FunctionDeclaration && underTest.includes(node.name?.text ?? ''))
  .map(node => node.getText(mainParsed)).join('\n'), { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;

function memoryDeletionHarness(state: Record<string, unknown>, request: (path: string) => Promise<unknown>) {
  const signal = new AbortController().signal, calls: string[] = [];
  const sandbox: any = {
    AbortController, AbortSignal, clearTimeout, setTimeout, window: { confirm: () => true },
    authorityVersion: () => signal,
    assertAuthority: (version: AbortSignal) => { if (version !== signal) throw new Error('synthetic stale authority'); },
    render() {}, notify(message: string) { sandbox.notice = message; }, failure: (error: unknown) => `synthetic failure: ${String(error)}`,
    connectedView: { active: false, reset() {}, async refresh() {} }, deleteMemoryAndReload,
    request: async (path: string) => { calls.push(path); return request(path); },
    listMemorySummaries: async () => ({ items: [] }),
    deleteMemoryEntry: async () => ({ deletedIds: ['synthetic-entry'] }), deleteMemorySummary: async () => ({ deletedIds: [] }),
    connection: 'Connected', busy: false, entriesMore: false, notice: '', error: '', recall: undefined, queryDraft: '', status: undefined,
    ...state,
  };
  runInContext(memoryDeletion, createContext(sandbox));
  return { context: sandbox, calls };
}

test('memory deletion with no conversation open reloads the saved entries it was showing', async () => {
  const harness = memoryDeletionHarness({ tab: 'Memory', session: undefined, entries: [], memorySummaries: [], summaryIds: new Set() },
    async path => path === '/sessions' ? { items: [{ id: 'capture-note' }], nextCursor: null } : { entries: [{ id: 'kept', text: 'kept note' }] });
  await harness.context.deleteMemory('synthetic-entry');
  assert.deepEqual(harness.calls, ['/sessions', '/sessions/capture-note'], 'the reload reads the saved entries, not a conversation');
  assert.deepEqual(Array.from(harness.context.entries, (entry: { text: string }) => entry.text), ['kept note'], 'the kept note survives and the deleted one is gone from the list');
  assert.equal(harness.context.error, '', 'the reload reports no failure');
});

test('memory deletion with a conversation open never reads the saved-entry list', async () => {
  const harness = memoryDeletionHarness({ tab: 'Conversation', session: { id: 'old-session' }, entries: [], memorySummaries: [], summaryIds: new Set() },
    async () => ({ session: { id: 'old-session' }, entries: [{ id: 'kept', text: 'kept note' }], nextCursor: 'more' }));
  await harness.context.deleteMemory('synthetic-entry');
  assert.deepEqual(harness.calls, ['/sessions/old-session'], 'only the open conversation is read');
  assert.equal(harness.context.entries.length, 1, 'the open conversation still supplies the list');
  assert.equal(harness.context.entriesMore, true, 'the conversation paging flag is untouched');
});
