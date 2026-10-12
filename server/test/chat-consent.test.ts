import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture, result } from './chat-process.js';
import { ChatService, ChatError, chatMigrations, type EnrollInput } from '../chat/index.js';
import { listenService } from '../http/server.js';
import { Store } from '../runtime/store.js';
import type { ModelPort } from '../adapters/model/types.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'standing-consent-'));
  let calls = 0;
  const model: ModelPort = { async generate(request) { calls++; return result(request, 'complete'); } };
  const f = openFixture(dir, model);
  return { ...f, calls: () => calls, close() { f.store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function enroll(f: ReturnType<typeof fixture>, key: string, extra: Record<string, unknown> = {}) {
  return f.chat.enroll({ title: key, timeZone: 'UTC', idempotencyKey: key, consent: false, ...extra } as EnrollInput, f.context);
}
test('remember creates one full standing tuple and authorizes a new conversation without disclosure', async () => {
  const f = fixture();
  try {
    const first = enroll(f, 'first', { consent: true, remember: true });
    assert.equal((first as unknown as { scope: string }).scope, 'standing');
    const second = enroll(f, 'second');
    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal((second as unknown as { scope: string }).scope, 'standing');
    const rows = f.store.transaction(tx => tx.all("SELECT * FROM chat_consents WHERE scope='standing'"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.owner_assistant_id, f.context.assistantId);
    assert.equal(rows[0]!.provider, f.config.route.provider);
    assert.equal(rows[0]!.model, f.config.route.model);
    assert.equal(rows[0]!.revision, 1);
    assert.ok(rows[0]!.route_identity);
    assert.deepEqual(JSON.parse(String(rows[0]!.permitted_classes)), f.config.route.allowedClasses);
    const run = f.chat.accept({ sessionId: second.sessionId, text: 'Hello', idempotencyKey: 'run' }, f.context);
    for await (const event of f.chat.subscribe(run.runId, f.context)) if (event.type === 'snapshot' && event.run.state === 'terminal') break;
    assert.equal(f.calls(), 1);
  } finally { f.close(); }
});
test('standing consent never crosses route or model boundaries, and does not dispatch', () => {
  const f = fixture();
  try {
    const first = enroll(f, 'first', { consent: true, remember: true });
    for (const route of [{ ...f.config.route, allowedClasses: ['ordinary'] as const }, { ...f.config.route, keyReference: 'private-route' }, { ...f.config.route, model: 'other-model' }]) {
      const chat = new ChatService({ ...f.config, route }); chat.recover(f.recoveryContext);
      assert.throws(() => chat.enroll({ title: 'other', timeZone: 'UTC', idempotencyKey: 'other', consent: false } as EnrollInput, f.context), ChatError);
      assert.throws(() => chat.accept({ sessionId: first.sessionId, text: 'Hello', idempotencyKey: 'blocked' }, f.context), ChatError);
    }
    assert.equal(f.calls(), 0);
  } finally { f.close(); }
});
test('revocation and disclosure revision invalidate standing grants but preserve conversation grants', () => {
  const f = fixture();
  try {
    const ordinary = enroll(f, 'ordinary', { consent: true });
    const standing = enroll(f, 'remember', { consent: true, remember: true });
    f.store.transaction(tx => tx.run("UPDATE chat_consents SET revision=2 WHERE scope='standing'"));
    assert.throws(() => enroll(f, 'revision'), ChatError);
    f.store.transaction(tx => tx.run("UPDATE chat_consents SET revision=1 WHERE scope='standing'"));
    f.chat.revoke(standing.sessionId, f.context);
    assert.throws(() => enroll(f, 'revoked'), ChatError);
    assert.equal(f.chat.conversation(ordinary.sessionId, f.context).state, 'active');
  } finally { f.close(); }
});

test('populated v4 consent table upgrades additively, defaulting existing rows to conversation', () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'consent-upgrade-'));
  let legacy: Store | undefined;
  try {
    legacy = new Store(dir, [...f.domain.migrations, ...chatMigrations.filter(m => m.version <= 4)]);
    const context = { ...f.context, assistantId: legacy.assistantId, authorityEpoch: legacy.authorityEpoch };
    const session = legacy.transaction(tx => f.domain.execute(tx, 'createSession', { title: 'legacy', timeZone: 'UTC' }, context, { writer: 'capture', dataClass: 'private' }));
    legacy.transaction(tx => tx.run(`INSERT INTO chat_consents VALUES (?,?,?,?,?,1,?,?,NULL,?,?)`, [session.id, context.assistantId, 'synthetic', 'counting', 'legacy-route', '["ordinary"]', context.now, 'legacy', 'fingerprint']));
    legacy.close();
    legacy = new Store(dir, [...f.domain.migrations, ...chatMigrations]);
    const rows = legacy.transaction(tx => tx.all('SELECT * FROM chat_consents'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.session_id, session.id);
    assert.equal(rows[0]!.scope, 'conversation');
    assert.equal(rows[0]!.route_identity, 'legacy-route');
    assert.equal(rows[0]!.revoked_at, null);
    legacy.close(); legacy = undefined;
    legacy = new Store(dir, [...f.domain.migrations, ...chatMigrations]);
    assert.equal(legacy.transaction(tx => tx.all('SELECT * FROM chat_consents')).length, 1);
  } finally { legacy?.close(); f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('real HTTP enrollment requires disclosure, returns standing scope and observes revocation', async () => {
  const f = fixture();
  const service = await listenService({ store: f.store, domain: f.domain, chat: f.chat, modelStatus: { status: 'configured', provider: 'gemini', model: 'counting' }, port: 0 });
  try {
    const bootstrap = await fetch(`${service.origin}/api/v1/auth/pairing`, { method: 'POST', headers: { Authorization: `Bearer ${f.store.adminCredential}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(bootstrap.status, 200);
    const pairingCode = (await bootstrap.json()).data.pairingCode;
    const paired = await fetch(`${service.origin}/api/v1/auth/pair`, { method: 'POST', headers: { Origin: service.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode }) });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie')!.split(';')[0]!;
    const auth = (await paired.json()).data;
    const headers = { Cookie: cookie, Origin: service.origin, 'Content-Type': 'application/json', 'X-Didi-CSRF': auth.csrfToken, 'X-Didi-Authority-Epoch': auth.authorityEpoch };
    async function enrollHTTP(key: string, extra: Record<string, unknown> = {}) {
      return fetch(`${service.origin}/api/v1/conversations`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify({ title: key, timeZone: 'UTC', ...extra }) });
    }
    const denied = await enrollHTTP('missing'); assert.notEqual(denied.status, 200);
    const malformed = await enrollHTTP('malformed', { consent: 'true', remember: true }); assert.equal(malformed.status, 400);
    assert.equal(f.calls(), 0);
    const first = await enrollHTTP('remember-http', { consent: true, remember: true }); assert.equal(first.status, 200);
    const grant = (await first.json()).data; assert.equal(grant.scope, 'standing');
    const status = await fetch(`${service.origin}/api/v1/chat/status`, { headers: { Cookie: cookie } });
    assert.equal((await status.json()).data.consent.scope, 'standing');
    const second = await enrollHTTP('without-flag'); assert.equal(second.status, 200);
    const effective = (await second.json()).data; assert.equal(effective.scope, 'standing');
    assert.notEqual(effective.sessionId, grant.sessionId);
    const revoked = await fetch(`${service.origin}/api/v1/conversations/${grant.sessionId}/revoke`, { method: 'POST', headers, body: '{}' }); assert.equal(revoked.status, 200);
    assert.notEqual((await enrollHTTP('after-revoke')).status, 200);
    const after = await fetch(`${service.origin}/api/v1/chat/status`, { headers: { Cookie: cookie } });
    assert.equal((await after.json()).data.consent, null);
  } finally { await service.close(); f.close(); }
});
