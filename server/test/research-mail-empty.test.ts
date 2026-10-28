/**
 * C-DEPTH11/#648: the pair the owner needs around an empty mail answer. A helper that answered with no
 * payload is a failed read with its own words; a search that genuinely matched nothing names the query it
 * ran. The fixture is synthetic and the run is the real research planner.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResearchLedger, runResearch, type ResearchDeps } from '../tools/research.js';

const signal = (): AbortSignal => new AbortController().signal;
const fixedNow = Date.parse('2026-10-19T12:00:00Z');

function fixture(execute: ResearchDeps['execute'], configured: ResearchDeps['configured'] = ['mail']): ResearchDeps {
  return {
    now: () => fixedNow, configured, ledger: new ResearchLedger(), timeZone: 'UTC',
    emit() {}, log() {}, step() {}, logSource() {}, logSubcall() {}, logRouted() {},
    execute,
  };
}

test('C-DEPTH11/#648: a mail helper that answered with no payload is voiced as a failed read, never as nothing matched', async () => {
  const deps = fixture(async subs => subs.map(call => ({ key: call.key, name: call.name, ok: false, code: 'invalid_result', text: '', originalCharacters: 0, omittedCharacters: 0 })));
  const reply = await runResearch(deps, {
    action: 'start', question: 'any unread mail',
    lookups: [{ source: 'mail', query: 'newer_than:2d is:unread' }],
  }, signal());
  assert.match(String(reply['note']), /mail: unavailable \(the helper returned no result, ask again\)/u, 'the owner hears the no-payload failure in its own words');
  assert.doesNotMatch(String(reply['note']), /nothing matched|no messages|no mail/iu, 'and never as a search that matched nothing');
});

test('C-DEPTH11/#648: the paired opposite, a search that matched nothing, says how it searched', async () => {
  const deps = fixture(async subs => subs.map(call => ({ key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0 })));
  const reply = await runResearch(deps, {
    action: 'start', question: 'any unread mail',
    lookups: [{ source: 'mail', query: 'newer_than:2d is:unread' }],
  }, signal());
  const note = `${String(reply['note'] ?? '')} ${String(reply['coverage'] ?? '')}`;
  assert.equal(/invalid_result/u.test(note), false, 'an honest empty never borrows the failure code');
  assert.match(note, /newer_than:2d|is:unread|unread/u, `the words name the query that ran: ${note}`);
});
