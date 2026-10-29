import { readFile, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function liveCallInLog(text) {
  let live = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('invalid_host_log'); }
    if (row.event === 'host_started') live = false;
    if (row.event === 'live_started') live = true;
    if (row.event === 'live_terminal' || (row.event === 'host_error' && row.class === 'LiveTerminal') || (row.event === 'live_session_diagnostics' && row.terminalCode)) live = false;
  }
  return live;
}

export async function installedCanary(argv, env = process.env, output = line => process.stdout.write(`${line}\n`)) {
  if (argv.length !== 1) throw new Error('expected_installed_target');
  const target = resolve(argv[0]);
  const home = env.HOME || homedir();
  const directory = join(home, '.lux/didi-canary');
  const asksPath = join(directory, 'asks.json');
  const logPath = join(env.LUX_DIDI_DATA_DIR || join(home, 'Library/Application Support/ai.peat.lux-didi-operator'), 'logs/host.log');
  let absent = false;
  try { const stat = await lstat(asksPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072) throw new Error('invalid_ask_file'); }
  catch (error) { if (error.code === 'ENOENT') absent = true; else throw error; }
  // Check the live-call receipt before allowing even the opt-out path.
  try {
    const stat = await lstat(logPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) throw new Error('invalid_host_log');
    if (liveCallInLog(await readFile(logPath, 'utf8'))) throw new Error('call_live');
  } catch (error) { if (!(absent && error.code === 'ENOENT')) throw error; }
  if (absent) { output('CANARY SKIP reason=private_ask_file_absent'); return 0; }
  const asks = JSON.parse(await readFile(asksPath, 'utf8'));
  if (!Array.isArray(asks) || asks.length === 0 || asks.length > 15) throw new Error('invalid_asks_count');
  const ids = new Set();
  for (const ask of asks) {
    if (!ask || !/^[a-zA-Z0-9_-]{1,64}$/.test(ask.id) || ids.has(ask.id) || !Array.isArray(ask.finals) || !ask.finals.length || ask.finals.length > 8 || ask.finals.some(text => typeof text !== 'string' || !text.trim() || text.length > 4000)) throw new Error('invalid_ask');
    ids.add(ask.id);
  }
  if (!(await lstat(join(target, 'Contents/Info.plist'))).isFile()) throw new Error('invalid_installed_target');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  const requestPath = join(directory, 'request.json');
  const resultPath = join(directory, `${nonce}.result.json`);
  const request = await open(requestPath, 'wx', 0o600);
  try {
    await request.writeFile(JSON.stringify({ nonce, target, deadline: Date.now() + 350_000 }));
    await request.close();
    const deadline = performance.now() + 360_000;
    while (performance.now() < deadline) {
      try {
        const stat = await lstat(resultPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('invalid_canary_report');
        const report = JSON.parse(await readFile(resultPath, 'utf8'));
        if (!Array.isArray(report.lines) || typeof report.failed !== 'number' || report.lines.some(line => typeof line !== 'string' || !/^CANARY (PASS|FAIL|SUMMARY) /.test(line))) throw new Error('invalid_canary_report');
        for (const line of report.lines) output(line);
        return report.failed === 0 ? 0 : 1;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await pause(100);
    }
    for (const ask of asks) output(`CANARY FAIL id=${ask.id} tool=${ask.expect?.tool || 'none'} code=provider_timeout ms=360000`);
    output(`CANARY SUMMARY pass=0 fail=${asks.length} asks=${asks.length} providerTurns=unknown`);
    return 1;
  } finally {
    await request.close();
    // Remove only this invocation's files. Never remove another request or a native-owned claim.
    try { if (JSON.parse(await readFile(requestPath, 'utf8')).nonce === nonce) await unlink(requestPath); } catch { /* already claimed */ }
    await unlink(resultPath).catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await installedCanary(process.argv.slice(2)); }
  catch (error) {
    const code = typeof error.message === 'string' && /^[a-zA-Z0-9_]+$/.test(error.message) ? error.message : 'canary_preflight_failed';
    process.stdout.write(`CANARY FAIL id=preflight tool=none code=${code} ms=0\nCANARY SUMMARY pass=0 fail=1 providerTurns=0\n`);
    process.exitCode = 1;
  }
}
