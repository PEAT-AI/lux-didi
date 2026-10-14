// W10 reads-only call timeline. These tests write synthetic jsonl logs to a temp dir,
// run the real CLI and assert the merged order, never the repo or a host process.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const CLI = resolve(import.meta.dirname, '../../scripts/call-timeline.mjs');

const HOST_LINES = [
  { ts: '2026-10-14T10:00:00.000Z', mono: 10, level: 'info', process: 'host', event: 'host.started', pid: 1, launchId: 'L1' },
  { ts: '2026-10-14T10:00:00.100Z', mono: 110, level: 'info', process: 'host', event: 'live.attempt_start', pid: 1, launchId: 'L1', attemptId: 'A1', liveSessionId: 'S1' },
  { ts: '2026-10-14T10:00:00.200Z', mono: 210, level: 'info', process: 'host', event: 'live.session_open', pid: 1, launchId: 'L1', attemptId: 'A1', liveSessionId: 'S1' },
  { ts: '2026-10-14T10:00:00.500Z', mono: 510, level: 'info', process: 'host', event: 'live.session_terminal', pid: 1, launchId: 'L1', attemptId: 'A1', liveSessionId: 'S1', code: 'closed' },
];
const NATIVE_LINES = [
  { ts: '2026-10-14T10:00:00.050Z', mono: 5, level: 'info', process: 'native', event: 'audio.config', launchId: 'L1', attemptId: 'A1', liveSessionId: 'S1', inputRate: 48000 },
  { ts: '2026-10-14T10:00:00.400Z', mono: 400, level: 'info', process: 'native', event: 'audio.flow', launchId: 'L1', attemptId: 'A1', liveSessionId: 'S1', side: 'native', tapFrames: 3 },
  { ts: '2026-10-14T10:00:00.300Z', mono: 300, level: 'info', process: 'native', event: 'audio.flow', launchId: 'L2', attemptId: 'A2', liveSessionId: 'S2', side: 'native', tapFrames: 9 },
];

async function fixtures(t) {
  const dir = await mkdtemp(join(tmpdir(), 'didi-timeline.'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'host.log'), HOST_LINES.map(line => JSON.stringify(line)).join('\n') + '\n');
  await writeFile(join(dir, 'native-live.log'), NATIVE_LINES.map(line => JSON.stringify(line)).join('\n') + '\n');
  return dir;
}

function run(args) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('merges host and native logs for the last call in timestamp order', async t => {
  const dir = await fixtures(t);
  const events = JSON.parse(run(['--last', '--json', '--dir', dir])).map(entry => entry.event);
  assert.deepEqual(events, ['host.started', 'audio.config', 'live.attempt_start', 'live.session_open', 'audio.flow', 'live.session_terminal']);
});

test('selects one call by session and by attempt', async t => {
  const dir = await fixtures(t);
  const bySession = JSON.parse(run(['--session', 'S2', '--json', '--dir', dir])).map(entry => entry.event);
  assert.deepEqual(bySession, ['audio.flow']);
  const byAttempt = JSON.parse(run(['--attempt', 'A1', '--json', '--dir', dir])).map(entry => entry.event);
  assert.equal(byAttempt.includes('host.started'), true);
  assert.equal(byAttempt.includes('audio.flow'), true);
});

test('renders a human timeline line per event without a json envelope', async t => {
  const dir = await fixtures(t);
  const text = run(['--last', '--dir', dir]);
  assert.match(text, /live\.attempt_start/);
  assert.match(text, /audio\.config/);
  assert.equal(text.includes('{"'), false, 'the human view is not raw json');
});
