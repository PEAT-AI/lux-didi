/**
 * The price gate, executed. The three `--real` refusals in the CLI are indistinguishable to an exit code alone,
 * because a missing key also refuses with 2, so the gate is proven here on the exported function with a numeric
 * rates table: no confirmation refuses, a confirmation outside the tolerance refuses, one inside accepts, and an
 * unfilled rate table refuses whatever is confirmed.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { buildPlan, confirmPrice, loadRates, loadScenarios, PRICE_CONFIRM_TOLERANCE, type Rates } from './plan.js';
import { judgePrompt } from './judge.js';
import { scenariosDir, serverDir } from './locate.js';

const scenarios = () => loadScenarios(join(scenariosDir(), 'release.jsonl'));

const numericRates: Rates = {
  model: { name: 'synthetic-model', inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  judge: { name: 'synthetic-judge', inputUsdPerMTok: 1, outputUsdPerMTok: 4 },
};

const priced = () => buildPlan({ scenarios: scenarios(), rates: numericRates, judgePrompt: judgePrompt() });

test('the shipped rates table prices nothing and says so', () => {
  const plan = buildPlan({ scenarios: scenarios(), rates: loadRates(join(serverDir(), '../config/eval-rates.json')), judgePrompt: judgePrompt() });
  assert.equal(plan.estimatedUsd, null);
  assert.deepEqual([...plan.unset].sort(), ['judge.inputUsdPerMTok', 'judge.outputUsdPerMTok', 'model.inputUsdPerMTok', 'model.outputUsdPerMTok']);
  assert.match(confirmPrice(plan, 1) ?? '', /price is UNSET \(model\.inputUsdPerMTok/);
});

test('a numeric rates table gives a positive estimate', () => {
  const plan = priced();
  assert.ok(plan.estimatedUsd !== null && plan.estimatedUsd > 0, `estimate ${plan.estimatedUsd}`);
  assert.deepEqual(plan.unset, []);
});

test('no confirmation refuses a priced plan', () => {
  const refusal = confirmPrice(priced(), undefined);
  assert.match(refusal ?? '', /needs --confirm-price <usd>/);
});

test('a confirmation outside the tolerance refuses, on both sides', () => {
  const plan = priced();
  const estimate = plan.estimatedUsd as number;
  assert.match(confirmPrice(plan, estimate * (1 + PRICE_CONFIRM_TOLERANCE * 2)) ?? '', /is not within 20 percent of the estimate/);
  assert.match(confirmPrice(plan, estimate * (1 - PRICE_CONFIRM_TOLERANCE * 2)) ?? '', /is not within 20 percent of the estimate/);
});

test('a confirmation inside the tolerance, and at the edges, accepts', () => {
  const plan = priced();
  const estimate = plan.estimatedUsd as number;
  assert.equal(confirmPrice(plan, estimate), undefined);
  assert.equal(confirmPrice(plan, estimate * (1 + PRICE_CONFIRM_TOLERANCE) * 0.99), undefined);
  assert.equal(confirmPrice(plan, estimate * (1 - PRICE_CONFIRM_TOLERANCE) * 1.01), undefined);
});

test('a confirmation of nothing at all refuses rather than accepting zero', () => {
  const plan = priced();
  assert.match(confirmPrice(plan, 0) ?? '', /must be a positive number of dollars/);
  assert.match(confirmPrice(plan, Number.NaN) ?? '', /must be a positive number of dollars/);
});
