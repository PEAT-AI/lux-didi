import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evidenceMarkup, NO_ANSWER_WORDS, partialWords, relativeWords, eventWords, sourcesMarkup, stepsMarkup,
} from '../src/markdown.ts';
import { stepFinished, stepRunning, stepsSummary } from '../src/tool-phrases.ts';
import type { ChatStep } from '../src/tool-phrases.ts';
import type { ToolEvidence } from '../src/protocol.ts';

// K4: the information architecture of one chat turn. The panel, lanes, composer and tokens are not
// under test here; only what a turn is made of, in the order the owner reads it.
const step = (over: Partial<ChatStep>): ChatStep => ({
  type: 'chat_step', runId: 'run-1', stepId: 's1', tool: 'mattermost_search', phase: 'start', ...over,
});
const NOW = Date.parse('2026-10-17T12:00:00Z');

test('a running turn shows one quiet line per tool, in the present tense', () => {
  const running = stepsMarkup([step({ stepId: 's1' }), step({ stepId: 's2', tool: 'gcal_list' })], false);
  assert.match(running, /^<ol class="chat-steps" role="status"/);
  assert.match(running, /Searching Mattermost\.\.\./);
  assert.match(running, /Checking your calendar\.\.\./);
  assert.equal(/<details/.test(running), false, 'nothing folds before the answer exists');
});

test('a finished step line counts its results and never shows a raw tool id', () => {
  const line = stepFinished(step({ phase: 'end', ok: true, ms: 640, resultCount: 13 }));
  assert.equal(line, 'Searched Mattermost, 13 results');
  assert.equal(stepFinished(step({ phase: 'end', resultCount: 1 })), 'Searched Mattermost, 1 result');
  assert.equal(stepFinished(step({ phase: 'end' })), 'Searched Mattermost');
  assert.equal(stepFinished(step({ tool: 'mongoose_search', phase: 'end', resultCount: 2 })), 'Used Mongoose, 2 results');
  assert.doesNotMatch(stepsMarkup([step({ phase: 'end' })], false), /mattermost_search|chat_step|run-1/);
  assert.equal(stepRunning(step({})), 'Searching Mattermost...');
});

test('after the answer the steps fold into one summary line that expands to the per-tool lines', () => {
  const steps = [
    step({ stepId: 's1', phase: 'end', resultCount: 13 }),
    step({ stepId: 's2', tool: 'mongoose_search', phase: 'end', resultCount: 4 }),
    step({ stepId: 's3', tool: 'gcal_list', phase: 'end', resultCount: 2 }),
  ];
  assert.equal(stepsSummary(steps), 'Checked Mattermost, Mongoose and Calendar');
  const folded = stepsMarkup(steps, true);
  assert.match(folded, /^<details class="chat-steps-done"><summary>Checked Mattermost, Mongoose and Calendar<\/summary>/);
  assert.match(folded, /Searched Mattermost, 13 results/);
  assert.match(folded, /Used Mongoose, 4 results/);
  assert.match(folded, /Checked your calendar, 2 results/);
  assert.equal(stepsMarkup([], true), '');
  assert.equal(stepsMarkup([step({ stepId: 's9' })], true), '', 'an unfinished step has no summary yet');
});

test('the answer is the only body text and its evidence is folded under it, newest first', () => {
  const evidence: ToolEvidence[] = [
    { name: 'mattermost_search', markdown: [
      '- lunch | alice | 2026-10-17T09:00:00Z | the release is on for friday',
      '- standup | bob | 2026-10-17T11:00:00Z | moving the sync to ten',
    ].join('\n'), sources: [{ title: 'Mattermost: moving the sync', url: 'https://mm.example.org/p/1' }] },
    { name: 'gmail_list', markdown: '- Quarterly numbers | from: Dana | date: 2026-10-16T08:00:00Z | the deck is ready', sources: [{ title: 'Gmail: Quarterly numbers', url: 'https://mail.example.org/1' }] },
    { name: 'gcal_list', markdown: '- 2026-10-17T14:30:00, Release review [id e1]', sources: [] },
    { name: 'search_knowledge', markdown: '### Release rhythm (PATTERN | 2026-10-10) [id 42]\nReleases ship on fridays.', sources: [] },
  ];
  const html = evidenceMarkup(evidence, NOW);
  // One folded block, never the raw shaped output as the body.
  assert.match(html, /^<details class="chat-evidence"><summary>Evidence<\/summary>/);
  assert.doesNotMatch(html, /class="markdown"/, 'no shaped tool text renders as markdown body');
  assert.doesNotMatch(html, /2026-10-17T09:00:00Z|\[id |\[post /, 'no ISO stamp and no raw id');
  // One section per source, with the source-appropriate one-line shape.
  assert.match(html, /<h4>Mattermost<\/h4>[\s\S]*standup · bob · 1 h ago[\s\S]*lunch · alice · 3 h ago/);
  assert.match(html, /chat-evidence-snippet">moving the sync to ten</);
  assert.match(html, /<h4>Gmail<\/h4>[\s\S]*Dana · Quarterly numbers · yesterday/);
  assert.match(html, /<h4>Calendar<\/h4>[\s\S]*14:30 · Release review/);
  assert.match(html, /<h4>Knowledge<\/h4>[\s\S]*Release rhythm · PATTERN/);
  assert.equal(evidenceMarkup([], NOW), '');
});

test('sources are one deduped chip row per answer, capped at three plus the count', () => {
  const source = (title: string, url?: string) => ({ title, url });
  const evidence: ToolEvidence[] = [
    { name: 'mattermost_search', markdown: '- chan | alice | 2026-10-17T09:00:00Z | hi', sources: [source('Mattermost: one', 'https://mm.example.org/p/1')] },
    { name: 'mattermost_get_thread', markdown: '- chan | alice | 2026-10-17T09:00:00Z | hi', sources: [source('Mattermost: one', 'https://mm.example.org/p/1'), source('Mattermost: two', 'https://mm.example.org/p/2')] },
    { name: 'gmail_list', markdown: '- s | from: Dana | date: 2026-10-16T08:00:00Z | x', sources: [source('Gmail: three', 'https://mail.example.org/3'), source('Gmail: four', 'https://mail.example.org/4')] },
  ];
  const html = sourcesMarkup(evidence);
  assert.equal((html.match(/href="https:\/\/mm\.example\.org\/p\/1"/g) ?? []).length, 1, 'the same source appears once');
  assert.equal(html.match(/class="answer-source"/g)?.length, 3, 'three chips');
  assert.match(html, /class="chat-sources-more">\+1</);
  assert.equal(sourcesMarkup([], undefined), '');
  assert.equal(/javascript:/.test(sourcesMarkup([{ name: 'gmail_list', markdown: '', sources: [{ title: 'x', url: 'javascript:alert(1)' }] }])), false);
});

test('a partial turn says in plain words where it stopped, and offers the next action', () => {
  assert.equal(partialWords(['Calendar']), 'I ran out of time before checking calendar. Here is what I found.');
  assert.equal(partialWords(['Calendar', 'Gmail']), 'I ran out of time before checking calendar or mail. Here is what I found.');
  assert.equal(partialWords([]), 'I ran out of time before finishing. Here is what I found.');
});

test('a turn with no answer says so, and never shows the evidence as the body', () => {
  assert.match(NO_ANSWER_WORDS, /did not save an answer/);
  assert.doesNotMatch(NO_ANSWER_WORDS, /evidence|tool|outcome_/);
  const evidence: ToolEvidence[] = [{ name: 'mattermost_search', markdown: '- chan | alice | 2026-10-17T09:00:00Z | a shaped body that is not an answer', sources: [] }];
  const body = `<p class="no-answer muted">${NO_ANSWER_WORDS}</p>`;
  assert.doesNotMatch(body, /a shaped body/);
  assert.match(evidenceMarkup(evidence, NOW), /<details class="chat-evidence"/, 'the evidence still exists, folded, under the honest state');
});

test('a stamp becomes relative words, and an unreadable stamp renders nothing at all', () => {
  assert.equal(relativeWords('2026-10-17T11:59:30Z', NOW), 'just now');
  assert.equal(relativeWords('2026-10-17T11:30:00Z', NOW), '30 min ago');
  assert.equal(relativeWords('2026-10-17T09:00:00Z', NOW), '3 h ago');
  assert.equal(relativeWords('2026-10-16T09:00:00Z', NOW), 'yesterday');
  assert.equal(relativeWords('2026-10-10T09:00:00Z', NOW), '7 days ago');
  assert.equal(relativeWords('2026-11-20T00:00:00', NOW), 'Nov 20');
  assert.equal(relativeWords('sometime', NOW), '');
  assert.equal(relativeWords('', NOW), '');
  assert.equal(relativeWords('1792000000000', NOW).endsWith('ago'), true, 'an epoch millisecond stamp is read');
  assert.equal(eventWords('2026-10-17T14:30:00', NOW), '14:30', 'a calendar time today is a clock time');
  assert.equal(eventWords('2026-10-18T09:00:00', NOW), 'tomorrow 09:00');
  assert.equal(eventWords('not a date', NOW), '');
});
