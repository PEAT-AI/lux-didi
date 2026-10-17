import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMiniRoute, miniMarkup, miniState } from '../src/mini.ts';

test('the mini route is a query on the one built page', () => {
  assert.equal(isMiniRoute('?view=mini'), true);
  assert.equal(isMiniRoute(''), false);
  assert.equal(isMiniRoute('?view=full'), false);
  assert.equal(isMiniRoute('?something=1&view=mini'), true);
});

test('one glance state folds voice and tool activity, error wins', () => {
  assert.equal(miniState('LISTENING', undefined), 'listening');
  assert.equal(miniState('CONNECTING', undefined), 'thinking');
  assert.equal(miniState('SPEAKING', undefined), 'speaking');
  assert.equal(miniState('PROCESSING', { kind: 'tools', text: 'Searching your mail' }), 'tool');
  assert.equal(miniState('CONNECTED', { kind: 'thinking', text: 'Thinking' }), 'thinking');
  assert.equal(miniState('ERROR', { kind: 'tools', text: 'x' }), 'error');
  assert.equal(miniState('CONNECTED', undefined), 'idle');
});

test('mini markup is orb-only with the shared caption and no transcript', () => {
  const caption = '<p class="orb-label">Listening</p><p class="activity-line">Searching your mail</p>';
  const html = miniMarkup('tool', caption);
  assert.match(html, /id="didi-orb"/);
  assert.match(html, /class="orb-stage mini-stage"/);
  assert.match(html, /data-mini-state="tool"/);
  assert.ok(html.includes(caption));
  assert.doesNotMatch(html, /conversation-history|data-tab|voice-text|draft|transcript|sidebar/i);
});

test('mini markup carries each glance state and only glows while active', () => {
  for (const state of ['idle', 'listening', 'thinking', 'speaking', 'tool', 'error'] as const) {
    assert.match(miniMarkup(state, ''), new RegExp(`data-mini-state="${state}"`));
  }
  assert.match(miniMarkup('speaking', ''), /presence-glow visible/);
  assert.match(miniMarkup('idle', ''), /presence-glow"/);
  assert.doesNotMatch(miniMarkup('error', ''), /presence-glow visible/);
});
