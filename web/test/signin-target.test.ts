import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { bindSignInButtons, settingsMarkup, type SignInButton } from '../src/settings-view.ts';

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

/** One parsed button from the rendered markup, with the click the binder would attach. */
function buttons(html: string): (SignInButton & { endpoint: string | null; click(): void })[] {
  return [...html.matchAll(/<button[^>]*data-signin[^>]*data-endpoint="([^"]*)"[^>]*>/g)].map(match => {
    const attributes: Record<string, string> = { 'data-endpoint': match[1]! };
    let listener: (() => void) | undefined;
    return {
      endpoint: attributes['data-endpoint']!,
      getAttribute: (name: string) => attributes[name] ?? null,
      addEventListener: (_type: 'click', next: () => void) => { listener = next; },
      click: () => listener?.(),
    };
  });
}

test('each click sends the endpoint name of the button it was rendered on', () => {
  const html = settingsMarkup({ status, connections: rows });
  const parsed = buttons(html);
  assert.equal(parsed.length, 3);
  const sent: string[] = [];
  bindSignInButtons({ querySelectorAll: () => parsed }, endpoint => sent.push(endpoint));
  // Clicked out of row order, so a shared or hard-coded target cannot pass.
  for (const button of [parsed[2]!, parsed[0]!, parsed[1]!]) button.click();
  assert.deepEqual(sent, ['crm', 'knowledge', 'data'], 'each click names exactly its own endpoint');
  assert.deepEqual([...sent].sort(), ['crm', 'data', 'knowledge'], 'and the three clicks cover all three endpoints');
});

test('a button whose endpoint is outside the closed set is never bound', () => {
  const html = settingsMarkup({ status, connections: [{ id: 'mongoose-admin', state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'needs_sign_in' }] });
  const parsed = [{ endpoint: 'mongoose-admin', getAttribute: () => 'mongoose-admin', addEventListener: () => { throw new Error('must not bind'); }, click: () => {} }];
  assert.doesNotMatch(html, /data-signin/, 'an id outside the three endpoints renders no button at all');
  bindSignInButtons({ querySelectorAll: () => parsed }, () => { throw new Error('must not send'); });
});
