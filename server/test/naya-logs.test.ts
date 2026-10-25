import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic fixtures only: every record below is invented for this test and the reader is pointed
// at a mkdtemp data directory, never at the owner's own host.log.

// server/dist/test -> repository root, where scripts/ lives.
const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'naya-logs.mjs');
const START = '2026-10-17T12:00:00.000Z';

function fixtures(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'didi-naya-logs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'logs'), { recursive: true, mode: 0o700 });
  const records = [
    { timestamp: START, pid: 1, event: 'live_started', liveSessionId: 'live-synthetic', provider: 'gemini', modelId: 'models/live', voice: 'Aoede' },
    { timestamp: '2026-10-17T12:00:01.000Z', pid: 1, event: 'live_tool_turn', liveSessionId: 'live-synthetic', sequence: 1, toolCallsThisTurn: 2, toolLatencyMs: [120, 900] },
    { timestamp: '2026-10-17T12:00:02.500Z', pid: 1, event: 'live_trace_rejected', kind: 'call.intent', code: 'MISSING_FIELD' },
    { timestamp: '2026-10-17T12:00:02.600Z', pid: 1, event: 'tool_failure', liveSessionId: 'live-synthetic', tool: 'calendar_window', code: 'timeout' },
    { timestamp: '2026-10-17T12:00:05.000Z', pid: 1, event: 'session_end', liveSessionId: 'live-synthetic', reason: 'ended' },
    { timestamp: '2026-10-17T12:10:00.000Z', pid: 1, event: 'chat_timing', runId: 'chat-synthetic', outcome: 'failed', rounds: [{ ms: 40 }], tools: [], fenceMs: 700, acquireMs: 5, answerMs: 1_200 },
    { timestamp: '2026-10-17T12:10:01.000Z', pid: 1, event: 'session_end', runId: 'chat-synthetic', reason: 'failed' },
    { timestamp: '2026-10-17T12:00:02.500Z', pid: 1, event: 'host_error', class: 'LiveTerminal', code: 'synthetic' },
  ];
  writeFileSync(join(root, 'logs', 'host.log'), records.map(row => `${JSON.stringify(row)}\n`).join(''));
  return root;
}

const run = (root: string, args: string[], env: Record<string, string> = {}): string => execFileSync(process.execPath, [
  script, ...args, '--data-dir', root,
], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 });

/** Run with no `--data-dir`, so the reader has to resolve the host's own default. */
const runBare = (args: string[], env: NodeJS.ProcessEnv): string => execFileSync(process.execPath, [script, ...args], {
  encoding: 'utf8', env, timeout: 60_000,
});

test('sessions lists one row per session with its identity and terminal reason', t => {
  const root = fixtures(t);
  const out = run(root, ['sessions']);
  assert.match(out, /^SESSION\s+KIND\s+STARTED\s+DURATION\s+PROVIDER\s+TURNS\s+TOOLS\s+TERMINAL/m);
  assert.match(out, /live-synthetic\s+live\s+2026-10-17 12:00:00\.000\s+5\.0s\s+gemini\s+1\s+3\s+ended/);
  assert.match(out, /chat-synthetic\s+chat\s+2026-10-17 12:10:00\.000\s+1\.0s\s+\s+0\s+0\s+failed/);
});

test('sessions honours --kind and --since', t => {
  const root = fixtures(t);
  assert.equal(run(root, ['sessions', '--kind', 'chat']).includes('live-synthetic'), false);
  assert.match(run(root, ['sessions', '--kind', 'chat']), /chat-synthetic/);
  // A window that ends before the fixtures is empty rather than an error.
  assert.match(run(root, ['sessions', '--since', '1m']), /no sessions in/);
});

test('sessions --json carries the summary of every session', t => {
  const root = fixtures(t);
  const sessions = JSON.parse(run(root, ['sessions', '--json']));
  assert.deepEqual(sessions.map((session: { id: string }) => session.id).sort(), ['chat-synthetic', 'live-synthetic']);
  const live = sessions.find((session: { id: string }) => session.id === 'live-synthetic');
  assert.equal(live.tools, 3, 'two delegated calls and one failed tool');
  assert.equal(live.terminal, 'ended');
});

test('tools reads the tool receipts host.log keeps, per session', t => {
  const root = fixtures(t);
  const out = run(root, ['tools', 'live-synthetic']);
  assert.match(out, /^TIME\s+EVENT\s+CALL\s+MS/m);
  assert.match(out, /live_tool_turn\s+-\s+120/);
  assert.match(out, /tool_failure\s+calendar_window/);
  assert.equal(out.includes('chat-synthetic'), false, 'tool receipts are read for the session asked for');
});

test('errors merges host.log failures, without a journal line to carry them', t => {
  const root = fixtures(t);
  const out = run(root, ['errors']);
  assert.match(out, /live_trace_rejected/);
  assert.match(out, /tool_failure/);
  assert.match(out, /host_error/);
  assert.match(out, /session_end/, 'a session that did not end cleanly is a failure row');
  assert.equal(out.includes('debug_journal_error'), false, 'the journal receipt is gone with the journal');
});

// L8-Q04: a call with a rejected command, a stall nudge, a 25 s dead air, a rebuild and a refused open
// printed none of them under errors.
test('L8-Q04: errors names a rejected command, dead air, a rebuild and a refused native action', t => {
  const root = mkdtempSync(join(tmpdir(), 'didi-naya-logs-q04-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'logs'), { recursive: true, mode: 0o700 });
  const records = [
    { timestamp: START, pid: 1, event: 'live_started', liveSessionId: 'live-q04', provider: 'openai', modelId: 'gpt-live-1', voice: 'marin' },
    { timestamp: '2026-10-17T12:00:01.000Z', pid: 1, event: 'command_rejected', code: 'invalid_request_error', param: 'type', kind: 'cont' },
    { timestamp: '2026-10-17T12:00:02.000Z', pid: 1, event: 'live_dead_air', deadAirMs: 25_437 },
    { timestamp: '2026-10-17T12:00:02.100Z', pid: 1, event: 'live_dead_air', deadAirMs: 776 },
    { timestamp: '2026-10-17T12:00:03.000Z', pid: 1, event: 'live_dead_air_nudge', elapsedMs: 20_623 },
    { timestamp: '2026-10-17T12:00:04.000Z', pid: 1, event: 'live_rebuild', trigger: 'no_output_after_ambient', liveSessionId: 'live-q04', generation: 1 },
    { timestamp: '2026-10-17T12:00:05.000Z', pid: 1, event: 'native_action', action: 'open_url', code: 'not_allowed', detail: 'none' },
    { timestamp: '2026-10-17T12:00:06.000Z', pid: 1, event: 'native_action', action: 'open_url', code: 'opened', detail: 'none' },
  ];
  writeFileSync(join(root, 'logs', 'host.log'), records.map(row => `${JSON.stringify(row)}\n`).join(''));
  const rows = JSON.parse(run(root, ['errors', '--json'])) as { kind: string; detail: string }[];
  const kinds = rows.map(row => row.kind);
  for (const kind of ['command_rejected', 'live_dead_air_nudge', 'live_rebuild', 'native_action']) assert.ok(kinds.includes(kind), `${kind} is a failure row: ${kinds.join(', ')}`);
  assert.equal(kinds.filter(kind => kind === 'live_dead_air').length, 1, 'only the long dead air is a failure, a normal gap is not');
  assert.equal(kinds.filter(kind => kind === 'native_action').length, 1, 'an opened native action is not a failure');
  assert.ok(rows.some(row => row.kind === 'native_action' && row.detail.includes('not_allowed')), 'the refusal names its code');
});

test('slow lists the timings over the threshold and nothing else', t => {
  const root = fixtures(t);
  const slow = JSON.parse(run(root, ['slow', '--json', '--over', '500']));
  assert.deepEqual(slow.map((row: { what: string }) => row.what).sort(), ['chat_answer', 'chat_fence', 'tool']);
});

test('native reads the app subsystem log for the session window', t => {
  const root = fixtures(t);
  const bin = join(root, 'fake-log');
  writeFileSync(bin, ["#!/bin/sh",
    "printf 'Filtering the log data using \"subsystem == ai.lux.didi\\n'",
    "printf 'Timestamp  Thread  Type  Activity  PID  Message\\n'",
    "printf '2026-10-17 12:00:01.000  main  Default  native-actions 77  synthetic native record\\n'",
  ].join('\n'));
  chmodSync(bin, 0o755);
  const out = run(root, ['native', 'live-synthetic'], { NAYA_LOG_BIN: bin });
  assert.match(out, /app log for live-synthetic, 2026-10-17T11:59:58\.000Z to 2026-10-17T12:00:07\.000Z/);
  assert.match(out, /synthetic native record/);
});

test('a missing session is reported, never silently empty', t => {
  const root = fixtures(t);
  assert.throws(() => run(root, ['tools', 'no-such-session']), /no session no-such-session/);
});

test('the timeline command is gone: its per-turn record lives in the trace store', t => {
  const root = fixtures(t);
  assert.throws(() => run(root, ['timeline', 'live-synthetic']), /unknown command timeline/);
});

test('the reader resolves the host default data dir with no --data-dir', t => {
  const home = mkdtempSync(join(tmpdir(), 'didi-naya-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // L8-Q10: on the Mac the default is the installed app's own directory, the one the owner's calls write.
  const expected = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'ai.peat.lux-didi')
    : process.platform === 'win32' ? join(home, 'AppData', 'Roaming', 'Lux Didi') : join(home, '.local', 'share', 'lux-didi');
  mkdirSync(join(expected, 'logs'), { recursive: true, mode: 0o700 });
  writeFileSync(join(expected, 'logs', 'host.log'), `${JSON.stringify({ timestamp: START, pid: 1, event: 'live_started', liveSessionId: 'live-default', provider: 'openai', modelId: 'gpt-live-1', voice: 'marin' })}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.DIDI_STATE_DIR;
  delete env.XDG_DATA_HOME;
  const out = runBare(['sessions'], env);
  assert.match(out, /live-default\s+live/, `the reader found the session under ${expected}`);
});
