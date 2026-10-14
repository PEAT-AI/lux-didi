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

test('only current STALE_AUTHORITY 409 resets; old stale and current CONFLICT do not', async () => {
  api.clearAuthority(); let resets = 0; api.onAuthorityChanged(() => { resets++; });
  globalThis.fetch = async () => envelope({ csrfToken: 'csrf1' }); await api.restoreSession();
  const held = deferred<Response>(); globalThis.fetch = async () => held.promise; const old = api.request('/status');
  const refusal = (code: string) => new Response(JSON.stringify({ error: { code, message: 'synthetic refusal' }, requestId: 'synthetic-id' }), { status: 409 });
  globalThis.fetch = async () => refusal('STALE_AUTHORITY');
  await assert.rejects(api.request('/sessions', { method: 'POST', body: {} }), { code: 'STALE_AUTHORITY' }); assert.equal(resets, 1);
  globalThis.fetch = async () => envelope({ csrfToken: 'csrf2' }, 'E2'); await api.restoreSession();
  held.resolve(refusal('STALE_AUTHORITY')); await assert.rejects(old, { code: 'AUTHORITY_CHANGED' }); assert.equal(resets, 1);
  globalThis.fetch = async () => refusal('CONFLICT'); await assert.rejects(api.request('/commitments/a'), { code: 'CONFLICT' }); assert.equal(resets, 1);
});

test('late pairing and session responses cannot publish old CSRF', async () => {
  for (const operation of [() => api.pair('synthetic'), () => api.restoreSession()]) {
    api.clearAuthority(); const held = deferred<Response>(); globalThis.fetch = async () => held.promise;
    const old = operation(); api.clearAuthority();
    globalThis.fetch = async () => envelope({ csrfToken: 'current' }, 'E2'); await api.restoreSession();
    held.resolve(envelope({ csrfToken: 'old' })); await assert.rejects(old, { code: 'AUTHORITY_CHANGED' });
    let csrf = ''; globalThis.fetch = async (_url, init) => { csrf = new Headers(init?.headers).get('X-Didi-CSRF')!; return envelope({}, 'E2'); };
    await api.request('/sessions', { method: 'POST', body: {} }); assert.equal(csrf, 'current');
  }
});

test('stream admission and buffered frames cannot publish after authority reset', async () => {
  api.clearAuthority(); globalThis.fetch = async () => envelope({ csrfToken: 'csrf1' }); await api.restoreSession();
  const held = deferred<Response>(); globalThis.fetch = async () => held.promise;
  let opens = 0, frames = 0;
  const old = api.stream('/chat/a/events', new AbortController().signal, () => { frames++; }, () => { opens++; });
  api.clearAuthority(); held.resolve(new Response('data: {"type":"snapshot"}\n\n'));
  await assert.rejects(old, { code: 'AUTHORITY_CHANGED' }); assert.equal(opens, 0); assert.equal(frames, 0);
  globalThis.fetch = async () => envelope({ csrfToken: 'csrf2' }, 'E2'); await api.restoreSession();
  globalThis.fetch = async () => new Response('data: {"type":"first"}\n\ndata: {"type":"late"}\n\n');
  const reading = api.stream('/chat/a/events', new AbortController().signal, () => { frames++; api.clearAuthority(); });
  await assert.rejects(reading, { code: 'AUTHORITY_CHANGED' }); assert.equal(frames, 1);
});

for (const phase of ['error-body', 'reader']) test(`lifetime abort during stream ${phase} stays an authority error`, async () => {
    api.clearAuthority(); globalThis.fetch = async () => envelope({ csrfToken: 'csrf1' }); await api.restoreSession();
    const entered = deferred<void>(); let refuse!: (error: Error) => void;
    globalThis.fetch = async (_url, init) => {
      init?.signal?.addEventListener('abort', () => refuse(new DOMException('synthetic lifetime abort', 'AbortError')), { once: true });
      if (phase === 'error-body') {
        const response = envelope({}, 'E1', 401);
        response.json = async () => new Promise((_resolve, reject) => { refuse = reject; entered.resolve(); });
        return response;
      }
      return new Response(new ReadableStream({ start(controller) { refuse = error => controller.error(error); }, pull() { entered.resolve(); } }, { highWaterMark: 0 }));
    };
    const old = api.stream('/chat/a/events', new AbortController().signal, () => { assert.fail('no old frame'); });
    await entered.promise; api.clearAuthority(); await assert.rejects(old, { code: 'AUTHORITY_CHANGED' });
});

test('current stream failure and caller cancellation keep their original semantics', async () => {
  api.clearAuthority(); let resets=0;api.onAuthorityChanged(()=>{resets++;});
  globalThis.fetch=async()=>envelope({csrfToken:'csrf1'});await api.restoreSession();
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:'SYNTHETIC_UNAVAILABLE',message:'unavailable'}}),{status:503});
  await assert.rejects(api.stream('/chat/a/events',new AbortController().signal,()=>{}),{code:'SYNTHETIC_UNAVAILABLE',status:503});
  const entered=deferred<void>(),caller=new AbortController();
  globalThis.fetch=async(_url,init)=>new Response(new ReadableStream({start(controller){init?.signal?.addEventListener('abort',()=>controller.error(new DOMException('caller abort','AbortError')),{once:true});},pull(){entered.resolve();}},{highWaterMark:0}));
  const pending=api.stream('/chat/a/events',caller.signal,()=>{assert.fail('no frame');});await entered.promise;caller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(resets,0);
});
