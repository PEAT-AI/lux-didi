import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionsMarkup, connectionIdentity } from '../src/connector-status.ts';
import { connectorState } from '../src/settings-view.ts';

// Synthetic identities only; no real owner address or token appears here.
const OWNER = 'owner@example.test';

test('connections renders all states using only allowlisted fields and fixed reason text', () => {
  const html = connectionsMarkup(['missing', 'configured', 'connected', 'error'].map((state, i) => ({
    id: `connector-${i}`, state, tools: i, lastHandshakeAt: '2026-10-12T14:52:00Z',
    reasonCode: i === 0 ? 'credential_missing' : i === 3 ? 'unreachable' : null,
    error: 'PRIVATE TOKEN https://secret.invalid/?token=secret', config: { secret: 'PRIVATE CONFIG' },
  })));
  for (const state of ['missing', 'configured', 'connected', 'error']) assert.match(html, new RegExp(state));
  assert.match(html, /add the credential file under provider-config and restart/);
  assert.match(html, /start the service, then restart Lux Didi/);
  assert.doesNotMatch(html, /PRIVATE|secret.invalid|token=|PRIVATE CONFIG/);
});

test('a mongoose sign-in need names the Settings button, never a restart', () => {
  const html = connectionsMarkup([{ id: 'mongoose-data', state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'needs_sign_in' }]);
  assert.match(html, /Sign-in needed\./);
  assert.match(html, /Settings/);
  assert.doesNotMatch(html, /restart/i);
});

test('the two reason codes the panel used to call unknown now say what to do', () => {
  const approval = connectionsMarkup([{ id: 'gmail', state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'configuration_error' }]);
  assert.match(approval, /Approval needed/);
  assert.doesNotMatch(approval, /Connection issue unknown/);
  const signedOut = connectionsMarkup([{ id: 'mattermost', state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'not_signed_in' }]);
  assert.match(signedOut, /Signed out/);
  assert.doesNotMatch(signedOut, /Connection issue unknown/);
});

test('unknown reason and invalid scalar payloads never render free text', () => {
  const html = connectionsMarkup([{ id: 'safe', state: 'error', tools: 'TOKEN', lastHandshakeAt: 'SECRET', reasonCode: 'RAW SECRET' }]);
  assert.doesNotMatch(html, /TOKEN|SECRET/);
  assert.match(html, /unknown/i);
});

test('connectionIdentity names the owner account, the mismatch and the unverified states', () => {
  assert.equal(connectionIdentity({ proven: true, match: true, value: OWNER }), `Connected as ${OWNER} \u2713`);
  assert.equal(connectionIdentity({ proven: true, match: null, value: OWNER }), `Connected as ${OWNER}`);
  assert.equal(connectionIdentity({ proven: true, match: false, value: 'other@example.test' }), 'Signed in as a different account');
  assert.equal(connectionIdentity({ proven: false, match: null, value: null }), 'Account not verified');
  assert.equal(connectionIdentity(undefined), undefined);
  assert.equal(connectionIdentity({ proven: 'yes', match: true, value: OWNER }), undefined);
  assert.equal(connectionIdentity({ proven: true, match: 'no', value: OWNER }), undefined);
  assert.equal(connectionIdentity({ proven: true, match: true, value: 'PRIVATE TOKEN' }), undefined);
  assert.equal(connectionIdentity({ proven: true, match: true, value: 42 }), undefined);
});

test('connections renders the identity line per source and never leaks a raw payload', () => {
  const html = connectionsMarkup([
    { id: 'gmail', state: 'connected', tools: 3, lastHandshakeAt: '2026-10-12T14:52:00Z', identity: { proven: true, match: true, value: OWNER } },
    { id: 'mattermost', state: 'connected', tools: 5, lastHandshakeAt: '2026-10-12T14:52:00Z', identity: { proven: true, match: false, value: 'other@example.test' } },
    { id: 'calendar', state: 'connected', tools: 2, lastHandshakeAt: '2026-10-12T14:52:00Z', identity: { proven: false, match: null, value: 'SECRET TOKEN' } },
  ]);
  assert.match(html, new RegExp(`Connected as ${OWNER}`));
  assert.match(html, /Signed in as a different account/);
  assert.match(html, /Account not verified/);
  assert.doesNotMatch(html, /SECRET TOKEN|other@example.test/);
});

test('the settings connector row carries the same owner identity sentence', () => {
  assert.equal(connectorState({ id: 'gmail', state: 'connected', identity: { proven: true, match: true, value: OWNER } })?.identity, `Connected as ${OWNER} \u2713`);
  assert.equal(connectorState({ id: 'mattermost', state: 'connected', identity: { proven: true, match: false, value: 'other@example.test' } })?.identity, 'Signed in as a different account');
  assert.equal(connectorState({ id: 'knowledge', state: 'connected' })?.identity, undefined);
});

// W14 (LOGS.md L-02): Drive's consent is its own gate. The connect probe reports scope_missing, and the
// row names what the owner has to do before any Drive read is attempted, never "Account not verified".
test('a drive consent proof reads as needs-consent with its own one-time action', () => {
  const html = connectionsMarkup([{
    id: 'drive', state: 'connected', tools: 2, lastHandshakeAt: '2026-10-12T14:52:00Z',
    reasonCode: 'scope_missing', identity: { proven: false, match: null, value: null, code: 'scope_missing' },
  }]);
  assert.match(html, /Needs consent/u);
  assert.match(html, /lux-google-mcp authorize --family drive/u);
  assert.match(html, /one-time/u);
  assert.doesNotMatch(html, /Account not verified/u);
  assert.equal(connectorState({ id: 'drive', state: 'connected', identity: { proven: false, match: null, value: null, code: 'scope_missing' } })?.identity, 'Needs consent');
});

// --- C-SIGNIN-LIVE: a Mongoose row says who the endpoint is signed in as. ---
test('the Mongoose rows say "signed in as" the proven account, and the other connectors stay connected', () => {
  const row = (id: string, identity: unknown) => connectorState({ id, state: 'connected', tools: 2, lastHandshakeAt: '2026-10-12T14:52:00Z', identity });
  assert.equal(row('mongoose-crm', { proven: true, match: true, value: OWNER })?.identity, `Signed in as ${OWNER}`);
  assert.equal(row('mongoose-data', { proven: true, match: false, value: 'other@example.test' })?.identity, 'Signed in as a different account');
  assert.equal(row('mongoose-knowledge', { proven: false, match: null, value: null })?.identity, 'Account not verified');
  assert.equal(row('gmail', { proven: true, match: true, value: OWNER })?.identity, `Connected as ${OWNER}`);
});
