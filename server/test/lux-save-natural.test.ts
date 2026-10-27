import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createLuxWriteTransport } from '../adapters/lux-write/client.js';
import { chatMigrations } from '../chat/index.js';
import { CONNECTOR_ENVELOPES } from '../connectors/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, liveMigrations, stageComposedNote, validateLiveProfile, type LiveContext } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { beginStage, composedAsk, confirmAsk } from '../tools/lux-note.js';
import { VAULT_PROJECT, VAULT_REMOTE_TOOL, VaultWriter, vaultContentKey, type VaultReceipt } from '../tools/vault-write.js';
import { fakeLiveVoicePort } from './fixtures/fake-live-voice.js';
import { fakeLux } from './fixtures/fake-lux-vault.js';

const NOW = 1_700_000_000_000;
const NOTE = 'the survey boat is moored at pontoon three';

/**
 * C-LUX-SAVE: the owner's own words, replayed through the shipped voice boundary. His notation is a
 * dictation turn and then a natural save ask, and the save must reach the fake lux-knowledge MCP child.
 */
interface Replay { store: Store; sessionId: string; speak: (text: string) => Promise<void>; say: (text: string) => Promise<void> }

async function replay(t: TestContext): Promise<Replay> {
  const dir = mkdtempSync(join(tmpdir(), 'lux-save-natural-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  t.after(() => store.close());
  const ctx: LiveContext = { clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch };
  const fake = fakeLiveVoicePort();
  const profile = validateLiveProfile({
    provider: 'gemini', liveModelId: 'models/lux-save-natural', voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: 'models/lux-save-natural', dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    features: { composedNotes: true },
    limits: { handshakeMs: 1000, idleMs: 600_000, sessionMs: 1_200_000, closeMs: 50 },
  });
  const owner = createLiveSessionOwner({ store, voice: fake.port, profile, now: () => NOW, timeZone: 'UTC',
    schedule: () => ({ unref: () => undefined, cancel: () => undefined }) });
  const session = owner.create({ idempotencyKey: randomUUID(), inputClass: 'ordinary' }, ctx);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, ctx);
  const drained = (async () => { for await (const chunk of attachment.output) void chunk; })();
  t.after(() => { attachment.close(); return drained; });
  const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  // The shipped adapter journals deltas and then one empty finished transcription; the turn closes there.
  const speak = async (text: string): Promise<void> => {
    fake.emit({ type: 'inputTranscription', text, finished: false });
    await flush();
    fake.emit({ type: 'inputTranscription', text: '', finished: true });
    await flush();
  };
  // One finalized owner turn, the shape a provider that sends a whole turn (not deltas) writes.
  const say = async (text: string): Promise<void> => {
    fake.emit({ type: 'inputTranscription', text, finished: true });
    await flush();
  };
  return { store, sessionId: session.liveSessionId, speak, say };
}

async function claimAndSave(store: Store, url: string, sessionId: string, content: string): Promise<VaultReceipt> {
  const writer = new VaultWriter({ store, transport: createLuxWriteTransport({ url }), now: () => NOW, log: () => undefined });
  const claim = writer.claim(sessionId, content);
  return claim.state === 'dispatch' ? writer.dispatch(claim) : claim.receipt;
}

test('his dictated note, then "save this to lux", reaches the vault as save_insight under didi-voice', async t => {
  const fake = await fakeLux(t, 'inserted', 'insight-42');
  const r = await replay(t);
  await r.speak(NOTE);
  await r.speak('save this to lux');
  assert.deepEqual(await claimAndSave(r.store, fake.url, r.sessionId, NOTE), { saved: true, insightId: 'insight-42' });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.name, VAULT_REMOTE_TOOL);
  assert.deepEqual(fake.calls[0]?.arguments, { content: NOTE, insight_title: NOTE, insight_type: 'UNCATEGORIZED', project: VAULT_PROJECT });
  const row = r.store.transaction(tx => tx.get('SELECT state,insight_id,content_key FROM vault_writes WHERE live_session_id=?', [r.sessionId]));
  assert.equal(row?.['state'], 'confirmed');
  assert.equal(row?.['content_key'], vaultContentKey(NOTE), 'the authorization is his own words, not the ask');
});

test('the same save ask in his other words routes to the same one write', async t => {
  for (const ask of ['put that in my knowledge', 'remember this in lux', 'save to my vault']) {
    const fake = await fakeLux(t, 'inserted', 'insight-9');
    const r = await replay(t);
    await r.speak(NOTE);
    await r.speak(ask);
    assert.deepEqual(await claimAndSave(r.store, fake.url, r.sessionId, NOTE), { saved: true, insightId: 'insight-9' }, ask);
    assert.equal(fake.calls[0]?.name, VAULT_REMOTE_TOOL, ask);
  }
});

test('the vault failing or going silent speaks the honest line and never claims a save', async t => {
  const cases = [
    ['fail', 'write_failed', 'the vault did not take the note, say it again'],
    ['drop', 'outcome_unknown', 'I am not sure it landed, check the vault'],
  ] as const;
  for (const [mode, code, guidance] of cases) {
    const fake = await fakeLux(t, mode);
    const r = await replay(t);
    await r.speak(NOTE);
    await r.speak('save this to lux');
    const receipt = await claimAndSave(r.store, fake.url, r.sessionId, NOTE);
    assert.deepEqual(receipt, { saved: false, code, guidance }, mode);
    assert.equal(fake.calls.length, 1, 'one request, no retry');
  }
});

test('research cannot reach a write: the lux-knowledge envelope is the two reads only', () => {
  assert.deepEqual(CONNECTOR_ENVELOPES['lux-knowledge'], ['search_knowledge', 'get_insight']);
  assert.equal(VAULT_REMOTE_TOOL, 'save_insight');
  assert.ok(!(CONNECTOR_ENVELOPES['lux-knowledge'] ?? []).includes(VAULT_REMOTE_TOOL));
});

test('a note about the conversation needs the ask and then his fresh confirmation', () => {
  assert.deepEqual(composedAsk('save a note about what we just discussed'), { decision: 'grant' });
  const held = new Set(['journal:1']);
  const stage = beginStage({ stageId: 'stage-1', sessionId: 'live-1', ownerText: 'save a note about what we just discussed',
    title: 'Pontoon', body: NOTE, evidence: ['journal:1'], heldEvidence: held, enabled: true, now: NOW });
  assert.equal(stage.state, 'staged', JSON.stringify(stage));
  assert.equal(confirmAsk('yes, save it'), 'affirm');
  assert.equal(confirmAsk('no, wait'), 'cancel');
  // With the switch off, the same ask stages nothing: the owner feature flag is the first gate.
  const off = beginStage({ stageId: 'stage-2', sessionId: 'live-1', ownerText: 'save a note about what we just discussed',
    title: 'Pontoon', body: NOTE, evidence: ['journal:1'], heldEvidence: held, enabled: false, now: NOW });
  assert.deepEqual(off, { state: 'refused', code: 'not_enabled' });
});

// W5 (C-LUX-SAVE-LANDS Q-05): the owner's ask arrived as two transcribed fragments. Nothing of the
// request may become the note; after she answers, "store it" stages HER ANSWER through the composed
// path, and the dictation ledger never holds the request's own words.
test('the split ask stages the answer she just gave, never the request fragments', async t => {
  const r = await replay(t);
  await r.say('Can you, can you');
  await r.say('store it in Lux Knowledge');
  const answer = 'Rize is a materials research company: its platform automates formulation and testing of new polymer blends.';
  const staged = r.store.transaction(tx => stageComposedNote(tx, r.sessionId,
    { title: 'Rize materials research', body: answer, evidenceRefs: ['journal:1', 'journal:2'] },
    { inputAt: NOW, inputFinal: true }, NOW, true));
  assert.equal(staged['staged'], true, `staged: ${JSON.stringify(staged)}`);
  assert.equal(staged['body'], answer);
  const rows = r.store.transaction(tx => tx.all('SELECT body,title FROM lux_note_stages'));
  assert.deepEqual(rows.map(row => [row['title'], row['body']]), [['Rize materials research', answer]]);
  const writes = r.store.transaction(tx => tx.all('SELECT content,title FROM vault_writes'));
  assert.equal(writes.some(row => String(row['content']).includes('Can you') || String(row['title']).includes('Can you')), false);
});
