#!/usr/bin/env node
// Synthetic stdio MCP child for server/test/mattermost-people.test.ts (wagon W2b).
// No network, no credentials, no session, no application files: every user, channel and post is
// invented here, relative to this process's clock.
// argv[2] = mode:
//   people  the child with person and channel reads (mattermost-mcp draft PRs A, B and C): resolve_person,
//           filtered list_channels pages, conversation_overview, attachmentText on posts.
//   legacy  the child as installed before those PRs: list_channels takes no arguments and answers every
//           channel at once, no resolve_person, no conversation_overview, no attachmentText.
// Shapes are literal copies of the child's own (src/search/serialize.ts, src/mcp/tools.ts): search answers
// {total, returned, results}, posts are {id, username, channel, timestamp, message, url, attachmentText?}.
// DIDI_FAKE_MATTERMOST_LOG records every call as one JSON line.
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const mode = process.argv[2] ?? 'people';
const people = mode === 'people';
const logPath = process.env.DIDI_FAKE_MATTERMOST_LOG;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// The one clock this fixture and its suite agree on, so a "this week" window never depends on the
// weekday the suite happens to run on (DIDI_FAKE_MATTERMOST_NOW, set by the suite).
const now = Number(process.env.DIDI_FAKE_MATTERMOST_NOW ?? '') || Date.now();
const iso = (ms) => new Date(ms).toISOString();
const day = (ms) => iso(ms).slice(0, 10);

const OWNER = { id: 'owner00000000000000000000a', username: 'robert', email: 'robert@example.invalid' };
const USERS = [
  { id: 'user0ada00000000000000000a', username: 'ada.moss', first_name: 'Ada', last_name: 'Moss', nickname: '' },
  { id: 'user0kim00000000000000000a', username: 'kim.oak', first_name: 'Kim', last_name: 'Oak', nickname: '' },
  // Two people share a first name: "Lena" alone is ambiguous.
  { id: 'user0lenab000000000000000a', username: 'lena.berg', first_name: 'Lena', last_name: 'Berg', nickname: '' },
  { id: 'user0lenas000000000000000a', username: 'lena.sand', first_name: 'Lena', last_name: 'Sand', nickname: '' },
  { id: 'user0noah0000000000000000a', username: 'noah.reed', first_name: 'Noah', last_name: 'Reed', nickname: '' },
  { id: 'user0pat00000000000000000a', username: 'pat.vale', first_name: 'Pat', last_name: 'Vale', nickname: '' },
  { id: 'user0quin0000000000000000a', username: 'quinn.ash', first_name: 'Quinn', last_name: 'Ash', nickname: '' },
  { id: 'user0ravi0000000000000000a', username: 'ravi.dune', first_name: 'Ravi', last_name: 'Dune', nickname: '' },
  { id: 'user0sam00000000000000000a', username: 'sam.lark', first_name: 'Sam', last_name: 'Lark', nickname: '' },
  { id: 'user0tess0000000000000000a', username: 'tess.wren', first_name: 'Tess', last_name: 'Wren', nickname: '' },
];
const userByName = new Map([OWNER, ...USERS].map(user => [user.username, user]));
const displayOf = (user) => [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username;

// Twelve direct and group channels. Their ids sort the most active conversation, the one with Ada, LAST,
// so a reader that takes the first few in id or name order never reaches it.
const dm = (id, username, lastAt) => ({ id, name: `${OWNER.id}__${userByName.get(username).id}`, display_name: username, type: 'D', members: [OWNER.username, username].sort(), lastAt });
const group = (id, usernames, lastAt) => {
  const members = [...usernames, OWNER.username].sort();
  return { id, name: `g${id}`, display_name: members.join(', '), type: 'G', members, lastAt };
};
const CHANNELS = [
  { id: 'chanAiAiAi000000000000000a', name: 'ai-ai-ai', display_name: 'AI AI AI', type: 'O', lastAt: now - 5 * HOUR },
  { id: 'chanBuilders0000000000000a', name: 'builders', display_name: 'Builders', type: 'O', lastAt: now - 2 * HOUR },
  { id: 'chanBuildersCo00000000000a', name: 'builders-co', display_name: 'Builders & Co.', type: 'O', lastAt: now - 30 * DAY },
  { id: 'chanBuilderFriends0000000a', name: 'builder--friends', display_name: 'Builder & Friends', type: 'P', lastAt: now - 3 * HOUR },
  { id: 'chanEngGeneral00000000000a', name: 'engineering-general', display_name: 'Eng - General', type: 'O', lastAt: now - 4 * HOUR },
  { id: 'chanEngSecurity0000000000a', name: 'engineering-security', display_name: 'Eng - Security', type: 'O', lastAt: now - 6 * HOUR },
  group('chanG01000000000000000000a', ['kim.oak', 'lena.berg'], now - 40 * DAY),
  group('chanG02000000000000000000a', ['ada.moss', 'kim.oak'], now - 1 * DAY),
  group('chanG03000000000000000000a', ['ada.moss', 'kim.oak', 'noah.reed'], now - 9 * DAY),
  dm('chanD01000000000000000000a', 'kim.oak', now - 50 * DAY),
  dm('chanD02000000000000000000a', 'lena.berg', now - 45 * DAY),
  dm('chanD03000000000000000000a', 'lena.sand', now - 60 * DAY),
  dm('chanD04000000000000000000a', 'noah.reed', now - 70 * DAY),
  dm('chanD05000000000000000000a', 'pat.vale', now - 80 * DAY),
  dm('chanD06000000000000000000a', 'quinn.ash', now - 90 * DAY),
  dm('chanD07000000000000000000a', 'ravi.dune', now - 100 * DAY),
  dm('chanD08000000000000000000a', 'sam.lark', now - 110 * DAY),
  dm('chanDzz000000000000000000a', 'ada.moss', now - 20 * 60 * 1000),
];
const channelById = new Map(CHANNELS.map(channel => [channel.id, channel]));
const adaDm = channelById.get('chanDzz000000000000000000a');

let seq = 0;
const POSTS = [];
const add = (channelId, author, at, message, extra = {}) => {
  seq += 1;
  const id = `post${String(seq).padStart(4, '0')}xxxxxxxxxxxxxxxxxx`.slice(0, 26);
  POSTS.push({ id, channelId, author, at, message, ...extra });
  return id;
};
// The DM with Ada: eleven posts by Ada and six by the owner in the last six days, two old ones by Ada.
for (let n = 0; n < 11; n += 1) add(adaDm.id, 'ada.moss', now - (n + 1) * 12 * HOUR, `ada note ${n + 1} about the pilot plan`);
for (let n = 0; n < 6; n += 1) add(adaDm.id, 'robert', now - (n + 1) * 13 * HOUR, `owner reply ${n + 1}`);
add(adaDm.id, 'ada.moss', now - 40 * DAY, 'ada old note from last season');
add(adaDm.id, 'ada.moss', now - 41 * DAY, 'ada older note');
// Other channels mention Ada by name: a keyword search for her name finds these, never her DM.
add('chanBuilders0000000000000a', 'kim.oak', now - 2 * HOUR, 'Ada said the pilot moves to Friday');
add('chanBuilders0000000000000a', 'noah.reed', now - 3 * HOUR, 'ask Ada about the release checklist');
add('chanEngGeneral00000000000a', 'pat.vale', now - 4 * HOUR, 'release checklist is ready for review');
// A webhook post: its whole text lives in the attachment.
add('chanBuilders0000000000000a', 'robert', now - 90 * 60 * 1000, '', people ? { attachmentText: 'Build 42 passed on main' } : {});
// Ada and Kim's group, and the owner's posts in a shared channel.
add('chanG02000000000000000000a', 'ada.moss', now - 1 * DAY, 'group plan for the field visit');
add('chanG02000000000000000000a', 'kim.oak', now - 26 * HOUR, 'field visit moves a day');
add('chanG02000000000000000000a', 'robert', now - 27 * HOUR, 'fine by me');
add('chanG02000000000000000000a', 'ada.moss', now - 28 * HOUR, 'who books the car');
add('chanG03000000000000000000a', 'noah.reed', now - 9 * DAY, 'four of us on this one');
add('chanBuilderFriends0000000a', 'tess.wren', now - 3 * HOUR, 'friends meetup is on');
add('chanBuilderFriends0000000a', 'robert', now - 5 * HOUR, 'count me in');
add('chanAiAiAi000000000000000a', 'sam.lark', now - 5 * HOUR, 'new model notes are up');
add('chanAiAiAi000000000000000a', 'ada.moss', now - 6 * HOUR, 'eval numbers look better');
add('chanAiAiAi000000000000000a', 'robert', now - 7 * HOUR, 'nice, ship the notes');
add('chanEngSecurity0000000000a', 'ravi.dune', now - 6 * HOUR, 'rotate the keys this week');
add('chanD02000000000000000000a', 'lena.berg', now - 45 * DAY, 'old hello from lena');

// R8-W9: an opt-in synthetic colleague whose direct conversation holds twelve posts, so the audit's
// "what did I discuss with Alex lately" ask can be replayed end to end. Off by default: every other test
// in this suite reads the same fixture without these posts.
const alexDm = 'chanDAlex0000000000000000a';
if (process.env.DIDI_FAKE_MATTERMOST_ALEX === 'yes') {
  const alex = { id: 'user0alex000000000000000a', username: 'alex.ray', first_name: 'Alex', last_name: 'Ray', nickname: '' };
  USERS.push(alex);
  userByName.set(alex.username, alex);
  const direct = dm(alexDm, alex.username, now - 30 * 60 * 1000);
  CHANNELS.push(direct);
  channelById.set(direct.id, direct);
  for (let index = 1; index <= 12; index += 1) {
    add(direct.id, index % 2 === 0 ? OWNER.username : alex.username, now - index * HOUR, `alex note ${index} about the pilot plan`);
  }
}

const channelLabel = (channel) => channel.display_name || channel.name;
const serialize = (post) => ({
  id: post.id, username: post.author, channel: channelLabel(channelById.get(post.channelId)), timestamp: iso(post.at),
  message: post.message, url: `https://chat.example.invalid/team/pl/${post.id}`,
  ...(post.attachmentText ? { attachmentText: post.attachmentText } : {}),
});

const fold = (text) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const words = (text) => fold(text).replace(/&/gu, ' and ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const resolveChannel = (reference) => CHANNELS.find(channel => channel.id === reference || channel.name === reference || fold(channel.display_name) === fold(reference));
const lastPostAt = (channel) => {
  const own = POSTS.filter(post => post.channelId === channel.id).map(post => post.at);
  return own.length > 0 ? Math.max(...own) : channel.lastAt;
};

function search(args) {
  let list = [...POSTS];
  if (args.channel !== undefined) {
    const channel = resolveChannel(args.channel);
    if (!channel) return { error: `Unknown channel: ${args.channel}` };
    list = list.filter(post => post.channelId === channel.id);
  }
  if (typeof args.author === 'string') list = list.filter(post => post.author === args.author);
  if (typeof args.from_date === 'string') list = list.filter(post => day(post.at) >= args.from_date);
  if (typeof args.to_date === 'string') list = list.filter(post => day(post.at) <= args.to_date);
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query !== '') {
    const terms = words(query);
    list = list.filter(post => terms.every(term => words(`${post.message} ${post.attachmentText ?? ''}`).includes(term)));
  }
  list.sort((a, b) => b.at - a.at);
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 10;
  const page = list.slice(offset, offset + limit).map(serialize);
  return { total: list.length, returned: page.length, results: page };
}

function resolvePerson(name) {
  const wanted = fold(name.replace(/^@/u, '').trim());
  const rows = USERS.map(user => {
    const fields = [user.username, user.first_name, user.last_name, `${user.first_name} ${user.last_name}`, user.nickname].filter(Boolean).map(fold);
    const match = fields.includes(wanted) ? 'exact' : fields.some(field => field.startsWith(wanted)) ? 'prefix' : undefined;
    return match === undefined ? undefined : { user, match };
  }).filter(Boolean);
  const exact = rows.filter(row => row.match === 'exact');
  const ambiguous = exact.length > 1 || (exact.length === 0 && rows.length > 1);
  const candidates = [...exact, ...rows.filter(row => row.match === 'prefix')].slice(0, 5).map(({ user, match }) => {
    const direct = CHANNELS.find(channel => channel.type === 'D' && channel.display_name === user.username);
    const dmPosts = direct === undefined ? [] : POSTS.filter(post => post.channelId === direct.id);
    return {
      user_id: user.id, username: user.username, display_name: displayOf(user), first_name: user.first_name, last_name: user.last_name, nickname: user.nickname, match,
      dm_channel_id: direct?.id ?? null, dm_post_count: dmPosts.length, dm_last_post_at: dmPosts.length > 0 ? iso(Math.max(...dmPosts.map(post => post.at))) : null,
    };
  });
  return { query: name, ambiguous, total_matches: rows.length, candidates, names_complete: true };
}

function listChannels(args) {
  if (Object.keys(args).length === 0 || !people) {
    const channels = CHANNELS.map(channel => ({ id: channel.id, name: channel.name, displayName: channel.display_name, team: 'team', type: channel.type, posts: POSTS.filter(post => post.channelId === channel.id).length, lastSyncAt: iso(now), archived: false, archivedAt: null }));
    return { count: channels.length, channels };
  }
  if (args.member !== undefined && Array.isArray(args.types) && args.types.some(type => type === 'O' || type === 'P')) return { error: 'member is exact for D and G channels only' };
  let list = [...CHANNELS];
  if (Array.isArray(args.types)) list = list.filter(channel => args.types.includes(channel.type));
  if (typeof args.member === 'string') list = list.filter(channel => (channel.members ?? []).includes(args.member));
  if (typeof args.query === 'string' && args.query.trim() !== '') {
    const terms = words(args.query);
    list = list.filter(channel => {
      const own = words(`${channel.name} ${channel.display_name}`);
      return terms.every(term => own.some(word => word.startsWith(term)));
    });
  }
  if (args.sort === 'name') list.sort((a, b) => channelLabel(a).localeCompare(channelLabel(b)));
  else list.sort((a, b) => lastPostAt(b) - lastPostAt(a));
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 50;
  const page = list.slice(offset, offset + limit).map(channel => ({
    id: channel.id, name: channel.name, displayName: channel.display_name, team: 'team', type: channel.type,
    post_count: POSTS.filter(post => post.channelId === channel.id).length, last_post_at: iso(lastPostAt(channel)), archived: false,
    ...(channel.members ? { members: channel.members } : {}),
  }));
  return { total: list.length, returned: page.length, offset, channels: page };
}

function overview(args) {
  const resolved = resolvePerson(args.person);
  if (resolved.candidates.length === 0) return { refusal: { error: 'not_found', message: `No user matches ${args.person}` } };
  if (resolved.ambiguous) return { refusal: { error: 'ambiguous', message: `${args.person} matches several people`, candidates: resolved.candidates } };
  const person = resolved.candidates[0];
  const from = args.from_date;
  const to = args.to_date ?? day(now);
  const limit = args.per_section_limit ?? 3;
  const inWindow = (post) => day(post.at) >= from && day(post.at) <= to;
  const brief = (post) => ({ id: post.id, author: post.author, created_at: iso(post.at), permalink: `https://chat.example.invalid/team/pl/${post.id}`, message: post.message, truncated: false, root_id: null });
  const direct = CHANNELS.find(channel => channel.type === 'D' && channel.display_name === person.username);
  const dmPosts = direct === undefined ? [] : POSTS.filter(post => post.channelId === direct.id && inWindow(post)).sort((a, b) => b.at - a.at);
  const groups = CHANNELS.filter(channel => channel.type === 'G' && channel.members.includes(person.username)).map(channel => {
    const posts = POSTS.filter(post => post.channelId === channel.id && inWindow(post)).sort((a, b) => b.at - a.at);
    return { channel, posts };
  }).filter(entry => entry.posts.length > 0);
  const shared = CHANNELS.filter(channel => channel.type === 'O' || channel.type === 'P').map(channel => {
    const posts = POSTS.filter(post => post.channelId === channel.id && inWindow(post) && (post.author === person.username || post.author === OWNER.username)).sort((a, b) => b.at - a.at);
    return { channel, posts, owner: posts.filter(post => post.author === OWNER.username).length, theirs: posts.filter(post => post.author === person.username).length };
  }).filter(entry => entry.owner > 0 && entry.theirs > 0);
  return {
    person: { user_id: person.user_id, username: person.username, display_name: person.display_name },
    owner: { user_id: OWNER.id, username: OWNER.username },
    window: { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` },
    dm: direct === undefined ? null : { channel_id: direct.id, post_count: dmPosts.length, last_post_at: dmPosts[0] ? iso(dmPosts[0].at) : null, posts: dmPosts.slice(0, limit).map(brief) },
    groups: groups.map(({ channel, posts }) => ({ channel_id: channel.id, display_name: channel.display_name, members: channel.members, post_count: posts.length, post_count_both: posts.filter(post => post.author === person.username || post.author === OWNER.username).length, last_post_at: iso(posts[0].at), posts: posts.slice(0, limit).map(brief) })),
    channels: shared.map(({ channel, posts, owner, theirs }) => ({ channel_id: channel.id, display_name: channel.display_name, type: channel.type, posts_by_owner: owner, posts_by_person: theirs, last_post_at: iso(posts[0].at), posts: posts.slice(0, limit).map(brief) })),
    totals: { dm_posts: dmPosts.length, groups: groups.length, group_posts: groups.reduce((sum, entry) => sum + entry.posts.length, 0), channels: shared.length, channel_posts_by_owner: shared.reduce((sum, entry) => sum + entry.owner, 0), channel_posts_by_person: shared.reduce((sum, entry) => sum + entry.theirs, 0) },
  };
}

const SEARCH_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  query: { type: 'string', default: '' }, author: { type: 'string' }, channel: { type: 'string' }, from_date: { type: 'string' }, to_date: { type: 'string' },
  replies_to: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0 },
  sort: { type: 'string', enum: ['relevance', 'newest'] }, mode: { type: 'string', enum: ['keyword', 'semantic', 'hybrid'] }, rerank: { type: 'boolean' }, format: { type: 'string', enum: ['concise', 'detailed'] },
} };
const LIST_SCHEMA = people
  ? { type: 'object', additionalProperties: false, properties: {
    types: { type: 'array', items: { type: 'string', enum: ['O', 'P', 'D', 'G'] } }, member: { type: 'string' }, posted_by: { type: 'string' },
    from_date: { type: 'string' }, to_date: { type: 'string' }, query: { type: 'string' }, sort: { type: 'string', enum: ['recent', 'name'] },
    limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 },
  } }
  : { type: 'object', properties: {} };
const SCHEMAS = {
  mattermost_whoami: { type: 'object', properties: {} },
  mattermost_search: SEARCH_SCHEMA,
  mattermost_get_thread: { type: 'object', additionalProperties: false, required: ['post_id'], properties: { post_id: { type: 'string' }, format: { type: 'string', enum: ['concise', 'detailed'] } } },
  mattermost_list_channels: LIST_SCHEMA,
  mattermost_get_channel_history: { type: 'object', additionalProperties: false, required: ['channel'], properties: { channel: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 }, format: { type: 'string', enum: ['concise', 'detailed'] } } },
  ...(people ? {
    mattermost_resolve_person: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1 } } },
    mattermost_conversation_overview: { type: 'object', additionalProperties: false, required: ['person', 'from_date'], properties: { person: { type: 'string', minLength: 1 }, from_date: { type: 'string' }, to_date: { type: 'string' }, per_section_limit: { type: 'integer', minimum: 0, maximum: 5 } } },
  } : {}),
  // A write tool the child publishes: the connector's envelope never carries it.
  mattermost_post_message: { type: 'object', properties: { channel: { type: 'string' }, message: { type: 'string' } } },
};

const server = new Server({ name: 'stdio-mattermost-people-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/list', () => ({
  tools: Object.keys(SCHEMAS).map(name => ({ name, description: `Synthetic ${name}`, inputSchema: SCHEMAS[name] })),
}));
server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify({ name, arguments: args })}\n`);
  const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const error = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });
  if (!Object.hasOwn(SCHEMAS, name) || name === 'mattermost_post_message') return error(`unsupported tool ${name}`);
  if (name === 'mattermost_whoami') return text(OWNER);
  if (name === 'mattermost_search') {
    const found = search(args);
    return found.error ? error(found.error) : text(found);
  }
  if (name === 'mattermost_get_channel_history') {
    const channel = resolveChannel(args.channel);
    if (!channel) return error(`Unknown channel: ${args.channel}`);
    const list = POSTS.filter(post => post.channelId === channel.id).sort((a, b) => a.at - b.at).slice(-(args.limit ?? 50)).map(serialize);
    return text({ total: list.length, returned: list.length, results: list });
  }
  if (name === 'mattermost_get_thread') {
    const root = POSTS.find(post => post.id === args.post_id);
    return text({ root: root ? serialize(root) : null, replies: [] });
  }
  if (name === 'mattermost_list_channels') {
    const listed = listChannels(args);
    return listed.error ? error(listed.error) : text(listed);
  }
  if (name === 'mattermost_resolve_person') return text(resolvePerson(args.name));
  if (name === 'mattermost_conversation_overview') {
    const result = overview(args);
    return result.refusal ? { isError: true, content: [{ type: 'text', text: JSON.stringify(result.refusal) }] } : text(result);
  }
  return error(`unsupported tool ${name}`);
});
await server.connect(new StdioServerTransport());
