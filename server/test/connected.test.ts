import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, request } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../runtime/store.js';
import { chatMigrations } from '../chat/index.js';
import { composeChat } from '../host/connected.js';
import { startHost, pairLocal } from '../host/runtime.js';
import { createDomainPort } from '../domain/index.js';
import { Outbox } from '../runtime/outbox.js';
import type { Credentials, Transport } from '../adapters/model/types.js';

const webRoot = resolve(import.meta.dirname, '../../../web/dist');
import { profile, sse, syntheticKey, answer } from './connected-process.js';

async function fixture(configured = true, options: { credentials?: Credentials; transport?: Transport; now?: () => number; model?: string; classes?: string[]; deadlineMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'didi-connected-'));
  if (configured) await profile(dir, options.model, options.classes);
  const captured: { url: string; init: RequestInit }[] = [];
  let credentialCalls = 0;
  const config = { dataDir: dir, webRoot, port: 0, ...(options.now ? { now: options.now } : {}),
    modelTesting: { ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}), credentials: options.credentials ?? { resolve: async () => { credentialCalls++; return syntheticKey; } }, transport: options.transport ?? (async (url: string, init: RequestInit) => { captured.push({ url, init }); return sse(); }) } };
  let host = await startHost(config);
  async function pair() {
    const code = await pairLocal(dir);
    const response = await fetch(host.descriptor.origin + '/api/v1/auth/pair', { method: 'POST', headers: { Origin: host.descriptor.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode: code }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: body.data.csrfToken as string };
  }
  let auth = await pair();
  async function call(path: string, body?: unknown, key = 'connected-key', extra: Record<string, string> = {}) {
    return fetch(host.descriptor.origin + '/api/v1' + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      Cookie: auth.cookie, Origin: host.descriptor.origin, 'X-Didi-CSRF': auth.csrf, 'X-Didi-Authority-Epoch': host.store.authorityEpoch, 'Idempotency-Key': key, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  return { dir, captured, get host() { return host; }, get auth() { return auth; }, get credentialCalls() { return credentialCalls; }, call,
    async enroll(key = 'enroll') { const r = await call('/conversations', { title: 'Explicit Naya conversation', timeZone: 'UTC' }, key); assert.equal(r.status, 200, await r.clone().text()); return (await r.json()).data; },
    async restart(model?: string) {
      await host.close();
      if (model) { const p = join(dir, 'provider-config', 'profile.json'); const data = JSON.parse(await readFile(p, 'utf8')); data.modelId = model; await writeFile(p, JSON.stringify(data), { mode: 0o600 }); }
      host = await startHost(config); auth = await pair();
    },
    async rebootstrap() { auth = await pair(); },
    async newClient() { return pair(); },
    async close() { await host.close(); await rm(dir, { recursive: true, force: true }); }
  };
}
async function final(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  const events = await f.call(`/chat/${runId}/events`, {});
  assert.equal(events.status, 200);
  // A bounded server-owned terminal stream proves provisional frames and persistence.
  const text = await events.text();
  const response = await f.call(`/chat/${runId}`);
  assert.equal(response.status, 200);
  return { run: (await response.json()).data, text };
}

test('CONNECTED absent config is sanitized; unavailable enrollment creates nothing and local capture works', async () => {
  const f = await fixture(false);
  try {
    const status = await f.call('/chat/status'); assert.equal(status.status, 200); assert.deepEqual((await status.json()).data, { status: 'unconfigured' });
    const denied = await f.call('/conversations', { title: 'Not enrolled', timeZone: 'UTC' }); assert.equal(denied.status, 503);
    assert.equal((await (await f.call('/sessions')).json()).data.items.length, 0);
    const local = await f.call('/sessions', { title: 'Local only', timeZone: 'UTC' }, 'local-session'); assert.equal(local.status, 200);
    assert.equal(f.credentialCalls, 0); assert.equal(f.captured.length, 0);
  } finally { await f.close(); }
});

test('CONNECTED actual adapter/HTTP atomic private enrollment and whole-turn context, replay and restart', async () => {
  const f = await fixture();
  try {
    const status = (await (await f.call('/chat/status')).json()).data; assert.deepEqual(status, { status: 'configured', provider: 'gemini', model: 'gemini-connected-test' });
    const local = (await (await f.call('/sessions', { title: 'EXCLUDED_OTHER_SESSION_CANARY', timeZone: 'UTC' }, 'local')).json()).data;
    assert.equal((await f.call(`/sessions/${local.id}/entries`, { text: 'EXCLUDED_LOCAL_NOTE_CANARY', role: 'user', timeZone: 'UTC' }, 'local-entry')).status, 200);
    assert.equal((await (await f.call(`/sessions/${local.id}`)).json()).data.entries[0].text, 'EXCLUDED_LOCAL_NOTE_CANARY');
    assert.equal((await f.call('/commitments', { title: 'EXCLUDED_TODAY_CANARY', dueAt: null, timeZone: 'UTC' }, 'local-commitment')).status, 200);
    const enrolled = await f.enroll();
    const replayEnrollment = await f.enroll(); assert.equal(replayEnrollment.sessionId, enrolled.sessionId);
    const domain = createDomainPort({ outbox: Outbox });
    assert.deepEqual(f.host.store.transaction(tx => domain.getRoutingLabel(tx, { kind: 'session', id: enrolled.sessionId })).dataClass, 'private');
    const accepted = await f.call('/chat', { sessionId: enrolled.sessionId, text: 'Help me choose one small next step.' }, 'first-turn'); assert.equal(accepted.status, 200, await accepted.clone().text());
    const first = (await accepted.json()).data; const completed = await final(f, first.runId);
    assert.equal(completed.run.outcome, 'complete'); assert.equal(completed.run.finalText, answer); assert.match(completed.text, /provisional/);
    assert.equal(f.captured.length, 1); assert.equal(f.credentialCalls, 1);
    assert.match(f.captured[0]!.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-connected-test:streamGenerateContent\?alt=sse$/);
    const payload = JSON.parse(String(f.captured[0]!.init.body)); assert.ok(payload.systemInstruction); assert.match(JSON.stringify(payload), /small next step/); assert.doesNotMatch(JSON.stringify(payload), /EXCLUDED_/);
    const entries = (await (await f.call(`/sessions/${enrolled.sessionId}`)).json()).data.entries;
    assert.deepEqual(entries.map((e: { role: string }) => e.role), ['user', 'assistant']);
    for (const e of entries) assert.equal(f.host.store.transaction(tx => domain.getRoutingLabel(tx, { kind: 'entry', id: e.id })).dataClass, 'private');
    assert.doesNotMatch(JSON.stringify(completed.run), /trace|manifest|systemInstruction|connected-synthetic|keyReference/);
    await f.restart();
    assert.equal((await (await f.call(`/conversations/${enrolled.sessionId}`)).json()).data.state, 'active');
    const replay = (await (await f.call('/chat', { sessionId: enrolled.sessionId, text: 'Help me choose one small next step.' }, 'first-turn')).json()).data;
    assert.equal(replay.runId, first.runId); assert.equal(replay.finalText, answer); assert.equal(f.captured.length, 1);
    assert.equal((await f.call('/chat', { sessionId: enrolled.sessionId, text: 'changed' }, 'first-turn')).status, 409);
    const second = (await (await f.call('/chat', { sessionId: enrolled.sessionId, text: 'Now help me make that step concrete.' }, 'second-turn')).json()).data;
    assert.equal((await final(f, second.runId)).run.outcome, 'complete');
    const nextPayload = JSON.stringify(JSON.parse(String(f.captured[1]!.init.body))); assert.match(nextPayload, /small next step/); assert.match(nextPayload, /keep the rest for later/); assert.match(nextPayload, /step concrete/); assert.doesNotMatch(nextPayload, /EXCLUDED_/);
    await f.restart('gemini-connected-new');
    assert.equal((await (await f.call(`/conversations/${enrolled.sessionId}`)).json()).data.state, 'route_changed');
    const count = f.credentialCalls;
    assert.equal((await f.call('/chat', { sessionId: enrolled.sessionId, text: 'must not capture' }, 'changed-route')).status, 409);
    assert.equal(f.credentialCalls, count); assert.equal(f.captured.length, 2);
    const newConversation = await f.enroll('new-route');
    const third = (await (await f.call('/chat', { sessionId: newConversation.sessionId, text: 'New explicit route.' }, 'new-turn')).json()).data;
    assert.equal((await final(f, third.runId)).run.outcome, 'complete'); assert.match(f.captured[2]!.url, /gemini-connected-new/);
  } finally { await f.close(); }
});

test('CONNECTED exact DTO/auth gates deny before credentials or adapter transport', async () => {
  const f = await fixture();
  try {
    const c = await f.enroll();
    for (const field of ['assistantId', 'clientId', 'labels', 'endpoint', 'toolPolicy', 'sourceRefs']) {
      assert.equal((await f.call('/chat', { sessionId: c.sessionId, text: 'forged', [field]: 'injected' }, field)).status, 400);
    }
    const body = { sessionId: c.sessionId, text: 'blocked' };
    assert.equal((await f.call('/chat', body, 'origin', { Origin: 'http://evil.invalid' })).status, 403);
    assert.equal((await f.call('/chat', body, 'csrf', { 'X-Didi-CSRF': '' })).status, 403);
    assert.equal((await f.call('/chat', body, 'epoch', { 'X-Didi-Authority-Epoch': 'stale' })).status, 409);
    const rawStatus = await new Promise<number>((resolveStatus, reject) => { const r = request(f.host.descriptor.origin + '/api/v1/chat', { method: 'POST', headers: { Host: 'evil.invalid', Cookie: f.auth.cookie } }, res => { res.resume(); resolveStatus(res.statusCode!); }); r.on('error', reject); r.end(JSON.stringify(body)); });
    assert.equal(rawStatus, 403); assert.equal(f.credentialCalls, 0); assert.equal(f.captured.length, 0);
    await f.call('/auth/logout', {});
    assert.equal((await f.call('/chat', body)).status, 401); assert.equal(f.credentialCalls, 0);
  } finally { await f.close(); }
});

test('CONNECTED revoke while actual adapter awaits credentials makes zero transport calls', async () => {
  let release!: (key: string) => void, entered!: () => void;
  const waiting = new Promise<void>(resolveEntered => { entered = resolveEntered; });
  const credentials: Credentials = { resolve: () => { entered(); return new Promise<string>(resolveKey => { release = resolveKey; }); } };
  let calls = 0;
  const f = await fixture(true, { credentials, transport: async () => { calls++; return sse(); } });
  try {
    const c = await f.enroll(); const run = (await (await f.call('/chat', { sessionId: c.sessionId, text: 'May be cancelled.' })).json()).data;
    await waiting; const revoked = await f.call(`/conversations/${c.sessionId}/revoke`, {}); assert.equal(revoked.status, 200);
    release(syntheticKey); const result = await final(f, run.runId); assert.notEqual(result.run.outcome, 'complete'); assert.equal(calls, 0);
    assert.equal((await f.call('/chat', { sessionId: c.sessionId, text: 'No new capture.' }, 'revoked')).status, 409);
    assert.equal((await (await f.call(`/sessions/${c.sessionId}`)).json()).data.entries.length, 1);
  } finally { release?.(syntheticKey); await f.close(); }
});

test('CONNECTED unlabeled legacy append blocks without silently granting it consent', async () => {
  const f = await fixture();
  try {
    const c = await f.enroll(); const legacy = await f.call(`/sessions/${c.sessionId}/entries`, { text: 'UNLABELED_LEGACY', role: 'user', timeZone: 'UTC' }, 'legacy'); assert.equal(legacy.status, 200);
    const before = (await (await f.call(`/sessions/${c.sessionId}`)).json()).data.entries.length;
    assert.equal((await f.call('/chat', { sessionId: c.sessionId, text: 'Never send unknown history.' })).status, 503);
    assert.equal((await (await f.call(`/sessions/${c.sessionId}`)).json()).data.entries.length, before); assert.equal(f.captured.length, 0); assert.equal(f.credentialCalls, 0);
  } finally { await f.close(); }
});

const trusted = (f: Awaited<ReturnType<typeof fixture>>) => ({ assistantId: f.host.store.assistantId, authorityEpoch: f.host.store.authorityEpoch, clientId: 'trusted-test-review', now: new Date().toISOString() });
function deferredCredentials() {
  let release!: (key: string) => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const credentials: Credentials = { resolve: () => { entered(); return new Promise<string>(resolve => { release = resolve; }); } };
  return { credentials, waiting, release() { release(syntheticKey); } };
}

test('CONNECTED private-denying and unsupported profiles keep local host alive and never enroll', async () => {
  for (const options of [{ classes: ['ordinary'] }, { model: 'unsupported-by-actual-adapter' }]) {
    const f = await fixture(true, options);
    try {
      const status = (await (await f.call('/chat/status')).json()).data;
      assert.equal(status.status, options.model ? 'error' : 'configured');
      if (options.model) assert.deepEqual(status, { status: 'error', code: 'ADAPTER_CONFIGURATION_INVALID' });
      assert.equal((await f.call('/conversations', { title: 'No grant', timeZone: 'UTC' })).status, 503);
      assert.equal((await (await f.call('/sessions')).json()).data.items.length, 0);
      assert.equal((await f.call('/sessions', { title: 'Still local', timeZone: 'UTC' }, 'local')).status, 200);
      assert.equal(f.credentialCalls, 0); assert.equal(f.captured.length, 0);
    } finally { await f.close(); }
  }
});

test('CONNECTED trusted blocking label correction aborts deferred actual-adapter credentials', async () => {
  const gate = deferredCredentials(); let calls = 0;
  const f = await fixture(true, { credentials: gate.credentials, transport: async () => { calls++; return sse(); } });
  try {
    const c = await f.enroll(); const run = (await (await f.call('/chat', { sessionId: c.sessionId, text: 'Waiting for credentials.' })).json()).data;
    await gate.waiting;
    const correction = f.host.chat.correctRoutingLabel({ subject: { kind: 'entry', id: run.userEntryId }, expectedRevision: 1, dataClass: 'sensitive' }, trusted(f));
    assert.equal(correction.revision, 2); gate.release();
    assert.equal((await final(f, run.runId)).run.outcome, 'cancelled'); assert.equal(calls, 0);
    assert.equal((await f.call('/chat', { sessionId: c.sessionId, text: 'Do not send sensitive history.' }, 'after-correction')).status, 503);
  } finally { gate.release(); await f.close(); }
});

test('CONNECTED revoke after local HTTP transport receives bytes aborts it and never saves assistant', async () => {
  let received!: () => void, closed!: () => void;
  const receiving = new Promise<void>(resolve => { received = resolve; }), closing = new Promise<void>(resolve => { closed = resolve; });
  const transportServer = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += String(part); assert.match(body, /already sent/);
    res.on('close', () => { if (!res.writableFinished) closed(); }); received();
  });
  await new Promise<void>(resolveListen => transportServer.listen(0, '127.0.0.1', resolveListen));
  const addr = transportServer.address(); assert.ok(addr && typeof addr !== 'string');
  const f = await fixture(true, { transport: (_url, init) => fetch(`http://127.0.0.1:${addr.port}/capturing-transport`, init) });
  try {
    const c = await f.enroll(); const run = (await (await f.call('/chat', { sessionId: c.sessionId, text: 'This has already sent bytes.' })).json()).data;
    await receiving; assert.equal((await f.call(`/conversations/${c.sessionId}/revoke`, {})).status, 200); await closing;
    const ended = (await final(f, run.runId)).run; assert.equal(ended.outcome, 'cancelled'); assert.equal(ended.mayHaveBeenSent, true);
    assert.equal((await (await f.call(`/sessions/${c.sessionId}`)).json()).data.entries.length, 1);
  } finally { await f.close(); await new Promise<void>(resolveClose => { transportServer.close(() => resolveClose()); transportServer.closeAllConnections(); }); }
});

test('CONNECTED terminal SQLite failure after persisted revoke still aborts outstanding actual adapter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-connected-fault-')); await profile(dir);
  const gate = deferredCredentials(); let calls = 0;
  const domain = createDomainPort({ outbox: Outbox });
  const migrations = chatMigrations.map(m => ({ ...m, statements: m.statements.map(sql => sql.startsWith('CREATE TABLE chat_runs') ? sql.replace(/\)\s*$/, ", CHECK(outcome IS NULL OR outcome!='cancelled'))") : sql) }));
  const store = new Store(dir, [...domain.migrations, ...migrations]);
  const { chat } = composeChat(store, domain, join(dir, 'provider-config'), { credentials: gate.credentials, transport: async () => { calls++; return sse(); } });
  const context = { assistantId: store.assistantId, authorityEpoch: store.authorityEpoch, clientId: 'trusted-fixture', now: new Date().toISOString() };
  try {
    const c = chat.enroll({ title: 'Fault control', timeZone: 'UTC', idempotencyKey: 'enroll' }, context);
    const run = chat.accept({ sessionId: c.sessionId, text: 'Revocation must abort despite storage failure.', idempotencyKey: 'turn' }, context);
    await gate.waiting; assert.equal(chat.revoke(c.sessionId, context).state, 'revoked'); gate.release();
    // Recovery of intent is truthful, not a completed answer or an automatic retry.
    await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
    assert.equal(calls, 0); assert.equal(chat.get(run.runId, context).finalEntryId, null);
    assert.equal(chat.get(run.runId, context).state, 'dispatch_intent');
    assert.deepEqual(store.transaction(tx => domain.execute(tx, 'getSession', { id: c.sessionId }, context)).entries.map(e => e.role), ['user']);
  } finally { chat.shutdown(); gate.release(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('CONNECTED idle expiry closes stream but not durable work; rebootstrap recovers without send', async () => {
  let clock = Date.now(); const gate = deferredCredentials(); const f = await fixture(true, { now: () => clock, credentials: gate.credentials });
  try {
    const c = await f.enroll(); const run = (await (await f.call('/chat', { sessionId: c.sessionId, text: 'Work survives subscriber expiry.' })).json()).data;
    await gate.waiting; const events = await f.call(`/chat/${run.runId}/events`, {}); assert.equal(events.status, 200);
    const end = events.text(); clock += 13 * 60 * 60 * 1000; assert.match(await end, /snapshot/);
    assert.equal((await f.call(`/chat/${run.runId}`)).status, 401);
    await f.rebootstrap(); gate.release(); assert.equal((await final(f, run.runId)).run.outcome, 'complete'); assert.equal(f.captured.length, 1);
  } finally { gate.release(); await f.close(); }
});

test('CONNECTED logout closes only that client stream; disconnect only detaches subscriber', async () => {
  const gate = deferredCredentials(), f = await fixture(true, { credentials: gate.credentials });
  try {
    const c = await f.enroll(); const run = (await (await f.call('/chat', { sessionId: c.sessionId, text: 'Different clients share the durable owner.' })).json()).data;
    await gate.waiting;
    const own = await f.call(`/chat/${run.runId}/events`, {}); const ownEnd = own.text();
    const other = await f.newClient(); const otherEvents = await f.call(`/chat/${run.runId}/events`, {}, 'subscriber', { Cookie: other.cookie, 'X-Didi-CSRF': other.csrf });
    const reader = otherEvents.body!.getReader(); assert.ok((await reader.read()).value); await reader.cancel(); reader.releaseLock();
    assert.equal((await f.call('/auth/logout', {})).status, 200); await ownEnd;
    await f.rebootstrap(); gate.release(); assert.equal((await final(f, run.runId)).run.outcome, 'complete'); assert.equal(f.captured.length, 1);
    assert.equal((await (await f.call(`/sessions/${c.sessionId}`)).json()).data.entries.length, 2);
  } finally { gate.release(); await f.close(); }
});

test('CONNECTED actual adapter failure, empty, truncated, deadline and explicit cancel are honest', async () => {
  for (const outcome of ['error', 'empty', 'truncated', 'deadline', 'cancelled']) {
    const gate = outcome === 'cancelled' ? deferredCredentials() : undefined;
    const f = await fixture(true, { ...(gate ? { credentials: gate.credentials } : {}), deadlineMs: 50,
      transport: async (_url, init) => {
        if (outcome === 'deadline') return new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
        return outcome === 'error' ? new Response('synthetic refusal', { status: 500 }) : sse(outcome === 'empty' ? '' : answer, outcome === 'truncated' ? 'MAX_TOKENS' : 'STOP');
      } });
    try {
      const c = await f.enroll(); const run = (await (await f.call('/chat', { sessionId: c.sessionId, text: 'Failure control.' })).json()).data;
      if (gate) { await gate.waiting; assert.equal((await f.call(`/chat/${run.runId}/cancel`, {})).status, 200); gate.release(); }
      const result = (await final(f, run.runId)).run; assert.equal(result.outcome, outcome); assert.equal(result.finalText, null);
      assert.equal((await (await f.call(`/sessions/${c.sessionId}`)).json()).data.entries.length, 1);
    } finally { gate?.release(); await f.close(); }
  }
});

test('CONNECTED actual in-flight host process crash recovers unknown with no provider retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-connected-crash-'));
  const child = fork(new URL('./connected-process.js', import.meta.url), [dir, webRoot, '0', 'hold'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  const phase = (name: string) => new Promise<Record<string, unknown>>((resolvePhase, reject) => {
    const listener = (value: unknown) => { if (value && typeof value === 'object' && 'phase' in value && value.phase === name) { child.off('message', listener); child.off('exit', exited); resolvePhase(value as Record<string, unknown>); } };
    const exited = () => { child.off('message', listener); reject(Error('Fixture exited before ' + name)); };
    child.on('message', listener); child.once('exit', exited);
  });
  try {
    const ready = await phase('ready'); const descriptor = ready.descriptor as { origin: string; authorityEpoch: string };
    const token = (await readFile(join(dir, 'admin-credential'), 'utf8')).trim();
    const call = (path: string, body: unknown, key: string) => fetch(descriptor.origin + '/api/v1' + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Didi-Authority-Epoch': descriptor.authorityEpoch, 'Idempotency-Key': key }, body: JSON.stringify(body) });
    const c = (await (await call('/conversations', { title: 'Crash proof', timeZone: 'UTC' }, 'enroll')).json()).data;
    const sent = phase('transport'); const run = (await (await call('/chat', { sessionId: c.sessionId, text: 'Interrupted in-flight.' }, 'turn')).json()).data;
    await sent; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    let retries = 0; host = await startHost({ dataDir: dir, webRoot, port: 0, modelTesting: { credentials: { resolve: async () => { retries++; return syntheticKey; } }, transport: async () => { retries++; return sse(); } } });
    const response = await fetch(host.descriptor.origin + `/api/v1/chat/${run.runId}`, { headers: { Authorization: `Bearer ${token}` } });
    const recovered = (await response.json()).data; assert.equal(recovered.outcome, 'outcome_unknown'); assert.equal(recovered.finalEntryId, null); assert.equal(recovered.mayHaveBeenSent, true);
    assert.equal(retries, 0); assert.equal((await readFile(join(dir, 'wire.jsonl'), 'utf8')).trim().split('\n').length, 1);
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } await host?.close(); await rm(dir, { recursive: true, force: true }); }
});
