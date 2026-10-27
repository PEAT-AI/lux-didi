import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrelloBoard, TRELLO_KEY_FILE, trelloConfigured, trelloIdentity } from '../host/trello.js';
import { createTrelloRestTransport, trelloSchemas } from '../adapters/trello/client.js';
import { foldName, indexTrelloSchemas, ownerAskedForChange, planTrelloCall, trelloDueInstant, validateTrelloRead, validateTrelloWrite, TRELLO_SERVER_ALLOW, TRELLO_SERVER_DENY, TRELLO_WRITE_DESCRIPTION, type TrelloBoard } from '../tools/trello.js';
import { startTrelloFake, SYNTHETIC_BOARD, type TrelloFake } from './trello-fake.js';

/** Monday 2026-10-26 10:00 UTC; the board's zone is UTC so the windows are exact. */
const NOW = Date.UTC(2026, 9, 26, 10, 0);
const now = () => NOW;
const ASK = 'please add this to my board';

let fake: TrelloFake;
let dir: string;
let board: TrelloBoard;
const events: Record<string, unknown>[] = [];

/** The owner's private key file, exactly as scripts/import-trello-key.sh writes it. */
function writeKey(configDir: string, key = 'key-owner', token = 'token-owner'): void {
  writeFileSync(join(configDir, TRELLO_KEY_FILE), JSON.stringify({ key, token }), { mode: 0o600 });
}

before(async () => {
  fake = await startTrelloFake({ now: NOW });
  dir = mkdtempSync(join(tmpdir(), 'trello-board-'));
  writeKey(dir, fake.key, fake.token);
  // W7-R2: the name is the owner's private configuration, so the fixture writes that file.
  writeFileSync(join(dir, 'trello-board.json'), JSON.stringify({ board: SYNTHETIC_BOARD, ownerIdentity: 'rob@plantix.net' }), { mode: 0o600 });
  board = createTrelloBoard({ configDir: dir, url: fake.url, timeZone: 'UTC', now, log: event => { events.push(event); } });
});
after(async () => { await fake.close(); rmSync(dir, { recursive: true, force: true }); });

const writes = () => fake.calls.filter(call => call.tool.startsWith('trelloWrite'));
const session = (() => { let n = 0; return () => `live-trello-${++n}`; })();





test('the overview pins the board by name and counts every list through all its pages', async () => {
  const result = await board.read(session(), { view: 'overview' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const lists = result.lists as { list: string; cards: number; newest: { name: string }[] }[];
  assert.deepEqual(lists.map(list => [list.list, list.cards]), [['Sprint', 3], ['Short Term Backlog', 3], ['Long Term Backlog', 2], ['Ideas', 2], ['Waiting for X', 1], ['Done', 2]]);
  assert.equal(lists[3]?.newest[0]?.name, 'Quick note from the phone', 'newest first');
  assert.ok(!JSON.stringify(result).includes('Foreign card'), 'the other board never shows');
  assert.ok(fake.calls.some(call => call.tool === 'trelloReadCard' && call.args.cursor === '2'), 'paging was followed');
});

test('a list page carries the true total and the next offset', async () => {
  const result = await board.read(session(), { view: 'list', list: 'short term backlog', limit: 2 });
  assert.deepEqual([result.list, result.total, result.shown, result.nextOffset], ['Short Term Backlog', 3, 2, 2]);
  const rest = await board.read(session(), { view: 'list', list: 'Short Term Backlog', offset: 2, limit: 2 });
  assert.deepEqual([rest.shown, rest.nextOffset], [1, undefined]);
});

test('due reads overdue first, then the window, in the owner zone', async () => {
  const today = await board.read(session(), { view: 'due', window: 'today' });
  assert.deepEqual((today.overdue as { name: string }[]).map(card => card.name), ['Draft the quarterly plan']);
  assert.deepEqual((today.due as { name: string }[]).map(card => card.name), ['Review the pilot budget']);
  assert.equal(today.datedCards, 3);
  const week = await board.read(session(), { view: 'due', window: 'week' });
  assert.deepEqual((week.due as { name: string }[]).map(card => card.name), ['Review the pilot budget', 'Book the venue']);
  const overdue = await board.read(session(), { view: 'due', window: 'overdue' });
  assert.equal(overdue.due, undefined);
});

test('search, recent and one card read only the pinned board', async () => {
  const search = await board.read(session(), { view: 'search', query: 'plumber' });
  assert.deepEqual((search.cards as { name: string }[]).map(card => card.name), ['Call the plumber']);
  const recent = await board.read(session(), { view: 'recent' });
  assert.deepEqual((recent.cards as { name: string }[]).map(card => card.name), ['Quick note from the phone']);
  const card = await board.read(session(), { view: 'card', card: 'book the venue' });
  assert.deepEqual(card.checklists, [{ name: 'Prep', items: [{ item: 'Call the venue', checked: false }] }]);
  assert.deepEqual(card.comments, [{ text: 'Rang the venue, they hold the room until Friday' }]);
});

test('a card, list or id from another board is outside_scope: reads classify it, no write is ever dispatched', async () => {
  const foreignCard = fake.cards.find(card => card.name === 'Foreign card')!;
  const foreignList = fake.lists.find(list => list.boardId !== fake.boards[0]!.id)!;
  const run = session();
  const start = fake.calls.length;
  assert.equal((await board.read(run, { view: 'card', card: foreignCard.id })).code, 'outside_scope');
  const before = writes().length;
  assert.equal((await board.write(run, { action: 'move', card: 'Call the plumber', list: foreignList.id }, 'move it')).code, 'outside_scope');
  assert.equal((await board.write(run, { action: 'archive', card: foreignCard.id }, 'archive it')).code, 'outside_scope');
  assert.equal((await board.write(run, { action: 'archive', card: 'ari:cloud:trello::board/workspace/w0fake/abc' }, 'archive it')).code, 'outside_scope');
  assert.equal(writes().length, before);
  const sent = fake.calls.slice(start);
  assert.ok(sent.every(call => call.tool.startsWith('trelloRead')), 'only reads go out to classify his foreign card');
  assert.equal(sent.filter(call => call.tool === 'trelloReadCard' && call.args.action === 'get').length, 2, 'the foreign card is read to classify it, once for the read and once for the refused write');
});


test('W7-F6: a write answered with another card, or a reply over the size bound, is attributed to nothing', async () => {
  // A server of its own: an oversized reply is cancelled mid-stream, which is no other test's business.
  const local = await startTrelloFake({ now: NOW });
  try {
    const transport = createTrelloRestTransport({ url: local.url, credentials: async () => ({ ok: true, key: local.key, token: local.token }) });
    local.replyWithWrongId();
    assert.deepEqual(await transport.call('trelloWriteCard', { action: 'archive', cardId: local.cards[0]!.id }), { ok: false, code: 'protocol_error' }, 'another card is no receipt');
    local.bloatNextReply(2_000_000);
    assert.deepEqual(await transport.call('trelloReadBoard', { action: 'list' }), { ok: false, code: 'protocol_error' }, 'a body over the bound is no reply');
    assert.equal((await transport.call('trelloReadBoard', { action: 'list' })).ok, true, 'the next reply is read again, so neither bad one was attributed');
  } finally { await local.close(); }
})

test('tools for boards, lists, members and Planner are never planned and never called', async () => {
  const index = indexTrelloSchemas(trelloSchemas());
  for (const tool of TRELLO_SERVER_DENY) assert.equal(planTrelloCall(index, tool, [{ action: 'create', name: 'x' }]), undefined, tool);
  assert.equal(planTrelloCall(index, 'trelloSearch', [{ action: 'search', query: 'x' }]), undefined, 'server search is not on the allowlist');
  assert.equal(index.get('trelloWriteCard')?.has('create'), true);
  const transport = createTrelloRestTransport({ url: fake.url, credentials: async () => ({ ok: true, key: fake.key, token: fake.token }) });
  assert.deepEqual(await transport.call('trelloWriteBoard', { action: 'create', name: 'x' }), { ok: false, code: 'not_allowed' });
  assert.deepEqual(await transport.call('trelloWriteList', { action: 'move', listId: 'x' }), { ok: false, code: 'not_allowed' });
  assert.ok(fake.calls.every(call => Object.hasOwn(TRELLO_SERVER_ALLOW, call.tool) && !(TRELLO_SERVER_DENY as readonly string[]).includes(call.tool)));
});

test('list names resolve exactly after folding; an unknown or ambiguous name is a clarification, never a guess', async () => {
  assert.equal(foldName(' Short  &  Long '), 'short and long');
  const run = session();
  const before = writes().length;
  const unknown = await board.write(run, { action: 'create', list: 'backlog', name: 'Synthetic task' }, 'add a card');
  assert.equal(unknown.code, 'list_unknown');
  assert.deepEqual(unknown.choices, ['Short Term Backlog', 'Long Term Backlog']);
  const ambiguous = await board.write(run, { action: 'archive', card: 'Plan review' }, 'archive it');
  assert.equal(ambiguous.code, 'card_ambiguous');
  assert.equal((ambiguous.choices as unknown[]).length, 2);
  assert.equal(writes().length, before);
});

test('a write needs the owner to ask for a change this turn', async () => {
  const before = writes().length;
  const refused = await board.write(session(), { action: 'archive', card: 'Call the plumber' }, 'what is in my sprint');
  assert.equal(refused.code, 'not_owner_requested');
  assert.equal(writes().length, before);
  assert.ok(ownerAskedForChange('move the plumber card to done'));
  assert.ok(!ownerAskedForChange('I should really look at the backlog someday'));
});

test('each write sends exactly its shape and answers from the receipt', async () => {
  const run = session();
  const id = (name: string) => fake.cards.find(card => card.name === name && !card.closed)!.id;
  const listId = (name: string) => fake.lists.find(list => list.name === name && list.boardId === fake.boards[0]!.id)!.id;
  const last = () => writes()[writes().length - 1]!;

  const created = await board.write(run, { action: 'create', list: 'Short Term Backlog', name: 'Call the accountant about the budget', due: '2026-10-30' }, 'add a card to short term backlog');
  assert.deepEqual(last(), { tool: 'trelloWriteCard', args: { action: 'create', listId: listId('Short Term Backlog'), name: 'Call the accountant about the budget', due: '2026-10-30T09:00:00.000Z' } });
  assert.deepEqual([created.ok, created.name, created.list, created.change, created.due], [true, 'Call the accountant about the budget', 'Short Term Backlog', 'created in Short Term Backlog', '2026-10-30 09:00']);

  await board.write(run, { action: 'update', card: 'Renew the passport', name: 'Renew both passports' }, 'rename it');
  assert.deepEqual(last().args, { action: 'update', cardId: id('Renew both passports'), name: 'Renew both passports' });

  const noted = await board.write(run, { action: 'note', card: 'Answer from the bank', text: 'the call moved to Thursday' }, 'note on the bank card');
  assert.deepEqual(last().args, { action: 'update', cardId: id('Answer from the bank'), desc: '2026-10-26: the call moved to Thursday' });
  assert.equal(noted.change, 'note added to the description');

  const ticked = await board.write(run, { action: 'checklist', card: 'Book the venue', item: 'call the venue', checked: true }, 'tick it off');
  assert.equal(last().args.action, 'update_item');
  assert.equal(last().args.state, 'complete');
  assert.equal(ticked.change, 'ticked Call the venue');

  const before = writes().length;
  const added = await board.write(run, { action: 'checklist', card: 'Sort the photo archive', item: 'Buy a drive' }, 'add a checklist item');
  assert.deepEqual(writes().slice(before).map(call => call.args.action), ['create', 'add_item']);
  assert.equal(added.change, 'added Buy a drive to a new checklist');

  await board.write(run, { action: 'due', card: 'Book the venue', due: '2026-10-30T14:30' }, 'set the due date to Friday');
  assert.deepEqual(last().args, { action: 'update', cardId: id('Book the venue'), due: '2026-10-30T14:30:00.000Z' });
  const cleared = await board.write(run, { action: 'due', card: 'Garden shed idea', due: 'none' }, 'clear the due date');
  assert.deepEqual(last().args, { action: 'update', cardId: id('Garden shed idea'), due: null });
  assert.equal(cleared.change, 'due date cleared');

  const moved = await board.write(run, { action: 'move', card: 'Call the plumber', list: 'Sprint' }, 'move the plumber card to the sprint');
  assert.deepEqual(last().args, { action: 'move', cardId: id('Call the plumber'), listId: listId('Sprint') });
  assert.deepEqual([moved.list, moved.change], ['Sprint', 'moved from Short Term Backlog to Sprint']);

  const done = await board.write(run, { action: 'done', card: 'Draft the quarterly plan' }, 'mark it done');
  assert.deepEqual(last().args, { action: 'move', cardId: id('Draft the quarterly plan'), listId: listId('Done') });
  assert.equal(done.change, 'moved from Sprint to Done');

  const labelled = await board.write(run, { action: 'label', card: 'Book the venue', label: 'Green' }, 'label it green');
  assert.equal(last().args.action, 'add_label');
  assert.deepEqual(labelled.labels, ['green']);
  await board.write(run, { action: 'label', card: 'Book the venue', label: 'green', remove: true }, 'remove the green label');
  assert.equal(last().args.action, 'remove_label');

  const archived = await board.write(run, { action: 'archive', card: 'Old finished task' }, 'archive it');
  assert.deepEqual(last().args, { action: 'archive', cardId: fake.cards.find(card => card.name === 'Old finished task')!.id });
  assert.equal(archived.change, 'archived; it can be restored in Trello');
});

test('the same write in one session answers from its first receipt and is sent once', async () => {
  const run = session();
  const ask = { action: 'create', list: 'Ideas', name: 'Synthetic idea once' };
  const first = await board.write(run, ask, 'add an idea');
  const before = writes().length;
  const second = await board.write(run, ask, 'add an idea');
  assert.equal(first.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(writes().length, before);
  assert.equal(fake.cards.filter(card => card.name === 'Synthetic idea once').length, 1);
});

test('a write whose answer never came stays unknown and is never sent again', async () => {
  const run = session();
  fake.dropNextCall();
  const ask = { action: 'create', list: 'Ideas', name: 'Synthetic idea in doubt' };
  const first = await board.write(run, ask, 'add an idea');
  assert.equal(first.code, 'outcome_unknown');
  const before = writes().length;
  const again = await board.write(run, ask, 'add an idea');
  assert.deepEqual([again.code, again.replayed], ['outcome_unknown', true]);
  assert.equal(writes().length, before, 'an unknown create is never sent twice');
  // A cut move is read back from the board: the next ask answers from what the board shows, and sends nothing.
  fake.dropNextCall();
  assert.equal((await board.write(run, { action: 'move', card: 'Answer from the bank', list: 'Ideas' }, 'move it to ideas')).code, 'outcome_unknown');
  const moved = writes().length;
  assert.equal((await board.write(run, { action: 'move', card: 'Answer from the bank', list: 'Ideas' }, 'move it to ideas')).code, 'no_change');
  assert.equal(writes().length, moved);
});

test('a refused write changed nothing, says so, and the owner may ask again', async () => {
  const run = session();
  fake.failNextCall();
  const refused = await board.write(run, { action: 'create', list: 'Ideas', name: 'Synthetic refused idea' }, 'add an idea');
  assert.equal(refused.code, 'write_failed');
  const retried = await board.write(run, { action: 'create', list: 'Ideas', name: 'Synthetic refused idea' }, 'add an idea');
  assert.equal(retried.ok, true);
});

test('dates are the owner local date, 09:00 when no time is given, and a non-date is refused', () => {
  assert.equal(trelloDueInstant('2026-10-30', 'Europe/Berlin'), '2026-10-30T08:00:00.000Z');
  assert.equal(trelloDueInstant('2026-03-29T10:00', 'Europe/Berlin'), '2026-03-29T08:00:00.000Z');
  assert.equal(trelloDueInstant('2026-02-30', 'UTC'), undefined);
  assert.equal(trelloDueInstant('Friday', 'UTC'), undefined);
});

test('the tool schemas refuse shapes outside each view and action', () => {
  assert.ok(validateTrelloRead({ view: 'list', list: 'Sprint', limit: 25 }));
  assert.ok(!validateTrelloRead({ view: 'list', list: 'Sprint', limit: 26 }));
  assert.ok(!validateTrelloRead({ view: 'overview', board: 'Other' }), 'no board argument exists');
  assert.ok(validateTrelloWrite({ action: 'move', card: 'C1', list: 'Done' }));
  assert.ok(!validateTrelloWrite({ action: 'move', card: 'C1' }));
  assert.ok(!validateTrelloWrite({ action: 'create', list: 'Sprint', name: 'x', board: 'Other' }));
  assert.ok(!validateTrelloWrite({ action: 'delete', card: 'C1' }), 'there is no delete');
  assert.ok(!validateTrelloWrite({ action: 'update', card: 'C1' }), 'an update must change something');
});

// C-FILLER: the voice model sends every declared property, so an unused boolean arrives as false.
test('FILLER: the unused booleans the voice model sends are absent, and the write sends its own shape', async () => {
  const run = session();
  const name = 'Call the vet about the booster';
  const written = await board.write(run, { action: 'create', list: 'Short Term Backlog', name, checked: false, complete: false, remove: false }, 'add a card to short term backlog');
  assert.equal(written.ok, true, 'the unused booleans are not model errors');
  const listId = fake.lists.find(list => list.name === 'Short Term Backlog' && list.boardId === fake.boards[0]!.id)!.id;
  assert.deepEqual(writes()[writes().length - 1]!.args, { action: 'create', listId, name }, 'no unused boolean reaches the server');
  assert.deepEqual(events[events.length - 1]!.normalized, ['checked', 'complete', 'remove'], 'the settle line names what it dropped');
  assert.ok(events.every(event => !JSON.stringify(event).includes(name)), 'a path is never a value');

  assert.equal(validateTrelloWrite({ action: 'label', card: 'C1', label: 'green', remove: false }), true, 'a boolean the action uses is validated as today');
  assert.equal(validateTrelloWrite({ action: 'checklist', card: 'C1', item: 'Buy a drive', checked: false }), true, 'the checklist keeps its own checked');
  assert.equal(validateTrelloWrite({ action: 'create', list: 'Today', name: 'Call the vet', checked: true }), false, 'a value the shape does not take still refuses');
  assert.equal(validateTrelloWrite({ action: 'create', list: 'Today', name: 'Call the vet', board: 'Other' }), false, 'so does a non-filler unknown property');
});

test('the host log lines are content-free: tool, phase, outcome and a closed reason', () => {
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).filter(key => !['event', 'connector', 'tool', 'phase', 'outcome', 'reason', 'normalized'].includes(key)), []);
    assert.equal(event.connector, 'trello');
    assert.ok(!JSON.stringify(event).includes('plumber'));
  }
});

// W7-R2: the repository is public, so the board name lives only in the owner's private config.
test('the board name comes only from the private config: with none, nothing on Trello is touched', async () => {
  const unnamed = mkdtempSync(join(tmpdir(), 'trello-noname-'));
  const local = await startTrelloFake({ now: NOW });
  try {
    writeKey(unnamed, local.key, local.token);
    const board2 = createTrelloBoard({ configDir: unnamed, url: local.url, timeZone: 'UTC', now });
    const before = local.calls.length;
    const read = await board2.read(session(), { view: 'overview' });
    assert.equal(read.code, 'not_configured');
    assert.match(String(read.guidance), /trello-board\.json/, 'the plain next step names the file to write');
    assert.equal((await board2.write(session(), { action: 'archive', card: 'Call the plumber' }, 'archive it')).code, 'not_configured');
    assert.equal(local.calls.length, before, 'no call reaches the server without a configured board');
  } finally { await local.close(); rmSync(unnamed, { recursive: true, force: true }); }
});

test('the configured name is the pin, and no board name is in the code', async () => {
  const configured = mkdtempSync(join(tmpdir(), 'trello-configured-'));
  const local = await startTrelloFake({ now: NOW });
  try {
    writeKey(configured, local.key, local.token);
    writeFileSync(join(configured, 'trello-board.json'), JSON.stringify({ board: SYNTHETIC_BOARD }), { mode: 0o600 });
    const board2 = createTrelloBoard({ configDir: configured, url: local.url, timeZone: 'UTC', now });
    const result = await board2.read(session(), { view: 'overview' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.board, SYNTHETIC_BOARD, 'the pin is the name the owner configured');
    const module = await import('../tools/trello.js');
    assert.equal(Object.hasOwn(module, 'TRELLO_DEFAULT_BOARD'), false, 'the code carries no default board name');
    assert.ok(!JSON.stringify(Object.values(module)).includes(SYNTHETIC_BOARD), 'no exported value names the board');
  } finally { await local.close(); rmSync(configured, { recursive: true, force: true }); }
});

// W7-R4: the per-session idempotency ledger is cleared when the session ends.
test('the idempotency ledger is cleared when the session ends', async () => {
  const run = session();
  const args = { action: 'note', card: 'Draft the quarterly plan', text: 'the form is in the hall' };
  const before = writes().length;
  const first = await board.write(run, args, 'note on the card');
  assert.equal(first.ok, true, JSON.stringify(first));
  const replay = await board.write(run, args, 'note on the card');
  assert.equal(replay.replayed, true, 'the same write in one session answers from its receipt');
  assert.equal(writes().length, before + 1);
  board.end(run);
  const after = await board.write(run, args, 'note on the card');
  assert.equal(after.replayed, undefined, 'an ended session leaves no receipt behind');
  assert.equal(writes().length, before + 2);
});

// W7-R5: the server has no comment tool, so a note is a dated line in the description.
test('a note appends a dated line to the description, and the words say description', async () => {
  const run = session();
  const card = fake.cards.find(entry => entry.name === 'Sort the photo archive')!;
  const noted = await board.write(run, { action: 'note', card: 'Sort the photo archive', text: 'the album is in the loft' }, 'note on the card');
  assert.equal(noted.ok, true, JSON.stringify(noted));
  assert.equal(noted.change, 'note added to the description');
  assert.equal(card.desc, '2026-10-26: the album is in the loft', 'the note is one dated line in the description');
  const again = await board.write(run, { action: 'note', card: 'Sort the photo archive', text: 'and the negatives too' }, 'note on the card');
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(card.desc, '2026-10-26: the album is in the loft\n\n2026-10-26: and the negatives too', 'a second note is a new dated line');
  assert.match(TRELLO_WRITE_DESCRIPTION, /no comment tool/i, 'the tool description says a note goes in the description');
  assert.ok(!/add a comment|post a comment/i.test(TRELLO_WRITE_DESCRIPTION), 'nothing promises a comment');
});

test('W7-F2: a card he asks for with a label is created with that label in the same turn', async () => {
  const run = session();
  const green = fake.labels.find(label => label.color === 'green')!.id;
  const before = writes().length;
  const created = await board.write(run, { action: 'create', list: 'Ideas', name: 'Call about the shed', label: 'green' }, 'add a card to ideas about the shed with the green label');
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.deepEqual(created.labels, ['green'], 'the receipt names the label it attached');
  assert.deepEqual(fake.cards.find(entry => entry.name === 'Call about the shed')!.labelIds, [green]);
  assert.deepEqual(writes().slice(before).map(call => call.args.action), ['create', 'add_label'], 'create then attach, never a silent drop');
  assert.equal(validateTrelloWrite({ action: 'create', list: 'Ideas', name: 'x', label: 'green' }), true);
});

test('W7-F5: the guard reads a change in his own words, so a read ask never admits a write', () => {
  for (const ask of ['what did I jot down today', "show me what's due", 'what is on my board', 'anything due this week', 'what did I note down']) {
    assert.equal(ownerAskedForChange(ask), false, ask);
  }
  for (const ask of ['add a card to Short Term Backlog', 'move the OCP card to Done', 'set the due date of X to Friday', 'note on the Gates card that the call moved',
    'put that note into Short Term Backlog', 'mark the venue card done', 'archive the shed card']) {
    assert.equal(ownerAskedForChange(ask), true, ask);
  }
  assert.match(TRELLO_WRITE_DESCRIPTION, /his own words this turn name a change/, 'the description says what the guard is');
});

/** The Objective's asks, judged by rule on what reached the server: the arguments a correct model call forwards. */const EVAL_ROWS: { ask: string; tool: 'read' | 'write'; args: Record<string, unknown>; judge: (calls: { tool: string; args: Record<string, unknown> }[], result: Record<string, unknown>) => boolean }[] = [
  { ask: "what's in my sprint", tool: 'read', args: { view: 'list', list: 'Sprint' }, judge: (calls, result) => calls.every(call => call.tool.startsWith('trelloRead')) && result.list === 'Sprint' },
  { ask: "what's overdue", tool: 'read', args: { view: 'due', window: 'overdue' }, judge: (calls, result) => calls.every(call => call.tool.startsWith('trelloRead')) && Array.isArray(result.overdue) },
  { ask: 'add a card to Short Term Backlog: call the accountant about the budget', tool: 'write', args: { action: 'create', list: 'Short Term Backlog', name: 'call the accountant about the budget' },
    judge: calls => calls.filter(call => call.tool === 'trelloWriteCard').length === 1 && calls.some(call => call.args.action === 'create' && call.args.due === undefined) },
  { ask: 'move the venue card to Done', tool: 'write', args: { action: 'move', card: 'Book the venue', list: 'Done' }, judge: calls => calls.filter(call => call.tool.startsWith('trelloWrite')).map(call => call.args.action).join() === 'move' },
  { ask: 'set the due date of the venue card to Friday', tool: 'write', args: { action: 'due', card: 'Book the venue', due: '2026-10-30' }, judge: calls => calls.some(call => call.args.due === '2026-10-30T09:00:00.000Z') },
  { ask: 'note on the bank card that the call moved', tool: 'write', args: { action: 'note', card: 'Answer from the bank', text: 'the call moved' }, judge: calls => calls.some(call => typeof call.args.desc === 'string' && call.args.desc.endsWith('2026-10-26: the call moved')) },
];
for (const row of EVAL_ROWS) {
  test(`eval: "${row.ask}"`, async () => {
    const before = fake.calls.length;
    const run = session();
    const result = row.tool === 'read' ? await board.read(run, row.args) : await board.write(run, row.args, row.ask);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(row.judge(fake.calls.slice(before), result), JSON.stringify(fake.calls.slice(before)));
  });
}

// D2: the owner's own API key is the whole connection. No sign-in, no OAuth, no browser.
test('a key file with the owner key and board name connects, and no key file is not configured', async () => {
  assert.equal(trelloConfigured(dir), true, 'the fixture key file, board name and owner name are a connection');
  const empty = mkdtempSync(join(tmpdir(), 'trello-nokey-'));
  try {
    const before = fake.calls.length;
    const unconfigured = createTrelloBoard({ configDir: empty, url: fake.url, timeZone: 'UTC', now });
    assert.equal(trelloConfigured(empty), false);
    assert.equal(unconfigured.available(), false, 'without a key nothing is offered');
    assert.equal((await unconfigured.read(session(), { view: 'overview' })).code, 'not_configured');
    assert.equal(fake.calls.length, before, 'nothing reaches Trello without a key');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('a revoked key is credential_revoked: loud, typed, and never an empty board', async () => {
  const local = await startTrelloFake({ now: NOW });
  const stale = mkdtempSync(join(tmpdir(), 'trello-revoked-'));
  try {
    writeKey(stale, local.key, 'a-token-trello-no-longer-accepts');
    writeFileSync(join(stale, 'trello-board.json'), JSON.stringify({ board: SYNTHETIC_BOARD, ownerIdentity: 'rob@plantix.net' }), { mode: 0o600 });
    const revoked = createTrelloBoard({ configDir: stale, url: local.url, timeZone: 'UTC', now });
    const read = await revoked.read(session(), { view: 'overview' });
    assert.equal(read.ok, false, 'a refused key is never an empty board');
    assert.equal(read.code, 'credential_revoked');
    assert.match(String(read.guidance), /import-trello-key\.sh/, 'the guidance names the command that replaces the key');
    assert.equal((await revoked.write(session(), { action: 'archive', card: 'Call the plumber' }, ASK)).code, 'credential_revoked');
  } finally { await local.close(); rmSync(stale, { recursive: true, force: true }); }
});

test('a rate-limited call waits the retry-after once and then reports rate_limited', async () => {
  const local = await startTrelloFake({ now: NOW });
  try {
    const waits: number[] = [];
    const transport = createTrelloRestTransport({
      url: local.url, credentials: async () => ({ ok: true, key: local.key, token: local.token }),
      sleep: async (ms: number) => { waits.push(ms); },
    });
    local.rateLimitNextCall(1, 2);
    assert.equal((await transport.call('trelloReadBoard', { action: 'list' })).ok, true, 'one retry after the wait succeeds');
    assert.deepEqual(waits, [2000], 'the Retry-After header is respected once, not guessed');
    local.rateLimitNextCall(2, 1);
    const limited = await transport.call('trelloReadBoard', { action: 'list' });
    assert.deepEqual(limited, { ok: false, code: 'rate_limited' }, 'a second 429 in a row is reported, never retried forever');
  } finally { await local.close(); }
});

test('the member behind the key must be the owner: email first, then the configured username', async () => {
  const matching = await startTrelloFake({ now: NOW });
  const other = await startTrelloFake({ now: NOW, member: { id: 'member0other', username: 'someone-else', email: 'someone@example.com' } });
  const nameless = await startTrelloFake({ now: NOW, member: { id: 'member0named', username: 'robplantix' } });
  const make = (target: TrelloFake, owner: Record<string, string>): string => {
    const configDir = mkdtempSync(join(tmpdir(), 'trello-identity-'));
    writeKey(configDir, target.key, target.token);
    writeFileSync(join(configDir, 'trello-board.json'), JSON.stringify({ board: SYNTHETIC_BOARD, ...owner }), { mode: 0o600 });
    return configDir;
  };
  const dirs = [make(matching, { ownerIdentity: 'rob@plantix.net' }), make(other, { ownerIdentity: 'rob@plantix.net' }),
    make(nameless, { ownerTrelloUsername: 'robplantix' }), make(nameless, { ownerTrelloUsername: 'another-account' })];
  try {
    assert.deepEqual(await trelloIdentity({ configDir: dirs[0]!, url: matching.url }), { ok: true, member: { username: 'robplantix', email: 'rob@plantix.net', fullName: 'Rob' } });
    assert.deepEqual(await trelloIdentity({ configDir: dirs[1]!, url: other.url }), { ok: false, code: 'credential_mismatch' }, 'another member never acts as the owner');
    assert.equal((await trelloIdentity({ configDir: dirs[2]!, url: nameless.url })).ok, true, 'without an email the username is the identity');
    assert.deepEqual(await trelloIdentity({ configDir: dirs[3]!, url: nameless.url }), { ok: false, code: 'credential_mismatch' });
  } finally {
    for (const configDir of dirs) rmSync(configDir, { recursive: true, force: true });
    for (const target of [matching, other, nameless]) await target.close();
  }
});

test('the import script writes a 0600 key file and prints no secret', async () => {
  const envFile = join(mkdtempSync(join(tmpdir(), 'trello-env-')), 'trello.env');
  const configDir = mkdtempSync(join(tmpdir(), 'trello-import-'));
  const key = 'f'.repeat(32);
  const token = 't'.repeat(64);
  try {
    writeFileSync(envFile, `TRELLO_API_KEY=${key}\nTRELLO_TOKEN=${token}\n`, { mode: 0o600 });
    const result = spawnSync('bash', ['scripts/import-trello-key.sh', envFile, configDir], { encoding: 'utf8', cwd: process.cwd() });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(`${String(result.stdout)}${String(result.stderr)}`.includes(key), false, 'the key is never printed');
    assert.equal(`${String(result.stdout)}${String(result.stderr)}`.includes(token), false, 'the token is never printed');
    const path = join(configDir, TRELLO_KEY_FILE);
    assert.equal(statSync(path).mode & 0o777, 0o600, 'the key file is private');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { key, token });
  } finally { rmSync(configDir, { recursive: true, force: true }); rmSync(join(envFile, '..'), { recursive: true, force: true }); }
});
