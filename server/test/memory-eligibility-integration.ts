import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../runtime/store.js';
import { hostMigrations } from '../host/runtime.js';
import { resolveLiveMemory } from '../host/live.js';
import { recall } from '../domain/memory.js';
import * as labels from '../domain/labels.js';
import { memoryLookup } from '../tools/memory-search.js';
import { createSummarizer } from '../services/summarize.js';
import { getBySession } from '../domain/summaries.js';
import type { ModelPort } from '../adapters/model/types.js';

const NOW = 1_792_400_000_000;
type Class = 'ordinary' | 'private' | 'sensitive' | 'unknown';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'didi-memory-eligibility-')), store = new Store(dir, hostMigrations);
  const add = (id: string, entry: Class, parent: Class, text = 'Synthetic neutral keyword', capturedAt = NOW) => store.transaction(tx => {
    tx.run('INSERT INTO sessions VALUES (?,?,?,NULL,?,1,?,?)', [`parent-${id}`, 'Synthetic', NOW, 'UTC', NOW, NOW]);
    tx.run('INSERT INTO entries VALUES (?,?,1,?,?,?, ?,1)', [id, `parent-${id}`, 'user', text, capturedAt, 'UTC']);
    for (const [kind, subject, dataClass] of [['entry', id, entry], ['session', `parent-${id}`, parent]]) {
      if (dataClass !== 'unknown') tx.run('INSERT INTO routing_labels VALUES (?,?,1,?,?,?)', [kind!, subject!, dataClass!, 'owner_review', NOW]);
    }
  });
  return { store, dir, add, cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('memory eligibility integration: entry and parent class matrix agrees with automatic startup injection', () => {
  const f = fixture();
  try {
    for (const entry of ['ordinary', 'private', 'sensitive', 'unknown'] as const) for (const parent of ['ordinary', 'private', 'sensitive', 'unknown'] as const) {
      const id = `${entry}-${parent}`; f.add(id, entry, parent, `Synthetic matrix ${id}`);
    }
    const automatic = f.store.transaction(resolveLiveMemory);
    const routed = f.store.transaction(tx => memoryLookup(tx, 'Synthetic matrix'));
    assert.deepEqual(automatic.map(row => row.id), ['ordinary-ordinary']);
    assert.equal(routed.lines.length, 1); assert.ok(routed.lines[0]!.includes('ordinary-ordinary'));
    assert.ok(!routed.text.includes('ordinary-unknown'), 'missing parent label fails closed');
  } finally { f.cleanup(); }
});

test('memory eligibility integration: more than40 disallowed matches cannot starve an eligible lower rank', () => {
  for (const blocked of ['entry', 'parent'] as const) {
    const f = fixture();
    try {
      for (let i = 0; i < 45; i++) f.add(`blocked-${i}`, blocked === 'entry' ? 'private' : 'ordinary', blocked === 'parent' ? 'private' : 'ordinary', 'Synthetic keyword priority', NOW + i);
      f.add('allowed', 'ordinary', 'ordinary', 'Synthetic keyword allowed', NOW - 1000);
      const routed = f.store.transaction(tx => memoryLookup(tx, 'keyword priority'));
      assert.equal(routed.lines.length, 1); assert.ok(routed.lines[0]!.includes('allowed'));
      const defaultRecall = f.store.transaction(tx => recall(tx, 'keyword priority', 40));
      assert.equal(defaultRecall.hits.length, 40); assert.equal(defaultRecall.totalMatches, 46);
      assert.equal(defaultRecall.hits[0]!.entryId, 'blocked-44', 'default authorized recall behavior stays unchanged');
    } finally { f.cleanup(); }
  }
});

test('memory eligibility integration: current relabels, stable ties and source provenance survive canonical filtering', () => {
  const f = fixture(), control = fixture();
  const hash = () => createHash('sha256').update(readFileSync(join(control.dir, 'state.sqlite'))).digest('hex');
  const untouched = hash();
  try {
    f.add('a', 'ordinary', 'private', 'Synthetic keyword first'); f.add('b', 'ordinary', 'ordinary', 'Synthetic keyword second');
    f.store.transaction(tx => tx.run('INSERT INTO source_references VALUES (?,?,?,?,?,?,?,?,?,?)', ['source-b', 'entry', 'b', 'Synthetic source', 'fixture', 'synthetic-account', 'external-b', NOW - 500, 'present', null]));
    assert.equal(f.store.transaction(tx => memoryLookup(tx, 'keyword')).lines.length, 1);
    f.store.transaction(tx => labels.correct(tx, { subject: { kind: 'session', id: 'parent-a' }, expectedRevision: 1, dataClass: 'ordinary' }, NOW + 1));
    assert.equal(f.store.transaction(tx => memoryLookup(tx, 'keyword')).lines.length, 2);
    f.store.transaction(tx => labels.correct(tx, { subject: { kind: 'session', id: 'parent-a' }, expectedRevision: 2, dataClass: 'private' }, NOW + 2));
    assert.equal(f.store.transaction(tx => memoryLookup(tx, 'keyword')).lines.length, 1);
    const original = f.store.transaction(tx => recall(tx, 'keyword', 20));
    assert.deepEqual(original.hits.map(hit => hit.entryId), ['a', 'b']);
    assert.equal(original.hits[1]!.sourceRefs[0]!.externalId, 'external-b');
    assert.equal(original.hits[1]!.sourceTimestamp, NOW - 500);
    const again = f.store.transaction(tx => recall(tx, 'keyword', 20)); assert.deepEqual(again, original);
    const eligible = f.store.transaction(tx => recall(tx, 'keyword', 20, { eligibility: 'ordinary-entry-and-parent' }));
    assert.deepEqual(eligible.hits, original.hits.filter(hit => hit.entryId === 'b'));
    assert.equal(f.store.transaction(tx => labels.entryAndParentOrdinary(tx, 'b', 'missing-parent')), false);
    assert.equal(f.store.transaction(tx => labels.entryAndParentOrdinary(tx, 'missing-entry', 'parent-b')), false);
    assert.equal(hash(), untouched, 'relabels never write a different store');
    for (let i = 0; i < 20; i++) f.add(`line-${i}`, 'ordinary', 'ordinary', 'Synthetic keyword ' + 'x'.repeat(400), NOW + i);
    const capped = f.store.transaction(tx => memoryLookup(tx, 'keyword'));
    assert.equal(capped.lines.length, 12); assert.ok(capped.lines.every(line => line.length <= 267));
  } finally { f.cleanup(); control.cleanup(); }
});

test('memory eligibility integration: real summarizer rejects private input before generation and local recall', async () => {
  const f = fixture(); let calls = 0;
  const model: ModelPort = { generate: async () => { calls++; return { status: 'complete', text: JSON.stringify({ skip: false, summary: 'Synthetic ordinary summary keyword.', openLoop: null }),
    providerContent: { role: 'model', parts: [{ text: 'Synthetic response' }] }, reason: '', prompt: { version: 'synthetic', hash: 'synthetic', omittedContextIds: [] }, timings: { kind: 'synthetic', totalMs: 0, firstTextMs: null } }; } };
  const summarizer = createSummarizer({ store: f.store, model, modelId: 'synthetic-model', assistantName: 'Synthetic assistant', now: () => NOW, timeZone: 'UTC', log: () => {} });
  try {
    for (const dataClass of ['private', 'sensitive', 'ordinary']) {
      const id = `live-${dataClass}`;
      f.store.transaction(tx => {
        tx.run(`INSERT INTO live_sessions (live_session_id,owner_assistant_id,authority_epoch,idempotency_key,fingerprint,client_id,audit_id,profile_identity,prompt_identity,lifecycle,dispatch_intent,ready,journal_events,journal_bytes,journal_complete,consumer_state,terminal_outcome,terminal_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'terminal',0,0,0,0,1,'ended',?,?,?,?)`, [id, f.store.assistantId, f.store.authorityEpoch, id, id, 'synthetic', 'synthetic-audit', 'synthetic-profile', 'synthetic-prompt', JSON.stringify({ state: 'closed', code: 'normal' }), NOW, NOW, NOW]);
        tx.run('INSERT INTO live_grants VALUES (?,?,?,?,?,?,?,?,?,?)', [id, id, 'openai', 'gpt-live-1', 'marin', 'synthetic-key', JSON.stringify(['ordinary', 'private', 'sensitive']), dataClass, 1, NOW]);
        for (const text of ['Synthetic owner first turn', 'Synthetic owner second turn']) tx.run('INSERT INTO live_journal (live_session_id,kind,text,finished,payload_bytes,arrived_at) VALUES (?,\'inputTranscription\',?,1,?,?)', [id, text, text.length, NOW]);
      });
      await summarizer.distill(id);
      const stored = f.store.transaction(tx => getBySession(tx, id))!;
      assert.equal(stored.status, dataClass === 'ordinary' ? 'complete' : 'skipped');
      if (dataClass !== 'ordinary') { assert.equal(stored.skipReason, 'non_ordinary'); assert.equal(stored.summary, null); assert.equal(calls, 0); }
    }
    assert.equal(calls, 1); assert.equal(f.store.transaction(tx => memoryLookup(tx, 'summary keyword')).lines.length, 1);
  } finally { f.cleanup(); }
});
