import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CanarySessions, canarySessions, assertCanaryResult, canaryPreflight, validateCanaryAsks } from '../dist/live/canary.js';

const ask = { id: 'synthetic-read', finals: ['Find the synthetic project'], expect: { tool: 'search', codeClass: 'success', nonEmpty: true } };
const result = { tool: 'search', result: { code: 'ok', items: [{ title: 'Synthetic project' }] }, ms: 4 };

test('canary accepts the tool own success code and data', () => {
  assert.deepEqual(assertCanaryResult(ask, result), { ok: true, code: 'ok' });
});
for (const [name, change, code] of [
  ['wrong tool', { tool: 'other' }, 'wrong_tool'],
  ['refusal stored as completed', { outcome: 'completed', result: { code: 'not_allowed', items: ['synthetic'] } }, 'not_allowed'],
  ['empty payload', { result: { code: 'ok', items: [] } }, 'empty_payload'],
  ['provider timeout', { timedOut: true }, 'provider_timeout'],
]) test(`canary rejects ${name}`, () => {
  assert.deepEqual(assertCanaryResult(ask, { ...result, ...change }), { ok: false, code });
});
for (const sideEffect of ['alarm', 'open', 'note']) test(`canary requires observed ${sideEffect} and cleanup`, () => {
  const sideAsk = { ...ask, expect: { ...ask.expect, sideEffect } };
  assert.equal(assertCanaryResult(sideAsk, result).code, 'side_effect_missing');
  assert.equal(assertCanaryResult(sideAsk, { ...result, sideEffect: { kind: sideEffect, observed: true, cleaned: false } }).ok, false);
  assert.equal(assertCanaryResult(sideAsk, { ...result, sideEffect: { kind: sideEffect, observed: true, cleaned: true } }).ok, true);
});
test('only absent asks can skip; a live call is always refused first', () => {
  assert.equal(canaryPreflight({ asksPresent: false, live: false }), 'skip');
  assert.throws(() => canaryPreflight({ asksPresent: false, live: true }), /call_live/);
  assert.equal(canaryPreflight({ asksPresent: true, live: false }), 'run');
});
test('canary input is bounded, unique and preserves split owner finals', () => {
  const split = { ...ask, finals: ['Set an alarm', 'in two minutes'] };
  assert.deepEqual(validateCanaryAsks([split]), [split]);
  assert.throws(() => validateCanaryAsks([]));
  assert.throws(() => validateCanaryAsks(Array(16).fill(ask)));
  assert.throws(() => validateCanaryAsks([ask, ask]));
  assert.throws(() => validateCanaryAsks([{ ...ask, finals: [''] }]));
});
test('native canary authority comes only from session opener, not frame/model fields', () => {
  let now = 0;
  const sessions = new CanarySessions(() => now);
  const frame = { type: 'native_action', id: 'action-1', action: 'open_url', target: 'https://example.invalid', canary: true };
  assert.equal(sessions.nativeFrame('ordinary', frame).action, 'open_url');
  assert.throws(() => sessions.nativeFrame('ordinary', { ...frame, action: 'canary_ack' }), /invalid_native_action/);
  sessions.open('canary-session');
  assert.equal(sessions.nativeFrame('canary-session', frame).action, 'canary_ack');
  assert.equal(sessions.nativeFrame('ordinary', frame).action, 'open_url');
  assert.throws(() => sessions.open('another'), /canary_already_live/);
  now = 360_001;
  assert.throws(() => sessions.nativeFrame('canary-session', frame), /canary_timeout/);
  sessions.close('canary-session');
  assert.equal(sessions.nativeFrame('canary-session', frame).action, 'open_url');
});

// Recorded sessions drive the exact production runner, not a separate assertion implementation.
const { runCanaryAsks, InstalledCanary } = await import('../dist/live/canary.js');
const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { spawnSync } = await import('node:child_process');
const { liveCallInLog } = await import('../../scripts/lib/check-installed-canary.mjs');

for (const [label, recorded, effect, expected] of [
  ['pass', result, undefined, 'PASS'],
  ['wrong-tool', { ...result, tool: 'other' }, undefined, 'FAIL'],
  ['stored-completed-refusal', { ...result, outcome: 'completed', result: { code: 'not_allowed', items: ['synthetic'] } }, undefined, 'FAIL'],
  ['empty', { ...result, result: { code: 'ok', items: [] } }, undefined, 'FAIL'],
  ['side-effect-missing', result, 'alarm', 'FAIL'],
  ['provider-timeout', { ...result, timedOut: true }, undefined, 'FAIL'],
]) test(`recorded session runner: ${label}`, async () => {
  const ownerFinals = [];
  let closed = 0;
  let cleaned = 0;
  const splitAsk = { ...ask, finals: ['Find the synthetic', 'project'], expect: { ...ask.expect, ...(effect ? { sideEffect: effect } : {}) } };
  const report = await runCanaryAsks([splitAsk], {
    inject: finals => ownerFinals.push(...finals),
    observe: async () => [recorded],
    verifyAndCleanup: async () => { cleaned++; },
    providerTurns: () => 2,
    close: () => { closed++; },
  }, new AbortController().signal);
  assert.match(report.lines[0], new RegExp(`^CANARY ${expected} id=synthetic-read tool=`));
  assert.match(report.lines.at(-1), /providerTurns=2$/);
  assert.deepEqual(ownerFinals, splitAsk.finals);
  assert.equal(closed, 1);
  assert.equal(cleaned, 1, 'cleanup runs even when result assertions fail');
});
test('aborted paid budget never injects another owner final', async () => {
  const abort = new AbortController(); abort.abort();
  let injected = 0;
  const report = await runCanaryAsks([ask], {
    inject: () => { injected++; }, observe: async () => [], verifyAndCleanup: async () => {}, providerTurns: () => 0, close: () => {},
  }, abort.signal);
  assert.equal(injected, 0);
  assert.equal(report.failed, 1);
  assert.match(report.lines[0], /code=provider_timeout/);
});
test('native acknowledgement must match an emitted action on the marked session', () => {
  const sessions = new CanarySessions(); sessions.open('marked');
  const ack = { type: 'native_action_result', id: 'known', ok: true, code: 'opened' };
  sessions.acknowledgeNative('marked', ack);
  assert.equal(sessions.nativeAckCount('marked'), 0);
  sessions.nativeFrame('marked', { type: 'native_action', id: 'known', action: 'open_url', target: 'https://example.com' });
  sessions.acknowledgeNative('ordinary', ack);
  sessions.acknowledgeNative('marked', { ...ack, ok: false });
  assert.equal(sessions.nativeAckCount('marked'), 0);
  sessions.acknowledgeNative('marked', ack);
  assert.equal(sessions.nativeAckCount('marked'), 1);
  sessions.close('marked');
});
test('own refusal status overrides a misleading success code', () => {
  assert.equal(assertCanaryResult(ask, { ...result, result: { code: 'ok', status: 'refused', reason: 'not_granted', items: ['synthetic'] } }).ok, false);
  assert.equal(assertCanaryResult(ask, { ...result, result: { messages: [] } }).code, 'empty_payload');
  assert.equal(assertCanaryResult(ask, { ...result, result: { saved: false, code: 'write_failed', title: 'synthetic' } }).ok, false);
});

for (const [label, options, expected, code] of [
  ['absent-private-file', {}, 0, 'CANARY SKIP reason=private_ask_file_absent'],
  ['live-call-without-asks', { live: true }, 1, 'code=call_live'],
  ['invalid-present-file', { asks: '{not-json' }, 1, 'CANARY FAIL'],
  ['missing-target-is-not-skip', { asks: JSON.stringify([ask]) }, 1, 'CANARY FAIL'],
]) test(`actual installed CLI preflight: ${label}`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'didi-canary-preflight-'));
  try {
    const data = join(home, 'synthetic-data');
    await mkdir(join(data, 'logs'), { recursive: true });
    await writeFile(join(data, 'logs/host.log'), JSON.stringify({ event: 'host_started' }) + '\n' + (options.live ? JSON.stringify({ event: 'live_started' }) + '\n' : ''));
    if (options.asks) { await mkdir(join(home, '.lux/didi-canary'), { recursive: true }); await writeFile(join(home, '.lux/didi-canary/asks.json'), options.asks); }
    const cli = spawnSync('bash', ['scripts/check-installed-canary.sh', join(home, 'Synthetic.app')], { cwd: new URL('../../', import.meta.url), env: { ...process.env, HOME: home, LUX_DIDI_DATA_DIR: data }, encoding: 'utf8', timeout: 5_000 });
    assert.equal(cli.status, expected, cli.stderr);
    assert.ok(cli.stdout.includes(code), cli.stdout);
    if (expected !== 0) assert.ok(!cli.stdout.includes('CANARY SKIP'));
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('live log resets only on host restart or a terminal receipt', () => {
  const lines = events => events.map(event => JSON.stringify(event)).join('\n');
  assert.equal(liveCallInLog(lines([{ event: 'live_started' }])), true);
  assert.equal(liveCallInLog(lines([{ event: 'live_started' }, { event: 'live_terminal' }])), false);
  assert.equal(liveCallInLog(lines([{ event: 'live_started' }, { event: 'host_started' }])), false);
  assert.throws(() => liveCallInLog('malformed'), /invalid_host_log/);
});
test('synthetic ask example stays inside the public format and paid count cap', async () => {
  const example = JSON.parse(await readFile(new URL('../../scripts/fixtures/canary-asks.example.json', import.meta.url), 'utf8'));
  assert.equal(validateCanaryAsks(example).length, 13);
});
test('host opener owns its flag and raw result observation ignores stored completed state', async () => {
  let injected = false;
  const finals = [];
  const id = '11111111-1111-4111-8111-111111111111';
  const live = {
    create: () => ({ liveSessionId: id }),
    snapshot: () => ({ lifecycle: 'active', terminal: null }),
    text: text => { injected = true; finals.push(text); },
    revoke: () => {},
  };
  const store = { transaction: callback => callback({
    get: sql => {
      if (sql.includes('COUNT(*)')) return { n: 3 };
      if (sql.includes('SELECT status,terminal_at')) return { status: 'completed', terminal_at: 0 };
      return undefined;
    },
    all: sql => {
      if (injected && sql.includes('FROM trace_call c')) return [{ call_key: 'synthetic', name: 'search', intent_at: Date.now(), text: JSON.stringify({ code: 'not_granted', items: ['synthetic'] }) }];
      return [];
    },
  }) };
  const host = new InstalledCanary(store, live);
  host.open([ask], { clientId: 'owner' });
  assert.equal(canarySessions.isCanary(id), true);
  await assert.rejects(() => host.run(id, 'other-client'), /invalid_canary_session/);
  const report = await host.run(id, 'owner');
  assert.equal(report.failed, 1);
  assert.equal(report.providerTurns, 3);
  assert.match(report.lines[0], /code=not_granted/);
  assert.deepEqual(finals, ask.finals);
  assert.equal(canarySessions.isCanary(id), false);
});

test('actual HTTP canary opener rejects model-shaped/browser requests and marks only native bearer sessions', async t => {
  const { Store } = await import('../dist/runtime/store.js');
  const { listenService } = await import('../dist/http/server.js');
  const home = await mkdtemp(join(tmpdir(), 'didi-canary-http-'));
  const store = new Store(home);
  store.transaction(tx => tx.run('CREATE TABLE live_sessions(live_session_id TEXT PRIMARY KEY,lifecycle TEXT NOT NULL)'));
  let created = 0;
  let revoked = 0;
  const id = '22222222-2222-4222-8222-222222222222';
  const live = {
    enabled: true, maxIncomingBytes: 65536, maxBufferedBytes: 65536,
    create: (_inputClass, key) => { created++; return { liveSessionId: id, idempotencyKey: key, lifecycle: 'accepted' }; },
    revoke: () => { revoked++; }, shutdown: async () => {},
  };
  const service = await listenService({ store, live, port: 0 });
  t.diagnostic(`CANARY HTTP FIXTURE port=${new URL(service.origin).port} pid=${process.pid}`);
  try {
    const url = `${service.origin}/api/v1/live-canary/open`;
    const body = JSON.stringify({ asks: [ask], deadline: Date.now() + 300_000 });
    const token = (await readFile(join(home, 'admin-credential'), 'utf8')).trim();
    const auth = { Authorization: `Bearer ${token}`, 'X-Didi-Authority-Epoch': store.authorityEpoch, 'Content-Type': 'application/json' };
    const anonymous = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(anonymous.status, 401);
    const browser = await fetch(url, { method: 'POST', headers: { ...auth, Origin: service.origin }, body });
    assert.equal(browser.status, 403);
    assert.equal(created, 0);
    assert.equal(canarySessions.isCanary(id), false);
    const modelFlag = await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify({ ...JSON.parse(body), canary: true }) });
    assert.equal(modelFlag.status, 400);
    assert.equal(created, 0);
    const opened = await fetch(url, { method: 'POST', headers: auth, body });
    assert.equal(opened.status, 200, await opened.text());
    assert.equal(created, 1);
    assert.equal(canarySessions.isCanary(id), true);
  } finally {
    await service.close(); store.close(); await rm(home, { recursive: true, force: true });
    t.diagnostic('CANARY HTTP FIXTURE closed=true');
  }
  assert.equal(revoked, 1);
  assert.equal(canarySessions.isCanary(id), false);
});
