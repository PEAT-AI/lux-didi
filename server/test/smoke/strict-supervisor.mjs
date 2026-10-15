// Real-path smoke: the strict supervisor harness.
//
// Mirrors the native supervisor's framing rule byte for byte (Sources/LuxDidi/NativeServiceSupervisor.swift):
// the host is launched with the app's own environment, one bounded nonce line is written to its stdin, the
// first newline-terminated stdout line is the ready frame, and ANY further stdout byte is invalid output.
// No probe here prints a payload: only byte counts, elapsed milliseconds and event names leave this module.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';

export const READY_LIMIT_BYTES = 1024;
export const READY_TIMEOUT_MS = 6000;

// The native supervisor launches the service with a closed environment: HOME, TMPDIR, LANG and nothing else.
export function appEnvironment() {
  return { HOME: homedir(), TMPDIR: tmpdir(), LANG: 'en_US.UTF-8' };
}

export function hostArguments({ serverEntry, dataDir, webRoot, port = '0', configDir, ownerProfilePath }) {
  const args = [serverEntry, '--supervised', '--data-dir', dataDir, '--web-root', webRoot, '--port', String(port)];
  if (configDir) args.push('--config-dir', configDir);
  if (ownerProfilePath) args.push('--owner-profile', ownerProfilePath);
  return args;
}

/**
 * Spawn the host exactly as the native app does and watch its stdout under the native rule.
 *
 * resolution:
 *   ready    { frame, bytes, ms } once the single ready frame parses and matches the sent nonce
 *   invalid  { bytes, ms } when a byte arrives after the ready frame, or the frame breaks the bounded
 *            single-line rule; `invalid` wins over a later ready value
 *   error    { stage, code } for a startup refusal or a read that ends before a frame
 */
export function spawnSupervised({ node = process.execPath, serverEntry, dataDir, webRoot, port = '0', configDir, ownerProfilePath }) {
  const nonce = randomUUID();
  const args = hostArguments({ serverEntry, dataDir, webRoot, port, configDir, ownerProfilePath });
  const child = spawn(node, args, { stdio: ['pipe', 'pipe', 'pipe'], env: appEnvironment() });
  const startedAt = Date.now();
  const state = {
    child, pid: child.pid, nonce, ready: null, invalid: null, error: null,
    readyBytes: 0, readyMs: 0, stderrBytes: 0, stderrTail: '', exited: null,
  };
  let buffer = Buffer.alloc(0);
  let delivered = false;

  child.stdout.on('data', chunk => {
    if (delivered) {
      // Native rule: after the ready frame, any stdout byte is invalid output. Record the byte count and
      // the elapsed time and stop the child; the session is already being torn down in the real app.
      if (!state.invalid) {
        state.invalid = { bytes: buffer.length + chunk.length, ms: Date.now() - startedAt };
        child.stdout.removeAllListeners('data');
      } else {
        state.invalid.bytes += chunk.length;
      }
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > READY_LIMIT_BYTES) {
      state.invalid = { bytes: buffer.length, ms: Date.now() - startedAt };
      return;
    }
    const newline = buffer.indexOf(10);
    if (newline < 0) return;
    if (newline !== buffer.length - 1) {
      // A second line, or trailing bytes after the newline, is the same native framing violation.
      state.invalid = { bytes: buffer.length, ms: Date.now() - startedAt };
      return;
    }
    const frameText = buffer.subarray(0, newline).toString('utf8');
    delivered = true;
    let frame;
    try { frame = JSON.parse(frameText); } catch { state.error = { stage: 'json', code: 'malformed' }; return; }
    if (!frame || frame.type !== 'ready') {
      state.error = { stage: 'frame', code: String(frame && frame.code ? frame.code : 'unexpected-type') };
      return;
    }
    if (frame.nonce !== nonce) { state.error = { stage: 'frame', code: 'nonce' }; return; }
    state.ready = frame;
    state.readyBytes = nonce.length > 0 ? Buffer.byteLength(frameText) : 0;
    state.readyMs = Date.now() - startedAt;
  });
  child.stdout.on('end', () => {
    if (!delivered && !state.error && !state.invalid) state.error = { stage: 'eof', code: 'before-ready' };
  });
  child.stderr.on('data', chunk => { state.stderrBytes += chunk.length; state.stderrTail = (state.stderrTail + String(chunk)).slice(-400); });
  child.on('exit', code => { state.exited = code; });
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ type: 'start', schemaVersion: 1, nonce }) + '\n');

  return state;
}

/** Resolve the launch once: ready frame, invalid output, startup refusal or a bounded timeout. */
export function waitForReady(state, timeoutMs = READY_TIMEOUT_MS) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (state.invalid) return resolve({ status: 'invalid', invalid: state.invalid });
      if (state.error) return resolve({ status: 'refused', error: state.error });
      if (state.ready) return resolve({ status: 'ready', frame: state.ready, bytes: state.readyBytes, ms: state.readyMs });
      if (state.exited !== null) return resolve({ status: 'exited', error: { stage: 'exit', code: String(state.exited) } });
      if (Date.now() >= deadline) return resolve({ status: 'timeout' });
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** Close the owned child only: stdin EOF first (the host's documented close), then a bounded escalation. */
export async function stopSupervised(state, { timeoutMs = 3000 } = {}) {
  const child = state.child;
  if (!child || child.exitCode !== null) return;
  try { child.stdin.end(); } catch { /* already closed */ }
  const closed = new Promise(resolve => child.once('exit', resolve));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const escalation = (async () => {
    await sleep(500);
    if (child.exitCode === null) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    await sleep(500);
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  })();
  await Promise.race([closed, Promise.race([escalation, sleep(timeoutMs)])]);
  if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  await Promise.race([closed, sleep(1000)]);
}
