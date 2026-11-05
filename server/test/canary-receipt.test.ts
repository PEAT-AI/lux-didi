import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore The installed check is an executable JavaScript module.
const { canaryReceipt } = await import('../../../scripts/lib/check-installed-canary.mjs');
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
