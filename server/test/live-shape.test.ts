import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanMailBody, cutAtSentence, shapeGcalList, shapeGmailList, shapeGmailRead, shapeLuxKnowledge, shapeMattermost,
  KNOWLEDGE_HITS, MATTERMOST_MESSAGE_CHARS,
} from '../tools/live-shape.js';

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

test('lux get_insight cuts an over-long body with the get_insight ids follow-up named', () => {
  const shaped = shapeLuxKnowledge('get_insight', JSON.stringify({ id: 7, insight_title: 'Deep body', content: 'Sentence one. '.repeat(400) }));
  assert.equal(shaped.partial, true);
  assert.match(shaped.text, /call get_insight with ids=\[7\]/);
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
