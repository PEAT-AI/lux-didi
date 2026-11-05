import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('offline depth rubric rejects omitted facts, gaps and padded restatements', async () => {
  const root = process.env.DIDI_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('../../test/', import.meta.url));
  const replay = await import(pathToFileURL(resolve(root, '../../scripts/eval-worker-replay.mjs')).href);
  const scenario = { owner_words: 'Find the trial dates, please', expected_exact: ['Cedar Lab', 'Mira Chen'],
    expected_facts: [['trial', 'Monday'], ['budget', 'approved']], expected_gap: ['venue', 'unknown'] };
  const spoken = 'Cedar Lab runs the trial on Monday. The venue is unknown.';
  assert.deepEqual(replay.scoreDepth(scenario, { spoken }), {
    entity_recall: 0.5, fact_coverage: 0.5, gap_declared: true, preamble_absent: true, spoken_length: spoken.length,
  });
  const padded = replay.scoreDepth(scenario, { spoken: 'Find the trial dates. Sure thing. Cedar Lab and Mira Chen confirmed the trial Monday and budget approved.' });
  assert.equal(padded.entity_recall, 1);
  assert.equal(padded.fact_coverage, 1);
  assert.equal(padded.gap_declared, false);
  assert.equal(padded.preamble_absent, false);
  assert.equal(replay.scoreDepth(scenario, { spoken: '' }).entity_recall, 0);
});
