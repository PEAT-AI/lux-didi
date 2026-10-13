import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionsMarkup } from '../src/connector-status.ts';

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

test('unknown reason and invalid scalar payloads never render free text', () => {
  const html = connectionsMarkup([{ id: 'safe', state: 'error', tools: 'TOKEN', lastHandshakeAt: 'SECRET', reasonCode: 'RAW SECRET' }]);
  assert.doesNotMatch(html, /TOKEN|SECRET/);
  assert.match(html, /unknown/i);
});
