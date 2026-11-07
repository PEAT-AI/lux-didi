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


test('progress replay rejects repeated facts, unsourced reports, duplicate reports and silent corrections', async () => {
  const root = process.env.DIDI_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('../../test/', import.meta.url));
  const replay = await import(pathToFileURL(resolve(root, '../../scripts/eval-worker-replay.mjs')).href);
  for (const id of ['sourced-progress', 'progress-correction']) {
    const row = replay.REPLAY_ROWS.find((row: { id: string }) => row.id === id);
    assert.ok(row);
    const call = { name: 'report_progress', args: { findings: [row.progress_finding], still_checking: row.still_checking } };
    const good = replay.scoreDepth(row, { calls: [call], spoken: row.final_example });
    assert.equal(good.progress_once, true); assert.equal(good.progress_sourced, true);
    assert.equal(good.final_not_repeated, true); assert.equal(good.correction_plain, true);
    assert.equal(replay.scoreDepth(row, { calls: [call, call], spoken: row.final_example }).progress_once, false);
    assert.equal(replay.scoreDepth(row, { calls: [{ name: 'report_progress', args: { findings: [{ text: 'A guess', source: '' }], still_checking: 'mail' } }] }).progress_sourced, false);
    if (id === 'sourced-progress') assert.equal(replay.scoreDepth(row, { spoken: row.progress_finding.text }).final_not_repeated, false);
    else assert.equal(replay.scoreDepth(row, { spoken: 'The review is Wednesday.' }).correction_plain, false);
  }
});

test('FR5 fast-first replay: a clear fast hit is read, a miss falls back to full, and a title is never the fact', async () => {
  const root = process.env.DIDI_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('../../test/', import.meta.url));
  const replay = await import(pathToFileURL(resolve(root, '../../scripts/eval-worker-replay.mjs')).href);
  const rows = replay.VAULT_FAST_ROWS;
  assert.deepEqual(rows.map((row: { id: string }) => row.id), ['vault-fast-named-topic', 'vault-fast-unrelated-hits', 'vault-fast-empty', 'vault-fast-absent-topic']);
  for (const row of rows) {
    const score = replay.scoreVaultFast(row, { calls: replay.vaultFastPlan(row), spoken: row.answer });
    assert.deepEqual(Object.values(score), [true, true, true, true, true, true], `${row.id} follows the shipped rule`);
  }
  // The shipped worker text carries the rule; before the FR5 paragraph every row fails right here.
  assert.equal(replay.instructionCarriesFastFirst(), true);

  const named = rows[0];
  const titleOnly = replay.scoreVaultFast(named, { calls: [replay.vaultFastPlan(named)[0]], spoken: 'The Orchard irrigation plan.' });
  assert.equal(titleOnly.body_read, false);
  assert.equal(titleOnly.fact_supported, false, 'a title alone never carries the fact');
  const leaked = replay.scoreVaultFast(rows[1], { calls: replay.vaultFastPlan(rows[1]), spoken: 'Orchard Road bus lane buses stop at 23:00.' });
  assert.equal(leaked.unrelated_absent, false, 'the unrelated keyword hit is not the answer');
  assert.equal(leaked.fact_supported, false);
  const fullFirst = replay.scoreVaultFast(named, { calls: [{ name: 'search_insights', args: { query: named.owner_words, limit: 8 } }, { name: 'get_insight', args: { insight_ids: [named.record_id] } }], spoken: named.answer });
  assert.equal(fullFirst.fast_first, false, 'a ranked search first is not fast-first');
  const skippedFull = replay.scoreVaultFast(rows[1], { calls: [replay.vaultFastPlan(rows[1])[0], { name: 'get_insight', args: { insight_ids: [rows[1].record_id] } }], spoken: rows[1].answer });
  assert.equal(skippedFull.full_when_needed, false, 'an unclear fast result still needs the full search');
  // FR5-R1: fast returned hits for 3 of 5 absent topics, so an absence claim after the fast search
  // alone is refused, and the full search must be the one that found nothing.
  const absent = rows[3];
  const claimedFromFast = replay.scoreVaultFast(absent, { calls: [replay.vaultFastPlan(absent)[0]], spoken: absent.answer });
  assert.equal(claimedFromFast.full_when_needed, false, 'an absence claim never rests on the fast search alone');

  // Paired simulated wait to the first body-supported finding: 70 ms fast, 1528 ms full (FR5-R1).
  assert.deepEqual(replay.vaultPairedMs(), { fast_first: 70 + 3 * 1598, full_only: 1528 * 4 });
  assert.equal(replay.vaultFirstFindingMs(named, 'fast-first'), 70);
  assert.equal(replay.vaultFirstFindingMs(named, 'full-only'), 1528);
});
