import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { draftFixtures, DEAD_AIR_LIMIT_MS, POSTCALL_FINDINGS, readCapture, renderReport, reviewSession, writeReview } from '../../trace/postcall.js';
import { regressionsDir } from './locate.js';

const capture = (): string => readFileSync(join(regressionsDir(), 'postcall-session.json'), 'utf8');
const review = () => reviewSession(readCapture(capture()), 'sess_synthetic');

test('a session capture yields every finding class the review recognises', () => {
  const findings = review().findings;
  assert.deepEqual(findings.map(finding => finding.class).sort(), [
    'claim_without_receipt', 'dead_air', 'no_provider_audio', 'reconnect', 'refusal', 'refusal', 'refusal', 'tool_failure',
  ]);
  const refusals = findings.filter(finding => finding.class === 'refusal').map(finding => `${finding.layer}:${finding.code}`).sort();
  assert.deepEqual(refusals, ['connector:auth_expired', 'dispatch:grant_missing', 'host:no_owner_input']);
  assert.equal(findings.find(finding => finding.class === 'tool_failure')?.tool, 'mail_send');
  assert.ok((findings.find(finding => finding.class === 'dead_air')?.ms ?? 0) > DEAD_AIR_LIMIT_MS);
});

test('a wait under the bound and a completed call are not findings', () => {
  const quiet = reviewSession(readCapture(JSON.stringify({ events: [
    { event: 'tool_call_outcome', tool: 'calendar_read', outcome: 'completed', ms: 12 },
    { event: 'live_dead_air', deadAirMs: 1_500 },
  ] })), 'sess_quiet');
  assert.deepEqual(quiet.findings, []);
  assert.match(renderReport(quiet), /clean/);
});

test('the report names counts and layers, never owner words', () => {
  const text = renderReport(review());
  assert.match(text, /refusal x1: host refused vault_write with no_owner_input/);
  assert.doesNotMatch(text, /standup|Acme|Q4 budget/i);
});

test('draft fixtures carry tool names, shapes, codes and timing, and no text field', () => {
  const drafts = draftFixtures(review());
  assert.equal(drafts.length, POSTCALL_FINDINGS.filter(name => drafts.some(draft => draft.class === name)).length);
  const allowed = new Set(['class', 'synthetic', 'count', 'rows', 'tool', 'layer', 'code', 'ms', 'argShape']);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(allowed.has(key), `draft fixture carries an unexpected field ${key}`);
      walk(child);
    }
  };
  walk(drafts);
  const serialized = JSON.stringify(drafts);
  assert.doesNotMatch(serialized, /standup|Acme|finance/i);
  // An argument shape is key names only: every value is a token or a comma separated list of tokens, so no room
  // is left for a value, a sentence or an owner's words.
  for (const draft of drafts) {
    assert.ok(draft.rows.length > 0);
    for (const row of draft.rows) {
      for (const [field, value] of Object.entries(row)) {
        if (typeof value === 'number') continue;
        assert.match(String(value), /^[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+)*$/, `${field}=${value}`);
      }
    }
  }
  const failed = drafts.find(draft => draft.class === 'tool_failure');
  assert.equal(failed?.rows[0]?.['argShape'], 'body,thread_id,to');
});

test('the review writes a report and one draft per class into the folder it is given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-postcall-'));
  try {
    const written = writeReview(review(), dir);
    assert.match(readFileSync(written.report, 'utf8'), /postcall review/);
    assert.equal(written.drafts.length, 6);
    for (const path of written.drafts) {
      const body = JSON.parse(readFileSync(path, 'utf8')) as { synthetic: boolean };
      assert.equal(body.synthetic, true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the metadata reader drops a key it does not recognise', () => {
  const events = readCapture(JSON.stringify({ events: [
    { event: 'tool_call_outcome', tool: 'calendar_read', outcome: 'completed', ms: 4, args: { query: 'Acme standup' } },
    { event: 'owner_said', text: 'secret' },
  ] }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { event: 'tool_call_outcome', tool: 'calendar_read', outcome: 'completed', ms: 4 });
});

test('an argument shape is kept only when every name in it is a token', () => {
  const shaped = readCapture(JSON.stringify({ events: [
    { event: 'tool_call_outcome', tool: 'mail_send', outcome: 'failed', argKeys: ['to', 'body'] },
  ] }));
  assert.deepEqual(shaped, [{ event: 'tool_call_outcome', tool: 'mail_send', outcome: 'failed', argKeys: ['body', 'to'] }]);
  const mixed = readCapture(JSON.stringify({ events: [
    { event: 'tool_call_outcome', tool: 'mail_send', outcome: 'failed', argKeys: ['to', 'not a key'] },
  ] }));
  assert.deepEqual(mixed, [{ event: 'tool_call_outcome', tool: 'mail_send', outcome: 'failed' }]);
});
