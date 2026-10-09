import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { startHost, pairLocal } from '../host/runtime.js';
import { createDomainPort } from '../domain/index.js';
import { Outbox } from '../runtime/outbox.js';
import type { Credentials, Transport } from '../adapters/model/types.js';

const webRoot = resolve(import.meta.dirname, '../../../web/dist');
const syntheticKey = 'connected-synthetic-not-a-real-key';
const answer = 'Naya: Let us choose one small next step and keep the rest for later.';
export async function profile(dir: string, model = 'connected-test-model', classes = ['ordinary', 'private']) {
  const configDir = join(dir, 'provider-config');
  await mkdir(configDir, { mode: 0o700 });
  await writeFile(join(configDir, 'profile.json'), JSON.stringify({ schemaVersion: 1, enabled: true, provider: 'gemini', modelId: model, keyReference: 'gemini-primary', dataClasses: classes,
    preferences: { dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'off', verbosity: 'balanced' } }), { mode: 0o600 });
  await writeFile(join(configDir, 'gemini-primary.json'), JSON.stringify({ schemaVersion: 1, keyReference: 'gemini-primary', key: syntheticKey }), { mode: 0o600 });
  return configDir;
}
export function sse(text = answer, finish = 'STOP') {
  const frames = `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: text.slice(0, 25) }] } }] })}\n\ndata: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: text.slice(25) }] }, finishReason: finish }] })}\n\n`;
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    const bytes = new TextEncoder().encode(frames); for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(configured = true, options: { credentials?: Credentials; transport?: Transport; now?: () => number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'didi-connected-'));
  if (configured) await profile(dir);
  const captured: { url: string; init: RequestInit }[] = [];
  let credentialCalls = 0;
  const config = { dataDir: dir, webRoot, port: 0, now: options.now,
    modelTesting: { credentials: options.credentials ?? { resolve: async () => { credentialCalls++; return syntheticKey; } }, transport: options.transport ?? (async (url: string, init: RequestInit) => { captured.push({ url, init }); return sse(); }) } };
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
    const status = (await (await f.call('/chat/status')).json()).data; assert.deepEqual(status, { status: 'configured', provider: 'gemini', model: 'connected-test-model' });
    const local = (await (await f.call('/sessions', { title: 'EXCLUDED_OTHER_SESSION_CANARY', timeZone: 'UTC' }, 'local')).json()).data;
    await f.call(`/sessions/${local.id}/entries`, { text: 'EXCLUDED_LOCAL_NOTE_CANARY', timeZone: 'UTC' }, 'local-entry');
    await f.call('/commitments', { title: 'EXCLUDED_TODAY_CANARY', dueAt: null, timeZone: 'UTC' }, 'local-commitment');
    const enrolled = await f.enroll();
    const replayEnrollment = await f.enroll(); assert.equal(replayEnrollment.sessionId, enrolled.sessionId);
    const domain = createDomainPort({ outbox: Outbox });
    assert.deepEqual(f.host.store.transaction(tx => domain.getRoutingLabel(tx, { kind: 'session', id: enrolled.sessionId })).dataClass, 'private');
    const accepted = await f.call('/chat', { sessionId: enrolled.sessionId, text: 'Help me choose one small next step.' }, 'first-turn'); assert.equal(accepted.status, 200, await accepted.clone().text());
    const first = (await accepted.json()).data; const completed = await final(f, first.runId);
    assert.equal(completed.run.outcome, 'complete'); assert.equal(completed.run.finalText, answer); assert.match(completed.text, /provisional/);
    assert.equal(f.captured.length, 1); assert.equal(f.credentialCalls, 1);
    assert.match(f.captured[0]!.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/connected-test-model:streamGenerateContent\?alt=sse$/);
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
    await f.restart('connected-new-model');
    assert.equal((await (await f.call(`/conversations/${enrolled.sessionId}`)).json()).data.state, 'route_changed');
    const count = f.credentialCalls;
    assert.equal((await f.call('/chat', { sessionId: enrolled.sessionId, text: 'must not capture' }, 'changed-route')).status, 409);
    assert.equal(f.credentialCalls, count); assert.equal(f.captured.length, 2);
    const newConversation = await f.enroll('new-route');
    const third = (await (await f.call('/chat', { sessionId: newConversation.sessionId, text: 'New explicit route.' }, 'new-turn')).json()).data;
    assert.equal((await final(f, third.runId)).run.outcome, 'complete'); assert.match(f.captured[2]!.url, /connected-new-model/);
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
    const c = await f.enroll(); const legacy = await f.call(`/sessions/${c.sessionId}/entries`, { text: 'UNLABELED_LEGACY', timeZone: 'UTC' }, 'legacy'); assert.equal(legacy.status, 200);
    const before = (await (await f.call(`/sessions/${c.sessionId}`)).json()).data.entries.length;
    assert.equal((await f.call('/chat', { sessionId: c.sessionId, text: 'Never send unknown history.' })).status, 503);
    assert.equal((await (await f.call(`/sessions/${c.sessionId}`)).json()).data.entries.length, before); assert.equal(f.captured.length, 0); assert.equal(f.credentialCalls, 0);
  } finally { await f.close(); }
});
