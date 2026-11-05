import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpeningFacts, deliveredOpeningTopics, excludedOpeningTopics } from '../prompt/live-persona.js';

const now = Date.parse('2026-11-05T09:00:00Z');
const base = { now, timeZone: 'Europe/London', familyNames: ['Alice'], floorSubjects: ['Freya', 'boat'] };

test('opening facts are bounded timestamped data, not choices of wording', () => {
  const result = buildOpeningFacts({ ...base,
    day: ['2026-11-05 10:00 Design review'],
    openThread: '2026-11-04 Discuss the architecture proposal',
    commitments: ['2027-04-01 Run the marathon'],
    savedForHim: ['2026-11-04 Article about architecture'],
    excludeTopics: ['sleep'],
  });
  assert.deepEqual(Object.keys(result.facts), ['now', 'day', 'open_thread', 'commitments', 'saved_for_him', 'exclude_topics']);
  assert.match(result.facts.now, /2026/);
  assert.deepEqual(result.facts.commitments, ['2027-04-01 Run the marathon']);
  assert.deepEqual(result.facts.exclude_topics, ['sleep']);
  assert.match(result.section, /```\nOPENING_FACTS /);
  assert.ok(!/pick one|option|kind|rotation/i.test(result.section));
});

test('host withholds floor subjects from every opening source, including amounts and family events', () => {
  const unsafe = ['2026-11-05 Freya refit', '2026-11-05 Alice birthday', '2026-11-05 Budget £12,000',
    '2026-11-05 An illness update', '2026-11-05 boat repairs'];
  const result = buildOpeningFacts({ ...base, day: unsafe, openThread: unsafe.join('; '),
    commitments: [...unsafe, '2027-04-01 Run the marathon'], savedForHim: unsafe });
  assert.deepEqual(result.facts.day, []);
  assert.equal(result.facts.open_thread, '');
  assert.deepEqual(result.facts.saved_for_him, []);
  assert.deepEqual(result.facts.commitments, ['2027-04-01 Run the marathon']);
  for (const word of ['Freya', 'Alice', '12,000', 'illness', 'boat']) assert.ok(!result.section.includes(word));
});

test('empty sources remain explicit empty facts and exclusion history survives independently', () => {
  const result = buildOpeningFacts({ ...base, excludeTopics: ['sleep', 'architecture'] });
  assert.deepEqual(result.facts.day, []);
  assert.equal(result.facts.open_thread, '');
  assert.deepEqual(result.facts.commitments, []);
  assert.deepEqual(result.facts.saved_for_him, []);
  assert.deepEqual(result.facts.exclude_topics, ['sleep', 'architecture']);
});

test('delivered topics describe the spoken first turn rather than every offered fact', () => {
  const facts = buildOpeningFacts({ ...base, day: ['2026-11-05 Architecture review'],
    commitments: ['2027-04-01 Run the marathon'] }).facts;
  const topics = deliveredOpeningTopics('How is the marathon preparation going?', facts);
  assert.ok(topics.includes('marathon'));
  assert.ok(!topics.includes('architecture'));
  assert.ok(deliveredOpeningTopics('Did you get any sleep?', facts).includes('sleep'));
});

test('only the last three delivered calls contribute excluded semantic topics', () => {
  const excludeTopics = excludedOpeningTopics([{ topics: ['sleep'] }, { topics: ['marathon'] }, { topics: ['architecture'] }, { topics: ['older'] }]);
  const opening = buildOpeningFacts({ ...base, excludeTopics });
  assert.deepEqual(opening.facts.exclude_topics, ['sleep', 'marathon', 'architecture']);
  assert.ok(!opening.section.includes('older'));
});
