// One-time comparative proof, not a CI ring: current compiled real-host test against base production.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const base = 'c77491b713808192e6314babd8b0bdbb3154cbdf';
const root = resolve(import.meta.dirname, '../..');
const server = join(root, 'server');
const selected = 'direct102 real host: direct Lux save commits without yes, outcome saved';
const testArgs = ['--test', '--test-reporter=tap', '--test-timeout=30000', `--test-name-pattern=${selected}`];
const run = cwd => spawnSync(process.execPath, [...testArgs, 'dist/test/live-remember.test.js'], {
  cwd, encoding: 'utf8', timeout: 45000, env: { ...process.env, CI: '1' }, maxBuffer: 8 * 1024 * 1024,
});
const current = run(server);
assert.equal(current.status, 0, `current real-host test must pass: ${current.stderr}\n${current.stdout}`);
console.log(`CURRENT ${selected}: exit ${current.status}, PASS`);
const work = mkdtempSync(join(tmpdir(), 'didi-direct102-base-'));
try {
  const archive = execFileSync('git', ['archive', base, 'server'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const unpack = spawnSync('tar', ['-xf', '-', '-C', work], { input: archive, encoding: 'utf8' });
  assert.equal(unpack.status, 0, unpack.stderr);
  const old = join(work, 'server');
  symlinkSync(join(server, 'node_modules'), join(old, 'node_modules'), 'dir');
  execFileSync(process.execPath, [join(server, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
    cwd: old, timeout: 60000, stdio: 'pipe', env: { ...process.env, CI: '1' },
  });
  mkdirSync(join(old, 'dist/test/fixtures'), { recursive: true });
  cpSync(join(server, 'dist/test/fixtures'), join(old, 'dist/test/fixtures'), { recursive: true });
  cpSync(join(server, 'dist/test/live-remember.test.js'), join(old, 'dist/test/live-remember.test.js'));
  const previous = run(old);
  const output = `${previous.stdout}\n${previous.stderr}`;
  assert.equal(previous.status, 1, `base must produce an assertion failure, not pass or time out: ${output}`);
  assert.match(output, /not ok \d+ - direct102 real host: direct Lux save commits without yes, outcome saved/);
  assert.match(output, /ERR_ASSERTION/);
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|TypeError:|timed out|test timed out/i);
  const actual = output.match(/^\s*actual: (.+)$/m)?.[1];
  const expected = output.match(/^\s*expected: (.+)$/m)?.[1];
  console.log(`BASE ${base}: selected real-host test exit ${previous.status}, ASSERTION RED; actual=${actual}, expected=${expected}`);
  console.log('COMPARATIVE PROOF PASS: identical compiled test, current green and base production assertion red; no missing-module or timeout evidence counted.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
