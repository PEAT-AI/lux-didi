#!/usr/bin/env node
// Synthetic stdio MCP child for server/test/mattermost-attention.test.ts.
// No network, no credentials, no session, no application files: every post is generated here,
// relative to this process's clock, so the window rules are exercised without a fixture clock.
// argv[2] = mode (window | no-window). DIDI_FAKE_MATTERMOST_LOG records every call and its arguments.
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const mode = process.argv[2] ?? 'window';
const logPath = process.env.DIDI_FAKE_MATTERMOST_LOG;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const OWNER = { id: 'owner0000000000000000000a', username: 'robert', display_name: 'Robert Peat' };

const post = (id, channel, author, at, text, slug, root = '') => ({
  id, channel, author, time: iso(at), create_at: at, text,
  permalink: `https://chat.example/m/${slug}`,
  ...(root === '' ? {} : { root_id: root }),
});

// Mention window: one inside the default seven days, one ten days back.
const mentionRecent = post('postMentionRecent', 'team-release', 'Dana', now - 2 * HOUR, '@robert can you confirm the 3k release?', 'mention-recent');
const mentionOld = post('postMentionOld', 'team-release', 'Dana', now - 10 * DAY, '@robert did you see this last week?', 'mention-old');
// A direct conversation, with one owner post and one from Dana.
const dmDana = post('postDmDana', 'direct-dana', 'Dana', now - 1 * HOUR, 'sent you the deck for review', 'dm-dana');
const dmOwner = post('postDmOwner', 'direct-dana', 'Robert Peat', now - 3 * HOUR, 'thanks, looking now', 'dm-owner');
// Two threads the owner opened: one waits on Dana, the other the owner answered last.
const threadOpenRoot = post('threadOpenRoot', 'direct-dana', 'Robert Peat', now - 5 * HOUR, 'can you check the diag numbers?', 'thread-open-root');
const threadOpenReply = post('threadOpenReply', 'direct-dana', 'Dana', now - 30 * 60 * 1000, 'done, they line up', 'thread-open-reply', 'threadOpenRoot');
const threadDoneRoot = post('threadDoneRoot', 'direct-dana', 'Robert Peat', now - 6 * HOUR, 'ok to ship?', 'thread-done-root');
const threadDoneReply = post('threadDoneReply', 'direct-dana', 'Robert Peat', now - 4 * HOUR, 'shipped it', 'thread-done-reply', 'threadDoneRoot');

// Deliberately unsorted: the connector owns the order it shows.
const mentions = [mentionOld, mentionRecent];
const history = {
  'direct-dana': [dmOwner, threadDoneRoot, dmDana, threadDoneReply, threadOpenRoot],
};
const threads = {
  threadOpenRoot: [threadOpenRoot, threadOpenReply],
  threadDoneRoot: [threadDoneRoot, threadDoneReply],
};

const SEARCH = mode === 'no-window'
  ? { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } } }
  : { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, limit: { type: 'integer' }, after: { type: 'string' }, before: { type: 'string' } } };

const READ_SCHEMAS = {
  mattermost_whoami: { type: 'object', additionalProperties: false, properties: {} },
  mattermost_list_channels: { type: 'object' },
  mattermost_get_channel_history: { type: 'object', additionalProperties: false, required: ['channel'], properties: { channel: { type: 'string' }, limit: { type: 'integer' } } },
  mattermost_get_thread: { type: 'object', additionalProperties: false, required: ['post_id'], properties: { post_id: { type: 'string' } } },
  mattermost_search: SEARCH,
};
const TOOLS = Object.keys(READ_SCHEMAS);

const server = new Server({ name: 'stdio-mattermost-attention-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/list', () => ({
  tools: TOOLS.map((name) => ({ name, description: `Synthetic ${name}`, inputSchema: READ_SCHEMAS[name] })),
}));
server.setRequestHandler('tools/call', (request) => {
  const { name, arguments: args = {} } = request.params;
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify({ name, arguments: args })}\n`);
  const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const within = (posts) => (typeof args.after === 'string'
    ? posts.filter((entry) => Date.parse(entry.time) >= Date.parse(args.after))
    : posts);
  if (name === 'mattermost_whoami') return text(OWNER);
  if (name === 'mattermost_list_channels') {
    return text({ channels: [
      { name: 'team-release', display_name: 'Team Release', type: 'O' },
      { name: 'direct-dana', type: 'D' },
    ] });
  }
  if (name === 'mattermost_get_channel_history') return text({ posts: history[args.channel] ?? [] });
  if (name === 'mattermost_get_thread') {
    const posts = threads[args.post_id];
    return text({ posts: posts ?? (typeof args.post_id === 'string' ? [{ ...dmDana, id: args.post_id }] : []) });
  }
  if (name === 'mattermost_search') return text({ posts: within(mentions) });
  return { isError: true, content: [{ type: 'text', text: `unsupported tool ${name}` }] };
});
await server.connect(new StdioServerTransport());
