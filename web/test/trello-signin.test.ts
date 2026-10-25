import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindSignInButtons, connectorState, settingsMarkup, signInAttemptText } from '../src/settings-view.ts';

// W7: the Trello board row signs in from Settings like a Mongoose row, with its own words and port.

test('a Trello row with no sign-in offers its own Sign in button and the Settings step', () => {
  const row = connectorState({ id: 'trello', state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'needs_sign_in' });
  assert.equal(row?.signInEndpoint, 'trello');
  assert.match(row!.next, /^Sign in to Trello in Settings/);
  assert.equal(row?.state, 'Sign-in needed');
  const signedIn = connectorState({ id: 'trello', state: 'configured', tools: 2, lastHandshakeAt: null, reasonCode: null });
  assert.equal(signedIn?.state, 'Configured');
  assert.equal(signedIn?.signInEndpoint, undefined);
});

test('the Trello attempt speaks of Trello and its own port; the Mongoose wording is unchanged', () => {
  const attempt = (reason: string) => ({ attemptId: '0123456789abcdef', phase: 'failed', reason });
  assert.equal(signInAttemptText('Trello', attempt('discovery_unreachable'), 'trello'), 'Trello is not reachable right now, so the Trello sign-in could not start: check the internet connection, then try again.');
  assert.match(String(signInAttemptText('Trello', attempt('port_in_use'), 'trello')), /port 8769 is busy/);
  assert.equal(signInAttemptText('Mongoose data', attempt('discovery_unreachable')), 'Mongoose is not reachable right now, so the Mongoose data sign-in could not start: check the VPN, then try again.');
  assert.match(String(signInAttemptText('Mongoose data', attempt('port_in_use'))), /port 8768 is busy/);
  const row = connectorState({ id: 'trello', state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'needs_sign_in', signIn: { attemptId: '0123456789abcdef', phase: 'waiting' } });
  assert.equal(row?.next, 'The Trello sign-in page was handed to your browser. Finish there, and the connector reconnects by itself.');
});

test('the Trello button sends trello, and only from its own row', () => {
  const markup = settingsMarkup({ status: { ownerProfile: { status: 'default', displayName: 'Naya' }, model: { configured: false }, capabilities: {}, serviceMode: 'loopback' },
    connections: [{ id: 'trello', state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'needs_sign_in' }] } as unknown as Parameters<typeof settingsMarkup>[0]);
  assert.match(markup, /<button type="button" class="secondary trello-signin" data-signin data-endpoint="trello">Sign in to Trello<\/button>/);
  const sent: string[] = [];
  let listener: ((event: { target: { closest(selector: string): { getAttribute(name: string): string | null } | null } }) => void) | undefined;
  bindSignInButtons({ addEventListener: (_type, handler) => { listener = handler; } }, name => { sent.push(name); });
  listener!({ target: { closest: () => ({ getAttribute: () => 'trello' }) } });
  listener!({ target: { closest: () => ({ getAttribute: () => 'trello-board' }) } });
  assert.deepEqual(sent, ['trello']);
});
