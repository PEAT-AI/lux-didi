import { taskChatReader } from './fixtures/task-chat-reader.js';
// C-CHAT (W2b): Naya reads the team chat by person, direct message, group and channel. Every test runs
// against the synthetic stdio child (fixtures/stdio-mattermost-people-child.mjs): no account, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { SOURCE_DISPATCH, SOURCE_CHILD_DISPATCHES, type EndpointConfig } from '../adapters/mcp/port.js';
import {
  CONNECTOR_COMPOSED_TOOLS, composedGrantedNames, connectionEnvelope, createMattermostReader,
  connectorDescriptor, MATTERMOST_ATTENTION_TOOL, MATTERMOST_CHAT_TOOL, MATTERMOST_PERSON_TOOLS, MATTERMOST_READ_TOOLS, MATTERMOST_TOPIC_TOOLS, MATTERMOST_TOOLS, withoutOwner,
} from '../connectors/index.js';
import type { MattermostAttention, MattermostChatRead, MattermostResult } from '../connectors/index.js';
import { projectMattermostResult } from '../tools/mattermost.js';
import { installPeople, parsePeople, type PeopleSnapshot } from '../people/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// The fixture's clock and the suite's, one instant, so the week window is the same every run.
const FIXTURE_NOW = Date.parse('2026-10-25T09:00:00Z');
const child = join(here, 'fixtures', 'stdio-mattermost-people-child.mjs');
const ACCOUNT = 'local';
const RESOURCE = 'mattermost';
const DAY = 24 * 60 * 60 * 1000;
const ADA_DM = 'chanDzz000000000000000000a';
const GROUP_ADA_KIM = 'chanG02000000000000000000a';
const BUILDER_FRIENDS = 'chanBuilderFriends0000000a';
const BUILDERS = 'chanBuilders0000000000000a';
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
// X-R2: the person-overview window is measured from the fixture's own clock, never the wall clock: the
// fixture is pinned to 2026-10-25, so a rolling 7-day window measured from today drifts past its oldest
// post and the same read counts 16 instead of 17.
const fixtureDaysAgo = (days: number): string => new Date(FIXTURE_NOW - days * DAY).toISOString().slice(0, 10);

type Call = { name: string; arguments: Record<string, unknown> };

async function setup(t: { after(fn: () => Promise<void> | void): void }, mode: 'people' | 'legacy', grant?: (names: string[]) => string[], extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-mattermost-people-'));
  const log = join(dir, 'calls.log');
  const registry = new McpRegistry();
  const config: EndpointConfig = {
    id: 'mattermost', transport: 'stdio', command: process.execPath, args: [child, mode],
    env: { HOME: dir, PATH: process.env.PATH ?? '/usr/bin', DIDI_FAKE_MATTERMOST_LOG: log, DIDI_FAKE_MATTERMOST_NOW: String(FIXTURE_NOW), LOGNAME: '', SHELL: '', TERM: '', USER: '', ...extraEnv },
    account: ACCOUNT, resource: RESOURCE,
  };
  registry.register(config);
  registry.enable('mattermost'); registry.allowEgress('mattermost');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore() });
  t.after(async () => { await adapter.close(); rmSync(dir, { recursive: true, force: true }); });
  const discovery = await adapter.discover('mattermost');
  if (discovery.state !== 'discovered') throw new Error('discovery failed');
  // The host grants the connector envelope intersected with what this child publishes (owner-trusted-reads).
  const published = discovery.tools.map(tool => tool.name);
  const envelope = connectionEnvelope('mattermost', { resource: RESOURCE });
  const names = (grant ?? (list => list))(envelope.filter(name => published.includes(name)));
  registry.approve({ endpointId: 'mattermost', schemaDigest: discovery.schemaDigest, toolNames: names, effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
  const reader = createMattermostReader({ port: adapter, registry, now: () => FIXTURE_NOW, config: { endpointId: 'mattermost', account: ACCOUNT, resource: RESOURCE, schemaDigest: discovery.schemaDigest, generation: 1, maxLimit: 50, queryChars: 200, names: [...names, ...composedGrantedNames('mattermost', names)] } });
  const calls = (): Call[] => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Call) : [];
  return { adapter, registry, reader, calls, published, names, dir, config, discovery };
}

function chatRead(result: MattermostResult): MattermostChatRead {
  assert.equal(result.state, 'completed', `the chat read completed: ${'reason' in result ? result.reason : ''}`);
  return (result as { decodedResult: unknown }).decodedResult as MattermostChatRead;
}

const searches = (calls: readonly Call[]) => calls.filter(call => call.name === 'mattermost_search').map(call => call.arguments);

test('C-CHAT: the read envelope carries the two person reads, never a write, and the composites stand on the base reads', () => {
  const envelope = connectionEnvelope('mattermost', { resource: RESOURCE });
  assert.deepEqual([...envelope], [...MATTERMOST_TOOLS, ...MATTERMOST_PERSON_TOOLS, ...MATTERMOST_TOPIC_TOOLS]);
  assert.deepEqual([...MATTERMOST_READ_TOOLS], [...envelope]);
  assert.ok(!envelope.includes('mattermost_post_message'));
  assert.deepEqual(composedGrantedNames('mattermost', [...MATTERMOST_TOOLS]).sort(), [MATTERMOST_ATTENTION_TOOL, MATTERMOST_CHAT_TOOL].sort(),
    'a child without the person reads still gets both composites');
  assert.deepEqual(composedGrantedNames('mattermost', MATTERMOST_TOOLS.filter(name => name !== 'mattermost_search')), [], 'no composite without every base read');
  const chat = CONNECTOR_COMPOSED_TOOLS['mattermost']!.find(tool => tool.name === MATTERMOST_CHAT_TOOL)!;
  assert.equal(chat.validate({ intent: 'person', person: 'Ada', sides: 'theirs', from_date: '2026-10-01', limit: 8 }), true);
  assert.equal(chat.validate({ intent: 'group', people: ['Ada', 'Kim'] }), true);
  assert.equal(chat.validate({ intent: 'person', person: 'Ada', author: 'x' }), false, 'an undeclared key is refused');
  assert.equal(chat.validate({ intent: 'post', person: 'Ada' }), false, 'an unknown intent is refused');
  assert.equal(chat.validate({ intent: 'person', person: 'Ada', from_date: 'yesterday' }), false, 'a window is a day, never a word');
});

test('C-CHAT: a newer child is granted its person reads and the filtered channel list passes the schema check', async t => {
  const f = await setup(t, 'people');
  assert.deepEqual([...f.names].sort(), [...MATTERMOST_READ_TOOLS].sort(), 'every read the child publishes, and the write it publishes stays out');
  const read = chatRead(await f.reader.chat({ intent: 'channel', channel: 'AI AI AI' }));
  assert.equal(read.read.startsWith('the channel AI AI AI'), true);
  assert.deepEqual(f.calls().find(call => call.name === 'mattermost_list_channels')?.arguments, { query: 'AI AI AI', types: ['O', 'P'], limit: 10 });
});

// TR-R16: the composed read is granted exactly when the base reads it stands on are, so a grant that
// drops one child read refuses the composite at the connector's own preflight and never reaches the child.
test('TR-R16: a composed read whose base read is not granted is refused, and no child read runs', async t => {
  const f = await setup(t, 'people', names => names.filter(name => name !== 'mattermost_get_thread'));
  const result = await f.reader.chat({ intent: 'channel', channel: 'AI AI AI' });
  assert.equal(result.state, 'refused', 'the composite is refused, not served');
  assert.equal((result as { reason: string }).reason, 'tool-not-granted', 'the refusal names the missing grant');
  assert.deepEqual(f.calls(), [], 'the child saw no read at all');
});

test('C-CHAT (W2B-R6): the channel query is the name as spoken, and the fold stays local', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'channel', channel: 'Builders' }));
  assert.match(read.read, /the channel Builders/u);
  assert.deepEqual(f.calls().filter(call => call.name === 'mattermost_list_channels').map(call => call.arguments), [
    { query: 'Builders', types: ['O', 'P'], limit: 10 },
  ], 'an exact hit is one read: the spoken words alone, no folded retry (W2B-R8)');
});

test('C-CHAT: an approval that predates the person reads keeps every read and names what is missing', async t => {
  const f = await setup(t, 'people', names => names.filter(name => !(MATTERMOST_PERSON_TOOLS as readonly string[]).includes(name)));
  const read = chatRead(await f.reader.chat({ intent: 'overview', person: '@ada.moss' }));
  assert.equal(f.calls().some(call => call.name === 'mattermost_resolve_person' || call.name === 'mattermost_conversation_overview'), false, 'an ungranted read is never called');
  assert.match(read.missing ?? '', /person lookups by name need the newer chat archive/u);
  assert.match(read.missing ?? '', /an overview across group chats and channels needs the newer chat archive/u);
  assert.match(read.read, /your direct messages with @ada\.moss/u, 'the best available read: both sides of the direct messages');
});

// ---- person-said -----------------------------------------------------------------------------------------

test('C-CHAT person-said: what a person wrote is their posts in the direct messages, with the archive count', async t => {
  const f = await setup(t, 'people');
  const result = await f.reader.chat({ intent: 'person', person: 'Ada', sides: 'theirs' });
  const read = chatRead(result);
  assert.deepEqual(f.calls().find(call => call.name === 'mattermost_resolve_person')?.arguments, { name: 'Ada' });
  assert.deepEqual(searches(f.calls()), [{ query: '', mode: 'keyword', limit: 8, sort: 'newest', channel: ADA_DM, author: 'ada.moss', from_date: daysAgo(30) }]);
  assert.equal(read.total, 11, 'the archive count, not the page');
  assert.equal(read.returned, 8);
  assert.ok(read.posts.every(post => post.author === 'ada.moss' && post.channel === 'ada.moss'), 'only her posts, only in the direct messages');
  assert.match(read.read, /^direct messages from Ada Moss \(@ada\.moss\) since \d{4}-\d{2}-\d{2}$/u);
  const projected = projectMattermostResult(f.adapter, result);
  assert.ok(projected.ok);
  assert.match(projected.projection.text, /^read: direct messages from Ada Moss/mu);
  assert.match(projected.projection.text, /^matched: 11$/mu);
});

test('C-CHAT person-said: "my chat with" reads both sides of the direct messages', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'person', person: 'Ada', sides: 'both', query: 'pilot' }));
  const [sent] = searches(f.calls());
  assert.equal(sent?.['author'], undefined, 'both sides: no author filter');
  assert.equal(sent?.['channel'], ADA_DM);
  assert.equal(sent?.['query'], 'pilot');
  assert.equal(read.total, 11, 'only her notes carry the topic word');
  assert.match(read.read, /^your direct messages with Ada Moss \(@ada\.moss\) since .*, about pilot$/u);
});

test('C-CHAT: two people share a first name, so the read asks which one and reads nothing', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'person', person: 'Lena', sides: 'theirs' }));
  assert.equal(read.clarify, 'Which Lena do you mean: Lena Berg (@lena.berg) or Lena Sand (@lena.sand)?');
  assert.equal(searches(f.calls()).length, 0, 'never a guess');
  assert.equal(read.posts.length, 0);
});

test('C-CHAT: a person nobody is called is said as such, never an empty success', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'person', person: 'Zed', sides: 'theirs' }));
  assert.equal(read.notFound, 'I found nobody called Zed in the team chat.');
  const projected = projectMattermostResult(f.adapter, await f.reader.chat({ intent: 'person', person: 'Zed' }));
  assert.ok(projected.ok);
  assert.match(projected.projection.text, /^not found: I found nobody called Zed/mu);
});

// ---- person-overview ------------------------------------------------------------------------------------

test('C-CHAT person-overview: the direct messages, shared groups and shared channels in one read, with counts', async t => {
  const f = await setup(t, 'people');
  const from = fixtureDaysAgo(7);
  const result = await f.reader.chat({ intent: 'overview', person: 'Ada', from_date: from });
  const read = chatRead(result);
  assert.deepEqual(f.calls().find(call => call.name === 'mattermost_conversation_overview')?.arguments, { person: 'Ada', from_date: from, per_section_limit: 3 });
  const names = (read.sections ?? []).map(section => `${section.name}: ${section.counts}`);
  assert.ok(names.includes('direct messages: 17 posts'), names.join('; '));
  assert.ok(names.includes('group with kim.oak: 4 posts'), names.join('; '));
  assert.ok(names.some(name => name.startsWith('channel AI AI AI: you 1, Ada 1')), names.join('; '));
  assert.ok(read.posts.length > 0 && read.posts.length <= 5, 'a few anchor posts, newest first');
  assert.match(read.read, /^everything you and Ada Moss \(@ada\.moss\) exchanged since /u);
  const projected = projectMattermostResult(f.adapter, result);
  assert.ok(projected.ok);
  // R8-W9: every section's counts ride ONE summary line after the posts, because nine header lines spent
  // the whole voice cap and the posts they counted never reached the answer.
  const summary = projected.projection.text.split('\n').filter(line => line.startsWith('- '));
  assert.equal(summary.length, 1, 'the counts are one summary line, never one line per conversation');
  assert.match(summary[0]!, /^- direct messages: 17 posts, last \d{4}-\d{2}-\d{2}; /u);
  assert.match(summary[0]!, /; group with kim\.oak: 4 posts/u);
  assert.ok(projected.projection.text.match(/^\*\*/mu), 'the posts lead, the line headed `**channel | role | age**`');
});

test('C-CHAT person-overview: an ambiguous name is the child refusal turned into the question', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'overview', person: 'Lena' }));
  assert.equal(read.clarify, 'Which Lena do you mean: Lena Berg (@lena.berg) or Lena Sand (@lena.sand)?');
});

// ---- channel-recent ---------------------------------------------------------------------------------------

test('C-CHAT channel-recent: "Builders and Friends" is the channel "Builder & Friends", read in its window', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'channel', channel: 'Builders and Friends' }));
  // F4: the child folds case and "&", never plurals, so the spoken words rank first and an inflection only
  // the fold can resolve earns one retry with the folded key.
  assert.deepEqual(f.calls().filter(call => call.name === 'mattermost_list_channels').map(call => call.arguments), [
    { query: 'Builders and Friends', types: ['O', 'P'], limit: 10 },
    { query: 'builder and friend', types: ['O', 'P'], limit: 10 },
  ], 'the spoken words first, then the folded key on a miss');
  assert.deepEqual(searches(f.calls()), [{ query: '', mode: 'keyword', limit: 8, sort: 'newest', channel: BUILDER_FRIENDS, from_date: daysAgo(30) }]);
  assert.match(read.read, /^the channel Builder & Friends since /u);
  assert.equal(read.total, 2);
});

test('C-CHAT channel-recent: "builder" reads the channel of that name and says which, never the one with more words', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'channel', channel: 'builder' }));
  assert.equal(searches(f.calls())[0]?.['channel'], BUILDERS);
  assert.match(read.read, /^the channel Builders since /u);
});

test('C-CHAT channel-recent: a name that fits several channels is a question naming them', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'channel', channel: 'Eng' }));
  assert.equal(read.clarify, 'Which channel do you mean: Eng - General or Eng - Security?');
  assert.equal(searches(f.calls()).length, 0);
});

// ---- group-chat -------------------------------------------------------------------------------------------

test('C-CHAT group-chat: the group whose members are exactly the people named, among the groups they share', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'group', people: ['Ada', 'Kim'] }));
  assert.deepEqual(f.calls().filter(call => call.name === 'mattermost_resolve_person').map(call => call.arguments['name']), ['Ada', 'Kim']);
  assert.deepEqual(f.calls().find(call => call.name === 'mattermost_list_channels')?.arguments, { types: ['G'], member: 'ada.moss', sort: 'recent', limit: 200 });
  assert.equal(searches(f.calls())[0]?.['channel'], GROUP_ADA_KIM);
  assert.match(read.read, /^the group chat with ada\.moss and kim\.oak since /u);
  assert.equal(read.total, 4);
});

// ---- attachment text --------------------------------------------------------------------------------------

test('C-CHAT (L4-10): a webhook post with no message shows its attachment text in search and in a chat read', async t => {
  const f = await setup(t, 'people');
  const search = await f.reader.search({ query: 'build' });
  assert.equal(search.state, 'completed');
  const shaped = projectMattermostResult(f.adapter, search);
  assert.ok(shaped.ok);
  assert.match(shaped.projection.text, /Build 42 passed on main/u);
  const read = chatRead(await f.reader.chat({ intent: 'channel', channel: 'Builders' }));
  assert.ok(read.posts.some(post => post.text === 'Build 42 passed on main'), 'the attachment-only post is kept, with its text');
});

// ---- attention --------------------------------------------------------------------------------------------

test('C-CHAT (L4-04, L4-11): attention reads the conversations that moved, newest first, and windows its own searches', async t => {
  const f = await setup(t, 'people');
  const result = await f.reader.attention({});
  assert.equal(result.state, 'completed');
  const view = (result as { decodedResult: unknown }).decodedResult as MattermostAttention;
  const calls = f.calls();
  assert.deepEqual(calls.find(call => call.name === 'mattermost_list_channels')?.arguments, { types: ['D', 'G'], sort: 'recent', limit: 10 });
  const read = searches(calls).map(args => String(args['channel'] ?? args['query']));
  assert.ok(read.includes(ADA_DM), 'the active direct messages are read although their id sorts last');
  for (const args of searches(calls).filter(args => String(args['query']).startsWith('from:') || String(args['query']).startsWith('@'))) {
    assert.equal(args['mode'], 'keyword');
    assert.equal(args['sort'], 'newest');
    assert.equal(args['from_date'], fixtureDaysAgo(7));
  }
  assert.ok(view.items.some(item => item.reason === 'dm' && item.author === 'ada.moss'));
  assert.equal(view.missing, undefined);
});

test('C-CHAT: attention on a child without channel recency skips that leg and says so, never the first few in list order', async t => {
  const f = await setup(t, 'legacy');
  const result = await f.reader.attention({});
  const view = (result as { decodedResult: unknown }).decodedResult as MattermostAttention;
  assert.equal(view.missing, 'direct messages by recency need the newer chat archive');
  assert.equal(f.calls().some(call => call.name === 'mattermost_get_channel_history'), false);
  const projected = projectMattermostResult(f.adapter, result);
  assert.ok(projected.ok);
  assert.match(projected.projection.text, /^note: direct messages by recency need the newer chat archive$/mu);
});

// ---- the child as installed before the person reads -------------------------------------------------------

test('C-CHAT legacy: a username reads the direct messages and the reply says person lookups need the newer archive', async t => {
  const f = await setup(t, 'legacy');
  const found = chatRead(await f.reader.chat({ intent: 'person', person: '@ada.moss', sides: 'theirs' }));
  assert.equal(found.missing, 'person lookups by name need the newer chat archive');
  assert.equal(searches(f.calls())[0]?.['channel'], ADA_DM);
  assert.equal(searches(f.calls())[0]?.['author'], 'ada.moss');
  const named = chatRead(await f.reader.chat({ intent: 'person', person: 'Ada', sides: 'theirs' }));
  assert.equal(named.notFound, 'I found no direct messages with a user named Ada.');
  assert.equal(named.missing, 'person lookups by name need the newer chat archive');
});

test('C-CHAT legacy: a channel resolves through the one channel index with the same strict rule', async t => {
  const f = await setup(t, 'legacy');
  const read = chatRead(await f.reader.chat({ intent: 'channel', channel: 'Builders and Friends' }));
  assert.deepEqual(f.calls().find(call => call.name === 'mattermost_list_channels')?.arguments, {});
  assert.equal(searches(f.calls())[0]?.['channel'], BUILDER_FRIENDS);
  assert.equal(read.missing, undefined);
});

// ---- R8-W9: what was said, the person's DM, the name's edge, and the product's spoken name -----------------

const ALEX_DM = 'chanDAlex0000000000000000a';

/** A roster with two colleagues: Alex (a direct conversation exists) and Tess (none does). */
function roster(): PeopleSnapshot {
  return parsePeople({
    version: 1,
    people: [
      { id: 'alex-ray', name: 'Alex Ray', aliases: ['Alex'], role: 'Engineer', circle: 'plantix', tier: 1, email: ['alex@example.invalid'], mattermost: 'alex.ray' },
      { id: 'tess-wren', name: 'Tess Wren', aliases: ['Tess'], role: 'Designer', circle: 'plantix', tier: 1, email: ['tess@example.invalid'], mattermost: 'tess.wren' },
    ],
  });
}

test('R8-W9: a roster person with an existing direct conversation reads it, never "no direct messages"', async t => {
  const f = await setup(t, 'people', undefined, { DIDI_FAKE_MATTERMOST_ALEX: 'yes' });
  installPeople(roster());
  t.after(() => installPeople(null));
  const read = chatRead(await f.reader.chat({ intent: 'person', person: 'Alex', sides: 'both' }));
  assert.equal(read.notFound, undefined);
  assert.doesNotMatch(read.read, /no direct messages/u);
  assert.equal(searches(f.calls())[0]?.['channel'], ALEX_DM, 'the existing DM channel, read only');
  assert.ok(read.posts.length > 0, 'the conversation holds posts');
});

test('R8-W9 (F1): a roster person without a direct conversation says so only after the lookup, and reads their mentions instead', async t => {
  const f = await setup(t, 'people');
  installPeople(roster());
  t.after(() => installPeople(null));
  const read = chatRead(await f.reader.chat({ intent: 'person', person: 'Tess', sides: 'both' }));
  assert.ok(f.calls().some(call => call.name === 'mattermost_list_channels'), 'the DM lookup ran before the answer');
  assert.equal(searches(f.calls())[0]?.['query'], '@tess.wren', 'their mentions, because no direct conversation exists');
  assert.equal(searches(f.calls())[0]?.['channel'], undefined, 'mentions live in every channel, never a DM');
  assert.match(read.read, /^posts mentioning Tess Wren \(@tess\.wren\) in every channel, because you have no direct messages with them/u);
  assert.doesNotMatch(read.read, /ask for their mentions/u, 'the mentions are already what was read');
});

test('R8-W9 (F2): the owner\'s display name goes with the handle, word by word, and only their own words go', () => {
  assert.equal(withoutOwner('pilot Robert Smith', 'owner-chat', 'Robert Smith'), 'pilot', 'the whole name is the owner');
  assert.equal(withoutOwner('pilot owner-chat', 'owner-chat', 'Robert Smith'), 'pilot', 'the handle too');
  assert.equal(withoutOwner('smith street pilot', 'owner-chat', 'Robert Smith'), 'street pilot', 'a shared surname is the owner\'s word and goes; other words stay');
  assert.equal(withoutOwner('pilot', 'owner-chat@example.invalid', 'Robert Smith'), 'pilot', 'the part before any @ is the handle');
  assert.equal(withoutOwner('pilot', '', ''), 'pilot', 'no identity, nothing dropped');
});

test('R8-W9: the owner\'s own handle never becomes a chat search term', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'person', person: 'Ada', sides: 'both', query: 'pilot owner-chat' }));
  assert.equal(searches(f.calls())[0]?.['query'], 'pilot', 'the handle is dropped, the topic stays');
  assert.doesNotMatch(read.read, /owner-chat/u);
});
// ---- W2B-R1, W2B-R2: the install route and its reverse, measured at a Live session acceptance ---------------
// The reviewer's W2b probe (B1, B2) lifted as the acceptance test: editing mcp.json alone must move the
// Mattermost connection, a run must hold only the new connection's tools, and the reverse edit must work.
import { chmod as probeChmod, mkdir as probeMkdir } from 'node:fs/promises';
import { writeFileSync as probeWrite } from 'node:fs';
import { randomUUID as probeUuid } from 'node:crypto';
import { Server as ProbeMcpServer, WebStandardStreamableHTTPServerTransport as ProbeTransport } from '@modelcontextprotocol/server';
import { Store as ProbeStore } from '../runtime/store.js';
import { toolsMigrations as probeMigrations } from '../tools/schema.js';
import { composeMcpRuntime as probeCompose } from '../host/mcp.js';
import type { RunAcceptance as ProbeAcceptance } from '../tools/types.js';

test('C-CHAT (W2B-R1, W2B-R2): the mcp.json edit alone moves the connection, and the reverse edit moves it back', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-w2b-move-'));
  const configDir = join(dir, 'provider-config');
  await probeMkdir(configDir, { recursive: true, mode: 0o700 });
  const servers = new Map<string, { sdk: ProbeMcpServer; transport: ProbeTransport }>();
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const server = servers.get(path);
    assert.ok(server, `a fake child answers ${path}`);
    return server.transport.handleRequest(new Request(input, init));
  });
  let store = new ProbeStore(join(dir, 'data'), probeMigrations);
  let runtime: Awaited<ReturnType<typeof probeCompose>> | undefined;
  t.after(async () => {
    await runtime?.close();
    for (const { sdk, transport } of servers.values()) { await sdk.close(); await transport.close(); }
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  // One restart: a fresh store over the same data dir, so every durable row survives the edit.
  const start = async (endpoints: readonly { id: string; path: string; enabled: boolean; allowEgress?: boolean }[], tools: Record<string, readonly string[]>, writeConfig = true) => {
    if (runtime) { await runtime.close(); store.close(); store = new ProbeStore(join(dir, 'data'), probeMigrations); }
    for (const { sdk, transport } of servers.values()) { await sdk.close(); await transport.close(); }
    servers.clear();
    for (const [path, names] of Object.entries(tools)) {
      const sdk = new ProbeMcpServer({ name: 'synthetic-mattermost', version: '1' }, { capabilities: { tools: {} } });
      const transport = new ProbeTransport({ sessionIdGenerator: () => probeUuid(), enableJsonResponse: true });
      sdk.setRequestHandler('tools/list', () => ({ tools: [...names, 'mattermost_post_message'].map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } })) }) as never);
      sdk.setRequestHandler('tools/call', () => ({ content: [{ type: 'text', text: JSON.stringify({ username: 'synthetic-owner', email: 'owner@example.invalid' }) }] }) as never);
      await sdk.connect(transport);
      servers.set(path, { sdk, transport });
    }
    const config = join(configDir, 'mcp.json');
    if (!writeConfig) rmSync(config, { force: true });
    else { probeWrite(config, JSON.stringify({
      schemaVersion: 1, grantMode: 'owner-trusted-reads',
      endpoints: endpoints.map(endpoint => ({ id: endpoint.id, connector: 'mattermost', transport: 'streamable-http', url: `http://127.0.0.1:18766${endpoint.path}`, account: 'mattermost', resource: 'mattermost', credentialRef: null, enabled: endpoint.enabled, allowEgress: endpoint.allowEgress ?? true, unknownClass: 'private' })),
    })); await probeChmod(config, 0o600); }
    runtime = await probeCompose({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null });
    await runtime.start();
    return runtime;
  };
  const owner = (composition: NonNullable<typeof runtime>) => composition.owner as unknown as { durableConnectionIds(tx: unknown): string[]; snapshotRun(tx: unknown, acceptance: ProbeAcceptance): unknown; liveDefinitions(runId: string, remember: () => { remembered: boolean; code: string }): { name: string }[] };
  // Exactly what server/live/index.ts #connectionIds computes at session acceptance (live/index.ts:3123-3126).
  const acceptanceIds = (composition: NonNullable<typeof runtime>): string[] => store.transaction(tx => [...new Set([...composition.connectionIds(), ...owner(composition).durableConnectionIds(tx)])]);
  const compose = (composition: NonNullable<typeof runtime>, ids: string[], runId: string): string[] => {
    const acceptance: ProbeAcceptance = {
      ownerId: store.assistantId, actorId: 'synthetic-actor', runId, authorityEpoch: store.authorityEpoch, revision: 1,
      route: { identity: 'gateway:live-voice', provider: 'gemini', modelId: 'models/synthetic', allowedClasses: ['ordinary', 'private'] },
      allowedClasses: ['ordinary', 'private'], connectionIds: ids,
    };
    store.transaction(tx => owner(composition).snapshotRun(tx, acceptance));
    return composition.owner.taskBindings(ids).flatMap(binding => connectorDescriptor(binding.connector)?.declarations(binding.policy).map(tool => tool.name) ?? []);
  };
  const states = (composition: NonNullable<typeof runtime>): string[] => composition.status().endpoints.map(endpoint => `${endpoint.id}:${endpoint.state}`);

  await start([{ id: 'mattermost', path: '/old', enabled: true }], { '/old': MATTERMOST_TOOLS });
  // The install route: the old entry is deleted from mcp.json and the new id is added in its place.
  const moved = await start([{ id: 'mattermost-people', path: '/people', enabled: true }], { '/people': MATTERMOST_READ_TOOLS });
  const movedIds = acceptanceIds(moved);
  assert.deepEqual(movedIds, ['mattermost-people'], 'the run holds the new connection alone: the deleted entry survives no durable row');
  const names = compose(moved, movedIds, 'install-run');
  assert.ok(names.includes('mattermost_chat'), 'the run composes its tools: a second mattermost connection would throw ambiguous_model_tool_name');
  assert.deepEqual(states(moved), ['mattermost-people:connected'], 'a deleted entry is never a connection report');
  assert.ok(moved.owner.taskBindings(movedIds).some(binding => binding.connector === 'mattermost'), 'the accepted connection remains available to the task path');

  // The other disabled shape the review measured: the old entry kept in the file with enabled false.
  const kept = await start([{ id: 'mattermost', path: '/old', enabled: false }, { id: 'mattermost-people', path: '/people', enabled: true }], { '/people': MATTERMOST_READ_TOOLS });
  const keptIds = acceptanceIds(kept);
  assert.deepEqual(keptIds, ['mattermost-people'], 'a disabled entry is a retired connection, whatever the durable row says');
  assert.ok(compose(kept, keptIds, 'disabled-run').includes('mattermost_chat'));
  assert.deepEqual(states(kept), ['mattermost-people:connected'], 'a disabled entry is never reported connecting, so the chat source stays readable');
  assert.ok(kept.owner.taskBindings(keptIds).some(binding => binding.connector === 'mattermost'), 'the accepted connection remains available to the task path');

  // The reverse edit: the new entry is deleted and the old one restored, and the same run holds it again.
  const back = await start([{ id: 'mattermost', path: '/old', enabled: true }], { '/old': MATTERMOST_TOOLS });
  const backIds = acceptanceIds(back);
  assert.deepEqual(backIds, ['mattermost'], 'a stored row whose id is enabled in the file stays active, and the removed id retires');
  assert.ok(compose(back, backIds, 'rollback-run').includes('mattermost_chat'));
  assert.deepEqual(states(back), ['mattermost:connected']);
  assert.ok(back.owner.taskBindings(backIds).some(binding => binding.connector === 'mattermost'), 'the accepted connection remains available to the task path');

  // The reviewer's traps: a missing catalog says nothing about connections, so it retires nothing, and an
  // entry that exists and is enabled is never retired even when it cannot leave the host.
  const missing = await start([], {}, false);
  assert.deepEqual(acceptanceIds(missing), ['mattermost', 'mattermost-people'], 'a missing mcp.json retires nothing');
  assert.deepEqual(states(missing), []);
  const noEgress = await start([{ id: 'mattermost', path: '/old', enabled: true, allowEgress: false }], { '/old': MATTERMOST_TOOLS });
  assert.deepEqual(acceptanceIds(noEgress), ['mattermost'], 'an enabled entry stays active with no egress, and the deleted one stays retired');
});

for (const [channel, phrase] of [['eng', /Which channel do you mean/u], ['synthetic-missing-channel', /not found/u]] as const) {
  test(`C-STEADY104: channel ${channel} returns a completed speakable empty read`, async t => {
    const f = await setup(t, 'people');
    const result = await f.reader.chat({ intent: 'channel', channel, limit: 8 });
    assert.equal(result.state, 'completed');
    if (result.state !== 'completed') return;
    const projection = projectMattermostResult(f.adapter, result);
    assert.equal(projection.ok, true);
    if (!projection.ok) return;
    assert.equal(projection.projection.shape, 'empty');
    assert.match(projection.projection.text, phrase);
    assert.equal(projection.projection.itemCount, 0);
  });
}

// Night-shift regression: a channel index from an earlier call is not evidence for an overview.
test('overview does not import channel-index dispatches from an unrelated earlier read', async t => {
  const f = await setup(t, 'people');
  const call = f.adapter.call.bind(f.adapter);
  let dispatch = 0;
  f.adapter.call = async (...args) => {
    const result = await call(...args);
    if (result.state === 'completed') result[SOURCE_DISPATCH] = { id: `synthetic-${++dispatch}` };
    return result;
  };
  assert.equal((await f.reader.getChannelHistory({ channel: 'Builders', limit: 5 })).state, 'completed');
  const result = await f.reader.chat({ intent: 'overview', person: 'Ada', from_date: fixtureDaysAgo(7) });
  const read = chatRead(result);
  assert.ok(read.posts.length > 0);
  // Identity and overview are the only children used by this call.
  assert.equal(result.state === 'completed' ? result[SOURCE_CHILD_DISPATCHES]?.length : undefined, 2);
});

test('recency person reads use empty query and do not inherit a channel', async t => {
  const f = await setup(t, 'people');
  for (const query of ['latest messages', 'recent messages', 'what did we discuss', 'today', 'yesterday']) {
    const read = chatRead(await f.reader.chat({ intent: 'person', person: 'Ada', query, channel: 'unrelated-channel', from_date: fixtureDaysAgo(7) }));
    assert.ok(read.posts.length > 0, query);
    const search = f.calls().filter(call => call.name === 'mattermost_search').at(-1)!;
    assert.equal(search.arguments['query'], '');
    assert.equal(search.arguments['channel'], ADA_DM);
    assert.equal(search.arguments['sort'], 'newest');
  }
});

test('F5a: an empty topic read retries the same conversation unfiltered, once, never by relevance', async t => {
  const f = await setup(t, 'people');
  // A topic word the fake archive has never seen: the keyword read matches nothing.
  const read = chatRead(await f.reader.chat({ intent: 'person', person: 'Ada', query: 'zzsyntheticnotopic', from_date: fixtureDaysAgo(7) }));
  const searchCalls = searches(f.calls());
  assert.ok(read.posts.length > 0);
  assert.equal(searchCalls.length, 2);
  assert.equal(searchCalls[0]?.['mode'], 'keyword');
  assert.equal(searchCalls[1]?.['mode'], 'keyword', 'the second read is keyword too: relevance is never a substitute for order');
  assert.equal(searchCalls[1]?.['query'], '');
  assert.equal(searchCalls[1]?.['channel'], ADA_DM);
  assert.equal(searchCalls[1]?.['from_date'], fixtureDaysAgo(7));
  assert.equal(searchCalls[1]?.['sort'], 'newest');
  assert.match(read.read, /fallback: recent_unfiltered/u);
});

// Synthetic tools/list recording supplied with C-CHAT, retrieved 2026-10-29.
// Deliberately independent of Didi's declarations: unsupported argument names fail closed.
const recordedMattermostToolsList = {
  retrievedOn: '2026-10-29',
  tools: [{ name: 'mattermost_search', inputSchema: { type: 'object', properties: {
    query: { type: 'string' }, author: { type: 'string' }, channel: { type: 'string' },
    from_date: { type: 'string' }, to_date: { type: 'string' }, replies_to: { type: 'string' },
    limit: { type: 'integer' }, offset: { type: 'integer' }, sort: { type: 'string' },
    mode: { type: 'string' }, rerank: { type: 'boolean' }, format: { type: 'string' },
  } } }, {
    // CA-R2: the newer child's thread list, so the drift gate covers the read that lists topics.
    name: 'mattermost_list_threads', inputSchema: { type: 'object', properties: {
      channel_id: { type: 'string' }, channel_name: { type: 'string' }, dm_username: { type: 'string' },
      since: { type: 'string' }, until: { type: 'string' }, query: { type: 'string' },
      limit: { type: 'integer' }, order: { type: 'string' },
    } },
  }],
};

test('Mattermost declared child argument schemas match the recorded binary tools/list', () => {
  const policy = { bounds: { maxQueryChars: 200, maxSearchLimit: 50, maxGetIds: 10, maxEntityBytes: 1024, maxResultBytes: 1024 } };
  const declared = connectorDescriptor('mattermost')!.declarations(policy as never);
  const check = (properties: Record<string, unknown>, binary: Record<string, { type: string }>) => {
    for (const [key, schema] of Object.entries(properties)) {
      assert.ok(key in binary, `binary does not accept ${key}`);
      assert.equal((schema as { type: string }).type, binary[key]!.type, key);
    }
  };
  for (const recorded of recordedMattermostToolsList.tools) {
    const tool = declared.find(tool => tool.name === recorded.name)!;
    const properties = tool.parameters.properties as Record<string, unknown>;
    check(properties, recorded.inputSchema.properties);
    const drift = { ...properties, after: { type: 'string' } };
    assert.throws(() => check(drift, recorded.inputSchema.properties), /binary does not accept after/u);
  }
});

test('plain topic searches also retry broader once and disclose hybrid to the model', async t => {
  const f = await setup(t, 'people', undefined, { DIDI_FAKE_MATTERMOST_NIGHT: 'yes' });
  const result = await f.reader.search({ query: 'deploying', channel: 'Alpha Alpha Alpha', from_date: fixtureDaysAgo(7) } as never);
  const projected = projectMattermostResult(f.adapter, result);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.match(projected.projection.text, /deployed sandbox/u);
  assert.match(projected.projection.text, /hybrid/u);
  const calls = searches(f.calls());
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.['mode'], 'hybrid');
  assert.equal(calls[1]?.['from_date'], fixtureDaysAgo(7));
});

test('a refused broader chat read is a refusal, never a false empty success', async t => {
  const f = await setup(t, 'people');
  const call = f.adapter.call.bind(f.adapter);
  // F5a: the broader read is the unfiltered recent read of the same conversation, and its refusal is the answer.
  f.adapter.call = (request, signal) => request.arguments['query'] === '' ? Promise.resolve({ state: 'refused', reason: 'read-grant-missing' }) : call(request, signal);
  const result = await f.reader.chat({ intent: 'person', person: 'Ada', query: 'sandboxing', from_date: fixtureDaysAgo(7) });
  assert.equal(result.state, 'refused');
  assert.equal('reason' in result && result.reason, 'read-grant-missing');
});

// C-RESIDUE: newer shared traffic must not evict the person's direct discussion.
test('C-RESIDUE overview keeps DM anchors ahead of newer shared traffic', async t => {
  const f = await setup(t, 'people', undefined, { DIDI_FAKE_DM_RESIDUE: '1' });
  const read = chatRead(await f.reader.chat({ intent: 'overview', person: 'Ada', from_date: fixtureDaysAgo(7) }));
  assert.equal(read.posts.length, 5);
  assert.match(JSON.stringify(read.posts[0]), /Synthetic direct discussion/u);
  assert.match(JSON.stringify(read.sections), /94 posts/u);
  assert.match(JSON.stringify(read.posts[1]), /Group update 1/u);
  assert.match(JSON.stringify(read.posts[4]), /Channel update 4/u);
});

test('F5a (O-A1): a later page of a 0-hit topic read is an honest gap, never a second fallback', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'person', person: 'Ada', query: 'zzsyntheticnotopic', limit: 3, offset: 3 }));
  const calls = searches(f.calls());
  assert.equal(calls.length, 1, 'a later page searched once: no fallback');
  const page = calls.at(-1)!;
  assert.equal(page['query'], 'zzsyntheticnotopic', 'the later page keeps the topic it was asked for');
  assert.equal(page['offset'], 3, 'and its own offset');
  assert.equal(read.returned, 0, 'an empty later page is reported as empty');
  assert.equal(read.posts.length, 0);
});

// ---- F5: order, the recent-unfiltered fallback, and one thread ------------------------------------------

test('F5b: order oldest is refused honestly when the child cannot walk from the oldest end', async t => {
  const f = await setup(t, 'people');
  // An older child: its sort enum offers newest only, so an ascending walk is impossible and must be refused.
  const visible = f.adapter.visibleTools.bind(f.adapter);
  f.adapter.visibleTools = (id: string) => visible(id).map(tool => tool.name !== 'mattermost_search' ? tool : {
    ...tool,
    inputSchema: { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties ?? {}), sort: { type: 'string', enum: ['relevance', 'newest'] } } },
  });
  const result = await f.reader.chat({ intent: 'person', person: 'Ada', sides: 'both', order: 'oldest' });
  assert.equal(result.state, 'refused');
  assert.equal((result as { reason: string }).reason, 'order-unsupported');
  const newest = chatRead(await f.reader.chat({ intent: 'person', person: 'Ada', sides: 'both', order: 'newest' }));
  assert.equal(searches(f.calls()).at(-1)?.['sort'], 'newest');
  assert.equal(newest.posts.length > 0, true);
});

test('F5b: an unknown order is refused before any read', async t => {
  const f = await setup(t, 'people');
  const result = await f.reader.chat({ intent: 'person', person: 'Ada', order: 'synthetic' as never });
  assert.equal(result.state, 'refused');
  assert.equal(searches(f.calls()).length, 0);
});

test('F5c: a thread read returns the whole thread in chronological order through the child thread read', async t => {
  const f = await setup(t, 'people');
  // The root post id comes from an earlier result, which is how the model gets one.
  const earlier = chatRead(await f.reader.chat({ intent: 'channel', channel: 'AI AI AI' }));
  const rootId = earlier.posts[0]!.id;
  const read = chatRead(await f.reader.chat({ intent: 'thread', post_id: rootId }));
  const threadCalls = f.calls().filter(call => call.name === 'mattermost_get_thread').map(call => call.arguments);
  assert.deepEqual(threadCalls[0], { post_id: rootId }, 'the first page is the root id from the earlier result');
  assert.equal(read.posts.length > 1, true, 'the root and its replies');
  const times = read.posts.map(post => Date.parse(post.time));
  assert.deepEqual(times, [...times].sort((left, right) => left - right), 'chronological, oldest first');
  const refused = await f.reader.chat({ intent: 'thread' });
  assert.equal(refused.state, 'refused');
  assert.equal((refused as { reason: string }).reason, 'thread-needs-post-id-or-topic');
});

test('F5b: order oldest walks the conversation ascending when the child accepts it, page by page', async t => {
  const f = await setup(t, 'people');
  const first = chatRead(await f.reader.chat({ intent: 'person', person: 'Ada', sides: 'both', order: 'oldest', limit: 3 }));
  const calls = searches(f.calls());
  assert.equal(calls[0]?.['sort'], 'oldest', 'the child is asked for the order the owner asked for');
  const times = first.posts.map(post => Date.parse(post.time));
  assert.deepEqual(times, [...times].sort((left, right) => left - right), 'oldest first');
  const second = chatRead(await f.reader.chat({ intent: 'person', person: 'Ada', sides: 'both', order: 'oldest', limit: 3, offset: 3 }));
  assert.deepEqual(searches(f.calls()).at(-1)?.['offset'], 3, 'the next page starts where the last ended');
  const later = second.posts.map(post => Date.parse(post.time));
  assert.ok(later.every(time => Number.isFinite(time)));
  assert.ok(first.posts.length > 0 && second.posts.length > 0);
  const head = Date.parse(first.posts[0]!.time);
  const tail = Date.parse(second.posts[0]!.time);
  assert.ok(head <= tail || second.posts.length === 0, 'the second page continues forward in time');
});

test('F5c: a thread about a topic in a direct conversation is the newest matching post and its thread', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'thread', person: 'Ada', query: 'pilot' }));
  const listed = f.calls().filter(call => call.name === 'mattermost_list_threads').map(call => call.arguments);
  assert.equal(listed.at(-1)?.['channel_id'] ?? listed.at(-1)?.['dm_username'], ADA_DM, 'the topic is looked up inside that direct conversation');
  assert.equal(listed.at(-1)?.['query'], 'pilot');
  const asked = f.calls().filter(call => call.name === 'mattermost_get_thread').map(call => call.arguments);
  assert.ok(asked.length >= 1, 'the thread is read');
  assert.equal(typeof asked[0]?.['post_id'], 'string', 'its root is the id the matching post carried');
  const times = read.posts.map(post => Date.parse(post.time));
  assert.deepEqual(times, [...times].sort((left, right) => left - right), 'the whole thread comes back oldest first');
  assert.ok(read.posts.length > 0, 'the thread holds the root and its replies');
  assert.match(read.read, /thread/u);
});

test('F5c: a thread about a topic in a named channel uses that channel, and one conversation is required', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'thread', channel: 'Builders', query: 'pilot' }));
  const listed = f.calls().filter(call => call.name === 'mattermost_list_threads').map(call => call.arguments);
  assert.equal(listed.at(-1)?.['query'], 'pilot');
  assert.equal(listed.at(-1)?.['channel_id'], BUILDERS, 'the channel the owner named, not another one');
  assert.ok(read.posts.length > 0);
  const neither = await f.reader.chat({ intent: 'thread', query: 'pilot' });
  assert.equal(neither.state, 'refused');
  assert.equal((neither as { reason: string }).reason, 'thread-needs-conversation');
  const noTopic = await f.reader.chat({ intent: 'thread', person: 'Ada' });
  assert.equal((noTopic as { reason: string }).reason, 'thread-needs-post-id-or-topic');
});

// ---- CA-R2: the owner's two-step ask: the topics of one conversation, then one thread whole ----------------

test('CA-R2: topics lists a channel\'s threads with counts and dates, newest activity first', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'topics', channel: 'AI AI AI' }));
  const listed = f.calls().filter(call => call.name === 'mattermost_list_threads').map(call => call.arguments);
  assert.equal(listed.length, 1, 'one thread list for one conversation');
  assert.deepEqual([listed[0]?.['order'], typeof listed[0]?.['since']], ['activity', 'string'], 'newest activity first, inside the window');
  assert.ok(Array.isArray(read.topics) && read.topics.length > 0, 'the topics reach the reply');
  const first = read.topics![0]!;
  assert.equal(typeof first.rootId, 'string');
  assert.ok(first.rootId !== '', 'every topic names the root id the thread read takes');
  assert.equal(typeof first.replies, 'number');
  assert.ok(Number.isFinite(Date.parse(first.createdAt)), 'a topic carries its date');
  assert.ok(first.preview.length > 0, 'and one line of what it is about');
  assert.match(read.read, /^the topics in the channel AI AI AI/u);
});

test('CA-R2: topics lists a direct conversation\'s threads by the username the roster knows', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'topics', person: 'Ada' }));
  const listed = f.calls().filter(call => call.name === 'mattermost_list_threads').map(call => call.arguments);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.['channel_id'] ?? listed[0]?.['dm_username'], ADA_DM, 'the direct conversation, not a channel');
  assert.ok((read.topics ?? []).length > 0);
  assert.match(read.read, /^the topics in direct messages with/u);
});

test('CA-R2: a thread read by the root id a topic list carried returns it whole, paged to the end', async t => {
  const f = await setup(t, 'people');
  const listed = chatRead(await f.reader.chat({ intent: 'topics', channel: 'AI AI AI' }));
  const rootId = listed.topics![0]!.rootId;
  const read = chatRead(await f.reader.chat({ intent: 'thread', post_id: rootId }));
  const pages = f.calls().filter(call => call.name === 'mattermost_get_thread').map(call => call.arguments);
  assert.ok(pages.length > 1, 'a long thread is read page by page');
  assert.deepEqual(pages[0], { post_id: rootId }, 'the first page is the root and its first replies');
  assert.equal(typeof pages[1]?.['cursor'], 'string', 'the next page is asked for by the cursor the child returned');
  assert.equal(read.posts.length, 1 + 6, 'the whole thread: the root and every reply, not the first page');
  const times = read.posts.map(post => Date.parse(post.time));
  assert.deepEqual(times, [...times].sort((left, right) => left - right), 'root first, then ascending');
});

test('CA-R2: a thread by keyword uses the thread list, and no topics in the window answers honestly', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'thread', channel: 'AI AI AI', query: 'model' }));
  const listed = f.calls().filter(call => call.name === 'mattermost_list_threads').map(call => call.arguments);
  assert.equal(listed.length, 1, 'the keyword goes to the thread list, not to a post search');
  assert.equal(listed[0]?.['query'], 'model');
  assert.ok(read.posts.length > 0);
  const empty = chatRead(await f.reader.chat({ intent: 'topics', channel: 'AI AI AI', query: 'zzsyntheticnotopic' }));
  assert.equal(empty.notFound, 'No thread in the channel AI AI AI is about zzsyntheticnotopic.');
  assert.deepEqual(empty.topics ?? [], [], 'an empty window lists nothing rather than inventing a topic');
});


for (const [name, args] of [
  ['chat_person', { person: 'Ada', sides: 'both' }],
  ['chat_channel', { channel: 'AI AI AI' }],
  ['chat_group', { people: ['Ada', 'Kim'] }],
  ['chat_overview', { person: 'Ada' }],
  ['chat_person_topics', { person: '@ada.moss' }],
  ['chat_channel_topics', { channel: 'AI AI AI' }],
] as const) {
  test(`R29 ${name} reaches its existing native SDK read with explicit typed arguments`, async t => {
    const f = await setup(t, 'people');
    const task = taskChatReader(f.adapter, f.registry, { ...f.config, credentialRef: null }, f.discovery.schemaDigest, f.names);
    const before = f.calls().length;
    const result = await task.call(name, { ...args, from_date: '2026-09-01', to_date: '2026-10-26' });
    assert.notEqual(result.status, 'failed', JSON.stringify(result));
    assert.ok(result.text);
    assert.equal(task.tools.get(name)?.outside_text, true);
    assert.ok(f.calls().length > before, 'the Native SDK actually read, not an invented local response');
    assert.equal(f.calls().some(call => call.name === 'mattermost_chat'), false, 'the composite is not sent as a fictional child API');
  });
}


test('R29 the native topics validator agrees with its published schema and still requires a conversation', async t => {
  const f = await setup(t, 'people');
  const task = taskChatReader(f.adapter, f.registry, { ...f.config, credentialRef: null }, f.discovery.schemaDigest, f.names);
  const declaration = connectorDescriptor('mattermost')!.declarations(task.policy).find(tool => tool.name === 'mattermost_chat')!;
  assert.equal(declaration.validate({ intent: 'topics', person: 'Ada' }), true);
  assert.equal(declaration.validate({ intent: 'topics', channel: 'AI AI AI' }), true);
  assert.equal(declaration.validate({ intent: 'topics' }), false);
  assert.equal(declaration.validate({ intent: 'not-a-chat-capability', person: 'Ada' }), false);
});
