import assert from 'node:assert/strict';
import { test } from 'node:test';
import assert_ from 'node:assert/strict';
import {
  RESEARCH, ResearchLedger, researchLedgerOf, researchRebuildAllowed, researchRebuildDue, retainedAfterSend, runResearch,
} from '../tools/research.js';
import type { ResearchBoundary, ResearchRetention, ResearchDeps } from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

/** C-DEPTH item 5 (W10-R2 light C): the retained payload, the safe boundary and the ledger a rebuild seeds. */

const EMPTY: ResearchRetention = { retainedChars: 0, rebuilds: 0 };
const SAFE: ResearchBoundary = { assistantAudioStreaming: false, responsePending: false, bargeIn: false, toolInFlight: false };

test('HYGIENE 1: nothing is rebuilt under the threshold, and the first answer past it is due', () => {
  assert.equal(researchRebuildDue(EMPTY), false, 'a fresh call owns nothing');
  assert.equal(researchRebuildDue({ retainedChars: RESEARCH.rebuildThresholdChars, rebuilds: 0 }), false,
    'exactly at the threshold the call still reads its own evidence');
  assert.equal(researchRebuildDue({ retainedChars: RESEARCH.rebuildThresholdChars + 1, rebuilds: 0 }), true,
    'one char past it and the rebuild is due');
  assert.equal(RESEARCH.rebuildThresholdChars, 24_000, 'the threshold W10-R2 set');
});

test('HYGIENE 2: the count is what was sent, and a rebuild starts it again at zero', () => {
  let retention = retainedAfterSend(EMPTY, 12_000);
  assert.equal(researchRebuildDue(retention), false, 'one full default answer is still under');
  retention = retainedAfterSend(retention, 12_000);
  assert.equal(researchRebuildDue(retention), false, 'two of them sit exactly on the threshold, which is still under it');
  retention = retainedAfterSend(retention, 1);
  assert.equal(researchRebuildDue(retention), true, 'the next character sent crosses it');
  assert.deepEqual({ ...retention, retainedChars: 0, rebuilds: retention.rebuilds + 1 },
    { retainedChars: 0, rebuilds: 1, }, 'the rebuild the host runs resets the count and records itself');
  assert.equal(researchRebuildDue({ retainedChars: 0, rebuilds: 1 }), false, 'and the next answer starts over');
});

test('HYGIENE 3: no rebuild while audio streams, a response is pending, a barge in runs or a tool is in flight', () => {
  assert.equal(researchRebuildAllowed(SAFE), true, 'a quiet call is the safe boundary');
  for (const fact of ['assistantAudioStreaming', 'responsePending', 'bargeIn', 'toolInFlight'] as const) {
    assert.equal(researchRebuildAllowed({ ...SAFE, [fact]: true }), false, `${fact} holds the rebuild`);
  }
});

test('HYGIENE 4: the ledger carries the asked entities, the source ids, the dates and the cursors', () => {
  const ledger = researchLedgerOf({
    question: 'what do we know about Ana, Ben and Cara Clifton',
    findings: [
      { source: 'knowledge', text: 'knowledge: 3 of 3 shown\n### Ana Clifton (person | 2026-09-14) [id 301]\n### Ben Clifton (person | 2026-09-02) [id 302]' },
      { source: 'mail', text: 'mail: 1 of 2 shown\n- Release note | from: Ana | date: 2026-10-16 [id m1]' },
    ],
    cursors: ['mail:next:abc'],
  });
  assert.match(ledger, /entities: Ana, Ben, Cara, Clifton/u, 'the people the owner asked for are named');
  assert.match(ledger, /knowledge: 3 held, ids 301,302/u, 'the knowledge ids a follow up can read again');
  assert.match(ledger, /dates 2026-09-14,2026-09-02/u, 'the dates the evidence carries');
  assert.match(ledger, /cursors: mail:next:abc/u, 'the cursor that recovers the body');
  assert.match(ledger, /no evidence for Cara/u, 'a gap is named, never invented');
  assert.ok(ledger.length <= RESEARCH.ledgerChars, `the ledger fits its own bound: ${ledger.length}`);
});

test('HYGIENE 5: the ledger never exceeds its bound, and it is deterministic', () => {
  const findings = Array.from({ length: 400 }, (_v, index) => ({
    source: 'knowledge',
    text: `knowledge: 1 of 1 shown\n### Entry ${index} (decision | 2026-10-17) [id ${index}] ${'detail '.repeat(200)}`,
  }));
  const input = { question: 'what did we decide about the release', findings, cursors: [] };
  const first = researchLedgerOf(input);
  assert.ok(first.length <= RESEARCH.ledgerChars, `a huge call still fits its ledger: ${first.length}`);
  assert.equal(researchLedgerOf(input), first, 'no model call, so the same input is the same ledger');
});

function sub(name: string, text: string, key = name): IntentSubResult {
  return { key, name, ok: true, text, originalCharacters: text.length, omittedCharacters: 0 };
}

test('HYGIENE 6 (J2): a fetch that misses its bound still delivers the summaries, and the header says excerpt', async () => {
  // A fake clock, no real wait: the stage two bound is zero, so the bounded read aborts at once.
  const summaries = Array.from({ length: 40 }, (_v, index) =>
    `### Ana Clifton entry ${index} (person | 2026-09-14) [id ${300 + index}] ${'summary detail '.repeat(8)}`).join('\n');
  const executed: string[] = [];
  const deps: ResearchDeps = {
    now: () => 0,
    configured: ['knowledge'] as const,
    knowledgeReadMs: 0,
    execute: async (subs: readonly IntentSubCall[]) => {
      for (const call of subs) executed.push(call.name);
      if (subs.every(call => call.name === 'get_insight')) {
        // The slow fetch: it never answers inside the bound.
        await new Promise(resolve => setTimeout(resolve, 10));
        return subs.map(call => sub(call.name, '', call.key));
      }
      return subs.map(call => sub(call.name, summaries, call.key));
    },
    emit: () => {},
    log: () => {},
    ledger: new ResearchLedger(),
  };
  const reply = await runResearch(deps, {
    action: 'start', question: 'what do we know about Ana Clifton',
    lookups: [{ source: 'knowledge', query: 'Clifton' }],
  }, new AbortController().signal);
  assert_ok(executed.includes('search_knowledge'), 'the search happened');
  const evidence = ((reply['findings'] ?? []) as { text: string }[]).map(finding => finding.text).join('\n');
  assert_ok(evidence.includes('Ana Clifton'), 'the summaries are delivered when the fetch cannot finish');
  assert_ok(String(reply['coverage']).includes('excerpt'), `the header says the source is an excerpt: ${String(reply['coverage'])}`);
});

function assert_ok(value: unknown, message: string): void { assert_(value, message); }
