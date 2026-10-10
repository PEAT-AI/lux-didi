// Explicit selected local memory over the real canonical Store + Domain + ChatService + HTTP.
// The HTTP accept allowlists must carry `selectedMemoryEntryIds` unchanged to ChatService.accept,
// which stays the sole fingerprint owner; nothing here adds a backdoor or a second database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startHost, pairLocal } from '../host/runtime.js';
import { createDomainPort } from '../domain/facade.js';
import { Outbox } from '../runtime/outbox.js';
import { profile, sse, syntheticKey } from './connected-process.js';

const webRoot = resolve(import.meta.dirname, '../../../web/dist');
const ORDINARY = 'SELMEM-ORDINARY-NOTE keep this thread';
const PRIVATE = 'SELMEM-PRIVATE-NOTE only for this message';
const SENSITIVE = 'SELMEM-SENSITIVE-NOTE beyond the grant';
const UNKNOWN = 'SELMEM-UNKNOWN-NOTE never classified';
const CANARY = 'SELMEM-CANARY-NEVER-SELECTED';
type Auth = { cookie: string; csrf: string };

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'didi-selmem-'));
  await profile(dir);
  const captured: { url: string; init: RequestInit }[] = [];
  const config = { dataDir: dir, webRoot, port: 0, modelTesting: {
    credentials: { resolve: async () => syntheticKey },
    transport: async (url: string, init: RequestInit) => { captured.push({ url, init }); return sse(); } } };
  let host = await startHost(config);
  const domain = createDomainPort({ outbox: Outbox });
  const ctx = () => ({ assistantId: host.store.assistantId, clientId: 'local-admin', authorityEpoch: host.store.authorityEpoch, now: new Date(0).toISOString() });
  const create = (title: string, dataClass?: string) => host.store.transaction(tx => domain.execute(tx, 'createSession', { title, timeZone: 'UTC' }, ctx(), dataClass ? { writer: 'capture', dataClass } as never : undefined)) as { id: string };
  const append = (sessionId: string, text: string, dataClass?: string) => host.store.transaction(tx => domain.execute(tx, 'appendEntry', { sessionId, text, role: 'user', timeZone: 'UTC' }, ctx(), dataClass ? { writer: 'capture', dataClass } as never : undefined)) as { id: string };
  const seed = (title: string, text: string, dataClass: string) => { const session = create(title, dataClass); return { sessionId: session.id, entryId: append(session.id, text, dataClass).id }; };
  const ordinary = seed('Ordinary notes', ORDINARY, 'ordinary');
  const privateNote = seed('Private notes', PRIVATE, 'private');
  const sensitive = seed('Sensitive notes', SENSITIVE, 'sensitive');
  const unknownSession = create('Unknown notes');
  const unknown = { sessionId: unknownSession.id, entryId: append(unknownSession.id, UNKNOWN).id };
  const canary = seed('Canary notes', CANARY, 'ordinary');
  async function pair(): Promise<Auth> {
    const code = await pairLocal(dir);
    const response = await fetch(host.descriptor.origin + '/api/v1/auth/pair', { method: 'POST', headers: { Origin: host.descriptor.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode: code }) });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: body.data.csrfToken as string };
  }
  function call(auth: Auth, path: string, body?: unknown, key = 'selmem-key', extra: Record<string, string> = {}) {
    return fetch(host.descriptor.origin + '/api/v1' + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      Cookie: auth.cookie, Origin: host.descriptor.origin, 'X-Didi-CSRF': auth.csrf, 'X-Didi-Authority-Epoch': host.store.authorityEpoch, 'Idempotency-Key': key, 'Content-Type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function enroll(auth: Auth) {
    const response = await call(auth, '/conversations', { title: 'Selected notes', timeZone: 'UTC' }, 'selmem-enroll');
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).data as { sessionId: string };
  }
  async function entries(auth: Auth, sessionId: string) {
    const response = await call(auth, `/sessions/${sessionId}`);
    assert.equal(response.status, 200, await response.clone().text());
    return ((await response.json()).data as { entries: unknown[] }).entries;
  }
  async function terminal(auth: Auth, runId: string) {
    for (let attempt = 0; attempt < 250; attempt++) {
      const data = (await (await call(auth, `/chat/${runId}`)).json()).data as { state: string; memorySelection: { requestedIds: string[]; usedIds: string[]; omitted: { id: string; reason: string }[]; counts: { requested: number; used: number; omitted: number }; frozen: boolean } | null };
      if (data.state === 'terminal') return data;
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    throw Error('run never became terminal');
  }
  return { dir, captured, ordinary, privateNote, sensitive, unknown, canary, get host() { return host; }, pair, call, enroll, entries, terminal,
    async restart() { await host.close(); host = await startHost(config); },
    async close() { await host.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('HTTP carries an explicit selected-note field through both allowlists to ChatService.accept', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair(); const c = await f.enroll(auth);
    const response = await f.call(auth, '/chat', { sessionId: c.sessionId, text: 'Use one stored note', selectedMemoryEntryIds: [f.ordinary.entryId] }, 'selmem-ok');
    assert.equal(response.status, 200, await response.clone().text());
    const run = (await response.json()).data as { runId: string; memorySelection: { requestedIds: string[] } };
    assert.deepEqual(run.memorySelection.requestedIds, [f.ordinary.entryId]);
    await f.terminal(auth, run.runId);
  } finally { await f.close(); }
});

test('malformed, oversized or non-array selected ids are refused 400 before any capture', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair(); const c = await f.enroll(auth);
    const malformed: unknown[] = [[123], ['bad id!'], ['ok_id', ''], Array.from({ length: 33 }, (_, i) => `note-${i}`), 'not-an-array', { id: 'x' }];
    for (const ids of malformed) {
      const response = await f.call(auth, '/chat', { sessionId: c.sessionId, text: 'Refused selection', selectedMemoryEntryIds: ids }, `bad-${Math.random()}`);
      assert.equal(response.status, 400, `${JSON.stringify(ids)} -> ${response.status}`);
      const body = await response.json();
      assert.match(String(body.error.message), /note/i);
    }
    assert.equal(f.captured.length, 0, 'no provider call for a refused selection');
    assert.equal((await f.entries(auth, c.sessionId)).length, 0, 'no user entry captured for a refused selection');
  } finally { await f.close(); }
});

test('the body may never carry an idempotency key; the header stays the only key', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair(); const c = await f.enroll(auth);
    const response = await f.call(auth, '/chat', { sessionId: c.sessionId, text: 'Body key attempt', idempotencyKey: 'forged-key' }, 'selmem-body-key');
    assert.equal(response.status, 400, await response.clone().text());
    assert.equal(f.captured.length, 0);
  } finally { await f.close(); }
});

test('a missing Origin or CSRF token is refused 403 and captures nothing', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair(); const c = await f.enroll(auth);
    const body = { sessionId: c.sessionId, text: 'No origin', selectedMemoryEntryIds: [f.ordinary.entryId] };
    assert.equal((await f.call(auth, '/chat', body, 'no-origin', { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await f.call(auth, '/chat', body, 'no-csrf', { 'X-Didi-CSRF': '' })).status, 403);
    assert.equal(f.captured.length, 0);
    assert.equal((await f.entries(auth, c.sessionId)).length, 0);
  } finally { await f.close(); }
});

test('an unknown stored id is refused with no run and no provider call', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair(); const c = await f.enroll(auth);
    const response = await f.call(auth, '/chat', { sessionId: c.sessionId, text: 'Unknown note', selectedMemoryEntryIds: ['does-not-exist-0001'] }, 'selmem-unknown-id');
    assert.equal(response.status, 404, await response.clone().text());
    assert.equal(f.captured.length, 0);
    assert.equal((await f.entries(auth, c.sessionId)).length, 0);
  } finally { await f.close(); }
});

test('an unclassified note and an over-grant note are refused with a local explanation and no capture', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair(); const c = await f.enroll(auth);
    const unclassified = await f.call(auth, '/chat', { sessionId: c.sessionId, text: 'Unclassified note', selectedMemoryEntryIds: [f.unknown.entryId] }, 'selmem-unknown-class');
    assert.equal(unclassified.status, 503, await unclassified.clone().text());
    const overGrant = await f.call(auth, '/chat', { sessionId: c.sessionId, text: 'Over-grant note', selectedMemoryEntryIds: [f.sensitive.entryId] }, 'selmem-over-grant');
    assert.equal(overGrant.status, 503, await overGrant.clone().text());
    assert.equal(f.captured.length, 0);
    assert.equal((await f.entries(auth, c.sessionId)).length, 0);
  } finally { await f.close(); }
});

test('an accepted cross-session note reaches the provider request and an unselected canary never does', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair(); const c = await f.enroll(auth);
    const response = await f.call(auth, '/chat', { sessionId: c.sessionId, text: 'Answer with my stored notes.', selectedMemoryEntryIds: [f.ordinary.entryId, f.privateNote.entryId] }, 'selmem-cross');
    assert.equal(response.status, 200, await response.clone().text());
    const run = (await response.json()).data as { runId: string };
    const snapshot = await f.terminal(auth, run.runId);
    const wire = JSON.stringify(f.captured[0]!.init.body);
    assert.match(wire, new RegExp(ORDINARY));
    assert.match(wire, new RegExp(PRIVATE));
    assert.doesNotMatch(wire, new RegExp(CANARY));
    assert.deepEqual([...snapshot.memorySelection!.requestedIds].sort(), [f.ordinary.entryId, f.privateNote.entryId].sort());
    assert.deepEqual([...snapshot.memorySelection!.usedIds].sort(), [f.ordinary.entryId, f.privateNote.entryId].sort());
    assert.equal(snapshot.memorySelection!.omitted.length, 0);
    assert.equal(snapshot.memorySelection!.frozen, true);
  } finally { await f.close(); }
});

test('normalized selection replays on a reordered equal set and conflicts on a different set, with no duplicate provider call', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair(); const c = await f.enroll(auth);
    const first = await f.call(auth, '/chat', { sessionId: c.sessionId, text: 'Deterministic selection', selectedMemoryEntryIds: [f.ordinary.entryId, f.privateNote.entryId] }, 'selmem-norm');
    assert.equal(first.status, 200, await first.clone().text());
    const firstRun = (await first.json()).data as { runId: string };
    await f.terminal(auth, firstRun.runId);
    assert.equal(f.captured.length, 1);
    const replay = await f.call(auth, '/chat', { sessionId: c.sessionId, text: 'Deterministic selection', selectedMemoryEntryIds: [f.privateNote.entryId, f.ordinary.entryId, f.privateNote.entryId] }, 'selmem-norm');
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal(((await replay.json()).data as { runId: string }).runId, firstRun.runId);
    assert.equal(f.captured.length, 1, 'a replay starts no second provider call');
    const conflict = await f.call(auth, '/chat', { sessionId: c.sessionId, text: 'Deterministic selection', selectedMemoryEntryIds: [f.ordinary.entryId] }, 'selmem-norm');
    assert.equal(conflict.status, 409, await conflict.clone().text());
    assert.equal(f.captured.length, 1);
    assert.equal((await f.entries(auth, c.sessionId) as { role: string }[]).filter(entry => entry.role === 'user').length, 1);
  } finally { await f.close(); }
});

test('recovered run keeps source-backed requested/used/omitted metadata after a service restart', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair(); const c = await f.enroll(auth);
    const response = await f.call(auth, '/chat', { sessionId: c.sessionId, text: 'Persist the evidence', selectedMemoryEntryIds: [f.ordinary.entryId] }, 'selmem-restart');
    assert.equal(response.status, 200, await response.clone().text());
    const run = (await response.json()).data as { runId: string };
    await f.terminal(auth, run.runId);
    await f.restart();
    const recovered = await f.terminal(auth, run.runId);
    assert.deepEqual(recovered.memorySelection!.requestedIds, [f.ordinary.entryId]);
    assert.deepEqual(recovered.memorySelection!.usedIds, [f.ordinary.entryId]);
    assert.equal(recovered.memorySelection!.counts.used, 1);
  } finally { await f.close(); }
});

test('an empty selection is omitted from the request and captures no selection row', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair(); const c = await f.enroll(auth);
    const response = await f.call(auth, '/chat', { sessionId: c.sessionId, text: 'No notes this turn' }, 'selmem-empty');
    assert.equal(response.status, 200, await response.clone().text());
    const run = (await response.json()).data as { runId: string };
    const snapshot = await f.terminal(auth, run.runId);
    assert.equal(snapshot.memorySelection, null);
  } finally { await f.close(); }
});
