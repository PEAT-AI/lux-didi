import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => null } });
const source = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
const api = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const envelope = (data: unknown, epoch = 'E1', status = 200) => new Response(JSON.stringify(status === 200 ? { data, authorityEpoch: epoch } : { error: { code: 'UNAUTHORIZED', message: 'synthetic unauthorized' } }), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('late old and new epoch responses cannot re-adopt authority after reset', async () => {
  for (const lateEpoch of ['E1', 'E2']) {
    api.clearAuthority();
    globalThis.fetch = async () => envelope({ csrfToken: 'csrf1' });
    await api.restoreSession();
    const held = deferred<Response>(); globalThis.fetch = async () => held.promise;
    const old = api.request('/sessions');
    globalThis.fetch = async () => envelope({}, 'E2');
    await assert.rejects(api.request('/status'), { code: 'AUTHORITY_CHANGED' });
    await api.restoreSession();
    held.resolve(envelope({ old: true }, lateEpoch));
    await assert.rejects(old, { code: 'AUTHORITY_CHANGED' });
  }
});

test('old 401 cannot invalidate recovered authority while current authenticated 401 invalidates once', async () => {
  api.clearAuthority(); let resets = 0; api.onAuthorityChanged(() => { resets++; });
  globalThis.fetch = async () => envelope({ csrfToken: 'csrf1' }); await api.restoreSession();
  const held = deferred<Response>(); globalThis.fetch = async () => held.promise; const old = api.request('/status');
  globalThis.fetch = async () => envelope({}, 'E2'); await assert.rejects(api.request('/status')); const afterReset = resets;
  globalThis.fetch = async () => envelope({ csrfToken: 'csrf2' }, 'E2'); await api.restoreSession();
  held.resolve(envelope({}, 'E1', 401)); await assert.rejects(old, { code: 'AUTHORITY_CHANGED' });
  assert.equal(resets, afterReset);
  globalThis.fetch = async () => envelope({}, 'E2', 401); await assert.rejects(api.request('/status'), { status: 401 });
  assert.equal(resets, afterReset + 1);
});

test('wrong pairing code 401 does not invalidate existing authenticated state', async () => {
  api.clearAuthority(); let resets = 0; api.onAuthorityChanged(() => { resets++; });
  globalThis.fetch = async () => envelope({ csrfToken: 'csrf1' }); await api.restoreSession();
  globalThis.fetch = async () => envelope({}, 'E1', 401); await assert.rejects(api.pair('wrong'), { status: 401 }); assert.equal(resets, 0);
  let headers: HeadersInit | undefined;
  globalThis.fetch = async (_url, init) => { headers = init?.headers; return envelope({}); };
  await api.request('/sessions', { method: 'POST', body: {} });
  assert.equal(new Headers(headers).get('X-Didi-CSRF'), 'csrf1');
});

test('request-owned key completion cannot remove a newer same-fingerprint key', async () => {
  api.clearAuthority(); globalThis.fetch = async () => envelope({ csrfToken: 'csrf1' }); await api.restoreSession();
  const held = deferred<Response>(); globalThis.fetch = async () => held.promise;
  const older = api.request('/sessions', { method: 'POST', body: {}, idempotencyKey: 'older' });
  let latestKey = '';
  globalThis.fetch = async (_url, init) => { latestKey = new Headers(init?.headers).get('Idempotency-Key')!; throw new Error('synthetic transport failure'); };
  await assert.rejects(api.request('/sessions', { method: 'POST', body: {}, idempotencyKey: 'newer' }));
  held.resolve(envelope({})); await older;
  await assert.rejects(api.request('/sessions', { method: 'POST', body: {} })); assert.equal(latestKey, 'newer');
});

test('authority reset aborts unsignalled local transport and lets existing queue advance', async () => {
  api.clearAuthority(); globalThis.fetch = async () => envelope({ csrfToken: 'csrf1' }); await api.restoreSession();
  const started = deferred<void>(); let aborted = false; let refuse!: (error: Error) => void;
  globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    refuse = reject; started.resolve(); init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('synthetic abort', 'AbortError')); }, { once: true });
  });
  const old = api.request('/conversation-selection', { method: 'POST', body: {} }); await started.promise;
  api.clearAuthority();
  const cancelledByLifetime = aborted; if (!aborted) refuse(new DOMException('fixture releases old transport', 'AbortError'));
  await assert.rejects(old, { code: 'AUTHORITY_CHANGED' }); assert.equal(cancelledByLifetime, true);
});
