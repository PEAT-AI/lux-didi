import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { settingsMarkup } from '../src/settings-view.ts';
import { reasonCodes } from '../src/next-steps.ts';

// The release 11 production catalogue: the seven endpoint ids the host emits on GET /api/v1/live/connections.
const status = {
  ownerProfile: { status: 'default', displayName: 'Naya' },
  model: { configured: true, provider: 'gemini', model: 'gemini-2.5' },
  capabilities: { memory: true, commitments: true, notifications: false, model: true },
  serviceMode: 'loopback',
};
const catalogue = (JSON.parse(readFileSync(new URL('../../server/test/fixtures/installed-mcp-config.json', import.meta.url), 'utf8')) as {
  endpoints: { id: string; connector: string }[];
}).endpoints;
const mongooseIDs = ['mongoose-knowledge', 'mongoose-data', 'mongoose-crm'];
const endpointRows = catalogue.map(({ id }) => (mongooseIDs.includes(id)
  ? { id, state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'needs_sign_in' }
  : { id, state: 'connected', tools: 3, lastHandshakeAt: '2026-10-12T14:52:00Z', reasonCode: null }));

test('the production catalogue renders one Sign in button per signed-out Mongoose endpoint row', () => {
  const html = settingsMarkup({ status, connections: endpointRows });
  const buttons = [...html.matchAll(/<button[^>]*data-signin[^>]*data-endpoint="([^"]+)"[^>]*>([^<]*)<\/button>/g)];
  assert.equal(buttons.length, 3, 'one button per signed-out Mongoose endpoint, never one shared control');
  assert.deepEqual(buttons.map(match => match[1]).sort(), [...mongooseIDs].sort(), 'each button carries its own endpoint id');
  assert.deepEqual(buttons.map(match => match[2]), ['Sign in to Mongoose knowledge', 'Sign in to Mongoose data', 'Sign in to Mongoose CRM']);
  assert.doesNotMatch(html, /id="mongoose-signin"/, 'a fixed element id cannot express one button per endpoint');
});

test('no production row with a known reason falls back to the generic failure step', () => {
  for (const { id } of catalogue) {
    for (const reasonCode of reasonCodes) {
      if (reasonCode === 'unknown') continue; // the unknown reason is the diagnostics sentence by design.
      const html = settingsMarkup({ status, connections: [{ id, state: 'error', tools: 0, lastHandshakeAt: null, reasonCode }] });
      assert.doesNotMatch(html, /Check the connector service, then use Copy diagnostics/, `${id} with ${reasonCode} says what to do`);
    }
  }
});

test('only the three Mongoose endpoint rows offer a sign-in, and never a connected one', () => {
  const connected = settingsMarkup({ status, connections: catalogue.map(({ id }) => ({ id, state: 'connected', tools: 1, lastHandshakeAt: null, reasonCode: null })) });
  assert.doesNotMatch(connected, /data-signin/, 'a connected endpoint needs no button');
  const others = settingsMarkup({ status, connections: [{ id: 'mattermost', state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'not_signed_in' }] });
  assert.doesNotMatch(others, /data-signin/, 'no other connector borrows the Mongoose sign-in');
});
