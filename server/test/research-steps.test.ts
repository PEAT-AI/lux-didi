import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachHostLogSink, stepSubject, STEP_SUBJECT_CAP, type LiveToolStep } from '../tools/host-events.js';
import { ResearchLedger, runResearch, type ResearchDeps, type SourceKind } from '../tools/research.js';
import { shapeGmailList } from '../tools/live-shape.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

const CONFIGURED: readonly SourceKind[] = ['knowledge', 'mail', 'chat'];
const CALL_ID = 'call-1';

function sub(name: string, text: string, ok = true, key = name): IntentSubResult {
  return { key, name, ok, text, originalCharacters: text.length, omittedCharacters: 0 };
}

/** The steps the tool layer publishes on the host event channel, the channel the Live owner reads. */
function stepCollector(): { steps: LiveToolStep[]; detach: () => void } {
  const steps: LiveToolStep[] = [];
  const detach = attachHostLogSink({
    event: raw => {
      const event = raw as { type?: string };
      if (event.type === 'live_tool_step') steps.push(raw as LiveToolStep);
    },
  });
  return { steps, detach };
}

function deps(execute: ResearchDeps['execute']): ResearchDeps {
  return { now: () => 0, configured: CONFIGURED, execute, emit: () => {}, log: () => {}, logSubcall: () => {}, ledger: new ResearchLedger() };
}

test('research publishes one live step per actual source read, including mail body follow-up', async () => {
  const collector = stepCollector();
  try {
    const execute = async (subs: readonly IntentSubCall[]): Promise<IntentSubResult[]> =>
      subs.map(call => call.name === 'gmail_search_messages'
        ? { key: call.key, name: call.name, ok: true, ...shapeGmailList({ messages: [{ id: 'synthetic-mail', headers: { Subject: 'release freeze decided on Friday' } }] }) }
        : sub(call.name, 'release freeze decided on Friday', true, call.key));
    const reply = await runResearch(deps(execute),
      { action: 'start', question: 'what happened to the release freeze in chat and mail', callId: CALL_ID }, new AbortController().signal);

    assert.equal(reply['status'], 'complete');
    assert.equal(collector.steps.length, 8, 'three searches and the actual mail body follow-up each start and end');
    const starts = collector.steps.filter(step => step.phase === 'start');
    const ends = collector.steps.filter(step => step.phase === 'end');
    // RUN-R3: with the selector gone the fallback plan dispatches chat before mail, and knowledge stays first.
    assert.deepEqual(starts.map(step => step.source), ['knowledge', 'mail', 'chat', 'mail']);
    assert.deepEqual(starts.map(step => step.action), ['search', 'search', 'search', 'read']);
    assert.deepEqual(ends.map(step => step.source), ['knowledge', 'mail', 'chat', 'mail']);
    assert.deepEqual(ends.map(step => step.action), ['search', 'search', 'search', 'read']);
    for (const step of collector.steps) {
      assert.equal(step.callId, CALL_ID, 'every step names the research call it belongs to');
      assert.ok(step.stepId, 'a step carries its own id');
    }
    // A step describes actual dispatched arguments, not an unused selector window.
    assert.equal(starts[0]!.subject, 'happened release freeze');
    // ROUTE-1022 K6: the plan authors the mail query from the question, so the mail step names the query
    // that was really dispatched (starts[1]; starts[2] is the chat read under the plan's own order).
    assert.equal(starts[1]!.subject, 'in:inbox newer_than:14d happened release freeze');
    // The end step replaces its own start line, so both share one id.
    for (const [index, start] of starts.entries()) assert.equal(ends[index]!.stepId, start.stepId);
    for (const step of ends) {
      assert.equal(step.ok, true);
      assert.equal(typeof step.resultCount, 'number');
      assert.equal(typeof step.ms, 'number');
    }
  } finally { collector.detach(); }
});

test('a source that fails ends its own line with ok false, never with a body', async () => {
  const collector = stepCollector();
  try {
    const execute = async (subs: readonly IntentSubCall[]): Promise<IntentSubResult[]> =>
      subs.map(call => call.name.includes('mail')
        ? { ...sub(call.name, '', false, call.key), code: 'connector_timeout' }
        : sub(call.name, 'the private message body', true, call.key));
    await runResearch(deps(execute),
      { action: 'start', question: 'what happened to the release freeze in chat and mail', callId: CALL_ID }, new AbortController().signal);

    const failed = collector.steps.filter(step => step.phase === 'end' && step.source === 'mail');
    // W0 (258dd0bd) receipts every attempt honestly: a failed read and its retry each end their own line.
    assert.ok(failed.length >= 1, 'the failed source ends a line');
    assert.ok(failed.every(step => step.ok === false), 'the failed source says so plainly');
    for (const step of collector.steps) {
      assert.ok(!(step.subject ?? '').includes('private'), 'a result body never becomes a subject');
    }
  } finally { collector.detach(); }
});

test('a step subject caps at 60 characters and never quotes a body or an id', () => {
  const subject = stepSubject({ query: 'release freeze timeline for the whole team', window: 'week', channelId: 'chan-123', body: 'the private message body', text: 'body text' });
  assert.equal(subject, 'release freeze timeline for the whole team, last 7 days');
  assert.ok(subject!.length <= STEP_SUBJECT_CAP);

  const capped = stepSubject({ query: 'release freeze retro notes and follow ups for the whole team today' });
  assert.ok(capped!.length <= STEP_SUBJECT_CAP, 'a long query is capped');
  assert.ok(capped!.endsWith('\u2026'), 'the cap is visible, never a silent cut mid-word');

  const words = stepSubject({ query: 'x'.repeat(90) });
  assert.ok(words!.length <= STEP_SUBJECT_CAP);

  assert.equal(stepSubject({ channelId: 'chan-123', body: 'the private message body', text: 'body text' }), undefined, 'an id or a body alone is never a subject');
  assert.equal(stepSubject(undefined), undefined);
});

test('F3 a subject refuses identifier-shaped values and control characters', () => {
  // A channel key is not read at all, so a channel id can never ride along with the search words.
  assert.equal(stepSubject({ channel: 'chan-9f2c4b6d8e1a', query: 'release freeze' }), 'release freeze');
  // A person-shaped key is read, but an identifier value is refused.
  assert.equal(stepSubject({ person: 'user:8f14e45fceea167a' }), undefined);
  assert.equal(stepSubject({ person: '8f14e45f-fcee-4a67-9d1b-2c3e4f5a6b7c' }), undefined);
  assert.equal(stepSubject({ person: 'Priya Raman' }), 'Priya Raman');
  // Control characters and ansi escapes never reach the owner view.
  const cleaned = stepSubject({ query: 'release\u0000\u0007 freeze\u001b[31m' });
  assert.equal(cleaned, 'release freeze');
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(cleaned!), false);
  // A real date window is still readable words, not an id.
  assert.equal(stepSubject({ window: '2026-10-17' }), 'on 2026-10-17');
});

// #615: a memory lookup reads earlier conversations only. The live session and the owner's own
// current question are never its own memory.
const MEMORY_AT = Date.parse('2026-10-24T12:00:00.000Z');
const MEMORY_ASK = 'what did we talk about last time';
interface MemoryHit { snippet: string; role: 'user' | 'assistant'; date: string; sessionId: string }

function memoryDeps(hits: readonly MemoryHit[]): ResearchDeps {
  return {
    now: () => MEMORY_AT, configured: [...CONFIGURED, 'memory'], emit: () => {}, log: () => {}, logSubcall: () => {},
    ledger: new ResearchLedger(),
    execute: async (subs: readonly IntentSubCall[]): Promise<IntentSubResult[]> => subs.map(call => ({
      key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0,
      binding: { executionId: call.key } as NonNullable<IntentSubResult['binding']>,
      historyPage: { status: 'ok', hits: hits.map(hit => ({ ...hit })), totalMatches: hits.length, nextCursor: null },
    })),
  };
}

const memoryAsk = (deps: ResearchDeps, question = MEMORY_ASK) =>
  runResearch(deps, { action: 'start', question, lookups: [{ source: 'memory', query: question }] }, new AbortController().signal);

/** What the model can read as memory evidence: the findings and the kept history page. */
const memoryEvidence = (reply: Record<string, unknown>): string => JSON.stringify({ findings: reply['findings'], pages: reply['historyPages'] });

const minutesAgo = (minutes: number): string => new Date(MEMORY_AT - minutes * 60_000).toISOString();

test('#615: memory evidence is an earlier conversation, never the live session or the current question', async () => {
  const hits: MemoryHit[] = [
    { snippet: MEMORY_ASK, role: 'user', date: minutesAgo(4), sessionId: 'live-session' },
    { snippet: 'we talked about the dentist on Friday', role: 'assistant', date: minutesAgo(3), sessionId: 'live-session' },
    { snippet: 'the dentist is on Friday at nine', role: 'assistant', date: minutesAgo(2), sessionId: 'live-session' },
    { snippet: 'we agreed the dentist is on Friday', role: 'user', date: minutesAgo(1440), sessionId: 'earlier-session' },
  ];
  const reply = await memoryAsk(memoryDeps(hits));
  const evidence = memoryEvidence(reply as Record<string, unknown>);
  assert.match(evidence, /we agreed the dentist is on Friday/, 'the earlier conversation is the evidence');
  assert.doesNotMatch(evidence, /we talked about the dentist on Friday|the dentist is on Friday at nine/, 'no line of the live session is evidence');
  assert.doesNotMatch(evidence, /talk about|what did we talk about last time/, "the owner's current question is never memory evidence");
});

test('#615: an earlier assistant line is evidence when no owner line matches', async () => {
  const reply = await memoryAsk(memoryDeps([
    { snippet: 'we talked about the dentist on Friday', role: 'assistant', date: minutesAgo(1440), sessionId: 'earlier-session' },
  ]));
  assert.match(memoryEvidence(reply as Record<string, unknown>), /we talked about the dentist on Friday/);
  assert.equal((reply['sources'] as Record<string, string>)['memory'], 'ok');
});

test('#615: an owner line from an earlier session leads her own line at the same match', async () => {
  const reply = await memoryAsk(memoryDeps([
    { snippet: 'we talked about the dentist and the party', role: 'assistant', date: minutesAgo(2880), sessionId: 'older-session' },
    { snippet: 'we talked about the dentist', role: 'user', date: minutesAgo(1440), sessionId: 'earlier-session' },
  ]));
  const evidence = memoryEvidence(reply as Record<string, unknown>);
  assert.match(evidence, /we talked about the dentist/, 'the owner line is the evidence');
  assert.doesNotMatch(evidence, /and the party/, 'her own line is evidence only when no owner line matches');
});

test('#615: a memory lookup with nothing from an earlier session reports empty, never the current turn', async () => {
  const reply = await memoryAsk(memoryDeps([
    { snippet: MEMORY_ASK, role: 'user', date: minutesAgo(4), sessionId: 'live-session' },
    { snippet: 'we talked about the dentist on Friday', role: 'assistant', date: minutesAgo(3), sessionId: 'live-session' },
    { snippet: 'the dentist is on Friday at nine', role: 'assistant', date: minutesAgo(2), sessionId: 'live-session' },
  ]));
  assert.equal((reply['sources'] as Record<string, string>)['memory'], 'empty', 'the source reports its closed empty reason');
  assert.doesNotMatch(memoryEvidence(reply as Record<string, unknown>), /dentist|talk about/, 'the current turn is never evidence');
});
