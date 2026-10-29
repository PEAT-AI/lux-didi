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
import { SOURCE_CHILD_DISPATCHES, type EndpointConfig } from '../adapters/mcp/port.js';
import {
  CONNECTOR_COMPOSED_TOOLS, composedGrantedNames, connectionEnvelope, createMattermostReader, nameKey,
  MATTERMOST_ATTENTION_TOOL, MATTERMOST_CHAT_TOOL, MATTERMOST_PERSON_TOOLS, MATTERMOST_READ_TOOLS, MATTERMOST_TOOLS, withoutOwner,
} from '../connectors/index.js';
import type { MattermostAttention, MattermostChatRead, MattermostReader, MattermostResult } from '../connectors/index.js';
import { projectMattermostResult } from '../tools/mattermost.js';
import { shapeMattermost } from '../tools/live-shape.js';
import { INTERNAL, type IntentSubCall, type IntentSubResult } from '../tools/intent.js';
import { ResearchLedger, runResearch, shapeBlock, type ResearchDeps } from '../tools/research.js';
import { chatAsk, chatIntent, chatWindow, spokenChannel } from '../tools/chat-intent.js';
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
  const reader = createMattermostReader({ port: adapter, registry, config: { endpointId: 'mattermost', account: ACCOUNT, resource: RESOURCE, schemaDigest: discovery.schemaDigest, generation: 1, maxLimit: 50, queryChars: 200, names: [...names, ...composedGrantedNames('mattermost', names)] } });
  const calls = (): Call[] => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Call) : [];
  return { adapter, registry, reader, calls, published, names };
}

function chatRead(result: MattermostResult): MattermostChatRead {
  assert.equal(result.state, 'completed', `the chat read completed: ${'reason' in result ? result.reason : ''}`);
  return (result as { decodedResult: unknown }).decodedResult as MattermostChatRead;
}

/** The research path bound to the real reader, the way the tools owner dispatches each sub-call. */
function researchDeps(f: Awaited<ReturnType<typeof setup>>, planned: IntentSubCall[] = []): ResearchDeps {
  const run = async (reader: MattermostReader, call: IntentSubCall): Promise<MattermostResult | undefined> => {
    const args = call.args as Record<string, unknown>;
    if (call.name === INTERNAL.chatRead) return reader.chat(args as never);
    if (call.name === INTERNAL.chatSearch) return reader.search(args as never);
    if (call.name === INTERNAL.chatAttention) return reader.attention(args as never);
    if (call.name === 'mattermost_get_thread') return reader.getThread({ postId: String(args['post_id']) });
    return undefined;
  };
  const execute = async (subs: readonly IntentSubCall[]): Promise<IntentSubResult[]> => Promise.all(subs.map(async call => {
    planned.push(call);
    const result = await run(f.reader, call);
    if (result === undefined) return { key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0 };
    if (result.state === 'refused' || result.state === 'unknown') return { key: call.key, name: call.name, ok: false, text: '', originalCharacters: 0, omittedCharacters: 0, code: result.reason };
    const projected = projectMattermostResult(f.adapter, result);
    const text = projected.ok ? projected.projection.text : '';
    return { key: call.key, name: call.name, ok: projected.ok, text, originalCharacters: text.length, omittedCharacters: 0 };
  }));
  return { now: () => FIXTURE_NOW, configured: ['chat'], execute, emit: () => {}, log: () => {}, ledger: new ResearchLedger(), timeZone: 'UTC' };
}

const searches = (calls: readonly Call[]) => calls.filter(call => call.name === 'mattermost_search').map(call => call.arguments);

// ---- envelope and grants ---------------------------------------------------------------------------------

test('C-CHAT: the read envelope carries the two person reads, never a write, and the composites stand on the base reads', () => {
  const envelope = connectionEnvelope('mattermost', { resource: RESOURCE });
  assert.deepEqual([...envelope], [...MATTERMOST_TOOLS, ...MATTERMOST_PERSON_TOOLS]);
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
  assert.deepEqual([...f.names].sort(), [...MATTERMOST_READ_TOOLS].sort(), 'the seven reads, and the write the child publishes stays out');
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

test('C-CHAT (AUD-002): the shaper leads a search with the archive count and the research header says 8 of 71', () => {
  const results = Array.from({ length: 8 }, (_, n) => ({ id: `p${n}`, username: 'kim.oak', channel: 'Builders', timestamp: `2026-10-2${n % 5}T10:00:00.000Z`, message: `note ${n}`, url: null }));
  const shaped = shapeMattermost('mattermost_search', { total: 71, returned: 8, results });
  assert.match(shaped.text, /^matched: 71\n/u);
  const block = shapeBlock('chat_search', [{ key: 'c0', name: 'mattermost_search', ok: true, text: shaped.text, originalCharacters: shaped.text.length, omittedCharacters: 0 }]);
  assert.equal(block.total, 71);
  assert.match(block.text, /^chat: 8 of 71 shown$/mu);
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
    assert.equal(args['from_date'], daysAgo(7));
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

// ---- the ask shapes -------------------------------------------------------------------------------------

test('C-CHAT (L1-01): a spoken channel name loses "named", "called", "team chat" and its articles', () => {
  assert.equal(spokenChannel('what is in the channel named AI AI AI'), 'AI AI AI');
  assert.equal(spokenChannel('what is in the AI AI AI team chat channel'), 'AI AI AI');
  assert.equal(spokenChannel("what's new in the AI AI AI team chat"), 'AI AI AI');
  assert.equal(spokenChannel('the channel is called Builders and Friends'), 'Builders and Friends');
  assert.equal(spokenChannel('messages in the channel AI AI AI'), 'AI AI AI');
  assert.equal(spokenChannel('what came in today'), undefined);
  assert.equal(nameKey('Builders and Friends'), nameKey('Builder & Friends'), 'L1-02: "and" is "&", a plural is its singular');
  assert.equal(nameKey('eng-general'), nameKey('Eng - General'));
  assert.notEqual(nameKey('builder'), nameKey('Builder & Friends'));
});

test('C-CHAT: the ask shapes pick person, overview, channel, group or topic', () => {
  const at = { terms: 'release checklist', nowMs: Date.parse('2026-10-25T09:00:00Z'), timeZone: 'UTC' };
  assert.deepEqual(chatIntent('what did Ada write me', at), { kind: 'person-said', person: 'Ada', sides: 'theirs', terms: '', window: {} });
  assert.deepEqual(chatIntent('read my DMs with Ada about the pilot plan', at), { kind: 'person-said', person: 'Ada', sides: 'both', terms: 'pilot plan', window: {} });
  assert.deepEqual(chatIntent('what did I discuss with Ada this week', at), { kind: 'person-overview', person: 'Ada', terms: '', window: { from: '2026-10-19' } });
  assert.deepEqual(chatIntent('my group chat with Ada and Kim', at), { kind: 'group-chat', people: ['Ada', 'Kim'], terms: '', window: {} });
  assert.deepEqual(chatIntent("what's new in the AI AI AI team chat", at), { kind: 'channel-recent', channel: 'AI AI AI', terms: '', window: {} });
  assert.deepEqual(chatIntent('did anyone mention the release checklist', at), { kind: 'topic-search', terms: 'release checklist', window: {} });
  assert.equal(chatAsk('what did Ada write me'), true);
  assert.equal(chatAsk('what did I discuss with Ada'), true);
  assert.equal(chatAsk('what did we say yesterday'), false, 'a pronoun is never a person');
});

test('C-CHAT (W2B-R5): a name nobody is called in a "news from" ask is a topic search, never name not found', async t => {
  const at = { terms: 'Bayer', nowMs: Date.parse('2026-10-25T09:00:00Z'), timeZone: 'UTC' };
  assert.deepEqual(chatIntent('news from Bayer', at), { kind: 'topic-search', terms: 'Bayer', window: {} });
  assert.equal(chatAsk('news from Bayer'), false, 'no person read for words that name a company');
  const f = await setup(t, 'people');
  const planned: IntentSubCall[] = [];
  const reply = await runResearch(researchDeps(f, planned), { action: 'start', question: 'news from Bayer', topic: 'Bayer' }, new AbortController().signal);
  assert.equal(planned.some(call => call.name === INTERNAL.chatRead), false, 'the ask stays a topic search');
  assert.doesNotMatch(JSON.stringify(reply), /I found nobody called/u);
});

test('C-CHAT (N-1): chat looks backwards; a future window names no chat window, "last week" names both ends', () => {
  const now = Date.parse('2026-10-25T09:00:00Z');
  assert.deepEqual(chatWindow('tell me about the conference next week', now, 'UTC'), { future: true });
  assert.deepEqual(chatWindow('what did Ada write last week', now, 'UTC'), { from: '2026-10-12', to: '2026-10-18' });
  assert.deepEqual(chatWindow('what came in yesterday', now, 'UTC'), { from: '2026-10-24', to: '2026-10-24' });
  assert.deepEqual(chatWindow('what did Kim say on monday', now, 'UTC'), { from: '2026-10-19', to: '2026-10-19' });
});

// ---- evals: the research path end to end, judged on the child calls and the evidence in the reply ---------

test('CHAT-A1 (AUD-001): "what did Ada write me" reads her posts in the direct messages, never mentions elsewhere', async t => {
  const f = await setup(t, 'people');
  const planned: IntentSubCall[] = [];
  const reply = await runResearch(researchDeps(f, planned), { action: 'start', question: 'what did Ada write me', topic: 'Ada messages' }, new AbortController().signal);
  assert.deepEqual(planned.map(call => call.name), [INTERNAL.chatRead]);
  assert.deepEqual(planned[0]?.args, { intent: 'person', limit: 8, person: 'Ada', sides: 'theirs' });
  assert.deepEqual(searches(f.calls())[0], { query: '', mode: 'keyword', limit: 8, sort: 'newest', channel: ADA_DM, author: 'ada.moss', from_date: daysAgo(30) });
  const findings = JSON.stringify(reply['findings'] ?? []);
  assert.match(findings, /ada note 1 about the pilot plan/u);
  assert.doesNotMatch(findings, /pilot moves to Friday|release checklist/u, 'posts that only mention her name stay out');
  assert.match(String(reply['coverage']), /chat truncated_to_budget 8 of 11 shown/u);
  assert.match(String(reply['note']), /I read direct messages from Ada Moss \(@ada\.moss\) since \d{4}-\d{2}-\d{2}\./u);
});

test('CHAT-P1: "what did I discuss with Ada this week" is the overview over this week, voiced with counts', async t => {
  const f = await setup(t, 'people');
  const planned: IntentSubCall[] = [];
  const reply = await runResearch(researchDeps(f, planned), { action: 'start', question: 'what did I discuss with Ada this week', topic: 'Ada discussion' }, new AbortController().signal);
  const sent = planned.find(call => call.name === INTERNAL.chatRead);
  assert.equal(sent?.args['intent'], 'overview');
  assert.equal(sent?.args['person'], 'Ada');
  assert.equal(typeof sent?.args['from_date'], 'string');
  assert.equal(f.calls().filter(call => call.name === 'mattermost_conversation_overview').length, 1);
  assert.match(JSON.stringify(reply['findings'] ?? []), /direct messages: \d+ posts/u);
  assert.match(String(reply['note']), /I read everything you and Ada Moss \(@ada\.moss\) exchanged since /u);
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

test('R8-W9: "what did I discuss with Alex lately" answers with the newest posts, not with section counts', async t => {
  const f = await setup(t, 'people', undefined, { DIDI_FAKE_MATTERMOST_ALEX: 'yes' });
  const planned: IntentSubCall[] = [];
  const reply = await runResearch(researchDeps(f, planned), { action: 'start', question: 'what did I discuss with Alex lately', topic: 'Alex discussion' }, new AbortController().signal);
  const sent = planned.find(call => call.name === INTERNAL.chatRead)?.args;
  assert.equal(sent?.['intent'], 'overview');
  assert.equal(sent?.['person'], 'Alex');
  assert.equal(sent?.['query'], undefined, '"lately" is a window, never a search term');
  assert.equal(sent?.['from_date'], fixtureDaysAgo(7), 'lately is seven days');
  const findings = String((reply['findings'] as { text: string }[])[0]?.text ?? '');
  assert.match(findings, /alex note 2 about the pilot plan/u, 'the newest post text reaches the voice');
  // N2: the roles are exact, never "either": the newest post is Alex's and the one before it is the owner's.
  assert.match(findings, /direct messages \| they \| (?:just now|\d+ (?:minute|hour|day|week|month)s? ago) \| alex note 1 about the pilot plan/u, 'the partner\'s post is "they"');
  assert.match(findings, /direct messages \| you \| (?:just now|\d+ (?:minute|hour|day|week|month)s? ago) \| alex note 2 about the pilot plan/u, 'the owner\'s post is "you"');
  assert.match(findings, /showing \d+ of 12 posts/u, 'the counts are one line saying how many of the twelve it showed');
  const summary = findings.split('\n').filter(line => /^showing \d+ of \d+ posts;/u.test(line));
  assert.equal(summary.length, 1, 'nine section lines never spend the voice cap again');
});

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
  assert.equal(withoutOwner('pilot Robert Smith', 'robert', 'Robert Smith'), 'pilot', 'the whole name is the owner');
  assert.equal(withoutOwner('pilot robert', 'robert', 'Robert Smith'), 'pilot', 'the handle too');
  assert.equal(withoutOwner('smith street pilot', 'robert', 'Robert Smith'), 'street pilot', 'a shared surname is the owner\'s word and goes; other words stay');
  assert.equal(withoutOwner('pilot', 'robert@example.invalid', 'Robert Smith'), 'pilot', 'the part before any @ is the handle');
  assert.equal(withoutOwner('pilot', '', ''), 'pilot', 'no identity, nothing dropped');
});

test('R8-W9: the owner\'s own handle never becomes a chat search term', async t => {
  const f = await setup(t, 'people');
  const read = chatRead(await f.reader.chat({ intent: 'person', person: 'Ada', sides: 'both', query: 'pilot robert' }));
  assert.equal(searches(f.calls())[0]?.['query'], 'pilot', 'the handle is dropped, the topic stays');
  assert.doesNotMatch(read.read, /robert/u);
});

test('R8-W9: a name stops at the name, and every person shape is a person ask', () => {
  const at = { terms: 'Alex telling the pilot', nowMs: Date.parse('2026-10-25T09:00:00Z'), timeZone: 'UTC' };
  assert.deepEqual(chatIntent('what is Alex telling', at), { kind: 'person-said', person: 'Alex', sides: 'theirs', terms: '', window: {} });
  assert.deepEqual(chatIntent('what did I exchange with Alex', at), { kind: 'person-overview', person: 'Alex', terms: '', window: {} });
  assert.deepEqual(chatIntent('what did I talk to Alex about', at), { kind: 'person-overview', person: 'Alex', terms: '', window: {} });
  assert.deepEqual(chatIntent('what did I chat with Alex about', at), { kind: 'person-overview', person: 'Alex', terms: '', window: {} });
  assert.deepEqual(chatIntent('what did Alex write to me', at), { kind: 'person-said', person: 'Alex', sides: 'theirs', terms: '', window: {} });
  assert.equal(chatAsk('what did I exchange with Alex'), true);
  assert.equal(chatAsk('what did I talk to Alex about'), true);
});

test('R8-W9: "lately" and "recently" are seven days, "last two weeks" fourteen, "today" from local midnight', () => {
  const now = Date.parse('2026-10-25T09:00:00Z');
  assert.deepEqual(chatWindow('what did Ada write lately', now, 'UTC'), { from: '2026-10-18' });
  assert.deepEqual(chatWindow('what has Ada said recently', now, 'UTC'), { from: '2026-10-18' });
  assert.deepEqual(chatWindow('what did Ada write in the last two weeks', now, 'UTC'), { from: '2026-10-11' });
  assert.deepEqual(chatWindow('what did Ada write this week', now, 'UTC'), { from: '2026-10-19' });
  assert.deepEqual(chatWindow('what did Ada write today', now, 'UTC'), { from: '2026-10-25' });
});

test('R8-W9 (N1): the summary line keeps one line of the voice cap even when the posts fill every other line', () => {
  const posts = Array.from({ length: 9 }, (_, index) => `**direct messages | they | ${index + 1} hours ago | note ${index + 1}**\nnote ${index + 1} about the pilot plan`);
  const text = ['read: everything you and Ada exchanged', 'matched: 40', ...posts, '- direct messages: 17 posts; group with kim.oak: 4 posts'].join('\n');
  const block = shapeBlock('chat_search', [{ key: 'c0', name: INTERNAL.chatRead, ok: true, text, originalCharacters: text.length, omittedCharacters: 0 }]);
  assert.equal(block.lines.length, 8, 'the voice cap is unchanged');
  assert.match(block.lines[7]!, /^showing 7 of 40 posts; direct messages: 17 posts; group with kim\.oak: 4 posts$/u, 'the counts and the honest count of posts survive a full page');
  assert.equal(block.total, 40, 'the header still says how many the archive matched');
});

test('R8-W9: every spoken form of the chat product\'s name routes to chat and is never a channel or a term', () => {
  const at = { terms: 'metamost', nowMs: Date.parse('2026-10-25T09:00:00Z'), timeZone: 'UTC' };
  for (const spoken of ['Metamos', 'Metamost', 'MetaMost', 'MetaMouse', 'meta mouse', 'matter most', 'Mattermost']) {
    assert.equal(chatAsk(`can you read ${spoken}`), true, spoken);
    assert.equal(spokenChannel(`what is in the ${spoken} channel`), undefined, `${spoken} is never a channel name`);
    assert.deepEqual(chatIntent(`can you read ${spoken}`, at), { kind: 'topic-search', terms: '', window: {} }, spoken);
  }
  assert.deepEqual(chatIntent('can you read Metamost about the pilot', { ...at, terms: 'metamost pilot' }), { kind: 'topic-search', terms: 'pilot', window: {} });
});

test('R8-W9: "can you read Metamost" reads the chat and never looks for a channel of that name', async t => {
  const f = await setup(t, 'people');
  const planned: IntentSubCall[] = [];
  const reply = await runResearch(researchDeps(f, planned), { action: 'start', question: 'can you read Metamost' }, new AbortController().signal);
  assert.ok(planned.every(call => call.name !== INTERNAL.chatRead), 'no channel read for a product name');
  assert.ok(planned.some(call => call.name === INTERNAL.chatSearch), 'the chat leg runs');
  assert.ok(planned.every(call => !String(call.args['query'] ?? call.args['channel'] ?? '').toLowerCase().includes('metamost')), 'the spoken name is not a search term');
  assert.doesNotMatch(JSON.stringify(reply), /channel-not-found|channel not found/u);
});

test('CHAT-P2 (L1-01): "what is in the AI AI AI team chat channel" reads that channel and names it', async t => {
  const f = await setup(t, 'people');
  const planned: IntentSubCall[] = [];
  const reply = await runResearch(researchDeps(f, planned), { action: 'start', question: 'what is in the AI AI AI team chat channel', topic: 'AI AI AI channel' }, new AbortController().signal);
  assert.deepEqual(planned.find(call => call.name === INTERNAL.chatRead)?.args, { intent: 'channel', limit: 8, channel: 'AI AI AI' });
  assert.match(JSON.stringify(reply['findings'] ?? []), /new model notes are up/u);
  assert.match(String(reply['note']), /I read the channel AI AI AI since /u);
  assert.doesNotMatch(String(reply['note']), /do not know a channel/u);
});

test('CHAT-P4: "my group chat with Ada and Kim" reads that group', async t => {
  const f = await setup(t, 'people');
  const planned: IntentSubCall[] = [];
  const reply = await runResearch(researchDeps(f, planned), { action: 'start', question: 'what is new in my group chat with Ada and Kim', topic: 'group chat Ada Kim' }, new AbortController().signal);
  assert.deepEqual(planned.find(call => call.name === INTERNAL.chatRead)?.args, { intent: 'group', limit: 8, people: ['Ada', 'Kim'] });
  assert.match(JSON.stringify(reply['findings'] ?? []), /field visit moves a day/u);
  assert.match(String(reply['coverage']), /chat complete 4 of 4 shown/u);
});

test('C-CHAT (W2B-R4): "what is new in Builders" reads that channel with no channel word spoken', async t => {
  const f = await setup(t, 'people');
  const planned: IntentSubCall[] = [];
  const reply = await runResearch(researchDeps(f, planned), { action: 'start', question: "what's new in Builders", topic: 'Builders' }, new AbortController().signal);
  const chat = planned.find(call => call.name === INTERNAL.chatRead)?.args;
  assert.equal(chat?.['intent'], 'channel', 'the ask is a channel read');
  assert.equal(chat?.['channel'], 'Builders', 'the spoken name, not a guess');
  assert.ok(searches(f.calls()).some(args => args['channel'] === BUILDERS), 'and then the channel read');
  assert.match(JSON.stringify(reply['findings'] ?? []), /pilot moves to Friday/u);
});

test('CHAT-T (control): a topic ask stays one keyword search over every channel', async t => {
  const f = await setup(t, 'people');
  const planned: IntentSubCall[] = [];
  const reply = await runResearch(researchDeps(f, planned), { action: 'start', question: 'did anyone mention the release checklist in chat', topic: 'release checklist' }, new AbortController().signal);
  assert.deepEqual(planned.find(call => call.name === INTERNAL.chatSearch)?.args, { query: 'release checklist', limit: 8 });
  assert.equal(planned.some(call => call.name === INTERNAL.chatRead), false);
  const sent = searches(f.calls())[0];
  assert.equal(sent?.['mode'], 'keyword');
  assert.equal(sent?.['channel'], undefined);
  assert.match(JSON.stringify(reply['findings'] ?? []), /release checklist/u);
});

test('C-CHAT (N-1): a chat read for something next week sends no future day to the archive', async t => {
  const f = await setup(t, 'people');
  const planned: IntentSubCall[] = [];
  await runResearch(researchDeps(f, planned), { action: 'start', question: 'what did people say in chat about the release checklist for next week', topic: 'release checklist' }, new AbortController().signal);
  const sent = searches(f.calls())[0];
  assert.ok(sent);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(sent['from_date'] === undefined || String(sent['from_date']) <= today, `never a future start: ${String(sent['from_date'])}`);
  assert.equal(planned[0]?.args['after'], undefined);
});

test('C-CHAT: "last week" sends both ends of the window', async t => {
  const f = await setup(t, 'people');
  const planned: IntentSubCall[] = [];
  await runResearch(researchDeps(f, planned), { action: 'start', question: 'what did Ada write me last week', topic: 'Ada' }, new AbortController().signal);
  const args = planned.find(call => call.name === INTERNAL.chatRead)?.args ?? {};
  assert.equal(typeof args['from_date'], 'string');
  assert.equal(typeof args['to_date'], 'string');
});

test('C-CHAT: an ambiguous person is voiced as one short question, never an empty chat', async t => {
  const f = await setup(t, 'people');
  const reply = await runResearch(researchDeps(f), { action: 'start', question: 'what did Lena write me', topic: 'Lena' }, new AbortController().signal);
  assert.match(String(reply['note']), /Ask him: Which Lena do you mean: Lena Berg \(@lena\.berg\) or Lena Sand \(@lena\.sand\)\?/u);
  assert.doesNotMatch(String(reply['note']), /found nothing matching/u);
  assert.match(String(reply['coverage']), /chat needs_clarification/u);
});

test('C-CHAT: on the older child the reply says once which capability is missing', async t => {
  const f = await setup(t, 'legacy');
  const reply = await runResearch(researchDeps(f), { action: 'start', question: 'what did I discuss with ada.moss', topic: 'ada.moss' }, new AbortController().signal);
  const note = String(reply['note']);
  assert.match(note, /Say once: person lookups by name need the newer chat archive; an overview across group chats and channels needs the newer chat archive\./u);
  assert.equal(note.match(/Say once:/gu)?.length, 1, 'said once');
});

test('C-CHAT (AUD-002): "more" reads the next page with the offset, and says which posts these are', async t => {
  const f = await setup(t, 'people');
  const deps = researchDeps(f);
  const first = await runResearch(deps, { action: 'start', question: 'what did Ada write me', topic: 'Ada' }, new AbortController().signal);
  const next = await runResearch(deps, { action: 'continue', researchId: String(first['researchId']) }, new AbortController().signal);
  assert.equal(searches(f.calls()).at(-1)?.['offset'], 8);
  assert.match(String(next['note']), /This is the next page: posts 9 to 11 of 11\./u);
  assert.match(JSON.stringify(next['findings'] ?? []), /ada note 9 about the pilot plan/u);
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
import { configuredSourcesForEndpoints as probeUnreachable } from '../tools/research.js';

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
    return owner(composition).liveDefinitions(runId, () => ({ remembered: false, code: 'owner_transcript_not_final' })).map(tool => tool.name);
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
  assert.deepEqual(probeUnreachable(moved.status().endpoints as never), [], 'research never calls the chat source unreachable');

  // The other disabled shape the review measured: the old entry kept in the file with enabled false.
  const kept = await start([{ id: 'mattermost', path: '/old', enabled: false }, { id: 'mattermost-people', path: '/people', enabled: true }], { '/people': MATTERMOST_READ_TOOLS });
  const keptIds = acceptanceIds(kept);
  assert.deepEqual(keptIds, ['mattermost-people'], 'a disabled entry is a retired connection, whatever the durable row says');
  assert.ok(compose(kept, keptIds, 'disabled-run').includes('mattermost_chat'));
  assert.deepEqual(states(kept), ['mattermost-people:connected'], 'a disabled entry is never reported connecting, so the chat source stays readable');
  assert.deepEqual(probeUnreachable(kept.status().endpoints as never), []);

  // The reverse edit: the new entry is deleted and the old one restored, and the same run holds it again.
  const back = await start([{ id: 'mattermost', path: '/old', enabled: true }], { '/old': MATTERMOST_TOOLS });
  const backIds = acceptanceIds(back);
  assert.deepEqual(backIds, ['mattermost'], 'a stored row whose id is enabled in the file stays active, and the removed id retires');
  assert.ok(compose(back, backIds, 'rollback-run').includes('mattermost_chat'));
  assert.deepEqual(states(back), ['mattermost:connected']);
  assert.deepEqual(probeUnreachable(back.status().endpoints as never), []);

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
  await f.reader.getChannelHistory({ channel: 'Builders', limit: 5 });
  const result = await f.reader.chat({ intent: 'overview', person: 'Ada', from_date: fixtureDaysAgo(7) });
  const read = chatRead(result);
  assert.ok(read.posts.length > 0);
  // Identity and overview are the only children used by this call.
  assert.equal(result.state === 'completed' ? result[SOURCE_CHILD_DISPATCHES]?.length : undefined, 2);
});
