import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrelloBoard, runTrelloLogin, trelloBinding, trelloSignedIn, trelloTokenSource, TRELLO_REFERENCE, TRELLO_SCOPE } from '../host/trello.js';
import { createTrelloTransport } from '../adapters/trello/client.js';
import { foldName, indexTrelloSchemas, ownerAskedForChange, planTrelloCall, trelloDueInstant, validateTrelloRead, validateTrelloWrite, TRELLO_SERVER_ALLOW, TRELLO_SERVER_DENY, type TrelloBoard } from '../tools/trello.js';
import { OAuthLoginError, writeOAuthRecord, type OAuthSignInHop } from '../host/oauth-client.js';
import { fakeToolSchemas, startTrelloFake, type TrelloFake } from './trello-fake.js';

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
    assert.ok(!/inbox|planner|write:organization/.test(TRELLO_SCOPE), 'the scope never asks for Inbox, Planner or workspace writes');
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

test('a card, list or id from another board is outside_scope and never dispatched', async () => {
  const foreignCard = fake.cards.find(card => card.name === 'Foreign card')!;
  const foreignList = fake.lists.find(list => list.boardId !== fake.boards[0]!.id)!;
  const run = session();
  assert.equal((await board.read(run, { view: 'card', card: foreignCard.id })).code, 'outside_scope');
  const before = writes().length;
  assert.equal((await board.write(run, { action: 'move', card: 'Call the plumber', list: foreignList.id }, 'move it')).code, 'outside_scope');
  assert.equal((await board.write(run, { action: 'archive', card: foreignCard.id }, 'archive it')).code, 'outside_scope');
  assert.equal((await board.write(run, { action: 'archive', card: 'ari:cloud:trello::board/workspace/w0fake/abc' }, 'archive it')).code, 'outside_scope');
  assert.equal(writes().length, before);
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

/** The Objective's asks, judged by rule on what reached the server: the arguments a correct model call forwards. */
const EVAL_ROWS: { ask: string; tool: 'read' | 'write'; args: Record<string, unknown>; judge: (calls: { tool: string; args: Record<string, unknown> }[], result: Record<string, unknown>) => boolean }[] = [
  { ask: "what's in my sprint", tool: 'read', args: { view: 'list', list: 'Sprint' }, judge: (calls, result) => calls.every(call => call.tool.startsWith('trelloRead')) && result.list === 'Sprint' },
  { ask: "what's overdue", tool: 'read', args: { view: 'due', window: 'overdue' }, judge: (calls, result) => calls.every(call => call.tool.startsWith('trelloRead')) && Array.isArray(result.overdue) },
  { ask: 'add a card to Short Term Backlog: call the accountant about the budget', tool: 'write', args: { action: 'create', list: 'Short Term Backlog', name: 'call the accountant about the budget' },
    judge: calls => calls.filter(call => call.tool === 'trelloWriteCard').length === 1 && calls.some(call => call.args.action === 'create' && call.args.due === undefined) },
  { ask: 'move the venue card to Done', tool: 'write', args: { action: 'move', card: 'Book the venue', list: 'Done' }, judge: calls => calls.filter(call => call.tool.startsWith('trelloWrite')).map(call => call.args.action).join() === 'move' },
  { ask: 'set the due date of the venue card to Friday', tool: 'write', args: { action: 'due', card: 'Book the venue', due: '2026-10-30' }, judge: calls => calls.some(call => call.args.due === '2026-10-30T09:00:00.000Z') },
  { ask: 'note on the bank card that the call moved', tool: 'write', args: { action: 'note', card: 'Answer from the bank', text: 'the call moved' }, judge: calls => calls.some(call => typeof call.args.desc === 'string' && call.args.desc.endsWith('2026-10-26: the call moved')) },
  { ask: 'what did I jot down today', tool: 'read', args: { view: 'recent' }, judge: (calls, result) => calls.every(call => call.tool.startsWith('trelloRead')) && Array.isArray(result.cards) },
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
