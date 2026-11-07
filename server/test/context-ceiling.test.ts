import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTEXT_BUDGET, ESTIMATED_CHARS_PER_TOKEN, estimatedTokens } from '../prompt/context-budget.js';
import { MEMORY_BACKGROUND, type MemoryBlockInput } from '../prompt/memory-block.js';
import type { OwnerProfileSnapshot } from '../prompt/types.js';
import {
  LIVE_MUTE_PICKUP, LIVE_RECOVERY_PICKUP, NAYA_LIVE_BASE, composeLiveSessionInstruction,
} from '../prompt/live-persona.js';
import { SEED_CHAR_LIMIT, SEED_MESSAGE_LIMIT, SEED_TOKEN_PROXY_LIMIT, alarmSessionInstructions, condenseSeed, fitSeedTurns } from '../live/index.js';

/**
 * The provider's documented live-session ceilings, quoted from its own guides and never from our estimates:
 * at most 16,384 tokens of instructions at session start, and 500 tokens per mid-call append. Every bound
 * below is charged at a pessimistic 3.0 characters per token, tighter than the app's own 3.2 estimator, so a
 * pass here holds at either reading of the tokenizer.
 */
const PROVIDER_INSTRUCTION_TOKENS = 16_384;
const PROVIDER_APPEND_TOKENS = 500;
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

function ownerLore(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, index) => `${index} ${'L'.repeat(200)}`).join('\n\n');
}

function owner(styleChars: number, loreParagraphs: number): OwnerProfileSnapshot {
  return {
    schemaVersion: 1, kind: 'profile', ownerId: 'p1-synthetic', profileVersion: 'p1', displayName: 'Synthetic Owner',
    style: { text: 'S'.repeat(styleChars), dataClass: 'private' },
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

/** Every section the composer can carry at once, each oversized, the owner style at three times the measured size. */
function worstCase() {
  const records = memoryRecords(64);
  return composeLiveSessionInstruction({
    text: `${NAYA_LIVE_BASE}\n\n${oversize(CONTEXT_BUDGET.sections.fixed.ceiling)}`,
    tools: ['search_knowledge'],
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
  });
}

// FINDING M20-F1: on base this throws `instruction_too_large` (live-persona.ts:683), so the worst-case start
// never reaches the model at all. The test stays red on purpose; the report carries the minimal fix.
test('worst case: every section oversized still composes inside hard admission and the provider instruction limit', () => {
  const composed = worstCase();
  assert.ok(estimatedTokens(composed.text) <= CONTEXT_BUDGET.hard,
    `composed instruction is ${estimatedTokens(composed.text)} estimated tokens, over the ${CONTEXT_BUDGET.hard} hard admission`);
  assert.ok(composed.text.length <= PROVIDER_INSTRUCTION_CHARS,
    `composed instruction is ${composed.text.length} characters, over the provider's ${PROVIDER_INSTRUCTION_CHARS}`);
});

// FINDING M20-F1: the same refusal, asserted on its own so the failure names the lost call, not the size.
test('worst case: composition never throws, so an oversized start is never a failed call', () => {
  assert.doesNotThrow(() => worstCase(), 'an oversized start must be trimmed, never refused');
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

// FINDING M20-F2: `alarmSessionInstructions` (live/index.ts:371) copies the alarm label and series rule in
// verbatim and neither field carries a bound, so a long reminder alone is over the provider's append budget.
test('every mid-call append payload stays inside the provider 500-token append budget', () => {
  const payloads: readonly [string, string][] = [
    ['a long alarm reminder', alarmSessionInstructions({ ownerDisplayName: 'Synthetic Owner', scheduledTime: '07:00', label: 'R'.repeat(1_200) })],
    ['a series alarm', alarmSessionInstructions({ ownerDisplayName: 'Synthetic Owner', scheduledTime: '07:00', label: 'Synthetic standup', series: 'S'.repeat(600) })],
    ['the recovery pickup', LIVE_RECOVERY_PICKUP],
    ['the mute pickup', LIVE_MUTE_PICKUP],
  ];
  for (const [what, payload] of payloads) {
    assert.ok(estimatedTokens(payload) <= PROVIDER_APPEND_TOKENS,
      `${what} is ${estimatedTokens(payload)} estimated tokens, over the provider's ${PROVIDER_APPEND_TOKENS}`);
  }
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
