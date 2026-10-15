import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the actual component with fake API/DOM boundaries, without a server or browser timer.
const source = readFileSync(new URL('../src/connected.ts', import.meta.url), 'utf8');
const moduleSource = ts.transpileModule(source.replace("import { ApiError, request, stream } from './api';", 'const { ApiError, request, stream } = globalThis.__connectedConsentApi;'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
let consent: unknown = null;
const panel = { innerHTML: '', querySelector() { return null; }, querySelectorAll() { return []; } };
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function install() {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById() { return panel; } } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem() { return JSON.stringify({ consent: true, remember: true, scope: 'standing' }); }, setItem() {} } });
  (globalThis as any).__connectedConsentApi = {
    ApiError: Error,
    async request(path: string) {
      if (path === '/status') return { ownerProfile: { displayName: 'Lux Didi' } };
      if (path === '/chat/status') return { status: 'configured', provider: 'server-provider', model: 'server-model', consent };
      if (path === '/sessions') return { items: [] };
      if (path === '/conversation-selection/clear') return {};
      throw new Error(`Unexpected API request ${path}`);
    },
    stream() { throw new Error('No stream expected for an empty history'); },
  };
}
function restore() {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete (globalThis as any).document;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else delete (globalThis as any).localStorage;
  delete (globalThis as any).__connectedConsentApi;
}

test('connected indicator and checkbox come from the server grant, not saved client flags', async () => {
  install();
  try {
    const { ConnectedView } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
    const view = new ConnectedView(() => {});
    consent = { sessionId: 'server-grant', provider: 'provider <X>', model: 'server-model', scope: 'standing', state: 'active' };
    await view.refresh('owner');
    assert.match(panel.innerHTML, /Connected as provider &lt;X&gt;, standing consent/);
    assert.match(panel.innerHTML, /id="connected-standing-revoke"/);
    assert.doesNotMatch(panel.innerHTML, /id="connected-consent"/);
    consent = null;
    await view.refresh('owner');
    assert.doesNotMatch(panel.innerHTML, /connected-consent-indicator/);
    assert.match(panel.innerHTML, /id="connected-consent"/);
    assert.match(panel.innerHTML, /id="connected-send"[^>]*disabled/);
  } finally { restore(); }
});
