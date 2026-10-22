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
      { action: 'start', question: 'what happened to the release freeze', callId: CALL_ID }, new AbortController().signal);

    assert.equal(reply['status'], 'complete');
    assert.equal(collector.steps.length, 8, 'three searches and the actual mail body follow-up each start and end');
    const starts = collector.steps.filter(step => step.phase === 'start');
    const ends = collector.steps.filter(step => step.phase === 'end');
    assert.deepEqual(starts.map(step => step.source), ['knowledge', 'mail', 'chat', 'mail']);
    assert.deepEqual(starts.map(step => step.action), ['search', 'search', 'search', 'read']);
    assert.deepEqual(ends.map(step => step.source), ['knowledge', 'mail', 'chat', 'mail']);
    assert.deepEqual(ends.map(step => step.action), ['search', 'search', 'search', 'read']);
    for (const step of collector.steps) {
      assert.equal(step.callId, CALL_ID, 'every step names the research call it belongs to');
      assert.ok(step.stepId, 'a step carries its own id');
    }
    // A step describes actual dispatched arguments, not an unused selector window.
    assert.equal(starts[1]!.subject, 'release freeze');
    assert.equal(starts[2]!.subject, 'release freeze');
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
      { action: 'start', question: 'what happened to the release freeze', callId: CALL_ID }, new AbortController().signal);

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
