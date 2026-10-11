import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { WebSocket } from '../../server/node_modules/ws/wrapper.mjs';
const [native, work] = process.argv.slice(2);
const state = join(work, 'process-state'), config = join(work, 'process-config');
mkdirSync(config, { recursive: true, mode: 0o700 });
const children = new Set();
function own(executable, args) {
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  children.add(child); child.once('exit', () => children.delete(child)); return child;
}
function firstLine(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('bounded fixture readiness')); }, 5000);
    child.stdout.on('data', bytes => {
      buffer += bytes.toString();
      if (buffer.length > 16384) { clearTimeout(timer); reject(new Error('oversized test IPC')); }
      if (buffer.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(buffer.split('\n')[0])); }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('fixture exited before ready')); });
  });
}
async function host(deadlineMode = 'idle') {
  const child = own(process.execPath, ['Tests/DidiLiveTests/host-child.mjs', state, config, resolve('web/dist'), deadlineMode]);
  const ready = await firstLine(child);
  const token = readFileSync(join(state, 'admin-credential'), 'utf8').trim();
  return { child, ready, token };
}
async function killOwned(child) {
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  const [code, signal] = await exited;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
}
async function json(h, path, options = {}) {
  const response = await fetch(h.ready.origin + path, { ...options, signal: AbortSignal.timeout(3000), headers: {
    Authorization: `Bearer ${h.token}`, 'x-didi-authority-epoch': h.ready.authorityEpoch, ...options.headers,
  } });
  assert.ok(response.ok, 'controlled process HTTP'); return (await response.json()).data;
}
async function nativeChild(h, mode) {
  const child = own(native, [mode]);
  child.stdin.end(JSON.stringify({ ...h.ready, token: h.token, redirectSessionID: '00000000-0000-0000-0000-000000000001' }));
  return { child, event: await firstLine(child) };
}
async function terminal(h, id) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const snapshot = await json(h, '/api/v1/live-sessions/' + id);
    if (snapshot.terminal) return snapshot;
    if (Date.now() > deadline) throw new Error('bounded terminal cleanup');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
let current;
try {
  current = await host();
  const before = await nativeChild(current, '--child-before-intent');
  const accepted = await json(current, '/api/v1/live-sessions/' + before.event.id);
  assert.equal(accepted.lifecycle, 'accepted'); assert.equal(accepted.dispatchIntent, false);
  await killOwned(before.child); await killOwned(current.child);
  current = await host();
  const recoveredBefore = await json(current, '/api/v1/live-sessions/' + before.event.id);
  assert.equal(recoveredBefore.terminal.state, 'not_started');
  console.log('PASS true native-child SIGKILL before intent + host restart => not_started');

  const after = await nativeChild(current, '--child-after-intent');
  const active = await json(current, '/api/v1/live-sessions/' + after.event.id);
  assert.equal(active.dispatchIntent, true);
  // Kill the host while native is attached: no graceful detach can rewrite crash uncertainty.
  await killOwned(current.child); await killOwned(after.child);
  current = await host();
  const recoveredAfter = await json(current, '/api/v1/live-sessions/' + after.event.id);
  assert.equal(recoveredAfter.terminal.state, 'outcome_unknown');
  console.log('PASS true native-child/host SIGKILL after intent + host restart => outcome_unknown');

  async function attached(key) {
    const created = await json(current, '/api/v1/live-sessions', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: '{"inputClass":"ordinary"}' });
    const socket = new WebSocket(current.ready.origin.replace('http:', 'ws:') + `/api/v1/live-sessions/${created.liveSessionId}/audio`, { headers: {
      Authorization: `Bearer ${current.token}`, 'x-didi-authority-epoch': current.ready.authorityEpoch, 'x-didi-live-profile': current.ready.profileIdentity,
    } });
    socket.on('error', () => {});
    const [message] = await once(socket, 'message'); assert.equal(JSON.parse(message.toString()).type, 'ready');
    return { socket, id: created.liveSessionId };
  }
  // With idle forwarding repaired, use a separate frozen profile whose idle exceeds its hard deadline.
  const beforeHard = once(current.child, 'exit'); current.child.stdin.end(); assert.equal((await beforeHard)[0], 0);
  current = await host('hard');
  const socketClose = await attached('process-socket-close');
  const socketClosed = once(socketClose.socket, 'close'); socketClose.socket.close(); await socketClosed;
  const closed = await terminal(current, socketClose.id);
  assert.notEqual(closed.terminal.state, 'outcome_unknown');
  assert.ok(['deadline', 'session_timeout'].includes(closed.terminal.code), 'separate hard deadline cannot pass on idle_timeout');
  console.log('PASS real socket-close cleanup at separate owner hard deadline durably terminal');
  const afterHard = once(current.child, 'exit'); current.child.stdin.end(); assert.equal((await afterHard)[0], 0);
  current = await host('idle');

  // Separate public-profile regression: idle must settle BEFORE sessionMs=1000, not be rescued by hard deadline.
  const idle = await attached('process-profile-idle');
  const idleClosed = once(idle.socket, 'close'); idle.socket.close(); await idleClosed;
  await new Promise(resolve => setTimeout(resolve, 300)); // bounded timer: configured idleMs=200, still before hard deadline
  const idleSnapshot = await json(current, '/api/v1/live-sessions/' + idle.id);
  const idleFailed = idleSnapshot.terminal?.code !== 'idle_timeout';
  if (idleFailed) console.error('FAIL UPSTREAM: public profile idleMs=200 not applied before sessionMs=1000; no immediate-close terminal claimed');
  else console.log('PASS public profile idleMs reaches owning adapter (idle_timeout before hard deadline)');

  const eof = await attached('process-host-eof');
  const exited = once(current.child, 'exit'); const audioClosed = once(eof.socket, 'close');
  current.child.stdin.end(); const [code, signal] = await exited; await audioClosed;
  assert.equal(code, 0); assert.equal(signal, null);
  current = await host();
  const eofRecovered = await json(current, '/api/v1/live-sessions/' + eof.id);
  assert.equal(eofRecovered.lifecycle, 'terminal'); assert.notEqual(eofRecovered.terminal.state, 'outcome_unknown');
  console.log('PASS true supervised host stdin EOF cleanup survives reopen');
  const finished = once(current.child, 'exit'); current.child.stdin.end(); assert.equal((await finished)[0], 0);
  if (idleFailed) throw new Error('UPSTREAM: profile idle propagation regression remains unsatisfied');
} finally {
  for (const child of [...children]) {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
}
