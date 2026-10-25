#!/usr/bin/env node
// Synthetic stdio MCP child for server/test/mattermost-attention.test.ts.
// No network, no credentials, no session, no application files: every post is generated here,
// relative to this process's clock, so the window rules are exercised without a fixture clock.
// Envelopes are literal copies of the installed child's shapes (mattermost-mcp src/search/serialize.ts):
// search and channel history answer {total, returned, results}, a thread answers {root, replies},
// whoami answers {id, username, email}, list_channels answers {count, channels} with no arguments and the
// newer child's filtered page {total, returned, offset, channels} (types, sort, limit) with them. Post fields are the
// concise shape {id, username, channel, timestamp, message, url}, and the declared limit maxima are
// the child's own (search 50, channel history 200).
// argv[2] = mode (window | no-window | no-thread | slow). DIDI_FAKE_MATTERMOST_LOG records every call.
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const mode = process.argv[2] ?? 'window';
const logPath = process.env.DIDI_FAKE_MATTERMOST_LOG;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const OWNER = { id: 'owner0000000000000000000a', username: 'robert', email: 'robert@example.invalid' };

const post = (id, channel, author, at, message, slug) => ({
  id, username: author, channel, timestamp: iso(at), message,
  url: `https://chat.example/m/${slug}`,
});

// Mention window: one inside the default seven days, one ten days back.
const mentionRecent = post('postMentionRecent', 'team-release', 'dana', now - 2 * HOUR, '@robert can you confirm the 3k release?', 'mention-recent');
const mentionOld = post('postMentionOld', 'team-release', 'dana', now - 10 * DAY, '@robert did you see this last week?', 'mention-old');
// A direct conversation, with one owner post and one from Dana.
const dmDana = post('postDmDana', 'direct-dana', 'dana', now - 1 * HOUR, 'sent you the deck for review', 'dm-dana');
const dmOwner = post('postDmOwner', 'direct-dana', 'robert', now - 3 * HOUR, 'thanks, looking now', 'dm-owner');
// Two threads the owner opened: one waits on Dana, the other the owner answered last.
const threadOpenRoot = post('threadOpenRoot', 'direct-dana', 'robert', now - 5 * HOUR, 'can you check the diag numbers?', 'thread-open-root');
const threadOpenReply = post('threadOpenReply', 'direct-dana', 'dana', now - 30 * 60 * 1000, 'done, they line up', 'thread-open-reply');
const threadDoneRoot = post('threadDoneRoot', 'direct-dana', 'robert', now - 6 * HOUR, 'ok to ship?', 'thread-done-root');
const threadDoneReply = post('threadDoneReply', 'direct-dana', 'robert', now - 4 * HOUR, 'shipped it', 'thread-done-reply');
// A public channel thread: the owner opened it, Dana answered last. Nothing mentions the owner,
// so only a read seeded by the owner's own posts can find it.
const publicThreadRoot = post('publicThreadRoot', 'team-release', 'robert', now - 7 * HOUR, 'who owns the 3k dock retest?', 'public-thread-root');
const publicThreadReply = post('publicThreadReply', 'team-release', 'dana', now - 20 * 60 * 1000, 'I can take it tomorrow morning', 'public-thread-reply');

// Deliberately unsorted: the connector owns the order it shows.
const mentions = [mentionOld, mentionRecent];
const ownerPosts = [dmOwner, threadOpenRoot, threadDoneRoot, threadDoneReply, publicThreadRoot];
const history = {
  'direct-dana': [dmOwner, threadDoneRoot, dmDana, threadDoneReply, threadOpenRoot],
};
const threads = {
  threadOpenRoot: [threadOpenRoot, threadOpenReply],
  threadDoneRoot: [threadDoneRoot, threadDoneReply],
  publicThreadRoot: [publicThreadRoot, publicThreadReply],
};

const SEARCH = mode === 'no-window'
  ? { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } } }
  : { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, channel: { type: 'string' }, from_date: { type: 'string' }, to_date: { type: 'string' }, sort: { type: 'string', enum: ['relevance', 'newest'] } } };

const READ_SCHEMAS = {
  mattermost_whoami: { type: 'object', additionalProperties: false, properties: {} },
  mattermost_list_channels: { type: 'object', additionalProperties: false, properties: { types: { type: 'array', items: { type: 'string', enum: ['O', 'P', 'D', 'G'] } }, sort: { type: 'string', enum: ['recent', 'name'] }, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 } } },
  mattermost_get_channel_history: { type: 'object', additionalProperties: false, required: ['channel'], properties: { channel: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  mattermost_get_thread: { type: 'object', additionalProperties: false, required: ['post_id'], properties: { post_id: { type: 'string' } } },
  mattermost_search: SEARCH,
};
// A child that does not publish the thread read: the attention composite has no grant at all.
const TOOLS = Object.keys(READ_SCHEMAS).filter(name => !(mode === 'no-thread' && name === 'mattermost_get_thread'));

const server = new Server({ name: 'stdio-mattermost-attention-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/list', () => ({
  tools: TOOLS.map(name => ({ name, description: `Synthetic ${name}`, inputSchema: READ_SCHEMAS[name] })),
}));
server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify({ name, arguments: args, at: Date.now() })}\n`);
  // A child that answers half a second late: a serial scan of its twelve children cannot fit the
  // same budget as a concurrent one, and the test stays well under the five second line.
  if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 500));
  const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const envelope = (list) => ({ total: list.length, returned: list.length, results: list });
  const within = (list) => (typeof args.from_date === 'string'
    ? list.filter(entry => entry.timestamp.slice(0, 10) >= args.from_date)
    : list);
  if (!TOOLS.includes(name)) return { isError: true, content: [{ type: 'text', text: `unsupported tool ${name}` }] };
  if (name === 'mattermost_whoami') return text(OWNER);
  if (name === 'mattermost_list_channels') {
    const channels = [
      { id: 'chanTeamRelease', name: 'team-release', display_name: 'Team Release', type: 'O' },
      { id: 'chanDirectDana', name: 'direct-dana', display_name: 'dana', type: 'D' },
    ];
    if (Object.keys(args).length === 0) return text({ count: channels.length, channels });
    const rows = channels.filter(channel => !Array.isArray(args.types) || args.types.includes(channel.type))
      .map(channel => ({ id: channel.id, name: channel.name, displayName: channel.display_name, type: channel.type, last_post_at: iso(now - 30 * 60 * 1000) }));
    return text({ total: rows.length, returned: rows.length, offset: 0, channels: rows });
  }
  if (name === 'mattermost_get_channel_history') {
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 200) {
      return { isError: true, content: [{ type: 'text', text: 'invalid limit' }] };
    }
    return text(envelope(history[args.channel] ?? []));
  }
  if (name === 'mattermost_get_thread') {
    const list = threads[args.post_id] ?? (typeof args.post_id === 'string'
      ? [{ ...dmDana, id: args.post_id }]
      : []);
    const [root, ...replies] = list;
    return text({ root, replies });
  }
  if (name === 'mattermost_search') {
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50) {
      return { isError: true, content: [{ type: 'text', text: 'invalid limit' }] };
    }
    const query = typeof args.query === 'string' ? args.query : '';
    // A channel read with no words: that conversation's posts, newest first, inside the window.
    if (typeof args.channel === 'string') {
      const byId = { chanDirectDana: 'direct-dana' };
      return text(envelope(within([...(history[byId[args.channel] ?? args.channel] ?? [])].sort((a, b) => b.timestamp.localeCompare(a.timestamp)))));
    }
    return text(envelope(within(query.startsWith('from:') ? ownerPosts : mentions)));
  }
  return { isError: true, content: [{ type: 'text', text: `unsupported tool ${name}` }] };
});
await server.connect(new StdioServerTransport());
