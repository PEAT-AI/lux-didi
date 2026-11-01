import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HOST_EVENT_KINDS, hostEventPayload, type HostEvent } from '../adapters/live-voice/types.js';
import { NAYA_TOOLS, NAYA_BACKEND_PROCEDURE, composeLiveInstruction, composeLiveSessionInstruction, NAYA_LIVE_BASE } from '../prompt/live-persona.js';
import {
  lintSources, lintSpeech, shapeOf, SHAPE_WORDS, type BaselineEntry, type ExactnessEntry, type SpeechSource,
} from '../prompt/speech-lint.js';
import type { OwnerProfileSnapshot } from '../prompt/types.js';

/**
 * C-HOSTFACTS BUILD-07: the mechanical speech lint, with its real consumers. The gate runs over the
 * surfaces this night migrated (the host event payloads and the composed live instruction), and the
 * mutation corpus proves each rule fires through concatenation and templates, not only literal text.
 */

/** The shipped host events, by value: this check stages the prompt and adapter units only. */
const HOST_EVENTS: readonly HostEvent[] = [
  { origin: 'host', kind: 'connection_recovered', id: 'live-recovery-pickup' },
  { origin: 'host', kind: 'model_muted', id: 'live-mute-pickup' },
  { origin: 'host', kind: 'line_dropped', id: 'live-dropped-line' },
];

const baselineFile = new URL('../../config/prompt-speech-baseline.json', import.meta.url);
const baseline = (JSON.parse(readFileSync(baselineFile, 'utf8')) as { entries: BaselineEntry[] }).entries;
const exactness: ExactnessEntry[] = [];

const ownerProfile: OwnerProfileSnapshot = {
  schemaVersion: 1, kind: 'profile', ownerId: 'synthetic-owner', profileVersion: 'fixture', displayName: 'Example',
  style: { text: 'Synthetic owner style', dataClass: 'ordinary' }, lore: { text: 'Synthetic owner lore', dataClass: 'ordinary' },
};

/** The authored surfaces this night changed, plus the composed live instruction the model receives. */
function corpus(): SpeechSource[] {
  const composed = composeLiveSessionInstruction({
    text: composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'hi' }).text,
    tools: ['search_knowledge'], ownerProfile, overlay: { schemaVersion: 1, text: 'Synthetic overlay' }, records: [], trustedChars: 60_000,
  }).text;
  const events = JSON.stringify(HOST_EVENTS.map(hostEventPayload));
  return [
    { source: 'host-events', text: events },
    { source: 'naya-tools', text: NAYA_TOOLS },
    { source: 'naya-backend-procedure', text: NAYA_BACKEND_PROCEDURE },
    { source: 'composed-live', text: composed },
  ];
}

test('C-HOSTFACTS BUILD-07 the migrated surfaces carry no untriaged recitable line', () => {
  const report = lintSources(corpus(), { exactness, baseline });
  // New or changed findings fail; known debt is reported with its obligation instead of being hidden.
  assert.deepEqual(report.untriaged, [], `untriaged findings: ${JSON.stringify(report.untriaged)}`);
  for (const entry of baseline) {
    assert.ok(entry.destination === 'HELD' || entry.destination === 'FILED', `${entry.id} names where its fix lands`);
    assert.equal(entry.obligation.length > 0, true, `${entry.id} names the obligation that ends it`);
  }
});

test('C-HOSTFACTS BUILD-07 the held fresh opening is recorded as debt, not silently exempted', () => {
  // HF-R3 / A1: the fresh-call opening slot stays until the held character unit. It is named here with its
  // ruling and its obligation, so the debt is visible and cannot be mistaken for compliance.
  const held = (JSON.parse(readFileSync(baselineFile, 'utf8')) as {
    held?: { id: string; ruling: string; destination: string; obligation: string; surfaces: { file: string; what: string }[] }[];
  }).held ?? [];
  const opening = held.find(row => row.id === 'held-fresh-opening-slot');
  assert.equal(opening?.ruling, 'HF-R3');
  assert.equal(opening?.destination, 'HELD');
  assert.equal(opening?.surfaces.some(surface => surface.file.endsWith('openai.ts')), true);
  assert.equal(opening?.surfaces.some(surface => surface.file.endsWith('gemini.ts')), true);
  assert.equal((opening?.obligation.length ?? 0) > 0, true);
});

test('C-HOSTFACTS BUILD-07 a host event payload is host metadata, never a speech specimen', () => {
  for (const event of HOST_EVENTS) {
    assert.deepEqual(lintSpeech(hostEventPayload(event)), [], `${event.id} carries no recitable shape`);
    assert.ok((HOST_EVENT_KINDS as readonly string[]).includes(event.kind));
  }
});

test('C-HOSTFACTS BUILD-07 a quoted reply is a finding and source facts are not', () => {
  assert.deepEqual(lintSpeech('Example: "I checked the deck and it is fine."').map(finding => finding.rule), ['quoted_speech']);
  // The same words as a plain fact statement are not a specimen, so the rule is not a quote ban.
  assert.deepEqual(lintSpeech('The deck was checked at 09:00 and it is fine.'), []);
  assert.deepEqual(lintSpeech('The token ALARM and the zone Asia/Kolkata stay exact.'), []);
});

test('C-HOSTFACTS BUILD-07 a delivery slot is found through templates and concatenation', () => {
  const verb = 'Say';
  const tails = ['it back', 'that again', 'that plainly'];
  for (const tail of tails) {
    // The mutation corpus: the slot is assembled, not written as one literal, and it is still found.
    const composed = ['# Delivery', `${verb} ${tail} in one sentence.`].join('\n');
    assert.equal(lintSpeech(composed).some(finding => finding.rule === 'delivery_slot'), true, composed);
  }
  const template = (text: string): string => `Wrap: ${text}`;
  assert.equal(lintSpeech(template('Tell them nothing is running.')).some(finding => finding.rule === 'delivery_slot'), true);
  // A quoted specimen split across a concatenation is still one specimen.
  assert.equal(lintSpeech('Example: ' + '"I will' + ' call back"').some(finding => finding.rule === 'quoted_speech'), true);
});

test('C-HOSTFACTS BUILD-07 an unquoted punchline bullet and a demonstration word are findings', () => {
  const bullets = ['- I will keep it short.', '- You can ask me again.'].join('\n');
  assert.deepEqual(lintSpeech(bullets).map(finding => finding.rule), ['punchline_bullet', 'punchline_bullet']);
  // A bullet that carries a supported token or a quoted specimen is not a punchline.
  assert.deepEqual(lintSpeech('- `search_knowledge` reads the note.'), []);
  assert.equal(lintSpeech('For example, say something like "one moment".').some(finding => finding.rule === 'demonstration'), true);
});

test('C-HOSTFACTS BUILD-07 diagnostics expose a shape of at most twelve words, never the line', () => {
  const line = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');
  assert.equal(shapeOf(line).split(' ').length, SHAPE_WORDS);
  const finding = lintSpeech(`Say ${line}.`)[0]!;
  assert.equal(finding.shape.split(' ').length <= SHAPE_WORDS, true);
  assert.equal(finding.shape.includes('word39'), false, 'the tail of the line is not republished');
  assert.equal(finding.fingerprint.length, 16);
});

test('C-HOSTFACTS BUILD-07 a baseline covers only its own fingerprint and count, and expiry is explicit', () => {
  const text = 'Say it back.\n' + 'Tell them plainly.';
  const findings = lintSpeech(text);
  assert.equal(findings.length, 2);
  const entry: BaselineEntry = {
    id: 'synthetic-debt', source: 'synthetic', rule: findings[0]!.rule, fingerprint: findings[0]!.fingerprint,
    line: findings[0]!.line, count: 1, destination: 'HELD', obligation: 'BUILD-03 replacement',
  };
  const known = lintSources([{ source: 'synthetic', text }], { baseline: [entry] });
  assert.equal(known.debt.length, 1, 'the baselined finding is debt, not a pass it hides');
  assert.equal(known.untriaged.length, 1, 'the second finding is still untriaged');
  // A changed span does not inherit the old entry: its fingerprint no longer matches.
  // A changed span carries a different fingerprint, so the old entry does not cover it.
  const changed = lintSources([{ source: 'synthetic', text: 'Tell it back.' }], { baseline: [entry] });
  assert.equal(changed.untriaged.length, 1, 'changed content fails instead of reusing the approval');
  assert.equal(changed.debt.length, 0);
});

test('C-HOSTFACTS BUILD-07 an exactness entry is narrow: it approves one span and nothing near it', () => {
  const text = '"I am here".';
  const approved = lintSpeech(text)[0]!;
  const entry: ExactnessEntry = {
    id: 'synthetic-control', source: 'synthetic', fingerprint: approved.fingerprint, line: approved.line,
    reason: 'supported control token', reviewer: 'synthetic-review',
  };
  const passed = lintSources([{ source: 'synthetic', text }], { exactness: [entry] });
  assert.equal(passed.exact.length, 1);
  assert.equal(passed.untriaged.length, 0);
  const changed = lintSources([{ source: 'synthetic', text: '"I am still here".' }], { exactness: [entry] });
  assert.equal(changed.untriaged.length, 1, 'the approval does not widen to new text');
});

// F2: an approval names the whole authored sentence at its line. A different verb with the same prescribed
// content, the same verb with different prescribed content, and the same sentence moved elsewhere all fail.
test('C-HOSTFACTS BUILD-07 an approval is bound to the full span and its location', () => {
  const authored = 'Say the reminder first, in your own words, as the first thing you say.';
  const finding = lintSpeech(authored)[0]!;
  const entry: BaselineEntry = {
    id: 'f2-span', source: 'synthetic', rule: finding.rule, fingerprint: finding.fingerprint, line: finding.line,
    count: 1, destination: 'FILED', obligation: 'the tool surfaces migrate',
  };
  const same = lintSources([{ source: 'synthetic', text: authored }], { baseline: [entry] });
  assert.equal(same.debt.length, 1, 'the exact span at its own line is the recorded debt');
  assert.equal(same.untriaged.length, 0);

  // Same verb, different prescribed content: the sentence changed, so the fingerprint no longer matches.
  const replaced = 'Say the reminder last, in someone else words, as the only thing you say.';
  const changed = lintSources([{ source: 'synthetic', text: replaced }], { baseline: [entry] });
  assert.equal(changed.untriaged.length, 1, 'same verb with changed content is untriaged');

  // Same sentence, one line lower: the location changed, so the same fingerprint does not carry over.
  const moved = 'A plain fact line.\n' + authored;
  const relocated = lintSources([{ source: 'synthetic', text: moved }], { baseline: [entry] });
  assert.equal(relocated.untriaged.length, 1, 'the same sentence at another line is untriaged');
  assert.equal(relocated.debt.length, 0);
});
