import assert from 'node:assert/strict';
import { test } from 'node:test';
// C-RESEARCH-CONTRACT (T-13, Q-13): the published schema is the validator. One constant set feeds the
// declaration, the description and the repair texts, and this file proves the three cannot drift apart.
import {
  CURSOR_MAX_CHARS, LOOKUP_SOURCES, MAX_LOOKUPS, QUESTION_MAX_CHARS, RESEARCH_LIMITS, TOPIC_MAX_CHARS, TOPIC_MAX_WORDS,
  parseResearch, researchDeclaration, researchDescription, researchRepair, statusAsk, STATUS_ASK_LOOKUP_LIMIT,
} from '../tools/research.js';
import { safeEvent } from '../host/log.js';

type Property = { type?: string; enum?: unknown[]; maxLength?: number; maxItems?: number; required?: string[]; properties?: Record<string, Property>; description?: string };
const declaration = researchDeclaration();
const parameters = declaration.parameters as unknown as { required?: string[]; anyOf?: unknown[]; properties: Record<string, Property> };

test('every validator limit has the schema keyword that states it', () => {
  assert.deepEqual(parameters.required, ['action']);
  const lookups = parameters.properties['lookups']!;
  // F1 (review resolution A): the keyword is the outer bound the parser accepts, so no schema-valid call is one
  // the host refuses; the per-call limit for an ordinary ask is stated in the description and the refusal.
  assert.equal(lookups.maxItems, STATUS_ASK_LOOKUP_LIMIT);
  assert.equal(STATUS_ASK_LOOKUP_LIMIT, RESEARCH_LIMITS.statusAskLookups);
  assert.equal(MAX_LOOKUPS, RESEARCH_LIMITS.maxLookups);
  const items = (lookups as unknown as { items: { properties: Record<string, Property> } }).items.properties;
  assert.deepEqual(items['source']!.enum, [...LOOKUP_SOURCES], 'the lookup source enum is the set the parser accepts');
  assert.equal(items['query']!.maxLength, RESEARCH_LIMITS.queryMaxChars);
  assert.equal(parameters.properties['topic']!.maxLength, TOPIC_MAX_CHARS);
  assert.equal(TOPIC_MAX_CHARS, RESEARCH_LIMITS.topicMaxChars);
  assert.equal(parameters.properties['question']!.maxLength, QUESTION_MAX_CHARS);
  assert.equal(QUESTION_MAX_CHARS, RESEARCH_LIMITS.questionMaxChars);
  assert.equal(parameters.properties['cursor']!.maxLength, CURSOR_MAX_CHARS);
  assert.deepEqual(parameters.properties['action']!.enum, ['start', 'continue', 'stop']);
  // The word cap is a prose rule a JSON schema cannot enforce, so the description states it and the parser
  // refuses it: the numbers on both sides come from the one constant.
  assert.match(parameters.properties['topic']!.description ?? '', new RegExp(`at most ${TOPIC_MAX_WORDS} words`));
});

test('the schema carries no float literal, because gpt-live-1 crashes session.start on one', () => {
  assert.equal(/\d\.\d/u.test(JSON.stringify(parameters)), false, 'every number in the schema is an integer');
});

test('the description and the repair texts are generated from the same values as the enum', () => {
  const description = researchDescription(['calendar', 'mail', 'chat', 'knowledge']);
  assert.match(description, new RegExp(`at most ${MAX_LOOKUPS} lookups`));
  assert.match(description, /One owner turn grants one research operation/);
  for (const source of LOOKUP_SOURCES) assert.match(description, new RegExp(`\\b${source}\\b`), `the description names ${source}`);
  assert.match(parameters.properties['sources']!.description ?? '', /company/, 'the owner-facing word is a published hint value');
  // Exactly the enum: the sentence is the enum joined, so a value can be neither missing nor invented.
  const expected = `${LOOKUP_SOURCES.slice(0, -1).join(', ')} or ${LOOKUP_SOURCES[LOOKUP_SOURCES.length - 1]}`;
  const guidance = String(researchRepair('lookup_source')['guidance']);
  assert.ok(guidance.includes(expected), `the repair lists ${expected}`);
  for (const source of LOOKUP_SOURCES) assert.ok(guidance.includes(source), `the repair names ${source}`);
  assert.match(String(researchRepair('lookups_count')['guidance']), new RegExp(`at most ${MAX_LOOKUPS} lookups`));
  assert.match(String(researchRepair('topic_length')['guidance']), new RegExp(`${TOPIC_MAX_WORDS} words`));
  assert.match(String(researchRepair('question_length')['guidance']), new RegExp(`${QUESTION_MAX_CHARS} characters`));
});

test('a call that violates each limit is refused with the reason the schema predicts', () => {
  const long = (chars: number): string => 'x'.repeat(chars);
  const cases: [string, unknown][] = [
    ['lookups_count', { action: 'start', question: 'the question', topic: 'names', lookups: Array.from({ length: MAX_LOOKUPS + 1 }, () => ({ source: 'knowledge', query: 'q' })) }],
    ['topic_length', { action: 'start', question: 'the question', topic: Array.from({ length: TOPIC_MAX_WORDS + 1 }, () => 'word').join(' ') }],
    ['topic_length', { action: 'start', question: 'the question', topic: long(TOPIC_MAX_CHARS + 1) }],
    ['question_length', { action: 'start', question: long(QUESTION_MAX_CHARS + 1), topic: 'names' }],
    ['lookup_query_length', { action: 'start', question: 'the question', topic: 'names', lookups: [{ source: 'knowledge', query: long(RESEARCH_LIMITS.queryMaxChars + 1) }] }],
    ['cursor_type', { action: 'continue', researchId: 'run-1', cursor: long(CURSOR_MAX_CHARS + 1) }],
    ['lookup_source', { action: 'start', question: 'the question', topic: 'names', lookups: [{ source: 'invented', query: 'q' }] }],
  ];
  for (const [reason, args] of cases) {
    const parsed = parseResearch(args);
    assert.equal(parsed.ok, false, `${reason}: refused`);
    assert.equal(parsed.ok ? '' : parsed.reason, reason);
    assert.equal(declaration.validate(args), false, `${reason}: the published validator agrees`);
  }
  // The three argument shapes the live host refused on 2026-10-27, each a wasted round trip: the schema now
  // states the limit, so a provider that validates rejects the call before a turn is spent.
  const refusedOntheDay: [string, unknown][] = [
    ['lookup_history', { action: 'start', question: 'the question', topic: 'names', lookups: [{ source: 'memory', history: 'the last month' }] }],
    ['topic_length', { action: 'start', question: 'the question', topic: 'who reports to whom in the singapore entity after the june org correction' }],
    ['lookups_count', { action: 'start', question: 'the question', topic: 'names', lookups: Array.from({ length: 5 }, () => ({ source: 'knowledge', query: 'q' })) }],
  ];
  for (const [reason, args] of refusedOntheDay) {
    const parsed = parseResearch(args);
    assert.equal(parsed.ok ? '' : parsed.reason, reason);
  }
  // F1 (review resolution A): the keyword publishes the outer bound, the description and the refusal publish the
  // per-call rule, and the invariant between them is one way: a call the schema accepts is a call the parser can
  // serve, so a provider that validates never rejects work the host would have done.
  assert.match(parameters.properties['lookups']!.description ?? '', new RegExp(`at most ${MAX_LOOKUPS} lookups`));
  assert.match(parameters.properties['lookups']!.description ?? '', new RegExp(`up to ${STATUS_ASK_LOOKUP_LIMIT}`));
  assert.match(String(researchRepair('lookups_count')['guidance']), new RegExp(`up to ${STATUS_ASK_LOOKUP_LIMIT}`));
  const statusQuestion = 'test all tools';
  assert.equal(statusAsk(statusQuestion), true, 'the status-ask case is the one #657 pins');
  const atCarveOut = { action: 'start', question: statusQuestion, topic: 'names', lookups: Array.from({ length: STATUS_ASK_LOOKUP_LIMIT }, (_, n) => ({ source: LOOKUP_SOURCES[n]!, query: 'q' })) };
  assert.equal(declaration.validate(atCarveOut), true, 'the schema accepts the widest list the parser serves');
  assert.equal(parseResearch(atCarveOut).ok, true, 'a status ask may name one lookup per source, as the declaration says');
  const pastCarveOut = { ...atCarveOut, lookups: Array.from({ length: STATUS_ASK_LOOKUP_LIMIT + 1 }, () => ({ source: 'knowledge', query: 'q' })) };
  assert.equal(declaration.validate(pastCarveOut), false, 'beyond the outer bound the provider refuses first');
  assert.equal(parseResearch(pastCarveOut).ok ? '' : (parseResearch(pastCarveOut) as { reason: string }).reason, 'lookups_count', 'and the parser refuses it too');
  // An ordinary ask keeps the per-call rule the description states: 5 lookups is refused with the reason the
  // description predicts, and the schema does not pretend otherwise in the model's direction.
  const ordinary = { action: 'start', question: 'who reports to Korbi', topic: 'Korbi reports', lookups: Array.from({ length: MAX_LOOKUPS + 1 }, () => ({ source: 'knowledge', query: 'q' })) };
  assert.equal(parseResearch(ordinary).ok ? '' : (parseResearch(ordinary) as { reason: string }).reason, 'lookups_count');
  assert.equal(declaration.validate(ordinary), true, 'the keyword is the outer bound, never a bound the host does not apply');
  assert.ok(JSON.stringify(parseResearch(refusedOntheDay[0]![1])).includes('"topicChars"'), 'the refusal carries lengths, not words');
  assert.equal(JSON.stringify(parseResearch(refusedOntheDay[0]![1])).includes('the last month'), false);
});

test('a refusal that names more lookups than the limit still logs its shape (F5)', () => {
  const parsed = parseResearch({ action: 'start', question: 'the question', topic: 'names', lookups: Array.from({ length: MAX_LOOKUPS + 2 }, () => ({ source: 'knowledge', query: 'q' })) });
  assert.equal(parsed.ok ? '' : parsed.reason, 'lookups_count');
  const shaped = safeEvent({ event: 'research_refused', state: 'refused', sequence: 1, reason: parsed.ok ? 'lookups_count' : parsed.reason, ...(parsed.ok ? {} : parsed.shape) });
  assert.notEqual(shaped, undefined, 'the refused call logs its shape, not nothing');
  assert.equal((shaped?.['queryChars'] as number[]).length, MAX_LOOKUPS + 2);
  assert.equal((shaped?.['lookupSources'] as string[]).length, MAX_LOOKUPS + 2);
  assert.equal((shaped?.['lookupCount'] as number), MAX_LOOKUPS + 2);
});
