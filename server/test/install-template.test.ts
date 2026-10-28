import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, symlinkSync, readlinkSync, copyFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadMcpEndpoints } from '../config/mcp.js';
import { loadLiveConfig } from '../config/live.js';
// Resolved from this file, not from the process cwd: the declared checks run with cwd 'server'.
const sourceInstaller = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'install-macos-app.sh');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'didi-install-portable-'));
  const home = join(root, 'home'), app = join(root, 'build/Lux Didi.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.example.synthetic-didi</string><key>CFBundleExecutable</key><string>LuxDidi</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  copyFileSync('/usr/bin/true', join(app, 'Contents/MacOS/LuxDidi'));
  const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { encoding: 'utf8' });
  assert.equal(signed.status, 0, signed.stderr);
  // The portable bundle has no service or account data. Exercise the real installer and gate
  // with a fixture-local installed check, never the checkout's compile/account probes.
  const scripts = join(root, 'scripts'); mkdirSync(scripts);
  const installer = join(scripts, 'install-macos-app.sh');
  copyFileSync(sourceInstaller, installer);
  copyFileSync(join(dirname(sourceInstaller), 'run-installed-checks.sh'), join(scripts, 'run-installed-checks.sh'));
  writeFileSync(join(scripts, 'check-installed-fixture.sh'), '#!/bin/bash\nset -eu\ntest -f "$1/Contents/MacOS/LuxDidi"\nexit "${DIDI_FIXTURE_CHECK_FAIL:-0}"\n');
  const run = (extra: Record<string, string> = {}) => spawnSync('/bin/bash', [installer, app], { env: { ...process.env, HOME: home, ...extra }, encoding: 'utf8', timeout: 15000 });
  return { root, home, app, run };
}
test('installed open-web check binds the explicit app target before any build', () => {
  const root = mkdtempSync(join(tmpdir(), 'didi-open-web-target-'));
  try {
    const check = join(dirname(sourceInstaller), 'check-installed-open-web.sh');
    const result = spawnSync('/bin/bash', [check, join(root, 'Missing.app')], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /A5 FAIL: installed host runtime missing/);
    assert.doesNotMatch(result.stdout, /A5 STAGED|>.*build|tsc -p/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('fresh installation creates no connector or provider authority configuration', () => {
  const f = fixture();
  try {
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /INSTALL-MACOS-APP PASS/);
    assert.match(result.stdout, /INSTALLED-CHECK PASS check-installed-fixture\.sh/);
    assert.match(result.stdout, /INSTALLED-CHECKS PASS ran=1 failed=0/);
    assert.ok(existsSync(join(f.home, 'Applications/Lux Didi.app/Contents/MacOS/LuxDidi')));
    assert.equal(existsSync(join(f.home, 'Library')), false);
    const configDir = join(f.home, 'provider-config');
    assert.deepEqual(loadMcpEndpoints({ configDir }), { state: 'missing' });
    assert.deepEqual(loadLiveConfig({ configDir, ownerId: 'synthetic-owner' }), { status: 'unconfigured' });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('successful upgrade and failed post-swap verification preserve owner files and symlinks', () => {
  const f = fixture();
  try {
    const snapshots: { path: string; bytes: string; ino: bigint; mtime: bigint; link?: string }[] = [];
    for (const location of ['provider-config', 'provider-38']) {
      const dir = join(f.home, 'Library/Application Support/ai.peat.lux-didi', location);
      mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o700);
      for (const kind of ['mcp', 'live']) {
        const path = join(dir, `${kind}.json`), bytes = `owner-controlled ${location} ${kind}\n`;
        if (location === 'provider-38') { const source = join(f.root, `${kind}.json`); writeFileSync(source, bytes); symlinkSync(source, path); }
        else writeFileSync(path, bytes, { mode: 0o600 });
        const stat = statSync(path, { bigint: true });
        snapshots.push({ path, bytes, ino: stat.ino, mtime: stat.mtimeNs, ...(location === 'provider-38' ? { link: readlinkSync(path) } : {}) });
      }
    }
    const first = f.run(); assert.equal(first.status, 0, first.stderr);
    const verifyOwnerFiles = () => {
      for (const snapshot of snapshots) {
        assert.equal(readFileSync(snapshot.path, 'utf8'), snapshot.bytes);
        const stat = statSync(snapshot.path, { bigint: true });
        assert.equal(stat.ino, snapshot.ino); assert.equal(stat.mtimeNs, snapshot.mtime);
        if (snapshot.link) assert.equal(readlinkSync(snapshot.path), snapshot.link);
      }
    };
    verifyOwnerFiles();
    const target = join(f.home, 'Applications/Lux Didi.app');
    writeFileSync(join(target, 'prior-install'), 'preserve prior app');
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'codesign'), '#!/bin/bash\nfor arg in "$@"; do if [ "$arg" = "$DIDI_FAIL_TARGET" ]; then exit 23; fi; done\nexec /usr/bin/codesign "$@"\n', { mode: 0o700 });
    const failed = f.run({ PATH: `${bin}:${process.env.PATH}`, DIDI_FAIL_TARGET: target });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /prior app restored/);
    assert.equal(readFileSync(join(target, 'prior-install'), 'utf8'), 'preserve prior app');
    verifyOwnerFiles();
    const failedGate = f.run({ DIDI_FIXTURE_CHECK_FAIL: '1' });
    assert.equal(failedGate.status, 1, failedGate.stderr);
    assert.match(failedGate.stderr, /INSTALLED-CHECK FAIL check-installed-fixture\.sh/);
    assert.match(failedGate.stderr, /prior app restored/);
    assert.equal(readFileSync(join(target, 'prior-install'), 'utf8'), 'preserve prior app');
    verifyOwnerFiles();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
