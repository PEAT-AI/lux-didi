import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachHostLogSink, stepSubject, STEP_SUBJECT_CAP, type LiveToolStep } from '../tools/host-events.js';
import { ResearchLedger, runResearch, type ResearchDeps, type ResearchSelector, type SourceKind } from '../tools/research.js';
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

function selectorOf(kinds: readonly ('knowledge_search' | 'mail_search' | 'chat_search')[], query: string, window?: string): ResearchSelector {
  return {
    select: async () => ({
      questionClass: 'cross_source',
      actions: kinds.map(kind => ({ kind, query, ...(window !== undefined && kind === 'chat_search' ? { window } : {}) })),
      pUseful: { knowledge_search: 0.9, mail_search: 0.8, chat_search: 0.7 },
    }),
  };
}

function deps(selector: ResearchSelector, execute: ResearchDeps['execute']): ResearchDeps {
  return { now: () => 0, configured: CONFIGURED, execute, emit: () => {}, log: () => {}, logSubcall: () => {}, ledger: new ResearchLedger(), selector };
}

test('research publishes one live step per source, in order, start then end', async () => {
  const collector = stepCollector();
  try {
    const execute = async (subs: readonly IntentSubCall[]): Promise<IntentSubResult[]> =>
      subs.map(call => sub(call.name, 'release freeze decided on Friday', true, call.key));
    const reply = await runResearch(deps(selectorOf(['knowledge_search', 'mail_search', 'chat_search'], 'release freeze', 'week'), execute),
      { action: 'start', question: 'what did the team decide about the release freeze', callId: CALL_ID }, new AbortController().signal);

    assert.equal(reply['status'], 'answered');
    assert.equal(collector.steps.length, 6, 'three sources, one start and one end each');
    const starts = collector.steps.filter(step => step.phase === 'start');
    const ends = collector.steps.filter(step => step.phase === 'end');
    assert.deepEqual(starts.map(step => step.source), ['knowledge', 'mail', 'chat']);
    assert.deepEqual(ends.map(step => step.source), ['knowledge', 'mail', 'chat']);
    for (const step of collector.steps) {
      assert.equal(step.callId, CALL_ID, 'every step names the research call it belongs to');
      assert.equal(step.action, 'search');
      assert.ok(step.stepId, 'a step carries its own id');
    }
    // The start line is what the owner reads while it runs: the query words, plus the window.
    assert.equal(starts[1]!.subject, 'release freeze');
    assert.equal(starts[2]!.subject, 'release freeze, last 7 days');
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
    await runResearch(deps(selectorOf(['knowledge_search', 'mail_search'], 'release freeze'), execute),
      { action: 'start', question: 'what did the team decide about the release freeze', callId: CALL_ID }, new AbortController().signal);

    const failed = collector.steps.filter(step => step.phase === 'end' && step.source === 'mail');
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.ok, false, 'the failed source says so plainly');
    for (const step of collector.steps) {
      assert.ok(!(step.subject ?? '').includes('private'), 'a result body never becomes a subject');
    }
  } finally { collector.detach(); }
});

test('a step subject caps at 60 characters and never quotes a body or an id', () => {
  const subject = stepSubject({ query: 'release freeze timeline for the whole team', window: 'week', channelId: 'chan-123', body: 'the private message body', text: 'body text' });
  assert.equal(subject, 'release freeze timeline for the whole team, last 7 days');
  assert.ok(subject!.length <= STEP_SUBJECT_CAP);

  const capped = stepSubject({ query: 'release freeze retro notes and follow ups for the whole team' });
  assert.ok(capped!.length <= STEP_SUBJECT_CAP, 'a long query is capped');
  assert.ok(capped!.endsWith('\u2026'), 'the cap is visible, never a silent cut mid-word');

  const words = stepSubject({ query: 'x'.repeat(90) });
  assert.ok(words!.length <= STEP_SUBJECT_CAP);

  assert.equal(stepSubject({ channelId: 'chan-123', body: 'the private message body', text: 'body text' }), undefined, 'an id or a body alone is never a subject');
  assert.equal(stepSubject(undefined), undefined);
});
