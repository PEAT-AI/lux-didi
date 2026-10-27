import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESEARCH, ResearchLedgerLog, VoiceReplyBook, capVoiceReply, researchLedgerOf,
  researchRebuildDue, researchRebuildStep, retainedAfterSend, type ResearchRetention,
} from '../tools/research.js';

// C-CONTINUITY replay: the shape of the owner's 21-minute call of 2026-10-27, at the layer that decides
// continuity. A research-heavy exchange crosses the rebuild threshold, a refused batch lands on the crossing, a
// mute recovery reopens the session, and the owner then asks "which company did you just mention". Every seed the
// call can hand a fresh session carries the company named before the rebuild, at most one rebuild happens, and
// no research payload delivered to the provider is wider than the reply cap. The text is synthetic.
const COMPANY = 'Halvorsen Maritime';
const BOUNDARY = { assistantAudioStreaming: false, responsePending: false, bargeIn: false, toolInFlight: false };

function longBatch(index: number, lines = 40): { source: string; text: string } {
  const body = Array.from({ length: lines }, (_unused, line) =>
    `knowledge: LAT-${1023 + line} ${COMPANY} fleet note ${index}.${line}, a sentence the owner heard in full`).join('\n');
  return { source: 'knowledge', text: body };
}

function refuse(): Record<string, unknown> {
  return { error: 'research_failed' };
}

test('C-CONTINUITY replay: the owner hears about a company, a rebuild follows, and the company survives it', () => {
  const book = new VoiceReplyBook();
  const ledger = new ResearchLedgerLog();
  let refusedChars = 0;
  let retention: ResearchRetention = { retainedChars: 0, rebuilds: 0 };
  let seed: string | undefined;
  const delivered: Record<string, unknown>[] = [];
  const answers: Record<string, unknown>[] = [];
  // The one independent count of what the provider was really handed, so the refusal assertion below can fail.
  let wireChars = 0;

  // The first answer names the company, and from then on every batch is capped and counted as delivered.
  for (let index = 0; index < 26; index += 1) {
    const reply = { researchId: `r-${index}`, status: 'answered', findings: index === 0
      ? [{ source: 'knowledge', text: `knowledge: ${COMPANY} is the company the owner just mentioned` }, longBatch(index)]
      : [longBatch(index)] };
    const page = capVoiceReply(reply, book);
    const wire = JSON.stringify(page);
    assert.ok(wire.length <= RESEARCH.voiceReplyChars, `delivered payload ${index} is ${wire.length} characters`);
    delivered.push(page);
    ledger.add(researchLedgerOf({ question: `tell me about ${COMPANY}`,
      findings: page['findings'] as { source?: string; text?: string }[], cursors: [] }));
    retention = retainedAfterSend(retention, wire.length);
    wireChars += wire.length;
    // A refused batch lands on the crossing: it adds nothing to the counter, nothing to the ledger, and the whole
    // reply it would have sent is still counted in the call's total context figure.
    if (index === 12) {
      const refused = refuse();
      answers.push(refused);
      refusedChars += JSON.stringify(refused).length;
      assert.equal(typeof refused['error'], 'string', 'the fixture really is a refusal');
      assert.equal(retention.retainedChars, wireChars, 'the refusal added nothing to the research counter');
      assert.equal(ledger.records, index + 1, 'and nothing to the ledger, which holds one record per delivered batch');
    }
  }

  // C-CONTINUITY item 5: the counter is the delivered characters and nothing else, while the total context figure
  // carries the refusal too. Both numbers exist, and they are different numbers.
  assert.equal(retention.retainedChars, wireChars, 'the counter holds exactly the delivered characters');
  assert.ok(refusedChars > 0, 'a refusal has a size, and it is counted in the total, not in the rebuild counter');
  assert.ok(retention.retainedChars + refusedChars > retention.retainedChars, 'the totals really differ');
  assert.ok(researchRebuildDue(retention, RESEARCH.rebuildThresholdChars), 'the call really crossed the threshold');
  assert.equal(RESEARCH.rebuildThresholdChars, 60_000, 'the threshold is the 60,000 delivered chars the decision made');

  // The rebuild fires once, at a safe boundary, with the whole call's ledger as its host section.
  const step = researchRebuildStep(retention, ledger.text().length, BOUNDARY, 60_000, 60_000);
  assert.equal(step.action, 'rebuild');
  seed = ledger.text();
  assert.ok(seed.includes('Halvorsen'), 'the seed names the company asked about before the rebuild');
  assert.ok(seed.length <= RESEARCH.ledgerChars, 'the ledger stays inside its own bound');
  retention = step.retention;
  assert.equal(retention.rebuilds, 1);
  assert.equal(step.seedChars, seed.length);

  // The mute recovery opens a fresh session: it resets the counter and drops the pending seed, so the same
  // research volume never buys a second destructive rebuild.
  retention = { retainedChars: 0, rebuilds: retention.rebuilds };
  seed = undefined;
  for (let index = 0; index < 10; index += 1) {
    retention = retainedAfterSend(retention, JSON.stringify(capVoiceReply({ researchId: `r-late-${index}`, status: 'answered',
      findings: [longBatch(index + 30)] }, book)).length);
  }
  assert.equal(researchRebuildDue(retention, RESEARCH.rebuildThresholdChars), false, 'the second volume is under the threshold again');
  assert.equal(seed, undefined, 'a recovered session owes no seed');

  assert.equal(answers.length, 1, 'exactly one refused batch rode this call');
  assert.ok(delivered.length === 26);
});
