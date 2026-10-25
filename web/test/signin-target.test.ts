import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { bindSignInButtons, settingsMarkup, type SignInTarget } from '../src/settings-view.ts';

// One click per endpoint: the button rendered on a row sends that row's endpoint name, never another.
const status = {
  ownerProfile: { status: 'default', displayName: 'Naya' },
  model: { configured: true, provider: 'gemini', model: 'gemini-2.5' },
  capabilities: { memory: true, commitments: true, notifications: false, model: true },
  serviceMode: 'loopback',
};
const catalogue = (JSON.parse(readFileSync(new URL('../../server/test/fixtures/installed-mcp-config.json', import.meta.url), 'utf8')) as {
  endpoints: { id: string }[];
}).endpoints;
const mongooseIDs = ['mongoose-knowledge', 'mongoose-data', 'mongoose-crm'];
const rows = catalogue.map(({ id }) => (mongooseIDs.includes(id)
  ? { id, state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'needs_sign_in' }
  : { id, state: 'connected', tools: 1, lastHandshakeAt: null, reasonCode: null }));

/** The stable root the binder sits on: one listener, and every click bubbles up to it. */
function signInRoot() {
  let listener: ((event: { target: SignInTarget }) => void) | undefined;
  return {
    addEventListener: (_type: 'click', next: (event: { target: SignInTarget }) => void) => { listener = next; },
    /** A click on this node, then the same click bubbling to the root. */
    click: (target: SignInTarget) => listener?.({ target }),
  };
}

/** One plain element: a sign-in button carrying its row's endpoint, or a node on no button at all. */
function element(attributes: Record<string, string>, signIn = true): SignInTarget {
  const node: SignInTarget = {
    getAttribute: (name: string) => attributes[name] ?? null,
    closest: (selector: string) => (signIn && selector === '[data-signin]' ? node : null),
  };
  return node;
}

/** The buttons of one render of the Settings markup, with the endpoints they carry. */
function buttons(html: string): SignInTarget[] {
  return [...html.matchAll(/<button[^>]*data-signin[^>]*data-endpoint="([^"]*)"[^>]*>/g)].map(match => element({ 'data-signin': '', 'data-endpoint': match[1]! }));
}

test('each click sends the endpoint name of the button it was rendered on', () => {
  const html = settingsMarkup({ status, connections: rows });
  const parsed = buttons(html);
  assert.equal(parsed.length, 3);
  const sent: string[] = [];
  const root = signInRoot();
  bindSignInButtons(root, endpoint => sent.push(endpoint));
  // Clicked out of row order, so a shared or hard-coded target cannot pass.
  for (const button of [parsed[2]!, parsed[0]!, parsed[1]!]) root.click(button);
  assert.deepEqual(sent, ['crm', 'knowledge', 'data'], 'each click names exactly its own endpoint');
  assert.deepEqual([...sent].sort(), ['crm', 'data', 'knowledge'], 'and the three clicks cover all three endpoints');
});

test('a row outside the closed set is never a sign-in target', () => {
  const html = settingsMarkup({ status, connections: [{ id: 'mongoose-admin', state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'needs_sign_in' }] });
  assert.doesNotMatch(html, /data-signin/, 'an id outside the three endpoints renders no button at all');
  const root = signInRoot();
  bindSignInButtons(root, () => { throw new Error('must not send'); });
  root.click(element({ 'data-signin': '', 'data-endpoint': 'mongoose-admin' }));
  root.click(element({}, false));
});
