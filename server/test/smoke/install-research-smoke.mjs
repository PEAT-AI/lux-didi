// Install research smoke (#598).
//
// The installer steps run this file against a built bundle: node install-research-smoke.mjs "<bundle>" <merged commit>.
// With no arguments it runs against the repo build (server/dist), which is what scripts/check-install-smoke.sh does.
// One synthetic mail endpoint answers the connector, every fetch is intercepted, and both research paths answer the
// same start: ResearchScheduler.call directly (no input gate) and a live tool call through the canonical journal
// (parseResearch runs there). It prints networkCalls and the synthetic store removal, and it starts nothing else.
// The bundled fixture carries no test files, so the fake Live voice port below is a copy of
// server/test/fixtures/fake-live-voice.ts; a coupling to that port that this copy misses fails here, loudly.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const [bundlePath, expectedCommit] = process.argv.slice(2);

let distRoot;
let installedCommit = null;
if (bundlePath === undefined) {
  distRoot = join(repoRoot, 'server', 'dist');
  assert.ok(existsSync(distRoot), `the repo build is missing at ${distRoot}: run npm run build in server/`);
} else {
  assert.ok(/^[0-9a-f]{40}$/.test(expectedCommit ?? ''), 'bundle mode needs the bundle path and the merged commit');
  const manifest = JSON.parse(readFileSync(join(bundlePath, 'Contents/Resources/didi-runtime.json'), 'utf8'));
  assert.equal(manifest.releaseCommit, expectedCommit, 'bundle release identity');
  installedCommit = manifest.releaseCommit;
  distRoot = join(bundlePath, 'Contents/Resources/server/node_modules/@lux-didi/service/dist');
  assert.ok(existsSync(distRoot), `the bundle carries no built service at ${distRoot}`);
}
const load = path => import(pathToFileURL(join(distRoot, path)).href);

const { ResearchScheduler, ResearchLedger, researchDeclaration } = await load('tools/research.js');
const { shapeGmailList } = await load('tools/live-shape.js');
const { createLiveSessionOwner, liveMigrations, validateLiveProfile } = await load('live/index.js');
const { liveProfileIdentity } = await load('live/config.js');
const { createToolsOwner, toolsMigrations } = await load('tools/index.js');
const { McpRegistry, canonicalToolDigest } = await load('adapters/mcp/registry.js');
const { MemoryResultStore } = await load('adapters/mcp/store.js');
const { createMcpAdapter } = await load('adapters/mcp/adapter.js');
const { Store } = await load('runtime/store.js');
const { domainMigrations } = await load('domain/schema.js');
const { chatMigrations } = await load('chat/index.js');

const msgs = Array.from({ length: 13 }, (_, n) => ({ id: `synthetic-${n}`, headers: [{ name: 'Subject', value: `Synthetic evidence ${n}` }] }));
const lookups = [{ source: 'mail', mail: { q: 'subject:synthetic', maxResults: 13 } }];

const declaration = researchDeclaration(['mail']);
assert.equal(declaration.name, 'research', 'the research tool name');
const schema = declaration.parameters;

const SYNTHETIC = { action: 'start', question: 'List synthetic evidence', topic: 'synthetic evidence' };

// Every field the declared schema requires of a start, filled with a synthetic value. A required field this
// table does not name is filled by type, so a new one is attempted and rejected here rather than at install.
function startArguments(schema) {
  const branch = (schema.anyOf ?? []).find(entry => (entry.properties?.action?.enum ?? []).includes('start'));
  assert.ok(branch, 'the research schema declares no start branch');
  const required = new Set([...(schema.required ?? []), ...(branch.required ?? [])]);
  const args = {};
  for (const name of required) {
    const property = schema.properties?.[name];
    assert.ok(property, `the research schema requires ${name} but declares no property for it`);
    if (SYNTHETIC[name] !== undefined) {
      if (property.enum !== undefined) assert.ok(property.enum.includes(SYNTHETIC[name]), `${name} is not one of its declared values`);
      args[name] = SYNTHETIC[name];
      continue;
    }
    if (property.enum !== undefined) { args[name] = property.enum[0]; continue; }
    if (property.type === 'string') { args[name] = `synthetic ${name}`; continue; }
    if (property.type === 'integer' || property.type === 'number') { args[name] = 1; continue; }
    if (property.type === 'boolean') { args[name] = false; continue; }
    throw new Error(`the install research smoke cannot fill the required ${property.type} field ${name}`);
  }
  for (const name of [...Object.keys(args), ...Object.keys({ lookups })]) {
    assert.ok(schema.properties?.[name] !== undefined, `the smoke sends ${name}, which the research schema does not declare`);
  }
  return args;
}

const startArgs = { ...startArguments(schema), lookups };

function fakeLiveVoicePort() {
  const requests = [];
  const toolResponses = [];
  let sessionsOpened = 0;
  let emit = () => {};
  const capabilities = Object.freeze({
    provider: 'gemini', supportsResumption: false, supportsGoAway: false, supportsInterruption: false,
    supportsServerVadConfig: false, inputRates: Object.freeze([8000]), outputRates: Object.freeze([24000]),
    outputModalities: Object.freeze(['audio', 'text']), thinking: 'provider_default',
    supportsToolScheduling: false, toleratesEmptyReadyLifecycle: false,
  });
  const port = {
    capabilities,
    open(request, control) {
      sessionsOpened += 1;
      requests.push(request);
      let closed = false;
      let resolveDone = () => {};
      const done = new Promise(resolve => { resolveDone = resolve; });
      const pending = [];
      let waiter;
      const wake = () => { const waiting = waiter; waiter = undefined; if (waiting) waiting(); };
      let sequence = 0;
      emit = event => { pending.push({ ...event, sequence: ++sequence }); wake(); };
      control.signal.addEventListener('abort', () => {
        if (closed) return;
        closed = true; wake(); resolveDone({ status: 'cancelled', code: 'cancelled' });
      }, { once: true });
      let readySeen = false;
      const events = {
        async *[Symbol.asyncIterator]() {
          while (!closed) {
            if (!readySeen) { readySeen = true; yield { sequence: ++sequence, type: 'ready' }; continue; }
            if (!pending.length) { await new Promise(resolve => { waiter = resolve; }); continue; }
            yield pending.shift();
          }
        },
      };
      return {
        ready: Promise.resolve(),
        events,
        done,
        sendToolResponse(input) { toolResponses.push(input.responses); },
        sendAudio() {}, sendText() {}, endAudioStream() {},
        close() { if (closed) return; closed = true; wake(); resolveDone({ status: 'closed', code: 'closed' }); },
      };
    },
  };
  return { port, requests, toolResponses, emit: event => emit(event), get sessionsOpened() { return sessionsOpened; } };
}

const signal = () => new AbortController().signal;
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
const summaries = [];

const ledger = new ResearchLedger();
let schedulerSources = 0;
const scheduler = new ResearchScheduler({
  ledger, configured: ['mail'], now: () => Date.now(), timeZone: 'UTC',
  emit() {}, step() {}, log() {}, logSource() {}, logSubcall() {}, logRouted() {},
  execute: async subs => {
    schedulerSources += subs.length;
    return subs.map(sub => ({ key: sub.key, name: sub.name, ok: true, ...shapeGmailList({ messages: msgs }) }));
  },
});
const schedulerStart = await scheduler.call(startArgs, signal());
assert.equal(typeof schedulerStart.nextCursor, 'string', 'the direct scheduler start carries a first cursor');
assert.match(JSON.stringify(schedulerStart.findings), /Synthetic evidence/, `the direct scheduler start returned ${JSON.stringify(schedulerStart.error ?? schedulerStart.findings)}`);
const schedulerNext = await scheduler.call({ action: 'continue', researchId: schedulerStart.researchId, cursor: schedulerStart.nextCursor }, signal());
assert.match(JSON.stringify(schedulerNext.findings), /Synthetic evidence 12/, 'the direct scheduler continue delivers the last synthetic message');
const sourcesBefore = schedulerSources;
const schedulerRetained = await scheduler.call({ action: 'continue', researchId: schedulerStart.researchId, cursor: schedulerStart.nextCursor }, signal());
assert.equal(schedulerRetained.alreadyDelivered, true);
assert.equal(schedulerRetained.error, undefined);
assert.deepEqual(schedulerRetained.findings, []);
assert.equal(schedulerSources, sourcesBefore, 'a retained continue executes no source');
await scheduler.call({ action: 'stop', researchId: schedulerStart.researchId }, signal());
const schedulerStopped = await scheduler.call({ action: 'continue', researchId: schedulerStart.researchId }, signal());
assert.equal(schedulerStopped.status, 'unavailable');
assert.equal(schedulerStopped.error, 'continuation_unavailable');
assert.equal(schedulerSources, sourcesBefore, 'a stopped continuation executes no source');
summaries.push({
  surface: 'ResearchScheduler.call',
  retained: { status: schedulerRetained.status, alreadyDelivered: schedulerRetained.alreadyDelivered, findings: schedulerRetained.findings.length, newSourceExecutions: 0 },
  stoppedContinuation: { status: schedulerStopped.status, errorPresent: 'error' in schedulerStopped, findings: schedulerStopped.findings.length, newSourceExecutions: 0 },
  sourceExecutions: schedulerSources,
});
ledger.close();

const dir = mkdtempSync(join(tmpdir(), 'didi-598-synthetic-'));
const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations, ...toolsMigrations]);
const fake = fakeLiveVoicePort();
const profile = validateLiveProfile({
  provider: 'gemini', liveModelId: 'models/live-session-test', voice: 'ExplicitVoice', keyReference: 'synthetic-only',
  route: { enabled: true, provider: 'gemini', modelId: 'models/live-session-test', dataClasses: ['ordinary'] },
  prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
  limits: { handshakeMs: 1000, idleMs: 60000, sessionMs: 120000, closeMs: 50 },
});
const endpoint = { id: 'mail', url: 'https://fixture.invalid/mail', account: 'synthetic-account', resource: 'synthetic-resource' };
const schemas = [
  { name: 'gmail_search_messages', inputSchema: { type: 'object', properties: { q: { type: 'string' }, maxResults: { type: 'integer' }, pageToken: { type: 'string' } }, additionalProperties: false } },
  { name: 'gmail_read_message', inputSchema: { type: 'object', properties: { id: { type: 'string' }, format: { type: 'string', enum: ['full', 'metadata'] } }, required: ['id'], additionalProperties: false } },
];
const registry = new McpRegistry();
registry.register(endpoint);
registry.enable('mail');
registry.allowEgress('mail');
let sourceCalls = 0;
let networkCalls = 0;
const originalFetch = globalThis.fetch;
const reply = message => {
  switch (message.method) {
    case 'initialize':
      return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'synthetic-mail', version: '1' } } };
    case 'tools/list':
      return { jsonrpc: '2.0', id: message.id, result: { tools: schemas } };
    case 'ping':
      return { jsonrpc: '2.0', id: message.id, result: {} };
    case 'tools/call':
      assert.equal(message.params.name, 'gmail_search_messages', 'the smoke asks its synthetic endpoint for one declared tool');
      sourceCalls += 1;
      return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ family: 'gmail', tool: 'gmail_search_messages', data: { messages: msgs }, coverage: { complete: true, next_page_token: null } }) }] } };
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `the synthetic endpoint serves no ${message.method}` } };
  }
};
// The service ships its MCP client but no MCP server, so this answers the streamable HTTP handshake itself:
// one JSON-RPC reply per POST, 202 for a notification, 405 for the standalone SSE stream it then gives up on.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.url !== endpoint.url) {
    networkCalls += 1;
    throw new Error(`external network forbidden: ${request.url}`);
  }
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const payload = await request.json();
  const messages = Array.isArray(payload) ? payload : [payload];
  const headers = new Headers({ 'content-type': 'application/json' });
  const replies = messages.filter(message => message.id !== undefined).map(reply);
  if (messages.some(message => message.method === 'initialize')) headers.set('mcp-session-id', 'synthetic-session');
  if (!replies.length) return new Response(null, { status: 202, headers });
  return new Response(JSON.stringify(replies.length === 1 ? replies[0] : replies), { status: 200, headers });
};
const port = createMcpAdapter({
  registry, store: new MemoryResultStore({ maxBytes: 262144, maxSliceBytes: 512 }),
  resolveCredential: async () => 'synthetic-token',
  budgets: { maxResponseBytes: 65536, projectionChars: 10, timeoutMs: 1000 },
});
let owner;
const tools = createToolsOwner({
  store, ownerId: store.assistantId, registry, port,
  lookupAuthority: async id => owner?.lookupAuthority(id) ?? owner?.lookupJobAuthority(id) ?? null,
});
let removed = false;
try {
  tools.applyConnection({
    schemaVersion: 1, ownerId: store.assistantId, connectionId: 'mail', generation: 1, enabled: true, connector: 'google',
    endpoint: { ...endpoint, credentialRef: null }, toolNames: ['gmail_search_messages', 'gmail_read_message'],
    schemaDigest: canonicalToolDigest(schemas),
    sourcePolicy: { id: 'synthetic-598', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
    route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 2048, maxSearchLimit: 50, maxGetIds: 3, maxEntityBytes: 65536, maxResultBytes: 65536 },
  });
  assert.equal((await port.discover('mail')).state, 'discovered');
  tools.projectConnection('mail');
  owner = createLiveSessionOwner({
    store, voice: fake.port, profile, memorySource: () => [],
    tools: { owner: tools, connectionIds: () => ['mail'] },
    now: () => Date.now(), timeZone: 'UTC',
  });
  const ctx = { clientId: 'synthetic', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
  const session = owner.create({ idempotencyKey: 'synthetic-598', inputClass: 'ordinary' }, ctx);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, ctx);
  await attachment.ready;
  await settle();
  fake.emit({ type: 'inputTranscription', text: 'synthetic owner turn', finished: true });
  await settle();
  // TR-R18: W5's admission allows one research operation per owner turn, so a continue speaks again first.
  const ownerTurn = async text => { fake.emit({ type: 'inputTranscription', text, finished: true }); await settle(); };
  const call = async (id, args) => {
    fake.emit({ type: 'toolCall', calls: [{ id, name: declaration.name, args }] });
    for (let i = 0; i < 100; i++) {
      await settle();
      const settled = fake.toolResponses.flat().find(response => response.id === id);
      if (settled) {
        const projection = owner.current().entries.filter(entry => entry.kind === 'toolResult').at(-1)?.tool;
        assert.ok(projection, 'canonical journal projection exists');
        return { response: settled.response, projection };
      }
    }
    throw new Error('synthetic tool did not settle');
  };
  const liveStart = await call('start', startArgs);
  assert.equal(liveStart.response.error, undefined, `the live research start was refused: ${JSON.stringify(liveStart.response)}`);
  assert.match(JSON.stringify(liveStart.response.findings), /Synthetic evidence/, `the live research start returned ${JSON.stringify(liveStart.response.findings)}`);
  assert.equal(liveStart.projection.status, 'completed');
  await ownerTurn('synthetic owner turn 2');
  const liveNext = await call('next', { action: 'continue', researchId: liveStart.response.researchId, cursor: liveStart.response.nextCursor });
  assert.match(JSON.stringify(liveNext.response.findings), /Synthetic evidence 12/);
  const count = sourceCalls;
  await ownerTurn('synthetic owner turn 3');
  const liveRetained = await call('retained', { action: 'continue', researchId: liveStart.response.researchId, cursor: liveStart.response.nextCursor });
  assert.equal(liveRetained.response.alreadyDelivered, true);
  assert.deepEqual(liveRetained.response.findings, []);
  assert.equal(liveRetained.projection.status, 'completed');
  assert.equal(sourceCalls, count);
  await call('stop', { action: 'stop', researchId: liveStart.response.researchId });
  await ownerTurn('synthetic owner turn 4');
  const liveStopped = await call('unavailable', { action: 'continue', researchId: liveStart.response.researchId });
  assert.equal(liveStopped.response.status, 'unavailable');
  assert.equal(liveStopped.response.error, 'continuation_unavailable');
  assert.equal(liveStopped.projection.status, 'error', 'an unavailable continuation must project as an error');
  assert.equal(sourceCalls, count);
  await ownerTurn('synthetic owner turn 5');
  const unknown = await call('unknown', { action: 'continue', researchId: 'nonexistent-synthetic-run' });
  assert.equal(unknown.response.error, 'unknown_research_run');
  assert.equal(unknown.projection.status, 'error');
  summaries.push({
    surface: 'LiveService tool event through the private research batch and the canonical journal',
    retained: liveRetained, stoppedContinuation: liveStopped, unknownContinuation: unknown,
    sourceExecutions: sourceCalls, newSourceExecutionsForRetainedAndStopped: 0,
  });
} finally {
  await owner?.shutdown();
  await port.close();
  globalThis.fetch = originalFetch;
  store.close();
  rmSync(dir, { recursive: true, force: true });
  removed = !existsSync(dir);
}

assert.equal(networkCalls, 0, 'the smoke made no network call outside its synthetic endpoint');
assert.equal(removed, true, 'the synthetic store directory is gone');
assert.ok(summaries.length === 2, 'both research surfaces ran');
console.log('INSTALL RESEARCH SMOKE PASS');
console.log(`mode: ${bundlePath === undefined ? 'repo build' : 'bundle'}`);
console.log(`server: ${distRoot}`);
console.log(`networkCalls: ${networkCalls}`);
console.log(`syntheticStoreRemoved: ${removed}`);
console.log(`startArgs: ${JSON.stringify(startArgs)}`);
console.log(JSON.stringify({ installedCommit, repoBuild: bundlePath === undefined, networkCalls, syntheticStoreRemoved: removed, startArgs, results: summaries }, null, 2));
