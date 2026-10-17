import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  evidenceMarkup, NO_ANSWER_WORDS, partialWords, relativeWords, eventWords, sourcesMarkup, stepsMarkup,
} from '../src/markdown.ts';
import { stepFinished, stepRunning, stepsSummary, TOOL_PHRASES, wroteExternally } from '../src/tool-phrases.ts';
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
  assert.equal(stepsSummary(steps), 'Checked Mattermost, Mongoose and calendar');
  const folded = stepsMarkup(steps, true);
  assert.match(folded, /^<details class="chat-steps-done"><summary>Checked Mattermost, Mongoose and calendar<\/summary>/);
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

test('a mail row without a sender says unknown sender beside its relative time, never a raw stamp (F2)', () => {
  const html = evidenceMarkup([{ name: 'gmail_list', markdown: '- Deck | date: 2026-10-16T08:00:00Z | ready', sources: [] }], NOW);
  assert.doesNotMatch(html, /2026-10-16T08:00:00Z/, 'a raw ISO stamp never reaches the owner');
  assert.match(html, /chat-evidence-line">unknown sender · Deck · yesterday</, 'the sender slot says so in words, and the stamp is relative');
  const both = evidenceMarkup([{ name: 'gmail_list', markdown: '- Deck | from: Dana | date: 2026-10-16T08:00:00Z | ready', sources: [] }], NOW);
  assert.match(both, /chat-evidence-line">Dana · Deck · yesterday</);
});

test('an evidence line keeps the underscores of a channel or branch name (F3)', () => {
  const html = evidenceMarkup([{ name: 'mattermost_search', markdown: '- release_3k | alice | 2026-10-17T09:00:00Z | the fix_1015 branch is ready', sources: [] }], NOW);
  assert.match(html, /release_3k · alice · 3 h ago/);
  assert.match(html, /the fix_1015 branch is ready/);
});

test('every current tool is read-only for the send warning, so the suffix rule is a tripwire (F4)', () => {
  for (const name of Object.keys(TOOL_PHRASES)) assert.equal(wroteExternally([name]), false, `${name} is read-only today`);
  assert.equal(wroteExternally(['mattermost_post']), true, 'a writer must be named here deliberately');
});

// The component seam:
// connected.ts runs unmodified against a fake API and a fake panel, so the turn is composed by the real
// view rather than by a string the test writes (F1).
const connectedSource = readFileSync(new URL('../src/connected.ts', import.meta.url), 'utf8');
const TURN_DIR = mkdtempSync(join(tmpdir(), 'k4-turn-'));
const SRC = new URL('../src/', import.meta.url);

async function loadView() {
  writeFileSync(join(TURN_DIR, 'api.mjs'), [
    'export class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }',
    'export const request = (...args) => globalThis.__turnApi.request(...args);',
    'export const stream = (...args) => globalThis.__turnApi.stream(...args);',
    'export const authorityVersion = () => "synthetic-authority-1";',
    'export const assertAuthority = () => {};',
  ].join('\n'));
  const rewritten = connectedSource.replace(/from '(\.\/[a-z-]+)(\.ts)?'/g, (_match, name: string) => `from '${name === './api' ? './api.mjs' : new URL(`${name}.ts`, SRC).href}'`);
  writeFileSync(join(TURN_DIR, 'connected.mjs'), ts.transpileModule(rewritten, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  return (await import(pathToFileURL(join(TURN_DIR, 'connected.mjs')).href)).ConnectedView;
}

const settle = async () => { for (let tick = 0; tick < 4; tick++) await new Promise(resolve => setImmediate(resolve)); };

function installTurnApi(turns: Record<string, { conversation: Record<string, unknown>; entries: { id: string; role: 'user' | 'assistant'; text: string }[]; run: Record<string, unknown> }>) {
  const panel = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] as unknown[] };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: () => panel } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => '{}', setItem() {} } });
  let onEvent: ((value: unknown) => void) | undefined;
  let releaseRun: (() => void) | undefined;
  (globalThis as unknown as { __turnApi: unknown }).__turnApi = {
    request: async (path: string) => {
      if (path === '/status') return { ownerProfile: { displayName: 'Lux Didi' } };
      if (path === '/chat/status') return { status: 'configured', provider: 'p', model: 'm', consent: { sessionId: 's1', scope: 'standing', state: 'active' } };
      if (path === '/sessions') return { items: [] };
      const conversation = /^\/conversations\/([^/]+)$/.exec(path);
      if (conversation) return turns[conversation[1]!]!.conversation;
      const session = /^\/sessions\/([^/]+)$/.exec(path);
      if (session) return { entries: turns[session[1]!]!.entries };
      const run = /^\/chat\/([^/]+)$/.exec(path);
      if (run) {
        const found = Object.values(turns).map(turn => turn.run).find(candidate => candidate.runId === run[1]);
        if (found) return found;
      }
      throw new Error(`Unexpected request ${path}`);
    },
    // The conversation stream opens at once; the run stream stays open, as a real one does, until the test
    // finishes its turn, so the view keeps accepting step events while it runs.
    stream: (path: string, _signal: unknown, handler: (value: unknown) => void, close?: () => void) => {
      if (path.startsWith('/conversations/')) { close?.(); return Promise.resolve(); }
      onEvent = handler;
      return new Promise<void>(resolve => { releaseRun = () => { close?.(); resolve(); }; });
    },
  };
  return {
    panel,
    emit(event: unknown) { assert.ok(onEvent, 'the view opened a run stream before its steps arrived'); onEvent(event); },
    release() { releaseRun?.(); releaseRun = undefined; },
    restore() {
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete (globalThis as { document?: unknown }).document;
      if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else delete (globalThis as { localStorage?: unknown }).localStorage;
      delete (globalThis as { __turnApi?: unknown }).__turnApi;
    },
  };
}

const shapedBody = 'shaped-body-that-is-not-an-answer';
const evidence: ToolEvidence[] = [{ name: 'mattermost_search', markdown: `- chan | alice | 2026-10-17T09:00:00Z | ${shapedBody}`, sources: [{ title: 'Mattermost: one', url: 'https://mm.example.org/p/1' }] }];
const runOf = (id: string, over: Record<string, unknown> = {}) => ({ runId: `run-${id}`, sessionId: 's1', state: 'terminal', outcome: 'complete', finalEntryId: null, finalText: null, partialText: '', mayHaveBeenSent: false, sequence: 0, memorySelection: null, toolEvidence: evidence, ...over });
const conversationOf = (runId: string) => ({ scope: 'conversation', sessionId: 's1', provider: 'p', model: 'm', state: 'active', revision: 1, permittedClasses: [], latestRunId: runId });
const ownerSays = { id: 'e1', role: 'user' as const, text: 'what changed?' };

test('the real view composes the turn: running steps, the answer with folded evidence, then the honest no-answer state (F1)', async () => {
  const ConnectedView = await loadView();
  const api = installTurnApi({
    s1: { conversation: conversationOf('run-1'), entries: [ownerSays], run: runOf('1') },
    s2: { conversation: conversationOf('run-2'), entries: [ownerSays], run: runOf('2', { state: 'accepted' }) },
    s3: { conversation: conversationOf('run-3'), entries: [ownerSays, { id: 'e2', role: 'assistant', text: 'The release is on friday.' }], run: runOf('3', { state: 'accepted' }) },
    s4: { conversation: conversationOf('run-4'), entries: [ownerSays], run: runOf('4', { outcome: 'deadline', partialText: '' }) },
  });
  try {
    const view = new ConnectedView(() => {});
    await view.refresh('owner');
    // A finished run with no answer: the honest line, never the shaped body, never an evidence block.
    await view.select('s1');
    assert.ok(api.panel.innerHTML.includes(NO_ANSWER_WORDS), 'the honest state is composed by the view');
    assert.ok(!api.panel.innerHTML.includes(shapedBody), 'the shaped tool output is never the body');
    assert.doesNotMatch(api.panel.innerHTML, /chat-evidence/);
    // A live run: one quiet line per step from the run's own events, nothing folded before the answer.
    await view.select('s2');
    await settle();
    api.emit({ type: 'chat_step', runId: 'run-2', stepId: 'a', tool: 'mattermost_search', phase: 'end', resultCount: 13 });
    api.emit({ type: 'chat_step', runId: 'run-2', stepId: 'b', tool: 'gcal_list', phase: 'start' });
    await settle();
    view.attach();
    assert.match(api.panel.innerHTML, /Searched Mattermost, 13 results/);
    assert.match(api.panel.innerHTML, /Checking your calendar\.\.\./);
    assert.doesNotMatch(api.panel.innerHTML, /chat-steps-done/);
    assert.doesNotMatch(api.panel.innerHTML, /chat-evidence/, 'no evidence before the answer');
    api.release();
    // A turn with an answer: the run's steps arrive, then the snapshot that carries the saved answer.
    await view.select('s3');
    await settle();
    api.emit({ type: 'chat_step', runId: 'run-3', stepId: 'a', tool: 'mattermost_search', phase: 'end', resultCount: 13 });
    api.emit({ type: 'chat_step', runId: 'run-3', stepId: 'b', tool: 'gcal_list', phase: 'end', resultCount: 2 });
    await settle();
    api.emit({ type: 'snapshot', run: runOf('3', { finalEntryId: 'e2' }) });
    await settle();
    view.attach();
    assert.match(api.panel.innerHTML, /<summary>Checked Mattermost and calendar<\/summary>/, 'the folded summary names its sources in prose');
    assert.match(api.panel.innerHTML, /The release is on friday\./);
    assert.match(api.panel.innerHTML, /class="chat-evidence"/);
    assert.match(api.panel.innerHTML, /class="chat-sources"/);
    const order = ['what changed?', 'chat-steps-done', 'entry assistant', 'chat-evidence', 'chat-sources'].map(marker => api.panel.innerHTML.indexOf(marker));
    assert.deepEqual(order, [...order].sort((left, right) => left - right), `turn order ${order.join(',')}`);
    // The shaped tool text survives only as a folded evidence snippet, never as any answer body.
    const answerBody = /<article class="entry assistant"><div class="markdown">([\s\S]*?)<\/div><\/article>/.exec(api.panel.innerHTML)?.[1] ?? '';
    assert.ok(answerBody.includes('The release is on friday.'));
    assert.ok(!answerBody.includes(shapedBody), 'the answer body is the model text alone');
    assert.ok(api.panel.innerHTML.indexOf(shapedBody) > api.panel.innerHTML.indexOf('chat-evidence'), 'the shaped text lives inside the folded evidence');
    api.release();
    // A read-only run that ran out of time: plain copy and the next action, no send warning.
    await view.select('s4');
    await settle();
    assert.match(api.panel.innerHTML, /ran out of time/i);
    assert.match(api.panel.innerHTML, /id="connected-retry"/);
    assert.doesNotMatch(api.panel.innerHTML, /may have been sent/i);
    assert.ok(!api.panel.innerHTML.includes(shapedBody), 'a timed-out turn never shows the shaped output');
  } finally { api.release(); api.restore(); }
});
