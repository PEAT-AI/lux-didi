import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createSourceFile, ScriptTarget, SyntaxKind, transpileModule, ModuleKind } from 'typescript';
import { deleteMemoryAndReload } from '../src/memory-list.ts';
const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const parsed = createSourceFile('main.ts', source, ScriptTarget.Latest, true);
const functions = parsed.statements.filter(node => node.kind === SyntaxKind.FunctionDeclaration && !['render', 'bind', 'paintLive'].includes((node as any).name?.text)).map(node => node.getText(parsed));
const reset = parsed.statements.find(node => node.kind === SyntaxKind.ExpressionStatement && node.getText(parsed).startsWith('onAuthorityChanged('))!.getText(parsed);
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function fixture() {
  let current = new AbortController().signal, callback!: (reason: string) => void;
  const timers = new Map<number, () => void>(); let id = 0;
  const context: any = { AbortController, AbortSignal, DOMException, ApiError: class extends Error { code: string; status: number; constructor(code: string, message: string, status: number) { super(message); this.code=code;this.status=status; } }, document: { hidden: false, getElementById: () => null }, navigator: { onLine: true },
    authorityVersion: () => current, assertAuthority: (version: AbortSignal) => { if (version !== current) throw new Error('synthetic stale authority'); },
    onAuthorityChanged: (fn: (reason: string) => void) => { callback = fn; },
    clearTimeout: (handle: number) => timers.delete(handle), setTimeout: (fn: () => void) => { timers.set(++id, fn); return id; },
    connectedView: { active: false, detach() {}, reset() {}, async refresh() {} }, deleteMemoryAndReload,
    request: async () => ({}), restoreSession: async () => {}, render() {}, paintLive() {},
    window: { confirm: () => true }, deleteMemoryEntry: async () => ({}),
    connection: 'Connected', pairingRequired: false, busy: false, readBusy: false, pairingBusy: false,
    controller: undefined, readGeneration: 0, liveBusy: false, connectionsBusy: false,
    sessions: [], entries: [], recent: [], session: undefined, plan: undefined, recall: undefined, status: undefined,
    detail: undefined, editing: undefined, editTitle: '', editNotes: '', editDue: '',
    messageDraft: '', titleDraft: '', queryDraft: '', memoryFilter: '', draftOwner: undefined,
    live: undefined, livePoll: {}, paintedLivePoll: undefined, connections: [], connectionsStale: false, statusUnavailable: false,
    pollTimer: undefined, liveTimer: undefined, connectionsTimer: undefined, backoff: 30000,
    sessionMore: false, entriesMore: false, notice: '', error: '', tab: 'Today', zone: 'UTC',
    localDate: () => '2026-10-14', liveDelay: () => undefined, pollLiveView: async (prior: unknown) => prior, fetchLive: async () => ({}) };
  createContext(context); runInContext(transpileModule(functions.join('\n') + '\n' + reset, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText, context);
  return { context, timers, reset(reason = 'changed') { current = new AbortController().signal; callback(reason); } };
}
test('authority invalidation clears loaded detail and edit content immediately', () => {
  const f = fixture(); Object.assign(f.context, { detail: { commitment: { title: 'loaded record' }, history: [] }, editing: { id: 'old' }, editTitle: 'loaded title', editNotes: 'loaded notes', editDue: 'old date' });
  f.reset(); assert.equal(f.context.detail, undefined); assert.equal(f.context.editing, undefined);
  assert.equal(f.context.editTitle, ''); assert.equal(f.context.editNotes, ''); assert.equal(f.context.editDue, '');
});
for (const kind of ['history', 'recall', 'plan', 'connections']) test(`held ${kind} cannot apply after authority reset`, async () => {
  const f = fixture(), held = deferred(); const value = kind === 'history' ? { commitment: { title: 'old' }, history: [] } : { marker: 'old' };
  f.context.request = async () => { await held.promise; return value; };
  const pending = kind === 'history' ? f.context.loadHistory('old') : kind === 'recall' ? f.context.searchRecall() : kind === 'plan' ? f.context.loadPlan() : f.context.pollConnections();
  f.reset(); held.release(); await pending;
  const result = f.context[kind === 'history' ? 'detail' : kind === 'connections' ? 'connections' : kind];
  assert.notEqual(result, value); assert.equal(f.context.readBusy, false);
});
for (const kind of ['session-list','open-session','status','pair']) test(`held ${kind} cannot reconnect or repaint after reset`, async () => {
  const f=fixture(),held=deferred();f.context.tab='Conversation';
  f.context.request=async()=>{await held.promise;return {assistantId:'old-owner',items:[{id:'old'}],session:{id:'old'},entries:[{text:'old'}],nextCursor:null};};
  f.context.pair=async()=>held.promise;
  const pending=kind==='session-list'?f.context.loadTab():kind==='open-session'?f.context.openSession('old'):kind==='status'?f.context.connect():f.context.pairBrowser('synthetic');
  await Promise.resolve();f.reset('unauthenticated');held.release();await pending;
  assert.equal(f.context.session,undefined);assert.equal(f.context.sessions.length,0);assert.equal(f.context.status,undefined);
  assert.equal(f.context.pairingRequired,true);assert.equal(f.context.connection,'Pair this browser');
});
test('client AUTHORITY_CHANGED cannot enter the verified server CONFLICT revision flow', async () => {
  for(const code of ['AUTHORITY_CHANGED','CONFLICT']){
    const f=fixture();let reads=0,calls=0;
    f.context.request=async(_path:string,options:{method?:string}={})=>{calls++;if(options.method==='PATCH')throw new f.context.ApiError(code,'synthetic conflict',409);reads++;return {commitment:{id:'current',title:'current'}};};
    await f.context.changeCommitment({id:'old'},'edit');assert.equal(reads,code==='CONFLICT'?2:0);assert.equal(calls,code==='CONFLICT'?3:1);
  }
});
test('background recovery repopulates reset current records and Connected view', async () => {
  const f = fixture(); let loads = 0, refreshes = 0;
  f.context.loadTab = async () => { loads++; }; f.context.connectedView.refresh = async () => { refreshes++; };
  f.context.request = async () => ({ assistantId: 'stable-owner' }); f.reset(); await f.context.connect(true);
  assert.equal(loads, 1); assert.equal(refreshes, 1); assert.equal(f.context.connection, 'Connected');
});
test('changed reset owns one background recovery while unauthenticated and logout do not', async () => {
  const f = fixture(), recovered = deferred(); let loads = 0;
  f.context.loadTab = async () => { loads++; }; f.context.connectedView.refresh = async () => { recovered.release(); };
  f.context.request = async () => ({ assistantId: 'stable-owner' });
  f.reset(); assert.equal(f.timers.size, 1); [...f.timers.values()][0](); await recovered.promise; await Promise.resolve();
  assert.equal(loads, 1); assert.equal(f.context.status.assistantId, 'stable-owner');
  f.reset('unauthenticated'); assert.equal(f.timers.size, 0); assert.equal(f.context.pairingRequired, true);
  f.reset('logout'); assert.equal(f.timers.size, 0);
});
test('independent drafts recover only for the same confirmed owner and logout clears them', () => {
  const f = fixture(); f.context.adoptOwner({ assistantId: 'owner-a' });
  f.context.status = { assistantId: 'owner-a' }; f.context.messageDraft = 'independent text'; f.context.titleDraft = 'independent title';
  f.reset(); assert.equal(f.context.status, undefined); assert.equal(f.context.messageDraft, 'independent text');
  f.context.adoptOwner({ assistantId: 'owner-a' }); assert.equal(f.context.messageDraft, 'independent text');
  f.context.adoptOwner({ assistantId: 'owner-b' }); assert.equal(f.context.messageDraft, ''); assert.equal(f.context.titleDraft, '');
  f.context.messageDraft = 'current'; f.reset('logout'); assert.equal(f.context.messageDraft, ''); assert.equal(f.context.draftOwner, undefined);
});
test('old mutation timeout and finally cannot affect a new controller', async () => {
  const f = fixture(), oldGate = deferred(), newGate = deferred();
  const old = f.context.mutate(async () => oldGate.promise); const timeout = [...f.timers.values()][0];
  f.reset(); f.context.connection='Connected'; const fresh = f.context.mutate(async () => newGate.promise); const newController = f.context.controller;
  timeout(); const newAborted = newController?.signal.aborted;
  oldGate.release(); await old; const stillOwned = f.context.controller === newController && f.context.busy;
  newGate.release(); await fresh; assert.equal(newAborted, false); assert.equal(stillOwned, true);
});
test('memory reload callbacks cannot restore old records or completion notice after reset', async () => {
  const f = fixture(), held = deferred(); f.context.tab = 'Conversation'; f.context.session = { id: 'old-session' };
  f.context.request = async () => { await held.promise; return { session: { id: 'old-session' }, entries: [{ text: 'old' }], nextCursor: null }; };
  const pending = f.context.deleteMemory('synthetic-entry'); await Promise.resolve(); f.reset(); held.release(); await pending;
  assert.equal(f.context.session, undefined); assert.equal(f.context.entries.length, 0); assert.equal(f.context.notice, '');
});
