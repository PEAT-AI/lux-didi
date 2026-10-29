import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CanarySessions, assertCanaryResult, canaryPreflight, validateCanaryAsks } from '../dist/live/canary.js';

const ask = { id: 'synthetic-read', finals: ['Find the synthetic project'], expect: { tool: 'search', codeClass: 'success', nonEmpty: true } };
const result = { tool: 'search', result: { code: 'ok', items: [{ title: 'Synthetic project' }] }, ms: 4 };

test('canary accepts the tool own success code and data', () => {
  assert.deepEqual(assertCanaryResult(ask, result), { ok: true, code: 'ok' });
});
for (const [name, change, code] of [
  ['wrong tool', { tool: 'other' }, 'wrong_tool'],
  ['refusal stored as completed', { outcome: 'completed', result: { code: 'not_allowed', items: ['synthetic'] } }, 'not_allowed'],
  ['empty payload', { result: { code: 'ok', items: [] } }, 'empty_payload'],
  ['provider timeout', { timedOut: true }, 'provider_timeout'],
]) test(`canary rejects ${name}`, () => {
  assert.deepEqual(assertCanaryResult(ask, { ...result, ...change }), { ok: false, code });
});
for (const sideEffect of ['alarm', 'open', 'note']) test(`canary requires observed ${sideEffect} and cleanup`, () => {
  const sideAsk = { ...ask, expect: { ...ask.expect, sideEffect } };
  assert.equal(assertCanaryResult(sideAsk, result).code, 'side_effect_missing');
  assert.equal(assertCanaryResult(sideAsk, { ...result, sideEffect: { kind: sideEffect, observed: true, cleaned: false } }).ok, false);
  assert.equal(assertCanaryResult(sideAsk, { ...result, sideEffect: { kind: sideEffect, observed: true, cleaned: true } }).ok, true);
});
test('only absent asks can skip; a live call is always refused first', () => {
  assert.equal(canaryPreflight({ asksPresent: false, live: false }), 'skip');
  assert.throws(() => canaryPreflight({ asksPresent: false, live: true }), /call_live/);
  assert.equal(canaryPreflight({ asksPresent: true, live: false }), 'run');
});
test('canary input is bounded, unique and preserves split owner finals', () => {
  const split = { ...ask, finals: ['Set an alarm', 'in two minutes'] };
  assert.deepEqual(validateCanaryAsks([split]), [split]);
  assert.throws(() => validateCanaryAsks([]));
  assert.throws(() => validateCanaryAsks(Array(16).fill(ask)));
  assert.throws(() => validateCanaryAsks([ask, ask]));
  assert.throws(() => validateCanaryAsks([{ ...ask, finals: [''] }]));
});
test('native canary authority comes only from session opener, not frame/model fields', () => {
  let now = 0;
  const sessions = new CanarySessions(() => now);
  const frame = { type: 'native_action', id: 'action-1', action: 'open_url', target: 'https://example.invalid', canary: true };
  assert.equal(sessions.nativeFrame('ordinary', frame).action, 'open_url');
  assert.throws(() => sessions.nativeFrame('ordinary', { ...frame, action: 'canary_ack' }), /invalid_native_action/);
  sessions.open('canary-session');
  assert.equal(sessions.nativeFrame('canary-session', frame).action, 'canary_ack');
  assert.equal(sessions.nativeFrame('ordinary', frame).action, 'open_url');
  assert.throws(() => sessions.open('another'), /canary_already_live/);
  now = 360_001;
  assert.throws(() => sessions.nativeFrame('canary-session', frame), /canary_timeout/);
  sessions.close('canary-session');
  assert.equal(sessions.nativeFrame('canary-session', frame).action, 'open_url');
});
