// Regression for the 10.13 stdout kill (issue 892): a task-path `console.info` reached the supervised
// host's stdout, the native supervisor read every byte after the ready frame as invalidOutput and tore
// the call down on its first tool call. Two gates hold the boundary issue 233 built:
// a static sweep for stdout writers, and a runtime case proving the console passthrough covers every
// console method, not only log/error/warn.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureHostDiagnostics, HostLog } from '../host/log.js';

const root = resolve(process.env.DIDI_TEST_SOURCE_ROOT ?? 'server/test', '../..');
const serverRoot = join(root, 'server');
// Entry-point programs own the terminal's stdout: it is their output, never the supervised host's.
const stdoutOwners = new Set(['host/index.ts', 'index.ts', 'memory/cli.ts', 'config/cli.ts', 'config/mcp-cli.ts', 'trace/postcall.ts']);
// The eval harness programs are run by scripts/, not by the host.
const stdoutOwnerDirs = ['eval/'];
const forbidden = /\bconsole\.log\(|\bconsole\.info\(|process\.stdout\.write\(/;

/** A real diagnostic capture into a private host.log, plus bounded stdout and stderr recorders. */
function capture(t: TestContext): { stdout: () => string; stderr: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'didi-supervised-stdout-'));
  const stopDiagnostics = captureHostDiagnostics(new HostLog(dir));
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  t.after(() => {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    stopDiagnostics();
    rmSync(dir, { recursive: true, force: true });
  });
  return { stdout: () => out.join(''), stderr: () => err.join('') };
}

test('no task-path source file writes to the supervised host stdout', () => {
  const files = readdirSync(serverRoot, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.ts'))
    .filter(name => !name.startsWith('test/'))
    .filter(name => !name.split('/').some(segment => segment === 'node_modules' || segment === 'dist'))
    .filter(name => !stdoutOwners.has(name) && !stdoutOwnerDirs.some(dir => name.startsWith(dir)))
    .sort();
  assert.ok(files.length > 100, `the sweep must read the source tree, read ${files.length} files`);
  const offences: string[] = [];
  for (const name of files) {
    const lines = readFileSync(join(serverRoot, name), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const code = line.trimStart();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      if (forbidden.test(line)) offences.push(`${name}:${index + 1}: ${code}`);
    });
  }
  assert.deepEqual(offences, [], 'a stdout write in a supervised host ends the call (issue 892)');
});

test('a console.info from task code reaches no stdout byte and lands on stderr', t => {
  const f = capture(t);
  console.info('company_bindings', JSON.stringify({ knowledge: true, data: true, crm: false }));
  assert.equal(f.stdout(), '', 'no diagnostic byte may reach the supervised stdout');
  assert.match(f.stderr(), /company_bindings/, 'the line is kept, on stderr');
});
