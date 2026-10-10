import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startHost, pairLocal } from '../host/runtime.js';
import type { Credentials, Transport } from '../adapters/model/types.js';
import { profile, sse, syntheticKey } from './connected-process.js';

const webRoot = resolve(import.meta.dirname, '../../../web/dist');
type Auth = { cookie: string; csrf: string };

async function fixture(options: { credentials?: Credentials; transport?: Transport } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'didi-native-'));
  await profile(dir);
  const captured: { url: string; init: RequestInit }[] = [];
  let credentialCalls = 0;
  const config = { dataDir: dir, webRoot, port: 0, modelTesting: {
    credentials: options.credentials ?? { resolve: async () => { credentialCalls++; return syntheticKey; } },
    transport: options.transport ?? (async (url: string, init: RequestInit) => { captured.push({ url, init }); return sse(); }) } };
  let host = await startHost(config);
  async function pair(): Promise<Auth> {
    const code = await pairLocal(dir);
    const response = await fetch(host.descriptor.origin + '/api/v1/auth/pair', { method: 'POST', headers: { Origin: host.descriptor.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode: code }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: body.data.csrfToken as string };
  }
  const bearer = async () => (await readFile(join(dir, 'admin-credential'), 'utf8')).trim();
  function call(auth: Auth, path: string, body?: unknown, key = 'native-key', extra: Record<string, string> = {}) {
    return fetch(host.descriptor.origin + '/api/v1' + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      Cookie: auth.cookie, Origin: host.descriptor.origin, 'X-Didi-CSRF': auth.csrf, 'X-Didi-Authority-Epoch': host.store.authorityEpoch, 'Idempotency-Key': key, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function read<T>(auth: Auth, path: string): Promise<T> { const response = await call(auth, path); assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).data as T; }
  async function enroll(auth: Auth, title = 'Native conversation', key = 'native-enroll') {
    const response = await call(auth, '/conversations', { title, timeZone: 'UTC' }, key);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).data as { sessionId: string };
  }
  function open(auth: Auth, path: string) {
    const controller = new AbortController();
    return fetch(host.descriptor.origin + '/api/v1' + path, { method: 'POST', headers: {
      Cookie: auth.cookie, Origin: host.descriptor.origin, 'X-Didi-CSRF': auth.csrf, 'X-Didi-Authority-Epoch': host.store.authorityEpoch, 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal })
      .then(response => ({ response, controller }));
  }
  return { dir, captured, get host() { return host; }, get credentialCalls() { return credentialCalls; }, pair, bearer, call, read, enroll, open,
    async restart() { await host.close(); host = await startHost(config); },
    async close() { await host.close(); await rm(dir, { recursive: true, force: true }); } };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** Bounded frame reader: the timeout is a failure guard, never an ordering proof. */
async function frames(response: Response) {
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = '';
  return { async next(timeoutMs = 5000): Promise<Record<string, unknown> | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) { const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) return JSON.parse(data) as Record<string, unknown>; continue; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Timed out waiting for a stream frame');
      const outcome = await Promise.race([reader.read(), new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), remaining))]);
      if (outcome === 'timeout') throw new Error('Timed out waiting for a stream frame');
      if (outcome.done) return undefined;
      buffer += decoder.decode(outcome.value, { stream: true });
    }
  } };
}
async function terminal(f: F, auth: Auth, runId: string) {
  const response = await f.call(auth, `/chat/${runId}/events`, {}, 'run-events');
  assert.equal(response.status, 200, await response.clone().text());
  await response.text();
  return (await (await f.call(auth, `/chat/${runId}`)).json()).data as { outcome: string | null; state: string };
}

test('NATIVE selection is browser-principal only and rejects confused Origin/CSRF/epoch before any destination read', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair();
    const token = await f.bearer();
    const select = { sessionId: '00000000-0000-4000-8000-000000000000', title: 'Nowhere' };
    const origin = f.host.descriptor.origin;
    // Never a bearer shortcut, and never cookie + Authorization together.
    assert.equal((await fetch(origin + '/api/v1/conversation-selection', { headers: { Authorization: `Bearer ${token}` } })).status, 403);
    assert.equal((await fetch(origin + '/api/v1/conversation-selection', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Didi-Authority-Epoch': f.host.store.authorityEpoch }, body: JSON.stringify(select) })).status, 403);
    assert.equal((await fetch(origin + '/api/v1/conversation-selection', { headers: { Cookie: auth.cookie, Authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await f.call(auth, '/conversation-selection', select, 'sel-origin', { Origin: 'http://evil.invalid' })).status, 403);
    assert.equal((await f.call(auth, '/conversation-selection', select, 'sel-csrf', { 'X-Didi-CSRF': '' })).status, 403);
    assert.equal((await f.call(auth, '/conversation-selection', select, 'sel-epoch', { 'X-Didi-Authority-Epoch': 'stale' })).status, 409);
    assert.equal((await f.call(auth, '/conversation-selection', { sessionId: 'not-a-uuid', title: 'x' }, 'sel-bad')).status, 400);
    assert.equal((await f.call(auth, '/conversation-selection', { sessionId: select.sessionId, title: '' }, 'sel-empty')).status, 400);
    assert.equal((await f.call(auth, '/conversation-selection', { sessionId: select.sessionId, title: 'x', extra: 1 }, 'sel-extra')).status, 400);
    // A rejected write stored nothing.
    assert.deepEqual(await f.read(auth, '/conversation-selection'), { sessionId: null, title: null });
  } finally { await f.close(); }
});

test('NATIVE selection set/clear is isolated per authenticated principal and denies unknown, local-only or revoked destinations', async () => {
  const f = await fixture();
  try {
    const first = await f.pair(), second = await f.pair();
    const enrolled = await f.enroll(first);
    assert.deepEqual(await f.read(second, '/conversation-selection'), { sessionId: null, title: null });
    const set = await f.call(first, '/conversation-selection', { sessionId: enrolled.sessionId, title: 'Native conversation' }, 'sel-set');
    assert.equal(set.status, 200, await set.clone().text());
    assert.deepEqual(await f.read(first, '/conversation-selection'), { sessionId: enrolled.sessionId, title: 'Native conversation' });
    assert.deepEqual(await f.read(second, '/conversation-selection'), { sessionId: null, title: null });
    // A different principal clearing its own empty record never touches the first principal.
    assert.equal((await f.call(second, '/conversation-selection/clear', {}, 'sel-clear-2')).status, 200);
    assert.deepEqual(await f.read(first, '/conversation-selection'), { sessionId: enrolled.sessionId, title: 'Native conversation' });
    // Unknown, local-only (unconsented) and revoked destinations are denied.
    assert.equal((await f.call(first, '/conversation-selection', { sessionId: '11111111-1111-4111-8111-111111111111', title: 'ghost' }, 'sel-ghost')).status, 404);
    const local = await f.call(first, '/sessions', { title: 'Local only', timeZone: 'UTC' }, 'sel-local-session');
    assert.equal(local.status, 200);
    assert.equal((await f.call(first, '/conversation-selection', { sessionId: (await local.json()).data.id, title: 'Local only' }, 'sel-local-set')).status, 404);
    assert.equal((await f.call(first, `/conversations/${enrolled.sessionId}/revoke`, {}, 'sel-revoke')).status, 200);
    assert.equal((await f.call(first, '/conversation-selection', { sessionId: enrolled.sessionId, title: 'Revoked' }, 'sel-revoked-set')).status, 404);
    // Clear is idempotent and only the calling principal loses its record.
    assert.equal((await f.call(first, '/conversation-selection/clear', {}, 'sel-clear')).status, 200);
    assert.deepEqual(await f.read(first, '/conversation-selection'), { sessionId: null, title: null });
  } finally { await f.close(); }
});

test('NATIVE selection is service memory only: restart loses it and no selection text is persisted', async () => {
  const canary = 'NATIVE_SELECTION_CANARY_TITLE';
  const f = await fixture();
  try {
    const auth = await f.pair();
    const enrolled = await f.enroll(auth);
    assert.equal((await f.call(auth, '/conversation-selection', { sessionId: enrolled.sessionId, title: canary }, 'sel-canary')).status, 200);
    assert.equal((await readFile(join(f.dir, 'state.sqlite'))).includes(canary), false);
    await f.restart();
    const again = await f.pair();
    assert.deepEqual(await f.read(again, '/conversation-selection'), { sessionId: null, title: null });
  } finally { await f.close(); }
});

test('NATIVE latest same-principal selection wins over an earlier in-flight write', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair();
    const a = await f.enroll(auth, 'Conversation A', 'enroll-a');
    const b = await f.enroll(auth, 'Conversation B', 'enroll-b');
    const first = f.call(auth, '/conversation-selection', { sessionId: a.sessionId, title: 'Conversation A' }, 'sel-a');
    const second = f.call(auth, '/conversation-selection', { sessionId: b.sessionId, title: 'Conversation B' }, 'sel-b');
    assert.equal((await first).status, 200); assert.equal((await second).status, 200);
    assert.deepEqual(await f.read(auth, '/conversation-selection'), { sessionId: b.sessionId, title: 'Conversation B' });
  } finally { await f.close(); }
});

test('NATIVE logout clears the selection and closes the principal conversation stream', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair();
    const enrolled = await f.enroll(auth);
    assert.equal((await f.call(auth, '/conversation-selection', { sessionId: enrolled.sessionId, title: 'Native conversation' }, 'sel-set')).status, 200);
    const { response, controller } = await f.open(auth, `/conversations/${enrolled.sessionId}/events`);
    const stream = await frames(response);
    assert.equal((await f.call(auth, '/auth/logout', {}, 'logout')).status, 200);
    assert.equal(await stream.next(), undefined);
    controller.abort();
    const fresh = await f.pair();
    assert.deepEqual(await f.read(fresh, '/conversation-selection'), { sessionId: null, title: null });
  } finally { await f.close(); }
});

test('NATIVE conversation stream emits one durable run frame per committed fresh run and none on duplicate replay', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair();
    const enrolled = await f.enroll(auth);
    const { response, controller } = await f.open(auth, `/conversations/${enrolled.sessionId}/events`);
    const stream = await frames(response);
    const accepted = await f.call(auth, '/chat', { sessionId: enrolled.sessionId, text: 'One small next step.' }, 'native-accept');
    assert.equal(accepted.status, 200, await accepted.clone().text());
    const runId = (await accepted.json()).data.runId as string;
    assert.deepEqual(await stream.next(), { type: 'run', sessionId: enrolled.sessionId, runId });
    assert.equal((await terminal(f, auth, runId)).outcome, 'complete');
    // Duplicate acceptance replay returns the same run and starts no second model action or frame.
    const replay = await f.call(auth, '/chat', { sessionId: enrolled.sessionId, text: 'One small next step.' }, 'native-accept');
    assert.equal((await replay.json()).data.runId, runId);
    assert.equal(f.captured.length, 1); assert.equal(f.credentialCalls, 1);
    // A genuinely fresh run emits exactly its own durable identifier.
    const next = await f.call(auth, '/chat', { sessionId: enrolled.sessionId, text: 'Say that another way.' }, 'native-accept-2');
    const secondRunId = (await next.json()).data.runId as string;
    assert.notEqual(secondRunId, runId);
    assert.deepEqual(await stream.next(), { type: 'run', sessionId: enrolled.sessionId, runId: secondRunId });
    assert.equal(f.captured.length, 2);
    controller.abort();
  } finally { await f.close(); }
});

test('NATIVE a frame missed while disconnected is found from the durable latestRunId after the subscription is re-registered', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair();
    const enrolled = await f.enroll(auth);
    const first = await f.open(auth, `/conversations/${enrolled.sessionId}/events`);
    const stream = await frames(first.response);
    const accepted = await f.call(auth, '/chat', { sessionId: enrolled.sessionId, text: 'First turn.' }, 'gap-accept');
    const runId = (await accepted.json()).data.runId as string;
    assert.equal((await stream.next())?.runId, runId);
    assert.equal((await terminal(f, auth, runId)).outcome, 'complete');
    first.controller.abort();
    // Accepted while no conversation stream is open: the event is missed, not replayed.
    const second = await f.call(auth, '/chat', { sessionId: enrolled.sessionId, text: 'Second turn.' }, 'gap-accept-2');
    const secondRunId = (await second.json()).data.runId as string;
    assert.notEqual(secondRunId, runId);
    // Reconnect repeats the durable snapshot; the missed run is found without an implicit retry.
    assert.equal((await f.read<{ latestRunId: string }>(auth, `/conversations/${enrolled.sessionId}`)).latestRunId, secondRunId);
    const reopened = await f.open(auth, `/conversations/${enrolled.sessionId}/events`);
    assert.equal(reopened.response.status, 200);
    reopened.controller.abort();
    assert.equal(f.captured.length, 2);
  } finally { await f.close(); }
});

test('NATIVE conversation stream is bounded and terminal run state stays truthful', async () => {
  const f = await fixture();
  try {
    const auth = await f.pair();
    const enrolled = await f.enroll(auth);
    const opened = [];
    for (let i = 0; i < 4; i++) { const item = await f.open(auth, `/conversations/${enrolled.sessionId}/events`); assert.equal(item.response.status, 200); opened.push(item); }
    const fifth = await f.open(auth, `/conversations/${enrolled.sessionId}/events`);
    assert.equal(fifth.response.status, 429);
    fifth.controller.abort();
    for (const item of opened) item.controller.abort();
    // A completed run reports its owning durable terminal state, not the local HTTP 200.
    const accepted = await f.call(auth, '/chat', { sessionId: enrolled.sessionId, text: 'One completed turn.' }, 'cap-accept');
    const runId = (await accepted.json()).data.runId as string;
    const done = await terminal(f, auth, runId);
    assert.equal(done.state, 'terminal'); assert.equal(done.outcome, 'complete');
  } finally { await f.close(); }
});

test('NATIVE cancel during a held dispatch stays the durable owning state', async () => {
  let release!: (key: string) => void;
  const credentials: Credentials = { resolve: () => new Promise<string>(resolveKey => { release = resolveKey; }) };
  const f = await fixture({ credentials, transport: async () => sse() });
  try {
    const auth = await f.pair();
    const enrolled = await f.enroll(auth);
    const accepted = await f.call(auth, '/chat', { sessionId: enrolled.sessionId, text: 'Hold this dispatch.' }, 'hold-accept');
    const runId = (await accepted.json()).data.runId as string;
    const cancelled = await f.call(auth, `/chat/${runId}/cancel`, {}, 'hold-cancel');
    assert.equal(cancelled.status, 200, await cancelled.clone().text());
    assert.equal((await cancelled.json()).data.outcome, 'cancelled');
    release(syntheticKey);
    assert.equal((await terminal(f, auth, runId)).outcome, 'cancelled');
    assert.equal(f.captured.length, 0);
  } finally { await f.close(); }
});
