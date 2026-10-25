import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrelloBoard, runTrelloLogin, trelloBinding, trelloSignedIn, trelloTokenSource, TRELLO_REFERENCE, TRELLO_SCOPE } from '../host/trello.js';
import { createTrelloTransport } from '../adapters/trello/client.js';
import { foldName, indexTrelloSchemas, ownerAskedForChange, planTrelloCall, trelloDueInstant, validateTrelloRead, validateTrelloWrite, TRELLO_CALL_TOOLS, TRELLO_SERVER_ALLOW, TRELLO_SERVER_DENY, TRELLO_WRITE_DESCRIPTION, type TrelloBoard } from '../tools/trello.js';
import { OAuthLoginError, writeOAuthRecord, type OAuthSignInHop } from '../host/oauth-client.js';
import { fakeToolSchemas, startTrelloFake, SYNTHETIC_BOARD, type TrelloFake } from './trello-fake.js';

/** Monday 2026-10-26 10:00 UTC; the board's zone is UTC so the windows are exact. */
const NOW = Date.UTC(2026, 9, 26, 10, 0);
const now = () => NOW;
const ASK = 'please add this to my board';

let fake: TrelloFake;
let dir: string;
let board: TrelloBoard;
const events: Record<string, unknown>[] = [];

async function signIn(configDir: string, target: TrelloFake, hops?: OAuthSignInHop[]): Promise<string> {
  let authorizeUrl = '';
  await runTrelloLogin({ configDir, binding: trelloBinding(target.resource, target.issuer), redirectPort: 0, now,
    ...(hops ? { onHop: hop => { hops.push(hop); } } : {}),
    openBrowser: async url => {
      authorizeUrl = url;
      const { callback } = await target.consent(url);
      setImmediate(() => { void fetch(callback).then(response => response.text()); });
    } });
  return authorizeUrl;
}

before(async () => {
  fake = await startTrelloFake({ now: NOW });
  dir = mkdtempSync(join(tmpdir(), 'trello-board-'));
  await signIn(dir, fake);
  // W7-R2: the name is the owner's private configuration, so the fixture writes that file.
  writeFileSync(join(dir, 'trello-board.json'), JSON.stringify({ board: SYNTHETIC_BOARD }), { mode: 0o600 });
  board = createTrelloBoard({ configDir: dir, binding: trelloBinding(fake.resource, fake.issuer), timeZone: 'UTC', now, log: event => { events.push(event); } });
});
after(async () => { await fake.close(); rmSync(dir, { recursive: true, force: true }); });

const writes = () => fake.calls.filter(call => call.tool.startsWith('trelloWrite'));
const session = (() => { let n = 0; return () => `live-trello-${++n}`; })();

test('the sign-in runs every hop against a resource and an issuer on different origins and stores one private record', async () => {
  const local = await startTrelloFake({ now: NOW });
  const configDir = mkdtempSync(join(tmpdir(), 'trello-login-'));
  try {
    const hops: OAuthSignInHop[] = [];
    const authorizeUrl = await signIn(configDir, local, hops);
    assert.deepEqual(hops.map(hop => `${hop.hop}:${hop.outcome}`), ['discovery:ok', 'registration:ok', 'browser_handoff:ok', 'callback:ok', 'token:ok', 'stored:ok']);
    const url = new URL(authorizeUrl);
    assert.equal(url.origin, new URL(local.issuer).origin, 'the browser goes to the issuer origin');
    assert.equal(url.searchParams.get('resource'), local.resource);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), TRELLO_SCOPE);
    // F10: the Inbox read this connector now performs is granted, and nothing wider is asked for.
    assert.match(TRELLO_SCOPE, /(?:^| )read:member\.inbox:trello(?: |$)/, 'the Inbox read is granted');
    assert.match(TRELLO_SCOPE, /(?:^| )write:member\.inbox:trello(?: |$)/, 'the Inbox to board move is granted');
    assert.match(TRELLO_SCOPE, /(?:^| )write:board:trello(?: |$)/, 'the board writes are granted');
    assert.ok(!/planner|write:organization/.test(TRELLO_SCOPE), 'the scope never asks for Planner or workspace writes');
    assert.equal(local.registrations[0]?.token_endpoint_auth_method, 'none');
    assert.match(String((local.registrations[0]?.redirect_uris as string[])[0]), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.deepEqual(local.tokens, [{ grant: 'authorization_code', resource: local.resource }]);
    const path = join(configDir, `${TRELLO_REFERENCE}.json`);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.deepEqual([record.endpoint, record.resource, record.issuer], ['board', local.resource, local.issuer]);
    assert.ok(trelloSignedIn(configDir, trelloBinding(local.resource, local.issuer)));
    assert.ok(!trelloSignedIn(configDir, trelloBinding()), 'a record for another resource is not a sign-in for the real one');
  } finally { await local.close(); rmSync(configDir, { recursive: true, force: true }); }
});

for (const [name, setup, outcome] of [
  ['a protected-resource document naming another authorization server', (f: TrelloFake) => { f.override.prm = { authorization_servers: ['https://auth.example.invalid/x'] }; }, 'server_untrusted'],
  ['a protected-resource document naming another resource', (f: TrelloFake) => { f.override.prm = { resource: `${f.resource}x` }; }, 'resource_mismatch'],
  ['server metadata with a foreign issuer', (f: TrelloFake) => { f.override.as = { issuer: `${new URL(f.issuer).origin}/OtherTenant` }; }, 'issuer_mismatch'],
  ['server metadata with a token endpoint off the issuer origin', (f: TrelloFake) => { f.override.as = { token_endpoint: 'https://token.example.invalid/oauth/token' }; }, 'endpoint_off_origin'],
] as const) {
  test(`discovery refuses ${name} before any registration`, async () => {
    const local = await startTrelloFake({ now: NOW });
    const configDir = mkdtempSync(join(tmpdir(), 'trello-refuse-'));
    try {
      setup(local);
      const hops: OAuthSignInHop[] = [];
      await assert.rejects(signIn(configDir, local, hops), (error: unknown) => error instanceof OAuthLoginError && error.code === 'metadata-unavailable');
      assert.deepEqual(hops, [{ hop: 'discovery', outcome }]);
      assert.equal(local.registrations.length, 0);
    } finally { await local.close(); rmSync(configDir, { recursive: true, force: true }); }
  });
}

test('an expiring session refreshes once with the resource URL and the board keeps working', async () => {
  const local = await startTrelloFake({ now: NOW });
  const configDir = mkdtempSync(join(tmpdir(), 'trello-refresh-'));
  try {
    await signIn(configDir, local);
    const record = JSON.parse(readFileSync(join(configDir, `${TRELLO_REFERENCE}.json`), 'utf8'));
    writeOAuthRecord(configDir, TRELLO_REFERENCE, { ...record, expiresAt: NOW + 60_000 });
    const token = await trelloTokenSource(configDir, trelloBinding(local.resource, local.issuer), { now })();
    assert.equal(token.ok, true);
    assert.deepEqual(local.tokens.map(entry => entry.grant), ['authorization_code', 'refresh_token']);
    assert.equal(local.tokens[1]?.resource, local.resource);
  } finally { await local.close(); rmSync(configDir, { recursive: true, force: true }); }
});

test('without a sign-in nothing is offered and nothing is sent', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'trello-empty-'));
  try {
    const before = fake.calls.length;
    const signedOut = createTrelloBoard({ configDir: empty, binding: trelloBinding(fake.resource, fake.issuer), timeZone: 'UTC', now });
    assert.equal(signedOut.available(), false);
    assert.equal((await signedOut.read(session(), { view: 'overview' })).code, 'not_signed_in');
    assert.equal((await signedOut.write(session(), { action: 'archive', card: 'Call the plumber' }, ASK)).code, 'not_signed_in');
    assert.equal(fake.calls.length, before);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

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
  assert.equal(card.comments, 'not offered by the Trello server');
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

test('W7-F4: a write the live tools/list does not offer is unsupported, and nothing reaches the server', async () => {
  const local = await startTrelloFake({ now: NOW, withoutTool: 'trelloWriteCard' });
  const configDir = mkdtempSync(join(tmpdir(), 'trello-noschema-'));
  try {
    await signIn(configDir, local);
    writeFileSync(join(configDir, 'trello-board.json'), JSON.stringify({ board: SYNTHETIC_BOARD }), { mode: 0o600 });
    const noCardWrites = createTrelloBoard({ configDir, binding: trelloBinding(local.resource, local.issuer), timeZone: 'UTC', now });
    const before = local.calls.length;
    const refused = await noCardWrites.write(session(), { action: 'archive', card: 'Call the plumber' }, 'archive it');
    assert.equal(refused.code, 'unsupported');
    assert.ok(local.calls.slice(before).every(call => call.tool.startsWith('trelloRead')), 'no write shape was sent');
  } finally { await local.close(); rmSync(configDir, { recursive: true, force: true }); }
  const index = indexTrelloSchemas(fakeToolSchemas());
  assert.equal(planTrelloCall(index, 'trelloWriteCard', [{ action: 'move', cardId: 'ari:cloud:trello::card/workspace/w0fake/1' }]), undefined, 'a planned property the schema does not carry is unsupported');
});

test('W7-F6: a reply with another id, or one over the size bound, is attributed to nothing', async () => {
  // A server of its own: an oversized reply is cancelled mid-stream, which is no other test's business.
  const local = await startTrelloFake({ now: NOW });
  try {
    const transport = createTrelloTransport({ url: local.mcpUrl, token: async () => ({ ok: true, token: local.accessToken }) });
    local.replyWithWrongId();
    assert.deepEqual(await transport.call('trelloReadBoard', { action: 'list' }), { ok: false, code: 'protocol_error' }, 'another id is no reply');
    local.bloatNextReply(2_000_000);
    assert.deepEqual(await transport.call('trelloReadBoard', { action: 'list' }), { ok: false, code: 'protocol_error' }, 'a body over the bound is no reply');
    assert.equal((await transport.call('trelloReadBoard', { action: 'list' })).ok, true, 'the next reply is read again, so neither bad one was attributed');
  } finally { await local.close(); }
});

test('tools for boards, lists, members, Inbox and Planner are never planned and never called', async () => {
  const index = indexTrelloSchemas(fakeToolSchemas());
  for (const tool of TRELLO_SERVER_DENY) assert.equal(planTrelloCall(index, tool, [{ action: 'create', name: 'x' }]), undefined, tool);
  assert.equal(planTrelloCall(index, 'trelloSearch', [{ action: 'search', query: 'x' }]), undefined, 'server search is not on the allowlist');
  assert.equal(index.get('trelloWriteCard')?.has('create'), true);
  const transport = createTrelloTransport({ url: fake.mcpUrl, token: async () => ({ ok: true, token: fake.accessToken }) });
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

test('the host log lines are content-free: tool, phase, outcome and a closed reason', () => {
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).filter(key => !['event', 'connector', 'tool', 'phase', 'outcome', 'reason'].includes(key)), []);
    assert.equal(event.connector, 'trello');
    assert.ok(!JSON.stringify(event).includes('plumber'));
  }
});

// W7-R1: quick capture from his phone lands in the Trello Inbox, not on the board.
test('what he jotted today reads the Inbox and the board cards he added today', async () => {
  const run = session();
  const before = fake.calls.length;
  const result = await board.read(run, { view: 'inbox' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.today, '2026-10-26');
  const jotted = result.jotted as { card: string; name: string; list: string; jotted: string }[];
  assert.deepEqual(jotted.map(entry => entry.name), ['Jotted note from the phone'], 'today Inbox cards, and only today ones');
  assert.deepEqual([jotted[0]!.list, jotted[0]!.jotted], ['Inbox', '2026-10-26']);
  const cards = result.cards as { name: string }[];
  assert.ok(cards.some(entry => entry.name === 'Quick note from the phone'), 'the board cards he added today are read with it');
  assert.ok(!cards.some(entry => entry.name === 'Call the plumber'), 'an older board card is not today');
  const tools = fake.calls.slice(before).map(call => call.tool);
  assert.ok(tools.includes('trelloReadInbox'), 'the Inbox is read through the server');
  assert.ok(tools.every(tool => tool.startsWith('trelloRead')), 'a jot read writes nothing');
  // F12: an Inbox read is a logged call, under a name the host's closed set keeps.
  assert.ok(TRELLO_CALL_TOOLS.includes('read.inbox'), 'the host log vocabulary carries the Inbox read');
  assert.ok(events.some(event => event.tool === 'read.inbox'), 'the Inbox read emits its content-free connector_call line');
});

test('an Inbox card moves onto a list of the pinned board, and no other Inbox write exists', async () => {
  const run = session();
  const inboxCard = fake.inbox.cards[0]!;
  const read = await board.read(run, { view: 'inbox' });
  assert.equal(read.ok, true, JSON.stringify(read));
  const handle = (read.jotted as { card: string }[])[0]!.card;
  const listId = fake.lists.find(list => list.name === 'Short Term Backlog' && list.boardId === fake.boards[0]!.id)!.id;
  const before = writes().length;
  for (const [args, words] of [
    [{ action: 'archive', card: handle }, 'archive it'],
    [{ action: 'note', card: handle, text: 'a line' }, 'note on the card'],
    [{ action: 'done', card: handle }, 'mark it done'],
    [{ action: 'label', card: handle, label: 'green' }, 'add the green label'],
  ] as const) {
    assert.equal((await board.write(run, args, words)).code, 'outside_scope', JSON.stringify(args));
  }
  const moved = await board.write(run, { action: 'move', card: handle, list: 'Short Term Backlog' }, 'put that note into Short Term Backlog');
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.change, 'moved from the Inbox to Short Term Backlog');
  assert.deepEqual(writes().slice(before), [{ tool: 'trelloWriteCard', args: { action: 'move', cardId: inboxCard.id, listId } }], 'the only Inbox write is the move onto the board');
  assert.equal(inboxCard.listId, listId, 'the note is in that list now');
  // F13: the moved note is a card of the board now, and its Inbox handle is spent rather than a trap.
  const noted = await board.write(run, { action: 'note', card: 'Jotted note from the phone', text: 'kept in the backlog' }, 'note on the card');
  assert.equal(noted.ok, true, JSON.stringify(noted));
  assert.equal((await board.write(run, { action: 'archive', card: handle }, 'archive it')).code, 'card_unknown', 'the Inbox handle no longer names anything');
});

// W7-R2: the repository is public, so the board name lives only in the owner's private config.
test('the board name comes only from the private config: with none, nothing on Trello is touched', async () => {
  const unnamed = mkdtempSync(join(tmpdir(), 'trello-noname-'));
  const local = await startTrelloFake({ now: NOW });
  try {
    await signIn(unnamed, local);
    const board2 = createTrelloBoard({ configDir: unnamed, binding: trelloBinding(local.resource, local.issuer), timeZone: 'UTC', now });
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
    await signIn(configured, local);
    writeFileSync(join(configured, 'trello-board.json'), JSON.stringify({ board: SYNTHETIC_BOARD }), { mode: 0o600 });
    const board2 = createTrelloBoard({ configDir: configured, binding: trelloBinding(local.resource, local.issuer), timeZone: 'UTC', now });
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
  { ask: 'what did I jot down today', tool: 'read', args: { view: 'inbox' }, judge: (calls, result) => calls.some(call => call.tool === 'trelloReadInbox') && Array.isArray(result.jotted) && Array.isArray(result.cards) },
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
