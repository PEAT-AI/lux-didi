import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic fixtures only: every record below is invented for this test and the reader is pointed
// at a mkdtemp data directory, never at the owner's own journal.

// server/dist/test -> repository root, where scripts/ lives.
const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'naya-logs.mjs');
const START = '2026-10-17T12:00:00.000Z';

function fixtures(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'didi-naya-logs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const day = join(root, 'debug', '2026-10-17');
  mkdirSync(day, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'logs'), { recursive: true, mode: 0o700 });
  const live = [
    { t: START, mono: 0, kind: 'live', sessionId: 'live-synthetic', generation: 0, event: 'session_start', provider: 'gemini', model: 'models/live', voice: 'Aoede', build: 'unknown', instructionChars: 24, instructions: 'Synthetic instructions' },
    { t: '2026-10-17T12:00:00.400Z', mono: 400, kind: 'live', sessionId: 'live-synthetic', event: 'provider_setup', stage: 'open', requestMs: 90 },
    { t: '2026-10-17T12:00:01.000Z', mono: 1000, kind: 'live', sessionId: 'live-synthetic', event: 'turn_start', speaker: 'owner' },
    { t: '2026-10-17T12:00:01.500Z', mono: 1500, kind: 'live', sessionId: 'live-synthetic', event: 'transcript', speaker: 'owner', text: 'Synthetic owner question', final: true },
    { t: '2026-10-17T12:00:02.000Z', mono: 2000, kind: 'live', sessionId: 'live-synthetic', event: 'tool', tool: 'calendar_window', args: { kind: 'today' }, ms: 812, outcome: 'completed', resultChars: 11, result: 'eleven chars' },
    { t: '2026-10-17T12:00:03.000Z', mono: 3000, kind: 'live', sessionId: 'live-synthetic', event: 'model_round', round: 1, requestMs: 320, responseMs: 9000, stopReason: 'complete' },
    { t: '2026-10-17T12:00:04.000Z', mono: 4000, kind: 'live', sessionId: 'live-synthetic', event: 'audio', at: 1792238401, inputBytes: 3200, outputBytes: 4800 },
    { t: '2026-10-17T12:00:05.000Z', mono: 5000, kind: 'live', sessionId: 'live-synthetic', event: 'session_end', code: 'closed', by: 'ended', complete: true },
  ];
  const chat = [
    { t: '2026-10-17T12:10:00.000Z', mono: 0, kind: 'chat', sessionId: 'chat-synthetic', event: 'session_start', provider: 'synthetic', model: 'counting', instructionChars: 9, instructions: 'Synthetic' },
    { t: '2026-10-17T12:10:00.500Z', mono: 500, kind: 'chat', sessionId: 'chat-synthetic', event: 'provider_error', message: 'Synthetic failure text' },
    { t: '2026-10-17T12:10:01.000Z', mono: 1000, kind: 'chat', sessionId: 'chat-synthetic', event: 'session_end', code: 'error', by: 'host' },
  ];
  const write = (path: string, rows: unknown[]): void => writeFileSync(path, rows.map(row => `${JSON.stringify(row)}\n`).join(''));
  write(join(day, 'live-live-synthetic.jsonl'), live);
  write(join(day, 'chat-chat-synthetic.jsonl'), chat);
  writeFileSync(join(root, 'logs', 'host.log'), [
    { timestamp: '2026-10-17T12:00:02.000Z', pid: 1, event: 'live_state', liveSessionId: 'live-synthetic', state: 'thinking' },
    { timestamp: '2026-10-17T12:00:02.500Z', pid: 1, event: 'host_error', class: 'LiveTerminal', code: 'synthetic' },
    { timestamp: '2026-10-17T12:00:02.700Z', pid: 1, event: 'debug_journal_error', code: 'write' },
  ].map(row => `${JSON.stringify(row)}\n`).join(''));
  return root;
}

const run = (root: string, args: string[], env: Record<string, string> = {}): string => execFileSync(process.execPath, [script, ...args, '--data-dir', root], {
  encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000,
});

test('sessions lists one row per session with its identity and terminal code', t => {
  const root = fixtures(t);
  const out = run(root, ['sessions']);
  assert.match(out, /^ID\s+KIND\s+START\s+DURATION\s+PROVIDER\s+TURNS\s+TOOLS\s+TERMINAL/m);
  assert.match(out, /live-synthetic\s+live\s+2026-10-17 12:00:00\.000\s+5\.0s\s+gemini\s+1\s+1\s+closed/);
  assert.match(out, /chat-synthetic\s+chat\s+2026-10-17 12:10:00\.000\s+1\.0s\s+synthetic\s+0\s+0\s+error/);
});

test('sessions honours --kind and --since', t => {
  const root = fixtures(t);
  assert.equal(run(root, ['sessions', '--kind', 'chat']).includes('live-synthetic'), false);
  assert.match(run(root, ['sessions', '--kind', 'chat']), /chat-synthetic/);
  // A window that ends before the fixtures is empty rather than an error.
  assert.match(run(root, ['sessions', '--since', '1m']), /no sessions under/);
});

test('timeline merges the journal and host.log on one millisecond clock, hiding content by default', t => {
  const root = fixtures(t);
  const hidden = run(root, ['timeline', 'live-synthetic']);
  assert.match(hidden, /\s{2}0ms\s+12:00:00\.000\s+journal\s+session_start/);
  assert.match(hidden, /transcript\s+speaker=owner text=\[24 chars hidden, --content\]/);
  assert.match(hidden, /host\.log\s+live_state\s+liveSessionId=live-synthetic state=thinking/);
  assert.match(hidden, /\s1000ms\s+12:00:01\.000/);
  const shown = run(root, ['timeline', 'live-synthetic', '--content']);
  assert.match(shown, /text=Synthetic owner question/);
  assert.match(shown, /instructions=Synthetic instructions/);
  assert.equal(shown.includes('chars hidden'), false);
});

test('timeline latest picks the most recently finished session', t => {
  const root = fixtures(t);
  assert.match(run(root, ['timeline', 'latest']), /session chat-synthetic/);
});

test('tools lists each call with arguments, duration, outcome and result size', t => {
  const root = fixtures(t);
  const out = run(root, ['tools', 'live-synthetic']);
  assert.match(out, /calendar_window\s+812\s+completed\s+11/);
  assert.match(out, /\{"kind":"today"\}/);
});

test('errors merges journal failures with host.log receipts', t => {
  const root = fixtures(t);
  const out = run(root, ['errors']);
  assert.match(out, /chat-synthetic\s+chat\s+provider_error\s+Synthetic failure text/);
  assert.match(out, /host_error\s+LiveTerminal synthetic/);
  assert.match(out, /debug_journal_error\s+write/);
});

test('slow lists the rounds and tools over the threshold, slowest first', t => {
  const root = fixtures(t);
  const out = run(root, ['slow', '--over', '500']);
  const clockLine = out.split('\n').find(line => line.includes('round 1'))!;
  assert.match(clockLine, /9320/);
  assert.match(out, /tool calendar_window\s+812/);
  assert.match(run(root, ['slow', '--over', '100000']), /nothing over 100000ms/);
});

test('--json returns machine-readable output for each command', t => {
  const root = fixtures(t);
  const sessions = JSON.parse(run(root, ['sessions', '--json']));
  assert.deepEqual(sessions.map((session: { id: string }) => session.id).sort(), ['chat-synthetic', 'live-synthetic']);
  const timeline = JSON.parse(run(root, ['timeline', 'live-synthetic', '--json']));
  assert.equal(timeline.some((row: { source: string }) => row.source === 'host.log'), true);
  const tools = JSON.parse(run(root, ['tools', 'live-synthetic', '--json']));
  assert.equal(tools[0].tool, 'calendar_window');
  assert.equal(tools[0].result, 'eleven chars');
  const errors = JSON.parse(run(root, ['errors', '--json']));
  assert.equal(errors.some((row: { event: string }) => row.event === 'debug_journal_error'), true);
  const slow = JSON.parse(run(root, ['slow', '--json', '--over', '500']));
  assert.equal(slow.length >= 2, true, 'the round and the tool both cross the threshold');
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
  assert.equal(out.includes('Filtering the log data'), false);
});

test('a missing session is reported, never silently empty', t => {
  const root = fixtures(t);
  assert.throws(() => run(root, ['timeline', 'live-absent']), /no session live-absent/);
});
