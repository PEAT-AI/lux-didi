import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import type { LiveVoiceLimits } from '../adapters/live-voice/index.js';
import { chatMigrations } from '../chat/index.js';
import { createDomainPort } from '../domain/facade.js';
import { Outbox } from '../runtime/outbox.js';
import { Store } from '../runtime/store.js';
import { createLiveSessionOwner, LiveConfigError, LiveError, liveMigrations, validateLiveProfile, type LiveContext, type LiveSessionOwner, type LiveSessionSnapshot } from '../live/index.js';
import { CANARY, fixture, options, pcm } from './live-voice-fixture.js';

const MODEL = 'models/live-session-test';
const NOW = 1_700_000_000_000;
const context = (store: Store): LiveContext => ({ clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const audio = () => ({ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } });

function profileInput(limits?: Record<string, number>, model = MODEL) {
  return {
    provider: 'gemini', liveModelId: model, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: model, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    ...(limits ? { limits } : {}),
  };
}

interface Harness {
  f: Awaited<ReturnType<typeof fixture>>;
  store: Store;
  owner: LiveSessionOwner;
  ctx: LiveContext;
  dir: string;
  advance(ms: number): void;
}

async function harness(t: TestContext, overrides: {
  limits?: Record<string, number>;
  adapterLimits?: Partial<LiveVoiceLimits>;
  credentials?: { resolve(reference: string): Promise<string | undefined> };
  model?: string;
} = {}): Promise<Harness> {
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-session-'));
  const domain = createDomainPort({ outbox: Outbox });
  const store = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations]);
  let clock = NOW;
  const profile = validateLiveProfile(profileInput(overrides.limits, overrides.model));
  const voice = new GeminiLiveVoiceAdapter(options({
    socketFactory: f.socketFactory, modelId: profile.liveModelId, voice: profile.voice, keyReference: profile.keyReference,
    route: { enabled: true, provider: 'gemini', modelId: profile.liveModelId, dataClasses: profile.route.dataClasses },
    credentials: overrides.credentials ?? { resolve: async () => CANARY },
    limits: { handshakeMs: 1000, idleMs: 2000, sessionMs: 4000, closeMs: 50, ...overrides.adapterLimits },
  }));
  const owner = createLiveSessionOwner({ store, voice, profile, now: () => clock });
  t.after(async () => { await owner.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { f, store, owner, ctx: context(store), dir, advance: ms => { clock += ms; } };
}

async function attached(h: Harness, key = 'k1') {
  const session = h.owner.create({ idempotencyKey: key, inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  return { session, attachment };
}

async function drain(h: Harness, liveSessionId: string, expected: number): Promise<LiveSessionSnapshot> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const snapshot = h.owner.get(liveSessionId);
    if (snapshot.journal.events >= expected) return snapshot;
    if (Date.now() > deadline) throw new Error(`journal did not reach ${expected} events`);
    await tick();
  }
}

async function waitTerminal(h: Harness, liveSessionId: string): Promise<LiveSessionSnapshot> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const snapshot = h.owner.get(liveSessionId);
    if (snapshot.terminal !== null) return snapshot;
    if (Date.now() > deadline) throw new Error('session never terminated');
    await tick();
  }
}

test('many-turn journal preserves provider order, late input, and an interrupted turn without generationComplete', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h);
  const turns = 140;
  for (let i = 0; i < turns; i++) {
    h.f.send({ serverContent: { outputTranscription: { text: `out-${i}`, finished: true }, generationComplete: true, turnComplete: true } });
    h.f.send({ serverContent: { inputTranscription: { text: `in-${i}` } } });
    await drain(h, session.liveSessionId, 1 + (i + 1) * 4);
  }
  h.f.send({ serverContent: { outputTranscription: { text: 'cut off' } } });
  h.f.send({ serverContent: { interrupted: true, turnComplete: true } });
  h.f.send({ serverContent: { inputTranscription: { text: 'late final input', finished: true } } });
  const live = await drain(h, session.liveSessionId, 1 + turns * 4 + 3);
  assert.equal(live.lifecycle, 'active');
  assert.ok(live.journal.events > 128, 'the adapter 128-event queue is not a lifetime journal cap');
  assert.equal(h.f.attempts, 1);

  const page = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 10 });
  assert.equal(page.fragments[0]?.kind, 'ready');
  assert.deepEqual(page.fragments.slice(1, 5).map(fragment => fragment.kind), ['outputTranscription', 'generationComplete', 'turnComplete', 'inputTranscription']);
  assert.equal(page.fragments[1]?.text, 'out-0');
  assert.equal(page.fragments[4]?.text, 'in-0');
  assert.equal(page.fragments[4]?.finished, null);
  const tail = h.owner.listFragments({ liveSessionId: session.liveSessionId, cursor: 1 + turns * 4 });
  assert.deepEqual(tail.fragments.map(fragment => fragment.kind), ['interrupted', 'turnComplete', 'inputTranscription']);
  assert.equal(tail.fragments[2]?.text, 'late final input');
  assert.equal(tail.fragments[2]?.finished, true);
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).interruptions, 1);
  const keys = ['arrivedAt', 'finished', 'journalSequence', 'kind', 'liveSessionId', 'providerSequence', 'rejectedKind', 'rejectedSequence', 'text'].sort();
  for (const fragment of page.fragments) assert.deepEqual(Object.keys(fragment).sort(), keys);
  attachment.close();
  const terminal = await attachment.done;
  assert.deepEqual(terminal.terminal, { state: 'closed', code: 'closed' });
  assert.equal(terminal.journal.complete, true);
});

test('excluded transport facts and raw secrets never persist; Domain and CHAT stay untouched', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h);
  h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio(), { text: 'unspoken thought', thought: true }] }, outputTranscription: { text: 'Spoken text' }, turnComplete: true } });
  await drain(h, session.liveSessionId, 4);
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: CANARY } });
  await tick();
  h.f.send({ serverContent: { inputTranscription: { text: 'synced' } } });
  await drain(h, session.liveSessionId, 5);
  attachment.close();
  await attachment.done;

  const journal = h.store.transaction(tx => tx.all('SELECT * FROM live_journal'));
  const dump = JSON.stringify(journal);
  assert.equal(dump.includes(CANARY), false, 'resolved credential and resumption handle never persist');
  assert.equal(dump.includes('unspoken thought'), false, 'modelText and thoughts are not transcripts');
  assert.equal(dump.includes(Buffer.from(pcm).toString('base64')), false, 'no PCM bytes persist');
  assert.equal(journal.some(row => String(row['kind']) === 'modelText' || String(row['kind']) === 'audio'), false);
  assert.ok(journal.some(row => String(row['text']) === 'Spoken text'));
  const tables = h.store.transaction(tx => tx.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(row => String(row['name'])));
  for (const table of ['live_sessions', 'live_grants', 'live_journal', 'sessions', 'entries', 'chat_runs', 'chat_consents']) assert.ok(tables.includes(table), table);
  const writes = h.store.transaction(tx => ({
    sessions: Number(tx.get('SELECT COUNT(*) AS n FROM sessions')!['n']),
    entries: Number(tx.get('SELECT COUNT(*) AS n FROM entries')!['n']),
    chatRuns: Number(tx.get('SELECT COUNT(*) AS n FROM chat_runs')!['n']),
    chatConsents: Number(tx.get('SELECT COUNT(*) AS n FROM chat_consents')!['n']),
  }));
  assert.deepEqual(writes, { sessions: 0, entries: 0, chatRuns: 0, chatConsents: 0 });
});

test('audio is rejected before ready and PCM never reaches the store', async t => {
  const h = await harness(t);
  const session = h.owner.create({ idempotencyKey: 'ready-order', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  assert.throws(() => attachment.sendAudio({ pcm }), (error: unknown) => error instanceof LiveError && error.code === 'not_ready');
  assert.throws(() => attachment.endAudioStream(), (error: unknown) => error instanceof LiveError && error.code === 'not_ready');
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  attachment.sendAudio({ pcm });
  await h.f.frame(2);
  assert.deepEqual(h.f.frames[1], { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(pcm).toString('base64') } } });
  attachment.endAudioStream();
  await h.f.frame(3);
  assert.deepEqual(h.f.frames[2], { realtimeInput: { audioStreamEnd: true } });
  attachment.close();
  await attachment.done;
});

test('single attach, idempotent create replay, conflict, and a terminal session that never reopens', async t => {
  const h = await harness(t);
  const first = h.owner.create({ idempotencyKey: 'dup', inputClass: 'ordinary' }, h.ctx);
  const replay = h.owner.create({ idempotencyKey: 'dup', inputClass: 'ordinary' }, h.ctx);
  assert.equal(replay.liveSessionId, first.liveSessionId);
  assert.equal(h.store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS n FROM live_sessions')!['n'])), 1);
  assert.throws(() => h.owner.create({ idempotencyKey: 'dup', inputClass: 'private' }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'invalid_request');

  const attachment = h.owner.attach({ liveSessionId: first.liveSessionId }, h.ctx);
  assert.throws(() => h.owner.attach({ liveSessionId: first.liveSessionId }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'already_attached');
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  attachment.close();
  const terminal = await attachment.done;
  assert.equal(terminal.lifecycle, 'terminal');

  const after = h.owner.create({ idempotencyKey: 'dup', inputClass: 'ordinary' }, h.ctx);
  assert.equal(after.lifecycle, 'terminal');
  assert.equal(after.dispatchIntent, true);
  assert.deepEqual(after.terminal, { state: 'closed', code: 'closed' });
  assert.equal(h.f.attempts, 1, 'replaying a terminal create never dispatches');
  assert.throws(() => h.owner.attach({ liveSessionId: first.liveSessionId }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'terminal');
});

test('an unused accepted session expires without ever opening the adapter', async t => {
  const h = await harness(t, { limits: { unusedMs: 1000 } });
  const session = h.owner.create({ idempotencyKey: 'unused', inputClass: 'ordinary' }, h.ctx);
  assert.equal(session.lifecycle, 'accepted');
  h.advance(2000);
  assert.throws(() => h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'expired');
  const after = h.owner.get(session.liveSessionId);
  assert.equal(after.lifecycle, 'terminal');
  assert.deepEqual(after.terminal, { state: 'expired' });
  assert.equal(after.journal.complete, false);
  assert.equal(h.f.attempts, 0);
});

test('profile validation rejects text-model fallback and bounds, and validation precedes credentials', async t => {
  const cases: unknown[] = [
    { ...profileInput(), provider: 'openai' },
    { ...profileInput(), liveModelId: 'gemini-2.0-flash' },
    { ...profileInput(), route: { enabled: false, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] } },
    { ...profileInput(), route: { enabled: true, provider: 'gemini', modelId: 'models/other', dataClasses: ['ordinary'] } },
    { ...profileInput(), route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: [] } },
    { ...profileInput(), prompt: { text: 'x', dataClass: 'private' } },
    { ...profileInput(), limits: { journalMaxEvents: 0 } },
    { ...profileInput(), limits: { journalMaxBytes: 2 ** 40 } },
  ];
  for (const value of cases) assert.throws(() => validateLiveProfile(value), (error: unknown) => error instanceof LiveConfigError);
  const input = profileInput();
  const profile = validateLiveProfile(input);
  assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.route) && Object.isFrozen(profile.route.dataClasses) && Object.isFrozen(profile.limits));
  (input.route.dataClasses as unknown as string[]).push('private');
  assert.deepEqual(profile.route.dataClasses, ['ordinary']);

  let resolves = 0;
  const h = await harness(t, { credentials: { resolve: async () => { resolves += 1; return CANARY; } } });
  const session = h.owner.create({ idempotencyKey: 'validated', inputClass: 'ordinary' }, h.ctx);
  assert.throws(() => h.owner.attach({ liveSessionId: session.liveSessionId }, { ...h.ctx, authorityEpoch: 'stale' }), (error: unknown) => error instanceof LiveError && error.code === 'stale_authority');
  assert.equal(resolves, 0);
  assert.equal(h.f.attempts, 0);
  assert.throws(() => h.owner.create({ idempotencyKey: 'class', inputClass: 'private' }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'invalid_request');
});

test('returned snapshots and fragments are mutation-proof copies', async t => {
  const h = await harness(t);
  const session = h.owner.create({ idempotencyKey: 'frozen', inputClass: 'ordinary' }, h.ctx);
  const first = h.owner.get(session.liveSessionId);
  first.grant.permittedClasses.push('sensitive');
  first.grant.model = 'models/tampered';
  const second = h.owner.get(session.liveSessionId);
  assert.deepEqual(second.grant.permittedClasses, ['ordinary']);
  assert.equal(second.grant.model, MODEL);
  assert.notEqual(first.grant, second.grant);
});

test('revocation aborts the adapter while silent, during model output, and during deferred credentials', async t => {
  const silent = await harness(t);
  const quiet = await attached(silent);
  silent.owner.invalidate('revoked');
  assert.deepEqual((await quiet.attachment.done).terminal, { state: 'revoked' });
  assert.throws(() => quiet.attachment.sendAudio({ pcm }), (error: unknown) => error instanceof LiveError && error.code === 'invalidated');
  await silent.f.closed;
  assert.equal(silent.f.frames.length, 1);

  const output = await harness(t);
  const speaking = await attached(output);
  output.f.send({ serverContent: { outputTranscription: { text: 'ongoing', finished: false } } });
  await drain(output, speaking.session.liveSessionId, 2);
  output.owner.invalidate('authority');
  assert.deepEqual((await speaking.attachment.done).terminal, { state: 'revoked' });
  await output.f.closed;
  assert.equal(output.owner.get(speaking.session.liveSessionId).journal.events, 2);

  const deferred = await harness(t, { credentials: { resolve: () => new Promise<string>(() => {}) } });
  const pending = deferred.owner.create({ idempotencyKey: 'deferred', inputClass: 'ordinary' }, deferred.ctx);
  const attachment = deferred.owner.attach({ liveSessionId: pending.liveSessionId }, deferred.ctx);
  deferred.owner.invalidate('profile');
  assert.deepEqual(deferred.owner.get(pending.liveSessionId).terminal, { state: 'revoked' });
  assert.equal(deferred.f.attempts, 0, 'no socket opens after invalidation during deferred credentials');
  await assert.rejects(attachment.ready);
  assert.equal(deferred.f.frames.length, 0);
});

test('attach after invalidation is refused, and both journal limits terminate durably', async t => {
  const invalidated = await harness(t);
  const accepted = invalidated.owner.create({ idempotencyKey: 'late', inputClass: 'ordinary' }, invalidated.ctx);
  invalidated.owner.invalidate('profile');
  assert.throws(() => invalidated.owner.attach({ liveSessionId: accepted.liveSessionId }, invalidated.ctx), (error: unknown) => error instanceof LiveError && error.code === 'invalidated');

  const counted = await harness(t, { limits: { journalMaxEvents: 3 } });
  const countedSession = await attached(counted, 'count');
  counted.f.send({ serverContent: { outputTranscription: { text: 'one' }, generationComplete: true, turnComplete: true } });
  const limit = await waitTerminal(counted, countedSession.session.liveSessionId);
  assert.deepEqual(limit.terminal, { state: 'journal_limit' });
  assert.equal(limit.journal.complete, false);
  assert.equal(limit.journal.events, 3, 'committed fragments are preserved');
  const page = counted.owner.listFragments({ liveSessionId: countedSession.session.liveSessionId, limit: 100 });
  assert.equal(page.counts.total, 3);
  const terminalRow = page.fragments.at(-1)!;
  assert.equal(terminalRow.kind, 'terminal');
  assert.equal(terminalRow.rejectedKind, 'turnComplete');
  assert.equal(terminalRow.text, null, 'the rejected fragment text is never stored');
  assert.ok(terminalRow.rejectedSequence !== null);

  const bytes = await harness(t, { limits: { journalMaxBytes: 10 } });
  const bytesSession = await attached(bytes, 'bytes');
  bytes.f.send({ serverContent: { inputTranscription: { text: 'x'.repeat(64) } } });
  const byteLimit = await waitTerminal(bytes, bytesSession.session.liveSessionId);
  assert.deepEqual(byteLimit.terminal, { state: 'journal_limit' });
  assert.equal(byteLimit.journal.events, 1);
  const bytePage = bytes.owner.listFragments({ liveSessionId: bytesSession.session.liveSessionId });
  assert.equal(bytePage.fragments.at(-1)!.rejectedKind, 'inputTranscription');
});

test('an undrained consumer channel terminates visibly instead of buffering without bound', async t => {
  const h = await harness(t, { limits: { consumerQueueEvents: 2 } });
  const { session, attachment } = await attached(h);
  for (let i = 0; i < 3; i++) h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio()] } } });
  const snapshot = await waitTerminal(h, session.liveSessionId);
  assert.deepEqual(snapshot.terminal, { state: 'consumer_backpressure' });
  assert.equal(snapshot.consumerState, 'backpressure');
  await h.f.closed;
  assert.equal(snapshot.journal.events, 1, 'audio is never journaled');
  await attachment.done;
});

test('a bounded cursor traverses every retained fragment without silent truncation', async t => {
  const h = await harness(t);
  const { session } = await attached(h);
  for (let i = 0; i < 12; i++) h.f.send({ serverContent: { inputTranscription: { text: `fragment-${i}` } } });
  await drain(h, session.liveSessionId, 13);
  const seen: number[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < 10; page++) {
    const read = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 3, ...(cursor === undefined ? {} : { cursor }) });
    assert.ok(read.fragments.length <= 3);
    seen.push(...read.fragments.map(fragment => fragment.journalSequence));
    if (read.nextCursor === null) break;
    cursor = read.nextCursor;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(new Set(seen).size, seen.length);
  const one = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 500 });
  assert.equal(one.counts.total, 13);
  assert.equal(one.nextCursor, null);
  const texts = one.fragments.filter(fragment => fragment.kind === 'inputTranscription').map(fragment => fragment.text);
  assert.deepEqual(texts, Array.from({ length: 12 }, (_value, i) => `fragment-${i}`));
});

test('live migrations preserve a populated accepted Store byte-for-byte', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const domain = createDomainPort({ outbox: Outbox });
  const before = new Store(dir, [...domain.migrations, ...chatMigrations]);
  before.transaction(tx => {
    tx.run('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)', ['s1', 'Prior session', 1, null, 'UTC', 1, 1, 1]);
    tx.run('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?)', ['e1', 's1', 1, 'user', 'preserved text', 2, 'UTC', 1]);
    tx.run('INSERT INTO chat_consents VALUES (?,?,?,?,?,?,?,?,?,?,?)', ['s1', before.assistantId, 'gemini', MODEL, 'route', 1, '["ordinary"]', '2026-01-01T00:00:00.000Z', null, 'consent-key', 'fingerprint']);
  });
  const prior = before.transaction(tx => ({
    sessions: tx.all('SELECT * FROM sessions ORDER BY id'),
    entries: tx.all('SELECT * FROM entries ORDER BY id'),
    consents: tx.all('SELECT * FROM chat_consents ORDER BY session_id'),
    outbox: tx.all('SELECT * FROM runtime_outbox ORDER BY id'),
  }));
  before.close();

  const migrated = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations]);
  t.after(() => migrated.close());
  const current = migrated.transaction(tx => ({
    sessions: tx.all('SELECT * FROM sessions ORDER BY id'),
    entries: tx.all('SELECT * FROM entries ORDER BY id'),
    consents: tx.all('SELECT * FROM chat_consents ORDER BY session_id'),
    outbox: tx.all('SELECT * FROM runtime_outbox ORDER BY id'),
  }));
  assert.deepEqual(current, prior, 'accepted CHAT and Domain rows stay meaningful');
  const owners = migrated.transaction(tx => tx.all('SELECT owner, MAX(version) AS version FROM runtime_migrations GROUP BY owner ORDER BY owner'));
  assert.deepEqual(owners.map(row => [String(row['owner']), Number(row['version'])]), [['chat', 2], ['domain', 2], ['live', 1]]);
});

test('a failed store write aborts visibly and never fabricates a durable outcome', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h);
  h.store.close();
  h.f.send({ serverContent: { inputTranscription: { text: 'after close' } } });
  await h.f.closed;
  const reopened = new Store(h.dir, [...createDomainPort({ outbox: Outbox }).migrations, ...chatMigrations, ...liveMigrations]);
  assert.equal(reopened.transaction(tx => String(tx.get('SELECT lifecycle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId])!['lifecycle'])), 'active');
  assert.equal(reopened.transaction(tx => tx.get('SELECT terminal_outcome FROM live_sessions WHERE live_session_id=?', [session.liveSessionId])!['terminal_outcome']), null);
  assert.equal(reopened.transaction(tx => Number(tx.get("SELECT COUNT(*) AS n FROM live_journal WHERE kind='terminal'")!['n'])), 0);
  reopened.close();
  await assert.rejects(attachment.done);
});

test('real SIGKILL before dispatch intent sweeps to not_started and after intent to outcome_unknown', async t => {
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-kill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const address = f.server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const domain = createDomainPort({ outbox: Outbox });
  const migrations = [...domain.migrations, ...chatMigrations, ...liveMigrations];
  const profile = validateLiveProfile(profileInput());
  const recoverOwner = (store: Store) => createLiveSessionOwner({
    store, voice: new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })), profile,
  });

  const before = await killChild(f, dir, port, 'accepted', 'before-intent');
  assert.equal(f.connections, 0, 'a session killed before intent never opened the adapter');
  let store = new Store(dir, migrations);
  let owner = recoverOwner(store);
  const swept = owner.get(before.liveSessionId);
  assert.deepEqual(swept.terminal, { state: 'not_started' });
  assert.equal(swept.journal.complete, false);
  assert.ok(owner.listFragments({ liveSessionId: before.liveSessionId }).fragments.some(fragment => fragment.kind === 'terminal'));
  await owner.shutdown();
  store.close();

  const afterIntent = await killChild(f, dir, port, 'intent', 'after-intent');
  assert.equal(f.connections, 1, 'exactly one adapter open before the crash');
  store = new Store(dir, migrations);
  owner = recoverOwner(store);
  const recovered = owner.get(afterIntent.liveSessionId);
  assert.deepEqual(recovered.terminal, { state: 'outcome_unknown' });
  assert.equal(recovered.dispatchIntent, true);
  assert.equal(f.connections, 1, 'recovery never opens a second adapter');
  assert.ok(owner.listFragments({ liveSessionId: afterIntent.liveSessionId }).fragments.length >= 1, 'a recovered session stays locally readable');
  await owner.shutdown();
  store.close();
});

async function killChild(f: Awaited<ReturnType<typeof fixture>>, dir: string, port: number, mode: string, key: string): Promise<{ liveSessionId: string }> {
  const child = fork(new URL('./live-session-process.js', import.meta.url), [mode, dir, String(port), key], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    const created = await nextMessage(child, 'created');
    const liveSessionId = String(created['liveSessionId']);
    if (mode === 'intent') {
      await f.frame(1);
      f.send({ setupComplete: {} });
      await nextMessage(child, 'intent');
    }
    return { liveSessionId };
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
}

function nextMessage(child: ReturnType<typeof fork>, phase: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${phase} message`)), 10_000);
    child.on('message', (message: Record<string, unknown>) => { if (message['phase'] === phase) { clearTimeout(timer); resolve(message); } });
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`child exited before ${phase}`)); });
  });
}

test('the owner disposes before Store.close and refuses work afterwards', async t => {
  const h = await harness(t);
  const { attachment } = await attached(h);
  await h.owner.shutdown();
  assert.deepEqual((await attachment.done).terminal, { state: 'closed', code: 'closed' });
  assert.throws(() => h.owner.get('missing'), (error: unknown) => error instanceof LiveError);
  await h.owner.shutdown();
});
