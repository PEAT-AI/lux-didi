import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTEXT_BUDGET, ESTIMATED_CHARS_PER_TOKEN, estimatedTokens } from '../prompt/context-budget.js';
import { MEMORY_BACKGROUND, type MemoryBlockInput } from '../prompt/memory-block.js';
import type { OwnerProfileSnapshot } from '../prompt/types.js';
import {
  LIVE_MUTE_PICKUP, LIVE_RECOVERY_PICKUP, NAYA_LIVE_BASE, composeLiveSessionInstruction,
} from '../prompt/live-persona.js';
import { APPEND_TOKEN_LIMIT, SEED_CHAR_LIMIT, SEED_MESSAGE_LIMIT, SEED_TOKEN_PROXY_LIMIT, alarmAppendText, alarmSessionInstructions, condenseSeed, fitSeedTurns } from '../live/index.js';

/**
 * The provider's documented live-session ceilings, quoted from its own guides and never from our estimates:
 * at most 16,384 tokens of instructions at session start, and 500 tokens per mid-call append. Every bound
 * below is charged at a pessimistic 3.0 characters per token, tighter than the app's own 3.2 estimator, so a
 * pass here holds at either reading of the tokenizer.
 */
const PROVIDER_INSTRUCTION_TOKENS = 16_384;
const PESSIMISTIC_CHARS_PER_TOKEN = 3.0;
const PROVIDER_INSTRUCTION_CHARS = PROVIDER_INSTRUCTION_TOKENS * PESSIMISTIC_CHARS_PER_TOKEN;
/** The owner-style section measured on the release 10.18 canary, in characters. */
const MEASURED_OWNER_STYLE_CHARS = 17_274;
const WORST_CASE_MULTIPLE = 3;
const NOW = Date.UTC(2026, 10, 7, 0);
const LORE_PARAGRAPH_CHARS = 210;
const chars = (tokens: number): number => Math.ceil(tokens * ESTIMATED_CHARS_PER_TOKEN);

/** Characters for a section holding `multiple` times its own token ceiling, at the app estimator. */
function oversize(tokens: number, multiple = WORST_CASE_MULTIPLE): string {
  return 'x'.repeat(chars(tokens) * multiple);
}

/** Authored style text arrives as paragraphs, which is the unit the last-resort clip is allowed to shed. */
function styleParagraphs(totalChars: number): string {
  const paragraphs: string[] = [];
  let used = 0;
  for (let index = 0; used < totalChars; index += 1) {
    const paragraph = `${index} ${'S'.repeat(200)}`;
    paragraphs.push(paragraph); used += paragraph.length + 2;
  }
  return paragraphs.join('\n\n');
}

function ownerLore(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, index) => `${index} ${'L'.repeat(200)}`).join('\n\n');
}

function owner(styleChars: number, loreParagraphs: number): OwnerProfileSnapshot {
  return {
    schemaVersion: 1, kind: 'profile', ownerId: 'p1-synthetic', profileVersion: 'p1', displayName: 'Synthetic Owner',
    style: { text: styleParagraphs(styleChars), dataClass: 'private' },
    lore: { text: ownerLore(loreParagraphs), dataClass: 'sensitive' },
  };
}

function memoryRecords(count: number): readonly { id: string; text: string; capturedAt: number }[] {
  return Array.from({ length: count }, (_, index) => ({ id: `note-${index}`, text: `${index} ${'M'.repeat(100)}`, capturedAt: NOW - index * 1_000 }));
}

/** Small facts, so whole-item granularity cannot move a part more than a few tokens off its budget. */
function tinyRecords(count: number): readonly { id: string; text: string; capturedAt: number }[] {
  return Array.from({ length: count }, (_, index) => ({ id: `fact-${index}`, text: `fact ${index}`, capturedAt: NOW - index * 1_000 }));
}

function startContext(patch: Partial<MemoryBlockInput> = {}): MemoryBlockInput {
  return { now: NOW, timeZone: 'UTC', clock: 'Sat 7 Nov 2026, 00:00 UTC', items: [], entries: [], summaries: [], ...patch };
}

/**
 * Every section the composer can carry at once, each oversized, the owner style at three times the measured
 * size. Two parts stay at their reservation rather than three times it: the fixed persona text, because the
 * ruling keeps the refusal of a start whose fixed text alone exceeds hard (asserted separately below), and the
 * memory block, whose selection is charged to the per-part ceilings by design.
 */
function worstCaseInput() {
  const records = memoryRecords(64);
  return {
    text: `${NAYA_LIVE_BASE}\n\n${oversize(CONTEXT_BUDGET.sections.fixed.ceiling, 1)}`,
    tools: ['search_insights'],
    records,
    trustedChars: 60_000,
    now: NOW,
    timeZone: 'UTC',
    runtimeContext: oversize(CONTEXT_BUDGET.sections.runtime.ceiling),
    calendar: `09:00 ${oversize(CONTEXT_BUDGET.sections.calendar.ceiling)}`,
    memoryBlockInput: startContext({ entries: records }),
    pickupNote: oversize(CONTEXT_BUDGET.sections.pickup.ceiling),
    openersNote: oversize(CONTEXT_BUDGET.sections.openings.ceiling),
    openingFacts: oversize(CONTEXT_BUDGET.sections.openings.ceiling),
    ownerProfile: owner(MEASURED_OWNER_STYLE_CHARS * WORST_CASE_MULTIPLE, 40),
  };
}

const worstCase = () => composeLiveSessionInstruction(worstCaseInput());

test('worst case: every section oversized still composes inside hard admission and the provider instruction limit', () => {
  const composed = worstCase();
  assert.ok(estimatedTokens(composed.text) <= CONTEXT_BUDGET.hard,
    `composed instruction is ${estimatedTokens(composed.text)} estimated tokens, over the ${CONTEXT_BUDGET.hard} hard admission`);
  assert.ok(composed.text.length <= PROVIDER_INSTRUCTION_CHARS,
    `composed instruction is ${composed.text.length} characters, over the provider's ${PROVIDER_INSTRUCTION_CHARS}`);
});

test('worst case: composition never throws, so an oversized start is never a failed call', () => {
  assert.doesNotThrow(() => worstCase(), 'an oversized start must be trimmed, never refused');
});

test('M20-R1: the last-resort clip takes the pickup note, then owner-style paragraphs, and reports what it took', () => {
  const composed = worstCase();
  assert.ok(composed.clipped.length > 0, 'the worst case must actually exercise the clip, or this test proves nothing');
  for (const item of composed.clipped) {
    assert.ok(item.id === 'pickup' || item.id === 'owner-style', `the clip must never reach ${item.id}`);
    assert.ok(item.chars > 0, 'a clip reports the characters it removed');
  }
  // The pickup note goes first, whole, and the style is cut only after it.
  assert.deepEqual(composed.clipped.map(item => item.id), ['pickup', 'owner-style']);
});

test('M20-R1: the clip never touches the pinned lore or the memory block, nor their floors', () => {
  const clipped = worstCase();
  const input = worstCaseInput();
  // The control is the same start with an owner style that needs no clip, so nothing else may differ.
  const control = composeLiveSessionInstruction({ ...input, pickupNote: 'Synthetic pickup', ownerProfile: owner(2_000, 40) });
  const section = (result: typeof clipped, id: string) => result.sections.find(entry => entry.id === id);
  assert.equal(section(clipped, 'owner-lore')?.chars, section(control, 'owner-lore')?.chars, 'the lore section is byte-identical');
  assert.equal(section(clipped, 'memory')?.chars, section(control, 'memory')?.chars, 'the memory block is byte-identical');
  for (const id of ['owner-lore', 'memory']) assert.ok(section(clipped, id) !== undefined, `the clip never drops ${id}`);
  const identityOf = (result: typeof clipped): string => {
    const at = result.text.indexOf('# Who he is');
    assert.ok(at !== -1, 'the identity part is never dropped');
    return result.text.slice(at, result.text.indexOf('# Open loops', at));
  };
  assert.equal(identityOf(clipped), identityOf(control), 'the identity part is byte-identical');
  assert.ok(estimatedTokens(identityOf(clipped)) >= CONTEXT_BUDGET.memory.identity.floor - 40,
    `identity keeps its floor: ${estimatedTokens(identityOf(clipped))} estimated tokens`);
});

test('M20-R3: a one-paragraph prose owner style over hard admission is cut at a sentence, not refused', () => {
  const records = memoryRecords(12);
  const prose = Array.from({ length: 900 }, (_, index) => `Sentence ${index} of the owner's own prose about how she should sound.`).join(' ');
  const composed = composeLiveSessionInstruction({
    text: NAYA_LIVE_BASE, tools: [], records, trustedChars: 60_000, now: NOW, timeZone: 'UTC',
    memoryBlockInput: startContext({ entries: records }),
    ownerProfile: { schemaVersion: 1, kind: 'profile', ownerId: 'p1-synthetic', profileVersion: 'p1', displayName: 'Synthetic Owner',
      style: { text: prose, dataClass: 'private' }, lore: { text: 'Synthetic lore paragraph.', dataClass: 'sensitive' } },
  });
  assert.ok(estimatedTokens(composed.text) <= CONTEXT_BUDGET.hard, `composed instruction is ${estimatedTokens(composed.text)} estimated tokens`);
  assert.ok(composed.text.length <= PROVIDER_INSTRUCTION_CHARS, `composed instruction is ${composed.text.length} characters`);
  assert.deepEqual(composed.clipped.map(item => item.id), ['owner-style'], 'the style is the thing that yields here');
  assert.ok(composed.text.includes('Sentence 0 of the owner'), 'the style is cut from its tail, never emptied');
  // The cut lands on a sentence boundary, so no sentence is half written.
  const style = composed.text.slice(composed.text.indexOf('Sentence 0'), composed.text.indexOf('Sentence 0') + 400);
  assert.match(style, /Sentence \d+ of the owner's own prose about how she should sound\./u);
});

test('M20-R1: a start whose fixed text alone exceeds hard admission is still refused', () => {
  // The persona text is not a yieldable part: the ladder can only shorten the owner style and the pickup note,
  // so a base that alone exceeds hard is the one refusal the ruling keeps, refused with its typed error.
  const record = [{ id: 'note', text: 'Synthetic fact', capturedAt: NOW }];
  assert.throws(() => composeLiveSessionInstruction({
    text: `${NAYA_LIVE_BASE}\n\n${'F'.repeat(chars(CONTEXT_BUDGET.hard) + 5_000)}`, tools: [], records: record,
    trustedChars: 60_000, now: NOW, timeZone: 'UTC',
    memoryBlockInput: startContext({ entries: record }),
    ownerProfile: owner(2_000, 3),
  }), { code: 'instruction_too_large' });
});

test('the pinned lore and the memory floors hold while the yieldable sections overflow', () => {
  const records = tinyRecords(120);
  const composed = composeLiveSessionInstruction({
    text: NAYA_LIVE_BASE,
    tools: [],
    records,
    trustedChars: 60_000,
    now: NOW,
    timeZone: 'UTC',
    runtimeContext: '# Runtime context\nSynthetic runtime',
    calendar: `09:00 ${oversize(CONTEXT_BUDGET.sections.calendar.ceiling)}`,
    memoryBlockInput: startContext({ entries: records, floors: true, floorParts: ['identity', 'loops', 'conversations'] }),
    openersNote: oversize(CONTEXT_BUDGET.sections.openings.ceiling),
    openingFacts: oversize(CONTEXT_BUDGET.sections.openings.ceiling),
    ownerProfile: owner(2_000, 40),
  });
  const section = (id: string) => composed.sections.find(entry => entry.id === id);
  const lore = section('owner-lore');
  // Pinned means clipped at its own ceiling, never yielded: whole paragraphs trade the last few hundred
  // characters for never cutting one mid-sentence, so the band is one paragraph wide, not exact.
  assert.ok(lore !== undefined, 'the authored lore is never dropped');
  assert.ok(lore.chars >= chars(CONTEXT_BUDGET.sections.lore.floor) - LORE_PARAGRAPH_CHARS,
    `lore is pinned at its floor: ${lore.chars} characters`);
  assert.ok(lore.chars <= chars(CONTEXT_BUDGET.sections.lore.ceiling) + 200, `lore stays inside its ceiling: ${lore.chars} characters`);
  assert.ok(composed.text.includes('1 ' + 'L'.repeat(200)), 'the authored lore is carried, not summarised');
  const memory = section('memory');
  assert.ok(memory !== undefined, 'the memory block is never dropped');
  assert.ok(composed.text.includes(MEMORY_BACKGROUND));
  const identityAt = composed.text.indexOf('# Who he is');
  assert.ok(identityAt !== -1, 'the identity part is never dropped');
  const identity = composed.text.slice(identityAt, composed.text.indexOf('# Open loops', identityAt));
  assert.ok(estimatedTokens(identity) >= CONTEXT_BUDGET.memory.identity.floor - 10,
    `identity keeps its floor: ${estimatedTokens(identity)} estimated tokens`);
  assert.ok(estimatedTokens(identity) <= CONTEXT_BUDGET.memory.identity.ceiling,
    `identity stays inside its ceiling: ${estimatedTokens(identity)} estimated tokens`);
  const calendar = section('calendar');
  if (calendar !== undefined) {
    assert.ok(calendar.chars <= chars(CONTEXT_BUDGET.sections.calendar.floor) + 200, `calendar yielded to its floor: ${calendar.chars} characters`);
  }
  assert.ok(estimatedTokens(composed.text) <= CONTEXT_BUDGET.hard, 'and the whole instruction still fits');
});

test('every mid-call append payload stays inside the provider 500-token append budget', () => {
  // M20-R3: the bound is asserted on the string the adapter writes, host note prefix and suffix included.
  const short = { ownerDisplayName: 'Synthetic Owner', scheduledTime: '07:00', label: 'call the bank' };
  assert.equal(alarmAppendText(short),
    `[host note, not the owner] ${alarmSessionInstructions(short)} Announce this now in the current call.`,
    'the wire string is the host note wrapper around the inner note plus its suffix');
  assert.ok(estimatedTokens(alarmAppendText(short)) <= APPEND_TOKEN_LIMIT, 'a short reminder is inside the budget');
  const payloads: readonly [string, string][] = [
    ['a long alarm reminder', alarmAppendText({ ownerDisplayName: 'Synthetic Owner', scheduledTime: '07:00', label: 'R'.repeat(1_200) })],
    ['a long series rule', alarmAppendText({ ownerDisplayName: 'Synthetic Owner', scheduledTime: '07:00', label: 'Synthetic standup', series: 'S'.repeat(600) })],
    ['the longest alarm note', alarmAppendText({ ownerDisplayName: 'Synthetic Owner', scheduledTime: '07:00', label: 'R '.repeat(900), series: 'S '.repeat(400), alarmId: 'alarm-synthetic' })],
    // A reminder that clips gradually, so the wire string lands near the limit and the prefix and suffix count.
    ['a wordy reminder near the limit', alarmAppendText({ ownerDisplayName: 'Synthetic Owner', scheduledTime: '07:00', label: 'call the bank '.repeat(140) })],
    ['the recovery pickup', LIVE_RECOVERY_PICKUP],
    ['the mute pickup', LIVE_MUTE_PICKUP],
  ];
  for (const [what, payload] of payloads) {
    assert.ok(estimatedTokens(payload) <= APPEND_TOKEN_LIMIT,
      `${what} is ${estimatedTokens(payload)} estimated tokens, over the provider's ${APPEND_TOKEN_LIMIT}`);
  }
  // The clip is at a word boundary and keeps the fixed instruction text whole.
  const clipped = alarmAppendText({ ownerDisplayName: 'Synthetic Owner', scheduledTime: '07:00', label: 'R '.repeat(900) });
  assert.ok(!/\s{2,}R?$|R{2,}/u.test(clipped.replace(/^[\s\S]*words, as the first thing you say: "/u, '')), 'the reminder is cut between words');
  assert.ok(clipped.includes('[alarm mode]') && clipped.includes('Briefly invite a spoken answer.'), 'the fixed note is never cut');
});

test('the recovery reseed stays inside 128 messages and 8,192 estimated tokens', () => {
  const transcript = Array.from({ length: 400 }, (_, index) => ({
    role: (index % 2 === 0 ? 'user' : 'model') as 'user' | 'model',
    text: `Turn ${index} ${'t'.repeat(400)}`,
  }));
  const fitted = fitSeedTurns(transcript);
  assert.ok(fitted.turns.length <= 128, `the reseed carries ${fitted.turns.length} messages`);
  assert.ok(fitted.chars <= SEED_CHAR_LIMIT);
  const fittedTokens = estimatedTokens(fitted.turns.map(turn => turn.text).join(''));
  assert.ok(fittedTokens <= SEED_TOKEN_PROXY_LIMIT, `the reseed is ${fittedTokens} estimated tokens, over ${SEED_TOKEN_PROXY_LIMIT}`);
  const condensed = condenseSeed(transcript);
  assert.ok(condensed.turns.length <= 128, `the condensed reseed carries ${condensed.turns.length} messages`);
  assert.ok(condensed.turns.length <= SEED_MESSAGE_LIMIT + 1, 'the condensed reseed leaves room for its opening line');
  const condensedTokens = estimatedTokens(condensed.turns.map(turn => turn.text).join(''));
  assert.ok(condensedTokens <= SEED_TOKEN_PROXY_LIMIT, `the condensed reseed is ${condensedTokens} estimated tokens`);
});
