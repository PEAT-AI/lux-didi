import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanMailBody, cutAtSentence, noEmptyResult, shapeGcalList, shapeGmailList, shapeGmailRead, shapeLuxKnowledge, shapeMattermost,
  CALENDAR_EVENT_CHARS, GMAIL_BODY_CHARS, GMAIL_LIST_EXCERPT_CHARS, KNOWLEDGE_EXCERPT_CHARS, KNOWLEDGE_HITS, KNOWLEDGE_RANKED_EXCERPT_CHARS, KNOWLEDGE_RANKED_TOTAL_CHARS, LIVE_RESULT_CHARS, MATTERMOST_CHANNELS, MATTERMOST_MESSAGE_CHARS, MATTERMOST_MESSAGES,
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

test('gmail read decodes entities in the header and the plain-text body to text', () => {
  const shaped = shapeGmailRead({ headers: { Subject: 'Q&amp;A &#39;now&#39;', From: 'Dana <d@example.invalid>', Date: 'Mon, 1 Jan 2024 00:00:00 +0000' }, body: "tom&#39;s &lt;note&gt; &amp; done" });
  assert.match(shaped.text, /subject: Q&A 'now'/);
  assert.match(shaped.text, /tom's <note> & done/);
});

test('gmail read omits an absent sender and date instead of printing the word unknown', () => {
  const shaped = shapeGmailRead({ headers: { Subject: 'Only a subject' }, body: 'hello' });
  assert.equal(shaped.text.includes('unknown'), false);
  // The read ends with the source's own body-coverage status, which is not a missing field.
  assert.match(shaped.text, /^subject: Only a subject\n\nhello\n\[Source inline body completeness is unverified\.\]$/);
});

test('gmail read reports a body cut as final, never mid-sentence and never promising a re-read', () => {
  const body = 'First sentence. Second sentence. Third sentence. '.repeat(600);
  const shaped = shapeGmailRead({ headers: HEADERS, body });
  assert.equal(shaped.partial, true);
  assert.match(shaped.text, /\[omitted: \d+ received characters of body omitted from this display\]/);
  assert.equal(shaped.text.includes('ask for more'), false);
  assert.match(shaped.text.split('\n\n[omitted:')[0]!.trimEnd(), /[.?!]$/);
});

test('gmail list keeps sender, date, snippet, unread flag and thread size for every message', () => {
  const shaped = shapeGmailList({ messages: [
    { id: 'm1', headers: { Subject: 'One', From: 'A <a@example.invalid>', Date: 'Mon' }, snippet: 'hello there', labelIds: ['UNREAD'], threadSize: 3 },
    { id: 'm2', headers: { Subject: 'Two', From: 'B <b@example.invalid>', Date: 'Tue' } },
  ] });
  assert.match(shaped.text, /- One \| from: A \| date: Mon \[unread\] \(thread 3\) \| hello there/);
  assert.match(shaped.text, /- Two \| from: B \| date: Tue/);
  // A message with no id is not a readable page entry, so both entries here carry one.
  assert.equal(shaped.partial, false);
});

test('gmail list reads the helper list header array and decodes entities in the header and snippet', () => {
  const shaped = shapeGmailList({ messages: [{
    id: 'm1', threadId: 't1', snippet: 'it&#39;s &lt;ready&gt; &amp; set',
    headers: [
      { name: 'From', value: 'Dana &lt;dana@example.invalid&gt;' },
      { name: 'Subject', value: 'Q&amp;A' },
      { name: 'Date', value: 'Mon, 1 Jan 2024 00:00:00 +0000' },
    ],
  }] });
  assert.match(shaped.text, /- Q&A \| from: Dana \| date: Mon, 1 Jan 2024 00:00:00 \+0000 \| it's <ready> & set/);
});

test('gmail list omits a field the source lacks instead of printing the word unknown', () => {
  const shaped = shapeGmailList({ messages: [{ id: 'm1', snippet: 'a message with no headers' }] });
  assert.equal(shaped.text.includes('unknown'), false);
  assert.match(shaped.text, /^- \(no subject\) \| a message with no headers \[id m1\]$/m);
});

test('calendar list keeps time, title, location, attendees and conference presence within the event bound', () => {
  const shaped = shapeGcalList({ events: [{
    summary: 'Standup', location: 'Room 1', start: { dateTime: '2024-01-01T09:00:00Z' }, htmlLink: 'https://calendar.google.com/event?eid=e1',
    attendees: [{ displayName: 'Dana' }, { email: 'kim@example.invalid' }], description: 'Daily sync', hangoutLink: 'https://meet.example/abc',
  }] });
  assert.match(shaped.text, /2024-01-01T09:00:00Z, Standup, Room 1/);
  assert.match(shaped.text, /attendees: Dana, kim@example\.invalid/);
  assert.match(shaped.text, /conference: yes/);
  assert.match(shaped.text, /Daily sync/);
  assert.equal(/https?:\/\//.test(shaped.text), false, 'calendar model text has no raw link url');
  assert.deepEqual(shaped.sources, [{ title: 'Calendar: Standup', url: 'https://calendar.google.com/event?eid=e1', sourceType: 'calendar' }]);
  assert.equal(shaped.text.length <= CALENDAR_EVENT_CHARS, true, 'one event stays within the per-event bound');
});

test('calendar events drop dial-in boilerplate', () => {
  const shaped = shapeGcalList({ events: [{
    summary: 'Standup', start: { dateTime: '2024-01-01T09:00:00Z' },
    description: 'Agenda: plan the week.\nJoin by phone: +1 555 0100 PIN: 1234\nMore phone numbers: https://dial.example/invite',
  }] });
  assert.match(shaped.text, /Agenda: plan the week\./);
  assert.equal(/dial[- ]?in|join by phone|more phone numbers|PIN:/i.test(shaped.text), false, 'dial-in boilerplate must not reach the model');
});

test('a long gmail list excerpt trims to 300 characters and a single read to 1500', () => {
  const long = 'Sentence. '.repeat(200);
  const list = shapeGmailList({ messages: [{ headers: { Subject: 'S' }, snippet: long }] });
  const snippet = list.text.split(' | ').at(-1)!.replace(/ \[id [^\]]*\]$/, '').split('\n')[0]!;
  assert.equal(snippet.length <= GMAIL_LIST_EXCERPT_CHARS, true, 'a list excerpt stays within the excerpt bound');
  assert.equal(list.text.includes(long), false, 'an unbounded snippet never reaches the model');
  const read = shapeGmailRead({ headers: HEADERS, body: long });
  const bodyText = read.text.split('\n\n')[1]!.split('\n\n[omitted:')[0]!;
  assert.equal(bodyText.length <= GMAIL_BODY_CHARS, true, 'a single-message read stays within the body bound');
  assert.equal(read.text.includes(long), false, 'the full unbounded body never reaches the model');
});

test('a knowledge search returns at most 3 hits with their bodies in one call', () => {
  const hits = Array.from({ length: 6 }, (_, index) => ({
    id: index + 1, insight_title: `Insight ${index + 1}`, insight_type: 'PATTERN', updated_at: '2026-10-14',
    content: `Body of insight ${index + 1}. ${'Detail. '.repeat(100)}`,
  }));
  const shaped = shapeLuxKnowledge('search_knowledge', JSON.stringify({ results: hits }));
  const headings = shaped.text.match(/^### /gm) ?? [];
  assert.equal(headings.length, KNOWLEDGE_HITS, 'only the top hits reach the model');
  assert.match(shaped.text, /Body of insight 1\./);
  assert.equal(shaped.text.includes('Insight 4'), false);
  const first = shaped.text.split('### ')[1]!;
  const body = first.split('\n').slice(1).join('\n').split('\n[omitted:')[0]!;
  assert.equal(body.length <= KNOWLEDGE_EXCERPT_CHARS, true, 'a search body stays within the excerpt bound');
});

test('a 60-post Mattermost payload shapes to at most 8 posts and at most 2000 characters', () => {
  const posts = Array.from({ length: 60 }, (_, index) => ({
    channel: 'harbour', author: 'river', time: `2026-10-11T10:${String(index % 60).padStart(2, '0')}:00Z`,
    text: `Message ${index}. ${'detail '.repeat(60)}`, permalink: `https://chat.example.invalid/pl/${index}`,
  }));
  const shaped = shapeMattermost('mattermost_get_channel_history', { posts });
  const shown = shaped.text.split('\n').filter(line => line.startsWith('**')).length;
  assert.equal(shown <= MATTERMOST_MESSAGES, true, 'only the bounded posts reach the model');
  assert.equal(shaped.text.length <= LIVE_RESULT_CHARS, true, 'a single Live tool result stays within the hard cap');
});

test('mattermost keeps text, author, channel, timestamp, reactions and thread position; drops system posts', () => {
  const shaped = shapeMattermost('mattermost_get_channel_history', { posts: [
    { channel: 'town-square', author: 'Rob', time: '2026-10-11T10:00:00Z', text: 'Standup at ten', permalink: 'https://chat.example/pl/abc', reactions: [{ emoji: 'thumbsup' }, { emoji: 'tada' }], reply_count: 2 },
    { channel: 'town-square', author: 'system', time: '2026-10-11T10:01:00Z', text: 'dana joined the channel' },
  ] });
  assert.match(shaped.text, /town-square \| Rob \| 2026-10-11T10:00:00Z \(2 reactions\) \(2 replies\)/);
  assert.match(shaped.text, /Standup at ten/);
  assert.equal(/https?:\/\//.test(shaped.text), false, 'mattermost model text has no raw permalink');
  assert.deepEqual(shaped.sources, [{ title: 'Mattermost: #town-square', url: 'https://chat.example/pl/abc', sourceType: 'mattermost' }]);
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
  assert.match(shaped.text, /### Insight 1 \(TECHNICAL_DECISION \| 2026-10-14\) \[id 1\]/);
  assert.match(shaped.text, new RegExp(`\\[omitted: 5 more hits; call search_knowledge again with limit=${hits.length}`));
  assert.equal(shaped.partial, true);
  assert.equal(shaped.text.includes('Insight 21'), false);
});

test('lux get_insight returns the full body, and the search excerpt names research for the rest', () => {
  const content = 'Sentence one. '.repeat(400); // ~5600 chars, over the 1200 excerpt bound but under the body bound
  const shaped = shapeLuxKnowledge('get_insight', JSON.stringify({ id: 7, insight_title: 'Deep body', content }));
  assert.equal(shaped.partial, false);
  assert.equal(shaped.text.includes('[omitted:'), false);
  assert.equal(shaped.text.includes(content), true, 'the whole insight body must reach the model');
  const excerpt = shapeLuxKnowledge('search_knowledge', JSON.stringify({ results: [{ id: 7, insight_title: 'Deep body', content }] }));
  assert.equal(excerpt.partial, true);
  // ROUTE-1022 K15: the live session reaches a stored note through research, never get_insight.
  assert.match(excerpt.text, /ask research with ids=\[7\] for the whole note/);
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
  assert.equal(/https?:\/\//.test(shaped.text), false, 'mattermost search text has no raw permalink');
  assert.match(shaped.text, /^open: L\d+ = Mattermost: #harbour$/m, 'the post permalink became a handle line');
  assert.deepEqual(shaped.sources, [
    { title: 'Mattermost: #harbour', url: 'https://chat.example.invalid/t/harbour/pl/p2', sourceType: 'mattermost' },
    { title: 'Mattermost: #harbour', url: 'https://chat.example.invalid/t/harbour/pl/p1', sourceType: 'mattermost' },
  ]);
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

test('mattermost channel list distinguishes archive sync time from message activity', () => {
  const shaped = shapeMattermost('mattermost_list_channels', CHANNELS);
  const lines = shaped.text.split('\n').filter(line => line.startsWith('- '));
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /Harbour/);
  assert.match(lines[0]!, /128 posts/);
  assert.match(lines[0]!, /archive synced 2026-10-11T10:10:00\.000Z/);
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
  assert.equal(/https?:\/\//.test(shaped.text), false, 'mattermost model text has no raw link url');
  assert.deepEqual(shaped.sources, [
    { title: 'Mattermost: #harbour', url: 'https://chat.example.invalid/t/harbour/pl/p2', sourceType: 'mattermost' },
    { title: 'Mattermost: #harbour', url: 'https://chat.example.invalid/t/harbour/pl/p1', sourceType: 'mattermost' },
  ]);
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
  // VOICE-R2: the note names the source and the query, tells the model to speak it in its own words and only
  // when the owner asked about that source, and never returns the bare canned "No results."
  const note = noEmptyResult('', 'search_mail', 'budget from Ana');
  assert.match(note, /search_mail/, 'the note names the source');
  assert.match(note, /budget from Ana/, 'the note names the query');
  assert.match(note, /in your own words/, 'the model is told to phrase it itself');
  assert.match(note, /only if the owner asked/, 'an unasked empty read stays unspoken');
  assert.equal(note.includes('No results.'), false, 'the canned empty line is gone');
  assert.equal(noEmptyResult('  \n ', 'search_mail').includes('for "'), false, 'no empty query is quoted');
  assert.equal(noEmptyResult('kept'), 'kept', 'a non-empty projection is untouched');
});

test('mattermost whoami (username/email record) reports the operator name', () => {
  const shaped = shapeMattermost('mattermost_whoami', WHOAMI);
  assert.match(shaped.text, /river/);
});

// The remote lux-knowledge search returns its digest as Markdown: a leading H1 header and an
// italic retrieval-metadata line above the hits. Neither may reach the Live model or the answer
// card (#254); the hits and their ids stay.
const SEARCH_MARKDOWN = [
  "# Knowledge Search: 'naya live answer card'",
  '',
  '_confidence: low · mode: fast_path_ · top score: 1.01 · relevant candidate: yes',
  '',
  '_739 sensitive row(s) withheld; pass include_sensitive=true to see them_',
  '',
  '**#89817** [TECHNICAL_DECISION] Didi Live tool orchestration roadmap',
  '  excerpt line',
  '  Score: 1.007',
  '',
  '_low confidence: results may not contain an answer, treat as leads_',
].join('\n');

test('a markdown knowledge search never carries its header or retrieval metadata', () => {
  const shaped = shapeLuxKnowledge('search_knowledge', SEARCH_MARKDOWN);
  assert.equal(/Knowledge Search/.test(shaped.text), false, 'the search header is stripped');
  assert.equal(/confidence|top score|relevant candidate|mode:/.test(shaped.text), false, 'the retrieval metadata line is stripped');
  assert.equal(shaped.text.startsWith('#'), false, 'a tool result never starts with a markdown heading');
  assert.match(shaped.text, /#89817/, 'the hits and ids stay');
  assert.match(shaped.text, /Didi Live tool orchestration roadmap/);
});

test('a knowledge tool result never starts with an H1 or H2', () => {
  const hits = [{ id: 1, insight_title: 'Insight 1', insight_type: 'PATTERN', updated_at: '2026-10-14', content: 'Body.' }];
  const shaped = shapeLuxKnowledge('search_knowledge', JSON.stringify({ results: hits }));
  assert.equal(/^#{1,2} /m.test(shaped.text), false, 'no H1/H2 heading survives shaping');
  assert.match(shaped.text, /### Insight 1 \(PATTERN \| 2026-10-14\) \[id 1\]/);
});

test('R6: organizer renders, and a capped attendee list says and others', () => {
  const shaped = shapeGcalList({ events: [{
    summary: 'Third-party sync', start: { dateTime: '2024-01-01T09:00:00Z' },
    attendees: [{ displayName: 'Dana', responseStatus: 'accepted' }, { email: 'kim@example.invalid', responseStatus: 'tentative' }],
    attendeesOmitted: true, organizer: { email: 'rob@example.invalid', displayName: 'Rob' },
  }] });
  assert.match(shaped.text, /attendees: Dana, kim@example\.invalid and others/u);
  assert.match(shaped.text, /organizer: Rob/u);
});

// O-R1: the owner's 18:34 IST call asked lux-knowledge for six bodies and heard "1 of 1 shown" from a
// 17 KB ranked reply, because the fallback cut the whole Markdown at the 1,500-character Gmail bound.
function rankedHit(id: number, title: string, body: string): string {
  return [`**#${id}** [TECHNICAL_DECISION] ${title}`, body, '  Score: 1.00' + String(id).slice(-2), ''].join('\n');
}
function ranked(parts: readonly string[]): string {
  return ["# Knowledge Search: 'ocp prep call'", '', '_confidence: high | top score: 1.01 | relevant candidate: yes', '', ...parts].join('\n');
}

// ROUTE-1022 K15/K17: the note names the tool the live session really has (research, never get_insight),
// and the coverage line takes the hit count the server states rather than the count that fit.
test('ROUTE-1022 K15: a cut knowledge excerpt tells the model to ask research, never get_insight', () => {
  const body = 'Sentence about the prep call. '.repeat(40);
  const excerpt = shapeLuxKnowledge('search_knowledge', JSON.stringify({ results: [{ id: 4242, insight_title: 'Prep', content: body }] }));
  assert.equal(excerpt.text.includes('get_insight'), false, 'the live session has no get_insight tool');
  assert.match(excerpt.text, /ask research with ids=\[4242\] for the whole note/);
  const rankedText = shapeLuxKnowledge('search_knowledge', ranked([
    rankedHit(91001, 'First', body), rankedHit(91002, 'Second', body),
  ]));
  assert.equal(rankedText.text.includes('get_insight'), false);
  assert.match(rankedText.text, /ask research again with ids=\[\d+\] for this note's whole text/);
});

test('ROUTE-1022 K17: the coverage line uses the hit count the server states', () => {
  const shaped = shapeLuxKnowledge('search_knowledge', [
    "# Knowledge Search: 'ocp prep call' (6 hits)",
    '',
    '_confidence: high | top score: 1.01 | relevant candidate: yes',
    '',
    ...Array.from({ length: 5 }, (_, index) => rankedHit(92000 + index, `Insight ${index}`, 'Sentence about the prep call.')),
  ].join('\n'));
  assert.match(shaped.text, /\[showing 5 of 6 hits;/, 'the server said six hits, and the line says six');
  assert.equal(shaped.partial, true, 'a reply that carried five of six is partial');
});

test('O-R1: a six hit ranked knowledge reply reaches the model as six hits inside its own budget', () => {
  const body = 'Sentence about the prep call. '.repeat(40);
  const text = ranked(Array.from({ length: 6 }, (_, index) => rankedHit(91100 + index, `Insight ${index}`, body)));
  const shaped = shapeLuxKnowledge('search_knowledge', text);
  for (let index = 0; index < 6; index += 1) assert.match(shaped.text, new RegExp(`\\*\\*#${91100 + index}\\*\\*`), `hit ${index} stays`);
  assert.equal(shaped.text.includes('[showing'), false, 'six hits fit the total bound, so none is trimmed');
  assert.ok(shaped.text.length <= KNOWLEDGE_RANKED_TOTAL_CHARS, `the shaped text stays under the knowledge total bound (${shaped.text.length})`);
  assert.match(shaped.text, /Score: 1\./, 'every kept hit keeps its score line');
});

test('O-R1: more hits than the total bound allows never drop silently', () => {
  const body = 'Sentence about the prep call. '.repeat(40);
  const text = ranked(Array.from({ length: 12 }, (_, index) => rankedHit(91200 + index, `Insight ${index}`, body)));
  const shaped = shapeLuxKnowledge('search_knowledge', text);
  assert.match(shaped.text, /\[showing \d+ of 12 hits; ask a narrower question or a higher limit for the rest\]/);
  assert.ok(shaped.text.length <= KNOWLEDGE_RANKED_TOTAL_CHARS + 200, `the trimmed text stays near its bound (${shaped.text.length})`);
  assert.equal(shaped.partial, true, 'a trimmed read is partial');
});

test('O-R1: one long body still cuts at a sentence and says how much it left out', () => {
  const shaped = shapeLuxKnowledge('search_knowledge', 'A plain long note. '.repeat(1000));
  assert.match(shaped.text, /\[omitted: \d+ characters; final, this read has no paging argument\]/);
  assert.ok(shaped.text.length <= 1600, `the single body keeps its old bound (${shaped.text.length})`);
});

// MED-1022: `detail: voice` answers the top hit in full and names each further hit on one bullet, in
// the same ranked reply the bodies shape sends, so every hit must still reach the model.
function voiceReply(topBody: string): string {
  return [
    "# Knowledge Search: 'ocp prep call'",
    '',
    '_confidence: high | top score: 1.01 | relevant candidate: yes',
    '',
    '**#91293** [TECHNICAL_DECISION] Commitment 2026-10-22',
    `  ${topBody}`,
    '  truncated: no (1,822 chars stored)',
    '  Score: 1.007 · status: relevant',
    ...Array.from({ length: 5 }, (_, index) => `- **#${91100 + index}** [PATTERN] Insight ${index}: ${'Snippet about the prep call. '.repeat(8)}`),
    '',
    'more: #90938',
  ].join('\n');
}

test('MED-1022: a voice knowledge reply reaches the model as every hit, the top body whole', () => {
  const body = `${'Sentence about the prep call. '.repeat(60)}Final sentence marker.`;
  const shaped = shapeLuxKnowledge('search_knowledge', voiceReply(body));
  assert.ok(shaped.text.includes('Final sentence marker.'), 'the top hit body is not cut at the ranked excerpt bound');
  assert.match(shaped.text, /\*\*#91293\*\*/u);
  for (let index = 0; index < 5; index += 1) assert.match(shaped.text, new RegExp(`\\*\\*#${91100 + index}\\*\\*`, 'u'), `hit ${index} reaches the model`);
  assert.equal(shaped.text.includes('[showing'), false, 'six hits fit the voice budget, so none is trimmed');
  assert.equal(shaped.text.includes('Knowledge Search'), false, 'the search header is still stripped');
});

test('MED-1022: a voice reply that found one entry arrives whole, with no get_insight tail', () => {
  const body = `${'Sentence about the prep call. '.repeat(70)}Final sentence marker.`;
  assert.ok(body.length > KNOWLEDGE_RANKED_EXCERPT_CHARS, `the fixture body is longer than an excerpt (${body.length})`);
  const shaped = shapeLuxKnowledge('search_knowledge', [
    "# Knowledge Search: 'ocp prep call'",
    '',
    '**#91293** [TECHNICAL_DECISION] Commitment 2026-10-22',
    `  ${body}`,
    '  truncated: no (2,037 chars stored)',
    '  Score: 1.007',
  ].join('\n'));
  assert.ok(shaped.text.includes('Final sentence marker.'), 'the one hit body is not cut to an excerpt');
  assert.equal(shaped.partial, false, 'nothing was left out, so the result is whole');
  assert.equal(shaped.text.includes('get_insight'), false, 'and no round trip is asked for');
});

test('#574: a twelve person event prints eight names and and others, and an empty one prints no line', () => {
  const many = Array.from({ length: 12 }, (_, n) => ({ displayName: `P${n}` }));
  const shaped = shapeGcalList({ events: [{ summary: 'Design review', start: { dateTime: '2026-10-19T09:00:00Z' }, attendees: many }] });
  assert.match(shaped.text, /attendees: P0, P1, P2, P3, P4, P5, P6, P7 and others/);
  assert.doesNotMatch(shaped.text, /P8/, 'the ninth name is never spoken');
  const empty = shapeGcalList({ events: [{ summary: 'Focus block', start: { dateTime: '2026-10-19T11:00:00Z' }, attendees: [] }] });
  assert.equal(/attendees/.test(empty.text), false, 'an event with nobody on it carries no attendees line');
});
