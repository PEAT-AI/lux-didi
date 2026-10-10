import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
const binary = process.argv[2];
const processes = new Set();
const durations = [];
function deadline(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout: ' + label)), 15000); })]).finally(() => clearTimeout(timer));
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGKILL'); await deadline(ended, 'owned child exit'); processes.delete(child);
}
async function fixture(dir) {
  const child = fork(new URL('./Host.mjs', import.meta.url), [dir], { silent: true }); processes.add(child);
  let sequence = 0;
  const pending = new Map(); const waiting = new Map(); const events = new Map();
  let stderr = ''; child.stderr.on('data', data => stderr += data);
  child.on('message', message => {
    if (message.id) { const slot = pending.get(message.id); if (slot) { pending.delete(message.id); message.error ? slot.reject(Error(message.error)) : slot.resolve(message.result); } }
    else if (waiting.has(message.event)) { waiting.get(message.event).shift()(message); if (!waiting.get(message.event).length) waiting.delete(message.event); }
    else { const list = events.get(message.event) ?? []; list.push(message); events.set(message.event, list); }
  });
  function event(name) {
    if (events.get(name)?.length) return Promise.resolve(events.get(name).shift());
    return deadline(new Promise(resolve => { const list = waiting.get(name) ?? []; list.push(resolve); waiting.set(name, list); }), name + stderr);
  }
  async function command(command, fields = {}) {
    const id = ++sequence;
    return deadline(new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.send({ id, command, ...fields }); }), command);
  }
  const { config } = await Promise.race([event('ready'), new Promise((_, reject) => child.once('exit', (code, signal) => reject(Error(`host startup exit ${code}/${signal}: ${stderr}`))))]);
  return { child, config, event, command, call: async (path, body, key) => command('call', { path, body, key }) };
}
function native(f, dir, mode, config = {}, text = 'e\u0301\r\n synthetic 🎙️ ') {
  const child = spawn(binary, ['--child', mode], { env: { ...process.env, DIDI_TEST_PAGE: JSON.stringify({ ...f.config, ...config }), DIDI_TEST_PENDING: dir, DIDI_TEST_TEXT: text }, stdio: ['pipe', 'pipe', 'pipe'] });
  processes.add(child); let stdout = '', stderr = ''; const lines = []; let lineWait;
  child.stdout.on('data', data => { stdout += data; for (const line of data.toString().trim().split('\n')) { if (line === 'BARRIER') { lines.push(line); if (lineWait) { lineWait(); lineWait = undefined; } } } });
  child.stderr.on('data', data => stderr += data);
  const done = deadline(new Promise((resolve, reject) => child.on('exit', (code, signal) => {
    processes.delete(child);
    if (signal) { resolve(null); return; }
    if (code !== 0) { reject(Error('Foundation child failed: ' + stdout + stderr)); return; }
    try { resolve(JSON.parse(stdout.trim().split('\n').at(-1))); } catch { reject(Error('missing child result: ' + stdout)); }
  })), 'Foundation child');
  return { child, done, barrier: () => lines.length ? Promise.resolve() : deadline(new Promise(resolve => lineWait = resolve), 'write-before-wire barrier') };
}
async function run(f, dir, mode, config, text) { return native(f, dir, mode, config, text).done; }
async function record(dir) { return JSON.parse(await readFile(join(dir, 'pending-request.json'), 'utf8')); }
async function absent(dir) { await assert.rejects(readFile(join(dir, 'pending-request.json')), { code: 'ENOENT' }); }
async function enroll(f, title) {
  const response = await f.call('/conversations', { title, timeZone: 'UTC' }); assert.equal(response.status, 200);
  return response.data.sessionId;
}
async function select(f, sessionId, title) { assert.equal((await f.call('/conversation-selection', { sessionId, title })).status, 200); }
async function stats(f) { return f.command('stats'); }
async function test(name, fn) { const start = performance.now(); await fn(); durations.push([name, (performance.now() - start) / 1000]); console.log('PASS ' + name); }
const root = await mkdtemp(join(tmpdir(), 'didi-native-send-'));
try {
  await test('real pre-wire child kill / A pinned while page B / exact replay / restore zero HTTP', async () => {
    const dir = join(root, 'before'); await mkdir(dir, { mode: 0o700 }); const f = await fixture(dir); const pending = join(dir, 'pending');
    const a = await enroll(f, 'A'), b = await enroll(f, 'B'); await select(f, a, 'A');
    const child = native(f, pending, 'send', { barrier: 'before-wire' }); await child.barrier();
    const saved = await record(pending); assert.equal(saved.phase, 'dispatch-unknown'); assert.equal(saved.sessionId, a);
    assert.equal((await stats(f)).wire.length, 0, 'wire preceded persistence');
    await select(f, b, 'B'); await stop(child.child); await child.done;
    assert.equal((await run(f, pending, 'restore')).state, 'unknown'); assert.equal((await stats(f)).wire.length, 0);
    assert.equal((await run(f, pending, 'replay')).state, 'accepted'); await absent(pending);
    const s = await stats(f); assert.equal(s.rows.length, 1); assert.equal(s.rows[0].session_id, a); assert.equal(s.captures, 1); assert.equal(s.attempts, 1);
    const wire = s.wire[0]; assert.equal(wire.key, saved.idempotencyKey); assert.equal(wire.epoch, saved.authorityEpoch); assert.equal(wire.authorization, null);
    assert.deepEqual(JSON.parse(wire.body), { sessionId: a, text: saved.frozenText });
    assert.equal((await f.call('/conversation-selection')).data.sessionId, b);
    assert.equal((await f.call('/conversations/' + b)).data.latestRunId, null);
    await stop(f.child);
  });
  await test('dropped response / real service process restart / durable outcome_unknown / one provider attempt', async () => {
    const dir = join(root, 'after'); await mkdir(dir, { mode: 0o700 }); let f = await fixture(dir); const pending = join(dir, 'pending');
    const a = await enroll(f, 'Crash A'); await select(f, a, 'Crash A'); await f.command('mode', { response: 'hold', provider: true });
    const child = native(f, pending, 'send'); const committed = await f.event('committed'); await f.event('provider');
    const saved = await record(pending); assert.equal(saved.phase, 'dispatch-unknown'); assert.equal(committed.run.sessionId, a);
    await stop(child.child); await child.done; await stop(f.child);
    f = await fixture(dir); assert.equal(saved.authorityEpoch, f.config.epoch);
    const before = await stats(f); assert.equal(before.rows[0].outcome, 'outcome_unknown'); assert.equal(before.attempts, 1);
    const restored = await run(f, pending, 'restore'); assert.equal(restored.pending, true); assert.equal((await stats(f)).wire.length, 0);
    const orphan = await run(f, pending, 'replay', { assistant: crypto.randomUUID() }); assert.equal(orphan.state, 'orphan'); assert.equal((await stats(f)).wire.length, 0); assert.deepEqual(await record(pending), saved);
    assert.equal((await run(f, pending, 'replay')).state, 'accepted'); await absent(pending);
    const after = await stats(f); assert.equal(after.rows.length, 1); assert.equal(after.rows[0].outcome, 'outcome_unknown'); assert.equal(after.captures, 1); assert.equal(after.attempts, 1); assert.equal(after.wire[0].key, saved.idempotencyKey);
    await stop(f.child);
  });
  await test('lost/malformed acceptance preserves exact envelope and duplicate replay sends once', async () => {
    for (const mode of ['drop', 'malformed']) {
      const dir = join(root, mode); await mkdir(dir, { mode: 0o700 }); const f = await fixture(dir); const pending = join(dir, 'pending');
      const a = await enroll(f, mode); await select(f, a, mode); await f.command('mode', { response: mode });
      const sent = await run(f, pending, 'send'); assert.equal(sent.state, 'unknown'); assert.equal(sent.pending, true);
      const saved = await record(pending); assert.equal(saved.frozenText, sent.text);
      await run(f, pending, 'restore'); assert.equal((await stats(f)).wire.length, 1);
      await f.command('mode'); assert.equal((await run(f, pending, 'replay')).state, 'accepted'); await absent(pending);
      const s = await stats(f); assert.equal(s.wire.length, 2); assert.deepEqual(s.wire[0], s.wire[1]); assert.equal(s.rows.length, 1); assert.equal(s.captures, 1); assert.equal(s.attempts, 1);
      await stop(f.child);
    }
  });
  await test('auth / revoked consent / active-run denial preserves draft and pending without provider retry', async () => {
    for (const reason of ['auth', 'consent', 'active']) {
      const dir = join(root, reason); await mkdir(dir, { mode: 0o700 }); const f = await fixture(dir); const pending = join(dir, 'pending');
      const a = await enroll(f, reason); await select(f, a, reason);
      const child = native(f, pending, 'send', { barrier: 'before-wire' }); await child.barrier(); const saved = await record(pending);
      if (reason === 'auth') assert.equal((await f.call('/auth/logout', {})).status, 200);
      if (reason === 'consent') assert.equal((await f.call(`/conversations/${a}/revoke`, {})).status, 200);
      if (reason === 'active') { await f.command('mode', { provider: true }); assert.equal((await f.call('/chat', { sessionId: a, text: 'synthetic active run' })).status, 200); await f.event('provider'); }
      child.child.stdin.write('dispatch\n'); const denied = await child.done;
      assert.equal(denied.state, 'unknown'); assert.equal(denied.text, saved.frozenText); assert.deepEqual(await record(pending), saved);
      const s = await stats(f); assert.equal(s.rows.length, reason === 'active' ? 1 : 0); assert.equal(s.attempts, reason === 'active' ? 1 : 0);
      await stop(f.child);
    }
  });
  for (const [name, duration] of durations.sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`${duration.toFixed(3)}s ${name}`);
  console.log('PHASE1 ONLY: no installed native/UI composition proof');
} finally {
  await Promise.all([...processes].map(stop)); await rm(root, { recursive: true, force: true });
}
