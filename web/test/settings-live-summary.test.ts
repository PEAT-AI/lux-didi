import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerDefaultVoice, providerVoices, settingsMarkup } from '../src/settings-view.ts';

const status = {
  ownerProfile: { status: 'default', displayName: 'Naya' },
  model: { configured: true, provider: 'gemini', model: 'gemini-2.5' },
  capabilities: { memory: true, commitments: true, notifications: false, model: true },
  serviceMode: 'loopback',
};

/** What GET /api/v1/live/summary answers for a running OpenAI Live session. */
const openaiSummary = {
  provider: 'openai', modelId: 'gpt-live-1', voice: 'marin', delegationModel: 'gpt-6-luna',
  personaName: 'Naya', limits: { sessionMs: 900000, idleMs: 60000 }, profileEnabled: true,
};

test('the running provider, model and voice come from the live summary, not a default', () => {
  const html = settingsMarkup({ status, summary: openaiSummary });
  assert.match(html, /Live provider<\/dt><dd>OpenAI GPT-Live/);
  assert.match(html, /Live model<\/dt><dd>gpt-live-1/);
  assert.match(html, /Live voice<\/dt><dd>marin/);
  assert.doesNotMatch(html, /Live (model|voice)<\/dt><dd><span class="settings-unavailable">Unavailable/);
});

test('the voice delegation model row names the OpenAI backend constants and is absent for Gemini', () => {
  const openai = settingsMarkup({ status, summary: openaiSummary });
  assert.match(openai, /Voice delegation model<\/dt><dd>gpt-6-luna/);
  const gemini = settingsMarkup({ status, summary: { ...openaiSummary, provider: 'gemini', modelId: 'models/gemini-3.8-live', voice: 'Aoede' } });
  assert.doesNotMatch(gemini, /Voice delegation model/);
});

test('the text model row is renamed and keeps its value', () => {
  const html = settingsMarkup({ status, summary: openaiSummary });
  assert.match(html, /Text chat and research model<\/dt><dd>gemini gemini-2.5/);
  assert.doesNotMatch(html, /Conversation model/);
});

test('a saved selection that differs from the running one is named beside the running values', () => {
  const html = settingsMarkup({ status, summary: openaiSummary, saved: { provider: 'gemini', voice: 'Aoede', appliesAt: 'next_start' } });
  assert.match(html, /Saved: gemini\/Aoede, applies on next start/);
  // The switch shows the saved choice, because that is what the next start will use.
  assert.match(html, /<option value="gemini" selected>/);
  assert.match(html, /id="live-voice"[^>]*value="Aoede"/);
  const same = settingsMarkup({ status, summary: openaiSummary, saved: { provider: 'openai', voice: 'marin', appliesAt: 'next_start' } });
  assert.doesNotMatch(same, /Saved: /);
});

test('a failed summary says so and never renders a default provider', () => {
  const html = settingsMarkup({ status, summaryUnavailable: true });
  assert.match(html, /Live provider unavailable/);
  assert.doesNotMatch(html, /id="live-settings-form"/);
  assert.doesNotMatch(html, /value="marin"/);
});

test('the file list names the OpenAI credential file by name only', () => {
  const html = settingsMarkup({ status, summary: openaiSummary });
  const files = html.slice(html.indexOf('<dl class="settings-files">'), html.indexOf('</dl>', html.indexOf('<dl class="settings-files">')));
  assert.match(files, /<dd><code>openai-primary\.json<\/code><\/dd>/);
  assert.match(files, /<dd><code>live\.json<\/code><\/dd>/);
  assert.doesNotMatch(files, /key|secret|token/i);
});

test('the page offers exactly the provider voice lists the server validates against', () => {
  assert.deepEqual([...providerVoices('gemini')], ['Aoede']);
  assert.equal(providerDefaultVoice('gemini'), 'Aoede');
  assert.equal(providerDefaultVoice('openai'), 'marin');
  assert.equal(providerVoices('openai').includes('nira'), true);
});
