import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createSourceFile, ScriptTarget, SyntaxKind, transpileModule, ModuleKind } from 'typescript';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
const parsed = createSourceFile('main.ts', main, ScriptTarget.Latest, true);
const functions = parsed.statements.filter(node => node.kind === SyntaxKind.FunctionDeclaration).map(node => node.getText(parsed));
const reset = parsed.statements.find(node => node.kind === SyntaxKind.ExpressionStatement && node.getText(parsed).startsWith('onAuthorityChanged('))!.getText(parsed);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function compile(source: string, module = ModuleKind.ESNext) { return transpileModule(source, { compilerOptions: { module, target: ScriptTarget.ES2022 } }).outputText; }

// This DOM seam models root replacement and required validation; real browser proof is separate.
function fixture() {
  let generation = 0, validationBlocks = 0;
  const fields = new Map<string, any>();
  const document: any = { hidden: false, activeElement: null, querySelector: () => null, getElementById: (id: string) => fields.get(id) ?? null };
  class Control {
    value = ''; disabled = false; required = false; selectionStart = null; selectionEnd = null;
    type = 'text'; tagName = 'BUTTON'; listeners = new Map<string, (event: any) => void>();
    id: string; generation: number;
    constructor(id: string, generation: number) { this.id=id; this.generation=generation; }
    addEventListener(kind: string, fn: (event: any) => void) { this.listeners.set(kind, fn); }
    focus() { document.activeElement = this; }
    fire(kind: string) { this.listeners.get(kind)?.({ target: this, preventDefault() {} }); }
    requestSubmit() {
      const input = fields.get('pair-code');
      if (input.required && !input.value) { validationBlocks++; input.focus(); return; }
      if (!fields.get('pair-submit').disabled) this.fire('submit');
    }
  }
  const root = {
    html: '',
    set innerHTML(value: string) {
      this.html = value; fields.clear(); generation++;
      for (const match of value.matchAll(/<(input|form|button|span)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const field = new Control(match[2], generation); field.tagName = match[1].toUpperCase();
        field.disabled = /\bdisabled\b/.test(match[0]); field.required = /\brequired\b/.test(match[0]);
        field.type = /\btype="([^"]+)"/.exec(match[0])?.[1] ?? 'text';
        fields.set(field.id, field);
      }
      const button = /<form id="pair-form">[\s\S]*?<button([^>]*)>Pair this browser<\/button>/.exec(value);
      if (button) { const submit = new Control('pair-submit', generation); submit.disabled = /\bdisabled\b/.test(button[1]); fields.set(submit.id, submit); }
    },
    querySelectorAll: () => [],
  };
  const calls: { path: string; method: string; signal?: AbortSignal | null }[] = [];
  const held = deferred<Response>(), entered = deferred<void>();
  let holding = false;
  const context: any = {
    exports: {}, AbortController, AbortSignal, DOMException, Response, crypto: globalThis.crypto,
    document, navigator: { onLine: true },
    fetch: async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace('/api/v1', ''); calls.push({ path, method: init.method ?? 'GET', signal: init.signal });
      if (holding && path === '/status') { entered.resolve(); return held.promise; }
      if (path === '/auth/session') return new Response(JSON.stringify({ authorityEpoch: 'E1', data: { csrfToken: 'synthetic-csrf' } }));
      throw new Error('unexpected synthetic route');
    },
    root, tabs: ['Conversation','Today','Memory','Settings'], zone: 'UTC', tab: 'Conversation',
    connectedView: { active: false, attach() {}, reset() {}, async refresh() {} },
    attachMemoryDeleteControls() {},
    e: (value: unknown) => String(value ?? ''), disabled: (value: boolean) => value ? 'disabled' : '',
    orb: undefined, status: undefined, connection: 'Pair this browser', pairingRequired: true,
    sessions: [], entries: [], recent: [], session: undefined, plan: undefined, recall: undefined,
    detail: undefined, editing: undefined, editTitle: '', editNotes: '', editDue: '',
    messageDraft: '', titleDraft: '', queryDraft: '', memoryFilter: '', draftOwner: undefined,
    notice: '', error: '', busy: false, readBusy: false, pairingBusy: false, controller: undefined,
    readGeneration: 0, connectionsBusy: false, liveBusy: false, connections: [], connectionsStale: false,
    live: undefined, livePoll: {}, paintedLivePoll: undefined, statusUnavailable: false,
    pollTimer: undefined, liveTimer: undefined, connectionsTimer: undefined, backoff: 30000,
    sessionMore: false, entriesMore: false,
    clearTimeout() {}, setTimeout() { throw new Error('unauthenticated reset must not schedule recovery'); },
  };
  createContext(context); runInContext(compile(api, ModuleKind.CommonJS), context);
  Object.assign(context, context.exports);
  runInContext(compile(functions.join('\n') + '\n' + reset), context);
  return { context, document, root, calls, fields, held, entered,
    hold() { holding = true; }, get generation() { return generation; }, get validationBlocks() { return validationBlocks; } };
}

test('pending current reconnect cannot erase an entered pairing code before ordinary submission', async () => {
  const f = fixture(); await f.context.restoreSession();
  const lifetime = f.context.authorityVersion(); f.hold();
  const connect = f.context.connect(); await f.entered.promise;
  const form = f.fields.get('pair-form'), input = f.fields.get('pair-code'), button = f.fields.get('pair-submit');
  assert(form && input && button); assert.equal(f.context.authorityVersion(), lifetime);
  const entryAllowed = !input.disabled && !button.disabled;
  input.value = 'synthetic-pairing-code'; input.focus(); input.fire('input');
  const beforeGeneration = f.generation;
  assert.equal(f.fields.get('pair-code'), input); assert.equal(input.value, 'synthetic-pairing-code');
  const pairDispatchesBeforeRelease=f.calls.filter(call => call.path === '/auth/pair').length;
  assert.equal(pairDispatchesBeforeRelease, 0);
  const currentRequest=f.calls.find(call=>call.path==='/status')!;assert(currentRequest && !currentRequest.signal?.aborted);
  f.held.resolve(new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Synthetic current session refused.' }, requestId: 'synthetic-request' }), { status: 401 }));
  await connect;
  const afterInput = f.fields.get('pair-code'), afterForm = f.fields.get('pair-form');
  assert.notEqual(f.context.authorityVersion(), lifetime);
  afterForm.requestSubmit();
  const observation = {
    currentAttemptAtAdmission: true, requestPath: currentRequest.path, requestStatus: 401,
    pairDispatchesBeforeRelease, pairEndpointResponse:false, currentRequestAbortedAfterReset:currentRequest.signal?.aborted===true,
    entryAllowed, generationChanged: f.generation !== beforeGeneration,
    formReplaced: form !== afterForm, inputReplaced: input !== afterInput,
    codeRetained: afterInput.value === 'synthetic-pairing-code', focusRetained: f.document.activeElement === afterInput,
    pairDispatches: f.calls.filter(call => call.path === '/auth/pair').length,
    requiredValidationBlocks: f.validationBlocks,
  };
  console.log('PAIRING READINESS OBSERVATION '+JSON.stringify(observation));
  assert.equal(observation.pairDispatches, 0);
  // Desired contract: entry is unavailable while settling, or its ephemeral value survives.
  assert(!entryAllowed || observation.codeRetained, 'editable pending pairing code was erased by the current reconnect completion');
});
