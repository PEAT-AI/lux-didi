import { safeEvent } from '../host/log.js';
import { DatabaseSync } from 'node:sqlite';
import { taskMigrations, pruneOpeningTopics } from '../runtime/task-schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpeningFacts, deliveredOpeningTopics, excludedOpeningTopics, openingContextFloors, openingTurnTranscript } from '../prompt/live-persona.js';

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

test('host floor inputs follow family roster membership, aliases and authored off-limit subjects', () => {
  const floors = openingContextFloors([{ name: 'Alice Smith', aliases: ['Ally'], circle: 'family' },
    { name: 'Morgan', aliases: [], circle: 'work' }], 'Never joke about Selene. Architecture is a fine subject for humour.');
  const result = buildOpeningFacts({ now, timeZone: 'UTC', ...floors, day: ['2026-11-05 Alice birthday', '2026-11-05 Ally lunch', '2026-11-05 Selene repairs', '2026-11-05 Morgan architecture review'] });
  assert.deepEqual(result.facts.day, ['2026-11-05 Morgan architecture review']);
});

test('first turn includes every transcription segment and stops before later assistant turns', () => {
  assert.equal(openingTurnTranscript([{ kind: 'inputTranscription', text: 'Hello' },
    { kind: 'outputTranscription', text: 'The architecture ' }, { kind: 'outputTranscription', text: 'review is next.' },
    { kind: 'turnComplete', text: null }, { kind: 'outputTranscription', text: 'Another topic' }]), 'The architecture review is next.');
});

test('calendar facts contain only upcoming timed items and preserve all-day context', () => {
  const result = buildOpeningFacts({ ...base, day: ['2026-11-05 08:00 Old meeting', '2026-11-05 10:00 Design review', '2026-11-05 All-day workshop'] });
  assert.deepEqual(result.facts.day, ['2026-11-05 10:00 Design review', '2026-11-05 All-day workshop']);
});

test('opening diagnostic retention removes old rows and bounds even a burst of calls', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const sql of taskMigrations.find(migration => migration.version === 4)!.statements) db.exec(sql);
    const insert = db.prepare('INSERT INTO delivered_opening_topics(call_id,utc,topics) VALUES (?,?,?)');
    insert.run('old', now - 31 * 86400000, '["old"]');
    for (let index = 0; index < 105; index++) insert.run(`call-${index}`, now + index, '["architecture"]');
    pruneOpeningTopics({ run: (sql, params = []) => Number(db.prepare(sql).run(...params).changes) }, now + 105);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM delivered_opening_topics').get()?.['n'], 100);
    assert.equal(db.prepare('SELECT call_id FROM delivered_opening_topics WHERE call_id=?').get('old'), undefined);
    assert.equal(db.prepare('SELECT call_id FROM delivered_opening_topics WHERE call_id=?').get('call-0'), undefined);
    assert.equal(db.prepare('SELECT call_id FROM delivered_opening_topics WHERE call_id=?').get('call-104')?.['call_id'], 'call-104');
  } finally { db.close(); }
});

test('opening log admits only the closed counts envelope and rejects private payloads', () => {
  const event = { event: 'opener_facts', day: 2, commitments: 1, saved_for_him: 0, open_thread: 1, exclude_topics: 3 };
  assert.deepEqual(safeEvent(event), event);
  for (const key of ['day', 'commitments', 'saved_for_him', 'open_thread', 'exclude_topics']) {
    for (const invalid of [-1, 0.5, NaN, Infinity, 'private fact', ['sleep'], null]) assert.equal(safeEvent({ ...event, [key]: invalid }), undefined);
  }
  assert.equal(safeEvent({ ...event, facts: 'private calendar title' }), undefined);
  assert.equal(safeEvent({ ...event, topics: ['sleep'] }), undefined);
  assert.equal(safeEvent({ event: 'opener_plan', kinds: ['calendar'], rotation: 0 }), undefined);
});

test('illness floors withhold concrete diseases, symptoms and treatment facts across all opening fields', () => {
  const protectedFacts = [
    '2026-11-05 Flu update', '2026-11-05 Pneumonia recovery', '2026-11-05 Influenza symptoms',
    '2026-11-05 COVID recovery', '2026-11-05 Migraine appointment', '2026-11-05 Diabetes review',
    '2026-11-05 Fever and a sore throat', '2026-11-05 Chest pain overnight',
    '2026-11-05 Antibiotics prescription', '2026-11-05 Chemotherapy appointment',
    '2026-11-05 Surgery recovery', '2026-11-05 A broken wrist',
  ];
  for (const fact of protectedFacts) {
    const result = buildOpeningFacts({ now: 0, timeZone: 'UTC', familyNames: [], floorSubjects: ['illness'],
      day: [fact], openThread: fact, commitments: [fact], savedForHim: [fact], excludeTopics: [fact] });
    assert.deepEqual(result.facts.day, [], fact);
    assert.equal(result.facts.open_thread, '', fact);
    assert.deepEqual(result.facts.commitments, [], fact);
    assert.deepEqual(result.facts.saved_for_him, [], fact);
    assert.deepEqual(result.facts.exclude_topics, [], fact);
  }
  const ordinary = ['2026-11-05 Software bug review', '2026-11-05 Cold outreach campaign', '2026-11-05 Database recovery plan', '2027-04-01 Run the marathon'];
  const allowed = buildOpeningFacts({ ...base, savedForHim: ordinary });
  assert.deepEqual(allowed.facts.saved_for_him, ordinary, 'illness screening must not erase ordinary work or the dated marathon');
});
