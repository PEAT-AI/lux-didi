import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calendarIdentityValues, classifyIdentity, gmailIdentityValues, identityAction, identityMatch,
  mattermostIdentityValues, normalizeIdentity, projectIdentity, proveIdentity,
  type IdentityProof, type IdentitySource,
} from '../connectors/identity.js';
import { safeEvent } from '../host/log.js';
import type { ConnectorResult } from '../connectors/index.js';

// Every identity below is synthetic; no real account, address or token appears in this file.
const OWNER = 'owner@example.test';
const OTHER = 'other@example.test';

function evidence(decodedResult: unknown): ConnectorResult {
  return { decodedResult, state: 'completed' } as unknown as ConnectorResult;
}

test('identityMatch is exact and case-insensitive, never a substring', () => {
  assert.equal(normalizeIdentity(' Owner@Example.Test '), 'owner@example.test');
  assert.equal(identityMatch([OWNER], ['OWNER@example.TEST']), true);
  assert.equal(identityMatch([OWNER], ['not-owner@example.test']), false);
  assert.equal(identityMatch([OWNER], ['owner@example.test.evil']), false);
  assert.equal(identityMatch([OWNER], []), false);
  assert.equal(identityMatch([], [OWNER]), false);
});

test('each connector maps its own identity field, and only its own', () => {
  assert.deepEqual(gmailIdentityValues({ emailAddress: OWNER, messagesTotal: 3 }), [OWNER]);
  assert.deepEqual(gmailIdentityValues({ emailAddress: 42 }), []);
  assert.deepEqual(calendarIdentityValues({ calendars: [{ id: 'work' }, { id: OWNER, primary: true }] }), [OWNER]);
  assert.deepEqual(calendarIdentityValues({ calendars: [{ id: 'primary' }, { id: 'work' }] }), []);
  assert.deepEqual(mattermostIdentityValues({ username: 'owner', email: OWNER }), ['owner', OWNER]);
  assert.deepEqual(mattermostIdentityValues({}), []);
});

test('classifyIdentity proves a value, matches the owner, and leaves an unset owner at match null', () => {
  const gmail: IdentitySource = { tool: 'gmail_get_profile', args: {}, values: gmailIdentityValues };
  const matched = classifyIdentity(evidence({ emailAddress: OWNER }), gmail, [OWNER]);
  assert.deepEqual(matched, { proven: true, match: true, value: OWNER });
  const mismatched = classifyIdentity(evidence({ emailAddress: OTHER }), gmail, [OWNER]);
  assert.deepEqual(mismatched, { proven: true, match: false, value: OTHER });
  const unset = classifyIdentity(evidence({ emailAddress: OWNER }), gmail, []);
  assert.deepEqual(unset, { proven: true, match: null, value: OWNER });
  const empty = classifyIdentity(evidence({}), gmail, [OWNER]);
  assert.deepEqual(empty, { proven: false, match: null, value: null });
  const refused = classifyIdentity({ state: 'refused', reason: 'source-unavailable' }, gmail, [OWNER]);
  assert.deepEqual(refused, { proven: false, match: null, value: null });
});

test('identityAction offers a proof, refuses a mismatch and keeps an unproven connector usable', () => {
  assert.equal(identityAction({ proven: true, match: true, value: OWNER }), 'offer');
  assert.equal(identityAction({ proven: true, match: null, value: OWNER }), 'offer');
  assert.equal(identityAction({ proven: true, match: false, value: OTHER }), 'refuse');
  assert.equal(identityAction({ proven: false, match: null, value: null }), 'unproven');
});

test('a proof failure (throw or timeout) is unproven, never a refusal', async () => {
  const gmail: IdentitySource = { tool: 'gmail_get_profile', args: {}, values: gmailIdentityValues };
  const thrown = await proveIdentity({ source: gmail, expected: [OWNER], call: async () => { throw new Error('boom'); } });
  assert.deepEqual(thrown, { proven: false, match: null, value: null });
  const timedOut = await proveIdentity({ source: gmail, expected: [OWNER], call: () => new Promise<ConnectorResult>(() => {}), timeoutMs: 5 });
  assert.deepEqual(timedOut, { proven: false, match: null, value: null });
  const proven = await proveIdentity({ source: gmail, expected: [OWNER], call: async () => evidence({ emailAddress: OWNER }) });
  assert.deepEqual(proven, { proven: true, match: true, value: OWNER });
});

test('connector_identity logs booleans and the connector name, never the identity', () => {
  const event = safeEvent({ event: 'connector_identity', connector: 'gmail', proven: true, match: false });
  assert.deepEqual(event, { event: 'connector_identity', connector: 'gmail', proven: true, match: false });
  assert.deepEqual(safeEvent({ event: 'connector_identity', connector: 'mattermost', proven: true, match: null }), { event: 'connector_identity', connector: 'mattermost', proven: true, match: null });
  // A free-text or extra field never crosses the boundary.
  assert.equal(safeEvent({ event: 'connector_identity', connector: 'gmail', proven: true, match: false, identity: OWNER }), undefined);
  assert.equal(safeEvent({ event: 'connector_identity', connector: 'gmail@example.test', proven: true, match: false }), undefined);
  assert.equal(safeEvent({ event: 'connector_identity', connector: 'gmail', proven: 'yes', match: false }), undefined);
  assert.equal(safeEvent({ event: 'connector_identity', connector: 'gmail', proven: true, match: 'no' }), undefined);
});

test('projectIdentity returns a closed shape, dropping anything unvalidated', () => {
  assert.deepEqual(projectIdentity({ proven: true, match: true, value: OWNER }), { proven: true, match: true, value: OWNER });
  assert.deepEqual(projectIdentity({ proven: false, match: null, value: null }), { proven: false, match: null, value: null });
  assert.deepEqual(projectIdentity({ proven: true, match: null, value: 42 }), { proven: true, match: null, value: null });
  assert.equal(projectIdentity({ proven: 'yes', match: true, value: OWNER }), undefined);
  assert.equal(projectIdentity({ proven: true, match: 'yes', value: OWNER }), undefined);
  assert.equal(projectIdentity(OWNER), undefined);
  const long = 'a'.repeat(300);
  assert.deepEqual((projectIdentity({ proven: true, match: true, value: long }) as IdentityProof).value, null);
});
