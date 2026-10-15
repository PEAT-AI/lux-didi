import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

const compile = (source: string) => 'data:text/javascript;base64,' + Buffer.from(transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText).toString('base64');
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
class Control {
  listeners = new Map<string, (event: any) => void>();
  addEventListener(kind: string, action: (event: any) => void) { this.listeners.set(kind, action); }
  fire(kind: string, target: any = {}, extra: any = {}) { this.listeners.get(kind)?.({ target, preventDefault() {}, ...extra }); }
}
class Panel {
  html = ''; controls = new Map<string, Control>();
  set innerHTML(value: string) { this.html = value; this.controls.clear(); }
  querySelector(id: string) { if (!this.controls.has(id)) this.controls.set(id, new Control()); return this.controls.get(id)!; }
  querySelectorAll() { return []; }
}
let panel = new Panel();
Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => null, getElementById: () => panel } });
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
const apiURL = compile(readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'));
const markdownURL = compile(readFileSync(new URL('../src/markdown.ts', import.meta.url), 'utf8'));
const api = await import(apiURL);
const connectedSource = readFileSync(process.env.CONNECTED_SOURCE_PATH ?? new URL('../src/connected.ts', import.meta.url), 'utf8').replace("from './api'", `from '${apiURL}'`).replace("from './markdown.ts'", `from '${markdownURL}'`);
const { ConnectedView } = await import(compile(connectedSource));
const conversation = (sessionId = 'S1') => ({ sessionId, scope: 'conversation', provider: 'synthetic', model: 'fixture', state: 'active', revision: 1, permittedClasses: ['private'], latestRunId: null });
const envelope = (data: unknown) => new Response(JSON.stringify({ authorityEpoch: 'E1', data }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
let routes: (path: string, init: RequestInit | undefined) => Promise<Response | undefined>;
let calls: string[];
async function setup(saved?: unknown) {
  panel = new Panel(); storage.clear(); calls = []; api.clearAuthority(); api.onAuthorityChanged(() => {});
  if (saved) storage.set('didi-connected:O1', JSON.stringify(saved));
  routes = async () => undefined;
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace('/api/v1', ''); calls.push(path);
    const custom = await routes(path, init); if (custom) return custom;
    if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    if (path === '/auth/session') return envelope({ csrfToken: 'synthetic' });
    if (path === '/status') return envelope({ assistantId: 'O1', ownerProfile: { displayName: 'Fixture' } });
    if (path === '/chat/status') return envelope({ status: 'configured', provider: 'synthetic', model: 'fixture' });
    if (path === '/sessions') return envelope({ items: [{ id: 'S1', title: 'Current history' }] });
    if (path.startsWith('/conversations/')) return envelope(conversation(path.split('/')[2]));
    if (path.startsWith('/sessions/')) return envelope({ entries: [] });
    return envelope({});
  };
  await api.restoreSession(); return new ConnectedView(() => {});
}

test('refresh reset rejects old values before selecting or publishing', async () => {
  const view = await setup(), held = deferred<Response>(), entered = deferred<void>();
  routes = async path => { if (path === '/chat/status') { entered.resolve(); return held.promise; } };
  const refresh = view.refresh('O1'); await entered.promise; view.reset();
  held.resolve(envelope({ status: 'configured', provider: 'OLD', model: 'OLD' })); await refresh;
  view.attach(); assert.doesNotMatch(panel.html, /OLD|Current history/);
  assert.equal(calls.includes('/conversation-selection'), false);
});

test('fresh refresh can hand lifecycle to select and preserves current typed text', async () => {
  const view = await setup({ sessionId: 'S1', draft: 'saved' }); await view.refresh('O1');
  assert.match(panel.html, /connected-send-form/);
  const held = deferred<Response>(), entered = deferred<void>();
  routes = async path => { if (path === '/chat/status') { entered.resolve(); return held.promise; } };
  const refresh = view.refresh('O1'); await entered.promise;
  panel.querySelector('#connected-draft').fire('input', { value: 'typed during refresh' });
  held.resolve(envelope({ status: 'configured', provider: 'synthetic', model: 'fixture' })); await refresh;
  assert.match(panel.html, /typed during refresh/); view.reset();
});

test('reset clears visible busy/error and late note completion cannot repopulate it', async () => {
  const view = await setup(); await view.refresh('O1');
  const held = deferred<Response>(), entered = deferred<void>();
  routes = async path => { if (path.startsWith('/recall?')) { entered.resolve(); return held.promise; } };
  panel.querySelector('#connected-notes-search').fire('submit'); await entered.promise;
  view.reset(); view.attach(); held.resolve(envelope({ hits: [{ entryId: 'OLD', snippet: 'OLD NOTE' }] })); await tick(); await tick();
  assert.doesNotMatch(panel.html, /OLD NOTE|OLD|configured: synthetic/);
  assert.equal(view.active, false);
});

test('pending selected-memory mismatch preserves key and refuses a new turn', async () => {
  const pending = { key: 'retained-key', text: 'pending turn', sessionId: 'S1', selectedMemoryEntryIds: ['note1'] };
  const view = await setup({ sessionId: 'S1', draft: 'pending turn', pending }); await view.refresh('O1');
  panel.querySelector('#connected-send-form').fire('submit'); await tick(); await tick();
  assert.equal(calls.includes('/chat'), false);
  assert.equal(JSON.parse(storage.get('didi-connected:O1')!).pending.key, 'retained-key');
  assert.match(panel.html, /Recover saved history|recover history/i); view.reset();
});

test('restoration requires fresh status owner and a current valid saved conversation', async () => {
  const view = await setup({ sessionId: 'FOREIGN', draft: 'secret draft', pending: { key: 'secret', text: 'secret draft', sessionId: 'FOREIGN' } });
  await view.refresh('O1'); assert.doesNotMatch(panel.html, /secret draft/); view.reset();
  const wrong = await setup({ sessionId: 'S1', draft: 'wrong owner' });
  routes = async path => path === '/status' ? envelope({ assistantId: 'OTHER', ownerProfile: { displayName: 'Other' } }) : undefined;
  await wrong.refresh('O1'); assert.doesNotMatch(panel.html, /wrong owner|Talk with Other/); wrong.reset();
});

test('select reset between snapshots issues no secondary read and publishes no stale projection', async () => {
  const view = await setup(); await view.refresh('O1'); const before = calls.length;
  const held = deferred<Response>(), entered = deferred<void>();
  routes = async path => { if (path === '/conversations/S2') { entered.resolve(); return held.promise; } };
  const selection = view.select('S2'); await entered.promise; view.reset(); held.resolve(envelope(conversation('S2'))); await selection;
  assert.equal(calls.slice(before).includes('/sessions/S2'), false); view.attach(); assert.doesNotMatch(panel.html, /S2/);
});

test('old send completion cannot overwrite a reset instance or persist old pending evidence under another owner', async () => {
  const view = await setup(); await view.refresh('O1');
  panel.querySelector('#connected-draft').fire('input', { value: 'old turn' });
  const held = deferred<Response>(), entered = deferred<void>();
  routes = async path => { if (path === '/chat') { entered.resolve(); return held.promise; } };
  panel.querySelector('#connected-send-form').fire('submit'); await entered.promise; view.reset();
  routes = async () => undefined; await view.refresh('O1');
  held.resolve(envelope({ runId: 'OLD', sessionId: 'S1', state: 'terminal', outcome: 'complete', finalEntryId: null, sequence: 1 })); await tick(); await tick();
  view.attach(); assert.equal(view.active, false); assert.doesNotMatch(panel.html, /data-run-id="OLD"/);
  assert.equal(JSON.parse(storage.get('didi-connected:O1')!).pending.text, 'old turn');
});


test('one FIFO queue aborts active old work, skips queued old work and admits fresh selection', async () => {
  const view = await setup(); await view.refresh('O1');
  const entered = deferred<void>(); let aborted = false;
  routes = async (path, init) => {
    if (path === '/conversation-selection/clear') return new Promise((_resolve, reject) => {
      entered.resolve(); init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('synthetic local abort', 'AbortError')); }, { once: true });
    });
  };
  const first = view.clearSelection(); await entered.promise;
  const queued = view.clearSelection(); view.reset();
  const didAbort = aborted;
  if (!didAbort) return assert.fail('reset must cancel the exact active local queue transport');
  routes = async () => undefined;
  await Promise.all([first, queued]); await view.refresh('O1');
  assert.equal(calls.filter(path => path === '/conversation-selection/clear').length, 1);
  assert.equal(calls.filter(path => path === '/conversation-selection').length, 2); view.reset();
});

test('intentional action-select handoff stays busy and current select failures remain visible', async () => {
  const view = await setup(); await view.refresh('O1');
  const held = deferred<Response>(), entered = deferred<void>();
  routes = async path => { if (path === '/conversations/S1') { entered.resolve(); return held.promise; } };
  void view.recoverHistory(); await entered.promise;
  assert.equal(view.active, true); const reads = calls.length;
  void view.recoverHistory(); await tick(); assert.equal(calls.length, reads);
  held.resolve(new Response(JSON.stringify({ error: { code: 'CONFLICT', message: 'current select failure' } }), { status: 409 })); await tick(); await tick();
  assert.match(panel.html, /current select failure/); assert.equal(view.active, false); view.reset();
});

test('external entries completion cannot overwrite fresh recovered history', async () => {
  const view = await setup(); let events!: ReadableStreamDefaultController<Uint8Array>;
  routes = async (path, init) => path === '/conversations/S1/events' ? new Response(new ReadableStream({ start(controller) { events = controller; init?.signal?.addEventListener('abort', () => controller.close(), { once: true }); } })) : undefined;
  await view.refresh('O1'); const held = deferred<Response>(), entered = deferred<void>();
  routes = async path => {
    if (path === '/chat/external') return envelope({ runId: 'external', sessionId: 'S1', state: 'terminal', partialText: '' });
    if (path === '/sessions/S1') { entered.resolve(); return held.promise; }
  };
  events.enqueue(new TextEncoder().encode('data: {"type":"run","sessionId":"S1","runId":"external"}\n\n')); await entered.promise;
  view.reset(); routes = async () => undefined; const recovered = view.refresh('O1'); await tick(); await tick();
  held.resolve(envelope({ entries: [{ id: 'OLD', role: 'user', text: 'OLD EXTERNAL HISTORY' }] })); await recovered; await tick(); await tick();
  view.attach(); assert.doesNotMatch(panel.html, /OLD EXTERNAL HISTORY/); view.reset();
});

test('watch terminal snapshot reset cannot issue stale entries read or overwrite recovered state', async () => {
  const view = await setup(); let chatReads = 0; const held = deferred<Response>(), entered = deferred<void>();
  routes = async path => {
    if (path === '/conversations/S1') return envelope({ ...conversation(), latestRunId: 'run1' });
    if (path === '/chat/run1/events') return new Response('');
    if (path === '/chat/run1') {
      if (++chatReads > 1) { entered.resolve(); return held.promise; }
      return envelope({ runId: 'run1', sessionId: 'S1', state: 'accepted', partialText: '', finalEntryId: null, sequence: 0 });
    }
  };
  await view.refresh('O1'); await entered.promise;
  view.reset(); routes = async () => undefined; await view.refresh('O1');
  const count = calls.filter(path => path === '/sessions/S1').length;
  held.resolve(envelope({ runId: 'run1', sessionId: 'S1', state: 'terminal', partialText: 'OLD WATCH', finalEntryId: null, sequence: 1 })); await tick(); await tick();
  assert.equal(calls.filter(path => path === '/sessions/S1').length, count); view.attach(); assert.doesNotMatch(panel.html, /OLD WATCH/);
});

test('selecting another history preserves unresolved pending recovery session and key', async () => {
  const pending = { key: 'retained-key', text: 'pending turn', sessionId: 'S1', selectedMemoryEntryIds: ['note1'] };
  const view = await setup({ sessionId: 'S1', draft: 'pending turn', pending }); await view.refresh('O1');
  await view.select('S2'); const saved = JSON.parse(storage.get('didi-connected:O1')!);
  assert.equal(saved.sessionId, 'S1'); assert.deepEqual(saved.pending, pending); view.reset();
  assert.deepEqual(JSON.parse(storage.get('didi-connected:O1')!).pending, pending);
});


test('refresh handoff reports a current selection failure and reset recovery restores only same owner', async () => {
  const view = await setup({ sessionId: 'S1', draft: 'same owner saved text' });
  routes = async path => path === '/sessions/S1' ? new Response(JSON.stringify({ error: { code: 'CONFLICT', message: 'current history failure' } }), { status: 409 }) : undefined;
  await view.refresh('O1'); assert.match(panel.html, /current history failure/);
  view.reset(); routes = async () => undefined; await view.refresh('O1'); assert.match(panel.html, /same owner saved text/);
  view.reset();
  routes = async path => path === '/status' ? envelope({ assistantId: 'O2', ownerProfile: { displayName: 'Second owner' } }) : undefined;
  await view.refresh('O2'); assert.doesNotMatch(panel.html, /same owner saved text/); assert.match(panel.html, /Second owner/); view.reset();
});


test('run-watch handoff retains the separate conversation subscription for later external runs', async () => {
  const view = await setup(); let events!: ReadableStreamDefaultController<Uint8Array>, subscriptionSignal!: AbortSignal;
  let reads = 0;
  routes = async (path, init) => {
    if (path === '/conversations/S1/events') {
      subscriptionSignal = init!.signal!;
      return new Response(new ReadableStream({ start(controller) { events = controller; subscriptionSignal.addEventListener('abort', () => controller.close(), { once: true }); } }));
    }
    if (path === '/conversations/S1') return envelope({ ...conversation(), latestRunId: 'run1' });
    if (path === '/chat/run1/events') return new Response('');
    if (path === '/chat/run1') return envelope({ runId: 'run1', sessionId: 'S1', state: ++reads === 1 ? 'accepted' : 'terminal', outcome: 'complete', partialText: '', finalEntryId: null, sequence: 1 });
    if (path === '/chat/external') return envelope({ runId: 'external', sessionId: 'S1', state: 'terminal', outcome: 'complete', partialText: '', finalEntryId: null, sequence: 1 });
  };
  await view.refresh('O1'); await tick(); await tick(); assert.equal(subscriptionSignal.aborted, false);
  events.enqueue(new TextEncoder().encode('data: {"type":"run","sessionId":"S1","runId":"external"}\n\n'));
  await tick(); await tick(); assert.match(panel.html, /data-run-id="external"/); view.reset(); assert.equal(subscriptionSignal.aborted, true);
});


test('missing or mismatched saved pending context preserves exact storage and refuses automatic selection', async () => {
  for (const savedSession of ['MISSING', 'S1']) {
    const pending = { key: 'unknown-key', text: 'unresolved turn', sessionId: 'MISSING', selectedMemoryEntryIds: ['note1'] };
    const view = await setup({ sessionId: savedSession, draft: 'unresolved turn', pending });
    const before = storage.get('didi-connected:O1');
    await view.refresh('O1');
    assert.equal(storage.get('didi-connected:O1'), before);
    assert.equal(calls.includes('/conversation-selection'), false);
    assert.equal(calls.includes('/chat'), false);
    assert.match(panel.html, /recover.*history|history.*recover/i);
    panel.querySelector('#connected-consent').fire('change', { checked: true });
    panel.querySelector('#connected-send-form').fire('submit'); await tick(); await tick();
    assert.equal(calls.includes('/conversations'), false);
    assert.equal(storage.get('didi-connected:O1'), before); view.reset();
  }
});

test('an unresolved turn whose conversation is missing offers an exact-key recovery action', async () => {
  const pending = { key: 'retained-key', text: 'unresolved turn', sessionId: 'MISSING', selectedMemoryEntryIds: ['note1'] };
  const view = await setup({ sessionId: 'MISSING', draft: 'unresolved turn', pending });
  const before = storage.get('didi-connected:O1');
  await view.refresh('O1');
  assert.equal(storage.get('didi-connected:O1'), before);
  assert.equal(calls.includes('/conversation-selection'), false);
  assert.match(panel.html, /id="connected-retry"/);
  let chat: RequestInit | undefined;
  routes = async (path, init) => {
    if (path !== '/chat') return undefined;
    chat = init;
    return envelope({ runId: 'recovered', sessionId: 'MISSING', state: 'terminal', outcome: 'complete', finalEntryId: null, partialText: '', sequence: 1 });
  };
  panel.querySelector('#connected-retry').fire('click'); await tick(); await tick(); await tick();
  assert.equal(calls.filter(path => path === '/chat').length, 1);
  assert.equal((chat!.headers as Record<string, string>)['Idempotency-Key'], 'retained-key');
  assert.equal(JSON.parse(storage.get('didi-connected:O1')!).pending, undefined);
  assert.equal(JSON.parse(storage.get('didi-connected:O1')!).sessionId, 'MISSING');
  view.reset();
});

test('a later list refresh that contains the missing conversation reconciles the unresolved turn', async () => {
  const pending = { key: 'retained-key', text: 'unresolved turn', sessionId: 'MISSING', selectedMemoryEntryIds: ['note1'] };
  const view = await setup({ sessionId: 'MISSING', draft: 'unresolved turn', pending });
  await view.refresh('O1');
  assert.match(panel.html, /id="connected-recovery"/);
  routes = async path => path === '/sessions' ? envelope({ items: [{ id: 'MISSING', title: 'Recovered history' }] }) : undefined;
  await view.refresh('O1');
  assert.equal(calls.includes('/sessions/MISSING'), true);
  assert.match(panel.html, /Recovered history/);
  assert.match(panel.html, /connected-send-form/);
  assert.doesNotMatch(panel.html, /id="connected-recovery"/);
  assert.equal(JSON.parse(storage.get('didi-connected:O1')!).pending.sessionId, 'MISSING');
  view.reset();
});

test('a definitively refused send clears the pending key and leaves the composer usable', async () => {
  const view = await setup({ sessionId: 'S1', draft: 'refused turn' }); await view.refresh('O1');
  routes = async path => path === '/chat'
    ? new Response(JSON.stringify({ error: { code: 'CONSENT_REVOKED', message: 'This conversation is no longer consented.' } }), { status: 403 })
    : undefined;
  panel.querySelector('#connected-draft').fire('input', { value: 'refused turn' });
  panel.querySelector('#connected-send-form').fire('submit'); await tick(); await tick(); await tick();
  assert.equal(calls.includes('/chat'), true);
  assert.match(panel.html, /This conversation is no longer consented/);
  assert.equal(JSON.parse(storage.get('didi-connected:O1')!).pending, undefined, 'a definitive refusal must not retain the acceptance key');
  panel.querySelector('#connected-consent').fire('change', { checked: true });
  const reads = calls.length;
  panel.querySelector('#connected-send-form').fire('submit'); await tick(); await tick();
  assert.equal(calls.slice(reads).includes('/chat'), true, 'the composer stays usable after a definitive refusal');
  view.reset();
});

test('Enter sends and Shift+Enter keeps a newline in the connected composer', async () => {
  const view = await setup({ sessionId: 'S1', draft: 'typed turn' }); await view.refresh('O1');
  panel.querySelector('#connected-draft').fire('keydown', { value: 'typed turn' }, { key: 'Enter', shiftKey: true, isComposing: false });
  await tick(); await tick();
  assert.equal(calls.includes('/chat'), false, 'Shift+Enter must not send');
  panel.querySelector('#connected-draft').fire('keydown', { value: 'typed turn' }, { key: 'Enter', shiftKey: false, isComposing: false });
  await tick(); await tick();
  assert.equal(calls.includes('/chat'), true, 'Enter sends the frozen turn');
  panel.querySelector('#connected-draft').fire('keydown', { value: 'typed turn' }, { key: 'Enter', shiftKey: false, isComposing: true });
  await tick(); await tick();
  assert.equal(calls.filter(path => path === '/chat').length, 1, 'an IME composition Enter must not send');
  view.reset();
});
