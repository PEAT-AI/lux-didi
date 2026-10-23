import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vaultCardMarkup, vaultCardState } from '../src/vault-card.ts';
import type { LiveCurrent, LiveEntry } from '../src/protocol.ts';

function live(entries: LiveEntry[]): LiveCurrent {
  return { state: 'listening', entries, cursor: 1 };
}

const entry = (receipt: unknown, status: 'called' | 'completed' = 'completed'): LiveEntry => ({
  seq: 1, kind: 'toolResult', tool: { name: 'save_to_vault', status, markdown: JSON.stringify(receipt) },
});

test('a saved receipt shows the vault id the vault itself returned', () => {
  const card = vaultCardState(live([entry({ saved: true, insightId: 'insight-7' })]));
  assert.deepEqual(card, { state: 'saved', insightId: 'insight-7' });
  const markup = vaultCardMarkup(card);
  assert.match(markup, /data-vault="saved"/);
  assert.match(markup, /Saved to your vault/);
  assert.match(markup, /insight-7/);
});

test('every refusal code has its own honest card', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['not_owner_requested', 'refused'],
    ['write_failed', 'failed'],
    ['vault_unavailable', 'failed'],
    ['outcome_unknown', 'unknown'],
  ];
  for (const [code, state] of cases) {
    const card = vaultCardState(live([entry({ saved: false, code })]));
    assert.equal(card?.state, state, code);
    assert.equal(card?.insightId, undefined, `${code} carries no id`);
  }
  assert.match(vaultCardMarkup({ state: 'unknown' }), /check the vault/);
});

test('a called or foreign tool makes no card, and the latest write wins', () => {
  assert.equal(vaultCardState(live([])), undefined);
  assert.equal(vaultCardState(undefined), undefined);
  assert.equal(vaultCardState(live([entry({ saved: true, insightId: 'insight-7' }, 'called')])), undefined);
  assert.equal(vaultCardState(live([{ seq: 1, kind: 'toolResult', tool: { name: 'remember_note', status: 'completed', markdown: '{"remembered":true}' } }])), undefined);
  const both = live([entry({ saved: true, insightId: 'insight-1' }), entry({ saved: false, code: 'outcome_unknown' })]);
  assert.deepEqual(vaultCardState(both), { state: 'unknown' });
});

test('an insight id is escaped before it reaches the page', () => {
  const markup = vaultCardMarkup({ state: 'saved', insightId: '<img src=x>' });
  assert.ok(!markup.includes('<img'), 'no markup from a vault id');
  assert.match(markup, /&lt;img/);
});
