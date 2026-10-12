import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryFixture, result } from './memory-context-process.js';
import { fixture, options } from './live-voice-fixture.js';
import { GeminiLiveVoiceAdapter, type LiveVoiceRequest } from '../adapters/live-voice/index.js';
import { createLiveSessionOwner, validateLiveProfile, liveMigrations } from '../live/index.js';
import { chatMigrations } from '../chat/index.js';
import { listenService } from '../http/server.js';
import type { ModelRequest } from '../adapters/model/types.js';

const note = 'synthetic retained deletion canary with "quotes" and\nnewline';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('HTTP deletion atomically scrubs retained chat, Live and request copies, including active rebuild', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-retained-'));
  const work: (() => void)[] = [], requests: ModelRequest[] = [], liveRequests: LiveVoiceRequest[] = [];
  const f = openMemoryFixture(dir, { generate: async request => { requests.push(request); return result(request); } },
    { schedule: task => work.push(task) }, [...chatMigrations, ...liveMigrations]);
  const ws = await fixture(t);
  const profile = validateLiveProfile({ enabled: true, provider: 'gemini', liveModelId: 'models/live-session-test',
    voice: 'Aoede', keyReference: 'fixture-key', route: { enabled: true, provider: 'gemini', modelId: 'models/live-session-test', dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' } });
  const adapter = new GeminiLiveVoiceAdapter(options({ socketFactory: ws.socketFactory, modelId: profile.liveModelId, voice: profile.voice, keyReference: profile.keyReference, route: { enabled: true, provider: 'gemini', modelId: profile.liveModelId, dataClasses: ['ordinary', 'private'] } }));
  const session = f.createSession('Memory');
  const entry = f.append(session.id, note);
  const keep = f.append(session.id, 'synthetic surviving note');
  const live = createLiveSessionOwner({ store: f.store, profile, voice: { open: (request, control) => {
    liveRequests.push(structuredClone(request)); return adapter.open(request, control);
  } }, memorySource: () => [{ id: entry.id, text: note, dataClass: 'ordinary' }, { id: keep.id, text: keep.text, dataClass: 'ordinary' }] });
  live.recover();
  const service = await listenService({ store: f.store, domain: f.domain, chat: f.chat, port: 0 });
  let attachment: ReturnType<typeof live.attach> | undefined;
  try {
    const auth = { Authorization: `Bearer ${readFileSync(join(dir, 'admin-credential'), 'utf8').trim()}`, 'Content-Type': 'application/json' };
    const bootstrap = await fetch(`${service.origin}/api/v1/auth/pairing`, { method: 'POST', headers: auth, body: '{}' });
    const pairingCode = (await bootstrap.json()).data.pairingCode as string;
    const paired = await fetch(`${service.origin}/api/v1/auth/pair`, { method: 'POST', headers: { Origin: service.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode }) });
    const headers = { Cookie: paired.headers.get('set-cookie')!.split(';')[0]!, Origin: service.origin,
      'X-Didi-CSRF': (await paired.json()).data.csrfToken as string, 'X-Didi-Authority-Epoch': f.store.authorityEpoch, 'Content-Type': 'application/json' };
    const conversation = f.enroll();
    const run = f.chat.accept({ sessionId: conversation.id, text: 'Use selected memory', selectedMemoryEntryIds: [entry.id, keep.id], idempotencyKey: 'first' }, f.context);
    const stream = f.chat.subscribe(run.runId, f.context);
    const finished = (async () => { for await (const event of stream) { if (event.type === 'snapshot' && event.run.state === 'terminal') return; } })();
    work.shift()!(); await finished;
    assert.equal(JSON.stringify(requests[0]).includes('synthetic retained deletion'), true);
    const pending = f.chat.accept({ sessionId: conversation.id, text: 'Use selected memory again', selectedMemoryEntryIds: [entry.id, keep.id], idempotencyKey: 'pending' }, f.context);
    const ctx = { clientId: f.context.clientId, auditId: 'retained', authorityEpoch: f.store.authorityEpoch };
    const input = { idempotencyKey: 'live', inputClass: 'ordinary' as const };
    const accepted = live.create(input, ctx);
    const detached = live.create({ ...input, idempotencyKey: 'detached' }, ctx);
    attachment = live.attach({ liveSessionId: accepted.liveSessionId }, ctx);
    await ws.frame(1); ws.send({ setupComplete: {} }); await attachment.ready;
    assert.equal(liveRequests[0]!.system.text.includes('synthetic retained deletion'), true);
    // A genuine owner response cache row, with the same fingerprint and response shape as HTTP writes.
    const path = `${service.origin}/api/v1/sessions`;
    const cached = await fetch(path, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'cached' }, body: JSON.stringify({ title: note, timeZone: 'UTC' }) });
    assert.equal(cached.status, 200);
    await cached.json();
    // Fail the last owner scrub after domain, chat and Live writes to prove rollback.
    const savedCache = f.store.transaction(tx => {
      const row = tx.get("SELECT response FROM runtime_requests WHERE request_key='cached'", [])!;
      tx.run("UPDATE runtime_requests SET response='{invalid' WHERE request_key='cached'", []);
      return String(row.response);
    });
    const failedDelete = await fetch(`${service.origin}/api/v1/entries/${entry.id}`, { method: 'DELETE', headers: { ...headers, 'Idempotency-Key': 'delete-failed' }, body: '{}' });
    assert.equal(failedDelete.status, 500);
    assert.equal(f.store.transaction(tx => f.domain.execute(tx, 'resolveEntries', { entryIds: [entry.id] }, f.context)).records.length, 1);
    for (const [table, column] of [['chat_run_context', 'resolved_records'], ['live_sessions', 'accepted_prompt_snapshot']] as const) {
      assert.equal(JSON.stringify(f.store.transaction(tx => tx.all(`SELECT ${column} FROM ${table}`, []))).includes('synthetic retained deletion'), true);
    }
    f.store.transaction(tx => tx.run("UPDATE runtime_requests SET response=? WHERE request_key='cached'", [savedCache]));
    const deleted = await fetch(`${service.origin}/api/v1/entries/${entry.id}`, { method: 'DELETE', headers: { ...headers, 'Idempotency-Key': 'delete' }, body: '{}' });
    assert.equal(deleted.status, 200);
    for (const [table, column] of [['chat_run_context', 'resolved_records'], ['live_sessions', 'accepted_prompt_snapshot'], ['runtime_requests', 'response']] as const) {
      const rows = f.store.transaction(tx => tx.all(`SELECT ${column} FROM ${table}`, []));
      assert.equal(JSON.stringify(rows).includes('synthetic retained deletion'), false, `${table} retains deleted text`);
    }
    const pendingStream = f.chat.subscribe(pending.runId, f.context);
    const pendingDone = (async () => { for await (const event of pendingStream) { if (event.type === 'snapshot' && event.run.state === 'terminal') return; } })();
    work.shift()!(); await pendingDone;
    assert.equal(JSON.stringify(requests.at(-1)).includes('synthetic retained deletion'), false);
    assert.equal(JSON.stringify(requests.at(-1)).includes('synthetic surviving note'), true);
    assert.equal(JSON.stringify(live.create(input, ctx)).includes('synthetic retained deletion'), false);
    ws.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-retained-handle' }, goAway: { timeLeft: '10s' } });
    await ws.frame(2);
    assert.equal(liveRequests.length, 2);
    assert.equal(liveRequests[1]!.system.text.includes('synthetic retained deletion'), false);
    assert.equal(liveRequests[1]!.system.text.includes('synthetic surviving note'), true);
    ws.send({ setupComplete: {} }); await tick();
    const replay = await fetch(path, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'cached' }, body: JSON.stringify({ title: note, timeZone: 'UTC' }) });
    assert.equal((await replay.text()).includes('synthetic retained deletion'), false);
    const again = await fetch(`${service.origin}/api/v1/entries/${entry.id}`, { method: 'DELETE', headers: { ...headers, 'Idempotency-Key': 'delete-again' }, body: '{}' });
    assert.equal(again.status, 200);
    const journal = f.store.transaction(tx => tx.all("SELECT text FROM live_journal WHERE live_session_id=? AND kind='continuity'", [accepted.liveSessionId]));
    assert.equal(journal.filter(row => String(row.text).includes('memory_deleted')).length, 1);
    live.revoke(accepted.liveSessionId);
    attachment = live.attach({ liveSessionId: detached.liveSessionId }, ctx);
    await ws.frame(3); ws.send({ setupComplete: {} }); await attachment.ready;
    assert.equal(liveRequests[2]!.system.text.includes('synthetic retained deletion'), false);
    assert.equal(liveRequests[2]!.system.text.includes('synthetic surviving note'), true);
  } finally {
    attachment?.close(); await service.close(); f.store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatch revalidates frozen records even when deletion bypassed HTTP composition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-frozen-'));
  const work: (() => void)[] = [], requests: ModelRequest[] = [];
  const f = openMemoryFixture(dir, { generate: async request => { requests.push(request); return result(request); } }, { schedule: task => work.push(task) });
  try {
    const memory = f.createSession('Memory'), entry = f.append(memory.id, note), conversation = f.enroll();
    const run = f.chat.accept({ sessionId: conversation.id, text: 'Selected memory', selectedMemoryEntryIds: [entry.id], idempotencyKey: 'frozen' }, f.context);
    f.store.transaction(tx => f.domain.execute(tx, 'deleteEntry', { id: entry.id }, f.context));
    const stream = f.chat.subscribe(run.runId, f.context);
    const done = (async () => { for await (const event of stream) { if (event.type === 'snapshot' && event.run.state === 'terminal') return; } })();
    work.shift()!(); await done;
    assert.equal(requests.length, 1);
    assert.equal(JSON.stringify(requests[0]).includes('synthetic retained deletion'), false);
  } finally { f.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
