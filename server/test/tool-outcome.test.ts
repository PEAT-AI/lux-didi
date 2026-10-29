import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolOutcomeOf } from '../live/tool-outcome.js';

const cases = [
  [{ status: 'refused', code: 'no_owner_request' }, 'refused', 'no_owner_request'],
  [{ status: 'clarify', reason: 'missing_time' }, 'clarify', 'missing_time'],
  [{ error: 'invalid arguments' }, 'failed', 'invalid_arguments'],
  [{ total: 0, messages: [] }, 'empty', undefined],
  [{ status: 'error', reason: 'tool_journal_failed' }, 'failed', 'tool_journal_failed'],
  [{ remembered: false, reason: 'owner_text_mismatch' }, 'refused', 'owner_text_mismatch'],
  [{ status: 'refused', code: 'authorization_missing' }, 'refused', 'authorization_missing'],
  [{ status: 'blocked', code: 'owner_turn_required' }, 'blocked', 'owner_turn_required'],
  [{ status: 'partial', answer: 'One synthetic result' }, 'partial', undefined],
  [{ status: 'answered', answer: 'Synthetic answer' }, 'completed', undefined],
  [{}, 'unknown', undefined],
  [{ status: 'completed' }, 'unknown', undefined],
  [{ saved: false, code: 'unrecognized_gate' }, 'refused', 'unrecognized_gate'],
] as const;
for (const [response, outcome, refusalCode] of cases) {
  test(`business outcome ${JSON.stringify(response)}`, () => {
    assert.deepEqual(toolOutcomeOf(response), { outcome, ...(refusalCode ? { refusalCode } : {}) });
  });
}
