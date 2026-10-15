import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanMailBody, cutAtSentence, noEmptyResult, shapeGcalList, shapeGmailList, shapeGmailRead, shapeLuxKnowledge, shapeMattermost,
  KNOWLEDGE_HITS, MATTERMOST_CHANNELS, MATTERMOST_MESSAGE_CHARS,
} from '../tools/live-shape.js';
// Synthetic Mattermost upstream shapes (mattermost-mcp src/search/serialize.ts and REST v4
// /posts). Invented names and text only. These are W12's committed fixtures: every one of them
// shaped to '' at train head, which is the defect they pin.
const WHOAMI = { id: 'u1', username: 'river', email: 'river@example.invalid' };
const SEARCH_RESULTS = {
  total: 2,
  returned: 2,
  results: [
    { id: 'p1', username: 'river', channel: 'harbour', timestamp: '2026-10-11T10:00:00.000Z', message: 'Mooring drift log is ready', url: 'https://chat.example.invalid/t/harbour/pl/p1', channelName: 'harbour', rootId: '', replyCount: 3, editedAt: null, score: 0.91 },
    { id: 'p2', username: 'ash', channel: 'harbour', timestamp: '2026-10-11T10:05:00.000Z', message: 'Reviewed the mooring drift log', url: 'https://chat.example.invalid/t/harbour/pl/p2', channelName: 'harbour', rootId: '', replyCount: 0, editedAt: null, score: 0.72 },
  ],
};
const SEARCH_EMPTY = { total: 0, returned: 0, results: [] };
const THREAD = {
  root: { id: 'p1', username: 'river', channel: 'harbour', timestamp: '2026-10-11T10:00:00.000Z', message: 'Mooring drift log is ready', url: 'https://chat.example.invalid/t/harbour/pl/p1', channelName: 'harbour', rootId: '', replyCount: 1, editedAt: null },
  replies: [
    { id: 'p2', username: 'ash', channel: 'harbour', timestamp: '2026-10-11T10:05:00.000Z', message: 'Reviewed the mooring drift log', url: 'https://chat.example.invalid/t/harbour/pl/p2', channelName: 'harbour', rootId: 'p1', replyCount: 0, editedAt: null },
  ],
  attachments: { p1: [{ name: 'drift.csv', extension: 'csv', size: 2048 }] },
};
const CHANNELS = {
  count: 2,
  channels: [
    { id: 'c1', name: 'harbour', displayName: 'Harbour', team: 'ops', type: 'O', posts: 128, lastSyncAt: '2026-10-11T10:10:00.000Z', archived: false, archivedAt: null },
    { id: 'c2', name: 'dry-dock', displayName: 'Dry Dock', team: 'ops', type: 'O', posts: 4, lastSyncAt: '2026-10-01T00:00:00.000Z', archived: true, archivedAt: '2026-10-02T00:00:00.000Z' },
  ],
};
const REST_POSTS = {
  order: ['r2', 'r1'],
  posts: {
    r1: { id: 'r1', create_at: 1760176800000, update_at: 1760176800000, user_id: 'u1', channel_id: 'c1', message: 'Tide table pinned', type: '' },
    r2: { id: 'r2', create_at: 1760176860000, update_at: 1760176860000, user_id: 'u2', channel_id: 'c1', message: 'Crane booked for Tuesday', type: '' },
    r3: { id: 'r3', create_at: 1760176920000, update_at: 1760176920000, user_id: 'u1', channel_id: 'c1', message: 'ash joined the channel', type: 'system_join_channel' },
  },
};
const ITEMS = {
  items: [
    { channel: 'harbour', author: 'river', time: '2026-10-11T10:00:00Z', text: 'Mooring drift log is ready', permalink: 'https://chat.example.invalid/t/harbour/pl/p1' },
    { channel: 'harbour', author: 'ash', time: '2026-10-11T10:05:00Z', text: 'Reviewed the mooring drift log', permalink: 'https://chat.example.invalid/t/harbour/pl/p2' },
  ],
};
const UNRECOGNISED = { blocks: [{ kind: 'canvas', ref: 'x1' }], cursor: 'next' };

// Rich, clean shaping of synthetic tool results. No real account, message or corpus.
const HEADERS = { Subject: 'Launch plan', From: 'Dana <dana@example.invalid>', To: 'rob@example.invalid', Cc: 'kim@example.invalid', Date: 'Mon, 1 Jan 2024 00:00:00 +0000' };

test('gmail read keeps every field and strips HTML, quotes, signature, base64 and tracking URLs', () => {
  const body = '<p>The plan is ready.</p><script>evil()</script><img src="data:image/png;base64,AAAA">\nReal tail text.\n> quoted history\n> more history\n-- \nSent from my phone\nhttps://tracker.example/click?utm_source=x';
  const shaped = shapeGmailRead({ headers: HEADERS, labelIds: ['INBOX', 'UNREAD'], attachments: [{ filename: 'plan.pdf' }], body });
  assert.match(shaped.text, /subject: Launch plan/);
  assert.match(shaped.text, /from: Dana/);
  assert.match(shaped.text, /to: rob@example\.invalid/);
  assert.match(shaped.text, /cc: kim@example\.invalid/);
  assert.match(shaped.text, /date: Mon, 1 Jan 2024/);
  assert.match(shaped.text, /labels: INBOX, UNREAD/);
  assert.match(shaped.text, /attachments: plan\.pdf/);
  assert.match(shaped.text, /The plan is ready\./);
  assert.match(shaped.text, /Real tail text\./, 'text after an inline image must survive');
  assert.equal(shaped.text.includes('quoted history'), false, 'quoted chain must be stripped');
  assert.equal(shaped.text.includes('Sent from my phone'), false, 'signature must be stripped');
  assert.equal(shaped.text.includes('<p>'), false, 'HTML must be converted to text');
  assert.equal(shaped.text.includes('base64'), false, 'inline image data must be stripped');
  assert.equal(shaped.text.includes('evil()'), false, 'script content must be dropped');
  assert.equal(shaped.text.includes('utm_source'), false, 'tracking URL must be stripped');
});

test('gmail read reports a body cut as final, never mid-sentence and never promising a re-read', () => {
  const body = 'First sentence. Second sentence. Third sentence. '.repeat(600);
  const shaped = shapeGmailRead({ headers: HEADERS, body });
  assert.equal(shaped.partial, true);
  assert.match(shaped.text, /\[omitted: \d+ characters of body; final/);
  assert.equal(shaped.text.includes('ask for more'), false);
  assert.match(shaped.text.split('\n\n[omitted:')[0]!.trimEnd(), /[.?!]$/);
});

test('gmail list keeps sender, date, snippet, unread flag and thread size for every message', () => {
  const shaped = shapeGmailList({ messages: [
    { headers: { Subject: 'One', From: 'A <a@example.invalid>', Date: 'Mon' }, snippet: 'hello there', labelIds: ['UNREAD'], threadSize: 3 },
    { headers: { Subject: 'Two', From: 'B <b@example.invalid>', Date: 'Tue' } },
  ] });
  assert.match(shaped.text, /- One \| A \| Mon \[unread\] \(thread 3\) \| hello there/);
  assert.match(shaped.text, /- Two \| B \| Tue/);
  assert.equal(shaped.partial, false);
});

test('calendar list keeps time, title, location, attendees, description and conference presence', () => {
  const shaped = shapeGcalList({ events: [{
    summary: 'Standup', location: 'Room 1', start: { dateTime: '2024-01-01T09:00:00Z' }, htmlLink: 'https://calendar.google.com/event?eid=e1',
    attendees: [{ displayName: 'Dana' }, { email: 'kim@example.invalid' }], description: 'Daily sync', hangoutLink: 'https://meet.example/abc',
  }] });
  assert.match(shaped.text, /2024-01-01T09:00:00Z, Standup, Room 1/);
  assert.match(shaped.text, /attendees: Dana, kim@example\.invalid/);
  assert.match(shaped.text, /conference: yes/);
  assert.match(shaped.text, /Daily sync/);
  assert.match(shaped.text, /source: https:\/\/calendar\.google\.com\/event\?eid=e1/);
});

test('mattermost keeps text, author, channel, timestamp, reactions and thread position; drops system posts', () => {
  const shaped = shapeMattermost('mattermost_get_channel_history', { posts: [
    { channel: 'town-square', author: 'Rob', time: '2026-10-11T10:00:00Z', text: 'Standup at ten', permalink: 'https://chat.example/pl/abc', reactions: [{ emoji: 'thumbsup' }, { emoji: 'tada' }], reply_count: 2 },
    { channel: 'town-square', author: 'system', time: '2026-10-11T10:01:00Z', text: 'dana joined the channel' },
  ] });
  assert.match(shaped.text, /town-square \| Rob \| 2026-10-11T10:00:00Z \(2 reactions\) \(2 replies\)/);
  assert.match(shaped.text, /Standup at ten/);
  assert.match(shaped.text, /source: https:\/\/chat\.example\/pl\/abc/);
  assert.equal(shaped.text.includes('joined the channel'), false, 'system join/leave posts must be dropped');
});

test('mattermost reports a per-message cut as final and never mid-sentence', () => {
  const shaped = shapeMattermost('mattermost_get_channel_history', { posts: [
    { channel: 'town-square', author: 'Rob', time: 't', text: 'Word. '.repeat(MATTERMOST_MESSAGE_CHARS) },
  ] });
  assert.equal(shaped.partial, true);
  assert.match(shaped.text, /\[omitted: \d+ characters; final/);
  assert.match(shaped.text.split('[omitted:')[0]!.trimEnd(), /[.?!]$/);
});

test('lux search keeps title, type, date, id and a substantial excerpt, and names a real follow-up argument', () => {
  const hits = Array.from({ length: KNOWLEDGE_HITS + 5 }, (_, index) => ({
    id: index + 1, insight_title: `Insight ${index + 1}`, insight_type: 'TECHNICAL_DECISION', updated_at: '2026-10-14',
    content: `Body of insight ${index + 1}. `.repeat(20),
  }));
  const shaped = shapeLuxKnowledge('search_knowledge', JSON.stringify({ results: hits }));
  assert.match(shaped.text, /## Insight 1 \(TECHNICAL_DECISION \| 2026-10-14\) \[id 1\]/);
  assert.match(shaped.text, new RegExp(`\\[omitted: 5 more hits; call search_knowledge again with limit=${hits.length}`));
  assert.equal(shaped.partial, true);
  assert.equal(shaped.text.includes('Insight 21'), false);
});

test('lux get_insight returns the full body, so the search excerpt follow-up is honest', () => {
  const content = 'Sentence one. '.repeat(400); // ~5600 chars, over the 1200 excerpt bound but under the body bound
  const shaped = shapeLuxKnowledge('get_insight', JSON.stringify({ id: 7, insight_title: 'Deep body', content }));
  assert.equal(shaped.partial, false);
  assert.equal(shaped.text.includes('[omitted:'), false);
  assert.equal(shaped.text.includes(content), true, 'the whole insight body must reach the model');
  const excerpt = shapeLuxKnowledge('search_knowledge', JSON.stringify({ results: [{ id: 7, insight_title: 'Deep body', content }] }));
  assert.equal(excerpt.partial, true);
  assert.match(excerpt.text, /call get_insight with ids=\[7\]/);
});

test('plain non-JSON knowledge payloads pass through untouched', () => {
  const shaped = shapeLuxKnowledge('search_knowledge', 'nonempty synthetic α insight');
  assert.equal(shaped.text, 'nonempty synthetic α insight');
  assert.equal(shaped.partial, false);
  assert.equal(shaped.omittedCharacters, 0);
});

test('cutAtSentence and cleanMailBody strip MIME boilerplate without mid-sentence cuts', () => {
  assert.equal(cleanMailBody('Content-Type: text/plain\nHello world.'), 'Hello world.');
  const cut = cutAtSentence('Alpha. Beta. Gamma.', 12);
  assert.equal(cut.text, 'Alpha. Beta.');
  assert.equal(cut.omitted, ' Gamma.'.length);
});

test('a boundary-free run-on is cut at the last whole word, never mid-word', () => {
  const cut = cutAtSentence('This is one very long runon sentence that never has a period until the very end here', 30);
  assert.equal(cut.text, 'This is one very long runon');
  assert.equal(/\s/u.test(cut.text.at(-1) ?? ''), false, 'the cut never ends mid-word or on whitespace');
  assert.equal(cut.omitted > 0, true);
});

// --- W12: every Mattermost read shape is recognised, and an empty read is never silent ---

test('mattermost search results (results array) shape with author, channel and permalink', () => {
  const shaped = shapeMattermost('mattermost_search', SEARCH_RESULTS);
  assert.match(shaped.text, /harbour \| river \| 2026-10-11T10:00:00\.000Z/);
  assert.match(shaped.text, /Mooring drift log is ready/);
  assert.match(shaped.text, /source: https:\/\/chat\.example\.invalid\/t\/harbour\/pl\/p1/);
  assert.equal(shaped.text.length > 0, true);
});

test('mattermost thread root and replies both shape', () => {
  const shaped = shapeMattermost('mattermost_get_thread', THREAD);
  assert.match(shaped.text, /Mooring drift log is ready/);
  assert.match(shaped.text, /Reviewed the mooring drift log/);
});

test('mattermost channel list (channels array) shapes display names', () => {
  const shaped = shapeMattermost('mattermost_list_channels', CHANNELS);
  assert.match(shaped.text, /- Harbour/);
  assert.match(shaped.text, /- Dry Dock/);
});

test('mattermost channel list is ranked by activity and carries posts and last activity', () => {
  const shaped = shapeMattermost('mattermost_list_channels', CHANNELS);
  const lines = shaped.text.split('\n').filter(line => line.startsWith('- '));
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /Harbour/);
  assert.match(lines[0]!, /128 posts/);
  assert.match(lines[0]!, /last activity 2026-10-11T10:10:00\.000Z/);
  assert.match(lines[1]!, /Dry Dock/);
  assert.equal(shaped.text.includes('display_name'), false);
});

test('a 1753-channel payload shapes to at most the cap and notes the omission', () => {
  const channels = Array.from({ length: 1753 }, (_, index) => ({
    id: `c${index}`, name: `channel-${index}`, displayName: `Channel ${index}`, team: 'ops', type: 'O',
    posts: index, lastSyncAt: '2026-10-11T00:00:00.000Z', archived: false, archivedAt: null,
  }));
  const shaped = shapeMattermost('mattermost_list_channels', { count: channels.length, channels });
  const lines = shaped.text.split('\n').filter(line => line.startsWith('- '));
  assert.equal(lines.length, MATTERMOST_CHANNELS, 'a 1753-channel dump never reaches the model in full');
  assert.match(shaped.text, /\[omitted: 1713 more channels;/);
  assert.match(lines[0]!, /Channel 1752/);
  assert.match(lines[0]!, /1752 posts/);
});

test('mattermost channel history shapes newest first, keeping the permalink', () => {
  const shaped = shapeMattermost('mattermost_get_channel_history', { posts: [
    { channel: 'harbour', author: 'river', timestamp: '2026-10-11T10:00:00.000Z', message: 'Older note', url: 'https://chat.example.invalid/t/harbour/pl/p1' },
    { channel: 'harbour', author: 'ash', timestamp: '2026-10-11T10:05:00.000Z', message: 'Newer note', url: 'https://chat.example.invalid/t/harbour/pl/p2' },
  ] });
  assert.equal(shaped.text.indexOf('Newer note') < shaped.text.indexOf('Older note'), true, 'the most recent post leads');
  assert.match(shaped.text, /source: https:\/\/chat\.example\.invalid\/t\/harbour\/pl\/p2/);
});

test('mattermost search results shape newest first', () => {
  const shaped = shapeMattermost('mattermost_search', SEARCH_RESULTS);
  assert.equal(shaped.text.indexOf('Reviewed the mooring drift log') < shaped.text.indexOf('Mooring drift log is ready'), true, 'recency questions lead with the newest hit');
});

test('mattermost REST id-map posts are shaped newest first and system posts dropped', () => {
  const shaped = shapeMattermost('mattermost_get_channel_history', REST_POSTS);
  assert.equal(shaped.text.length > 0, true);
  assert.equal(shaped.text.indexOf('Crane booked for Tuesday') < shaped.text.indexOf('Tide table pinned'), true);
  assert.equal(shaped.text.includes('joined the channel'), false);
});

test('mattermost REST id-map posts ignore an oldest-first order and shape newest first', () => {
  const shaped = shapeMattermost('mattermost_get_channel_history', {
    order: ['r1', 'r2'],
    posts: {
      r1: { id: 'r1', create_at: 1760176800000, message: 'Tide table pinned', type: '' },
      r2: { id: 'r2', create_at: 1760176860000, message: 'Crane booked for Tuesday', type: '' },
    },
  });
  assert.equal(shaped.text.indexOf('Crane booked for Tuesday') < shaped.text.indexOf('Tide table pinned'), true);
});

test('mattermost items wrapper shapes', () => {
  const shaped = shapeMattermost('mattermost_search', ITEMS);
  assert.match(shaped.text, /harbour \| river \| 2026-10-11T10:00:00Z/);
});

test('a genuinely empty Mattermost read returns an explicit note, never an empty string', () => {
  assert.equal(shapeMattermost('mattermost_search', SEARCH_EMPTY).text, 'No messages matched.');
  assert.equal(shapeMattermost('mattermost_get_channel_history', { posts: [] }).text, 'No messages in this channel for that window.');
  assert.equal(shapeMattermost('mattermost_list_channels', { channels: [] }).text, 'No channels.');
});

test('an unrecognised Mattermost shape fails loud: raw text plus the shape marker', () => {
  const shaped = shapeMattermost('mattermost_search', UNRECOGNISED);
  assert.equal(shaped.text.length > 0, true);
  assert.match(shaped.text, /canvas/);
  assert.equal(shaped.shape, 'unrecognised');
});

test('noEmptyResult turns an empty completed projection into an explicit note', () => {
  assert.equal(noEmptyResult(''), 'No results.');
  assert.equal(noEmptyResult('  \n '), 'No results.');
  assert.equal(noEmptyResult('kept'), 'kept');
});

test('mattermost whoami (username/email record) reports the operator name', () => {
  const shaped = shapeMattermost('mattermost_whoami', WHOAMI);
  assert.match(shaped.text, /river/);
});
