import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const moduleUrl = process.env['DIDI_TEST_SOURCE_ROOT']
  ? pathToFileURL(resolve(process.env['DIDI_TEST_SOURCE_ROOT'], '../../scripts/lib/check-installed-canary.mjs')).href
  : new URL('../../../scripts/lib/check-installed-canary.mjs', import.meta.url).href;
const { canaryReceipt, validateInstalledReceipt } = await import(moduleUrl);
import { validateTaskCanaryAsks } from '../live/canary.js';
const line = (event: string, fields: Record<string, unknown> = {}) => JSON.stringify({ event, liveSessionId: 'call', taskId: 'task', ...fields });
const start = line('task_lifecycle', { phase: 'start' });
const tool = line('task_tool', { tool: 'web_search', category: 'ok', durationMs: 3 });
const settled = line('task_settled', { status: 'complete', findings: 1 });
const log = (...rows: string[]) => rows.join('\n');
test('receipt requires a real tool and complete findings for the exact call and task', () => {
  assert.equal(canaryReceipt(log(start, tool, settled), 'call').code, 'ok');
  assert.equal(canaryReceipt(log(start, tool, settled), 'other').ok, false);
  assert.equal(canaryReceipt(log(start, line('task_tool', { taskId: 'other', category: 'ok' }), settled), 'call').ok, false);
});
test('lifecycle complete without a tool is never an install receipt', () => {
  assert.equal(canaryReceipt(log(start, line('task_lifecycle', { phase: 'complete' }), settled), 'call').code, 'task_tool_missing');
});
test('inference failures and incomplete settlement preserve reason codes', () => {
  assert.equal(canaryReceipt(log(start, tool, settled, line('task_inference_failed', { reason_code: 'provider_auth' })), 'call').code, 'provider_auth');
  assert.equal(canaryReceipt(log(start, tool, line('task_settled', { status: 'incomplete', reason_code: 'source_unavailable' })), 'call').code, 'source_unavailable');
});
test('uncorrelated events and empty findings cannot pass', () => {
  assert.equal(canaryReceipt(log(start, tool, line('task_settled', { liveSessionId: undefined, status: 'complete', findings: 1 })), 'call').ok, false);
  assert.equal(canaryReceipt(log(start, tool, line('task_settled', { status: 'complete', findings: 0 })), 'call').ok, false);
});

test('installer receipt must match the exact installed bundle and build identity', () => {
  const build = { target: '/synthetic/app', installId: 'installation-one', releaseCommit: 'a'.repeat(40) };
  const receipt = { schemaVersion: 1, ...build, ok: true, code: 'ok', callId: 'call', terminalReason: 'clean_close' };
  assert.equal(validateInstalledReceipt(receipt, build), 'ok');
  assert.equal(validateInstalledReceipt(null, build), 'canary_receipt_missing');
  for (const key of ['target', 'installId', 'releaseCommit']) {
    assert.equal(validateInstalledReceipt({ ...receipt, [key]: 'different' }, build), 'canary_receipt_stale');
  }
  assert.equal(validateInstalledReceipt({ ...receipt, ok: false }, build), 'canary_red');
  assert.equal(validateInstalledReceipt({ ...receipt, callId: '' }, build), 'canary_red');
  assert.equal(validateInstalledReceipt({ ...receipt, terminalReason: 'provider_failed' }, build), 'canary_red');
  assert.equal(validateInstalledReceipt({ ...receipt, terminalReason: 'canary_shutdown_timer' }, build), 'ok');
});
test('installed task asks are read-only owner finals, never legacy write or voice-tool asks', () => {
  const ask = { id: 'read', finals: ['Find the official public specification'], expect: { task: 'complete', readOnly: true } };
  assert.deepEqual(validateTaskCanaryAsks([ask]), [ask]);
  for (const sideEffect of ['alarm', 'open', 'note']) {
    assert.throws(() => validateTaskCanaryAsks([{ ...ask, expect: { ...ask.expect, sideEffect } }]), /read_only_task_ask_required/);
  }
  assert.throws(() => validateTaskCanaryAsks([{ ...ask, expect: { tool: 'set_alarm', codeClass: 'success' } }]), /read_only_task_ask_required/);
  assert.throws(() => validateTaskCanaryAsks([{ ...ask, expect: { ...ask.expect, readOnly: false } }]), /read_only_task_ask_required/);
});
