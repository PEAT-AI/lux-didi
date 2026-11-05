import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTaskPayload } from '../tasks/connectors.js';

export const vaultEnvelope = `# Knowledge Search: 'orchid watering'

_confidence: medium · mode: reranked · low_confidence: yes_ · top score: 0.45 · relevant candidate: yes · top ranker score: 0.45

_sensitive rows excluded from this search; pass include_sensitive=true to include them_

*Use get_insight(ids=[...]) to fetch full content*

**#115** [PATTERN] Orchid | Care | Watering schedule
  valid from 2026-02-01 · current
  · unknown
  Orchids are watered once a week in the shade house...
  Score: 0.518

**#89969** [TECHNICAL_DECISION] Old watering plan
  ⚠ superseded by a confirmed current replacement, retained for historical context (see #90213)
  valid from 2026-10-15 · superseded by #90213 (2026-10-17)
  Twice a week was the earlier rule...
  Score: 0.348
`;

test('vault semantic hits retain evidence and are successful without exact titles', () => {
  const result = projectTaskPayload('search_knowledge', vaultEnvelope, { query: 'orchid watering' });
  assert.equal(result.status, 'ok');
  for (const evidence of ['_confidence: medium', 'low_confidence: yes', 'sensitive rows excluded', '[PATTERN]', 'valid from 2026-02-01', 'once a week', 'Score: 0.518', 'superseded', '#90213']) {
    assert.ok(result.text.includes(evidence), evidence);
  }
  assert.deepEqual(result.references.map(ref => ref.id), ['115', '89969']);
  assert.ok(result.text.indexOf('#115') < result.text.indexOf('#89969'));
});

test('vault absence is empty while malformed source text is not evidence of absence', () => {
  assert.equal(projectTaskPayload('search_knowledge', '# Knowledge Search\n\nNo results found.', { query: 'absent' }).status, 'empty');
  assert.notEqual(projectTaskPayload('search_knowledge', 'upstream response missing', { query: 'absent' }).status, 'empty');
});

test('vault shaping is bounded and does not change company exact-name matching', () => {
  const result = projectTaskPayload('search_knowledge', vaultEnvelope + 'x'.repeat(100000), { query: 'orchid watering' });
  assert.ok(result.text.length <= 24000);
  assert.equal(projectTaskPayload('search_company', vaultEnvelope, { query: 'orchid watering' }).status, 'no_match');
});
