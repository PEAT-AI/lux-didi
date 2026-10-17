#!/usr/bin/env node
// Synthetic artifact proof for a composed production .app: runtime manifest
// identity, bundled-Node shape, single launcher/Info.plist, and no developer
// home or build path leaked into the public artifact.
//
// Usage: node Tests/DidiMacTests/staged-app-proof.mjs <app> --forbid PATH...
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const app = args.shift();
if (!app) throw new Error('staged-app-proof.mjs needs an app path');
const forbidden = [];
while (args.length) {
  const flag = args.shift();
  if (flag !== '--forbid' || !args.length) throw new Error('staged-app-proof.mjs: usage --forbid PATH');
  forbidden.push(args.shift());
}

function assert(condition, label) {
  if (!condition) throw new Error('staged-app-proof: ' + label);
}

const manifestPath = join(app, 'Contents/Resources/didi-runtime.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert(JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify(
  ['installId', 'nodeMajor', 'nodePath', 'releaseCommit', 'schemaVersion', 'serverEntry', 'webRoot'].sort()),
  'runtime manifest must keep the seven-key schema');
assert(manifest.schemaVersion === 1, 'schemaVersion must be 1');
assert(manifest.nodeMajor === 26, 'nodeMajor must be validated 26');
assert(manifest.nodePath === 'Contents/MacOS/node', 'nodePath must be bundle-relative Contents/MacOS/node');
assert(!manifest.nodePath.startsWith('/'), 'nodePath must never be absolute');
assert(manifest.serverEntry === 'server/node_modules/@lux-didi/service/dist/host/index.js', 'serverEntry is the accepted Resources-relative host entry');
assert(manifest.webRoot === 'web/dist', 'webRoot is Resources-relative');
assert(/^[0-9a-f]{40}$/.test(manifest.releaseCommit), 'releaseCommit must be 40 lowercase hex');

const nodePath = join(app, manifest.nodePath);
const nodeInfo = lstatSync(nodePath);
assert(nodeInfo.isFile() && !nodeInfo.isSymbolicLink(), 'bundled node must be a regular, non-symlink file');
assert((nodeInfo.mode & 0o100) !== 0, 'bundled node must be owner-executable');
assert((nodeInfo.mode & 0o022) === 0, 'bundled node must not be group/world writable');

// One launcher, one Info.plist, no duplicate entitlements next to the app.
const macos = readdirSync(join(app, 'Contents/MacOS')).sort();
assert(macos.includes('LuxDidi') && macos.includes('node'), 'exactly one launcher plus bundled node');
for (const entry of macos) {
  assert(entry === 'LuxDidi' || entry === 'node' || entry.endsWith('.dylib'), `unexpected Contents/MacOS entry ${entry}`);
}
assert(!readdirSync(join(app, 'Contents')).includes('entitlements'), 'no entitlements copied into the bundle');

// Check the native executable's minimum for every slice, not bundled Node's.
const plistPath = join(app, 'Contents/Info.plist');
const plistValue = (key) => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', plistPath], { encoding: 'utf8' }).trim();
assert(plistValue('CFBundleExecutable') === 'LuxDidi', 'CFBundleExecutable must be LuxDidi');
// UI3a: the Dock tile is the bundled icon, so the plist names it and the file is in place.
assert(plistValue('CFBundleIconFile') === 'AppIcon.icns' || plistValue('CFBundleIconFile') === 'AppIcon', 'CFBundleIconFile must name AppIcon');
const iconPath = join(app, 'Contents/Resources/AppIcon.icns');
const iconInfo = lstatSync(iconPath);
assert(iconInfo.isFile() && !iconInfo.isSymbolicLink() && iconInfo.size > 0, 'bundle must carry Contents/Resources/AppIcon.icns');
assert(readFileSync(iconPath).subarray(0, 4).toString('latin1') === 'icns', 'the bundled icon must be an icns file');
const nativePath = join(app, 'Contents/MacOS/LuxDidi');
const nativeInfo = lstatSync(nativePath);
assert(nativeInfo.isFile() && !nativeInfo.isSymbolicLink(), 'native executable must be a regular, non-symlink file');
function normalizedVersion(value) {
  assert(typeof value === 'string' && /^\d+(?:\.\d+){0,2}$/.test(value), 'OS minimum must be a numeric version');
  const parts = value.split('.').map(Number);
  assert(parts.every(Number.isSafeInteger), 'OS minimum components must be safe integers');
  while (parts.length < 3) parts.push(0);
  return parts.join('.');
}
const declaredMinimum = normalizedVersion(plistValue('LSMinimumSystemVersion'));
const architectures = execFileSync('/usr/bin/lipo', ['-archs', nativePath], { encoding: 'utf8' }).trim().split(/\s+/);
assert(architectures.length > 0 && architectures.every((arch) => /^[a-zA-Z0-9_]+$/.test(arch)) &&
  new Set(architectures).size === architectures.length, 'native architectures must be present and unambiguous');
for (const architecture of architectures) {
  const commands = execFileSync('/usr/bin/otool', ['-arch', architecture, '-l', nativePath], { encoding: 'utf8' })
    .split(/(?=^Load command \d+$)/m).filter((command) => /^\s+cmd LC_(?:BUILD_VERSION|VERSION_MIN_\w+)$/m.test(command));
  assert(commands.length === 1, `native ${architecture} must have exactly one OS minimum command`);
  const command = commands[0];
  let minimum;
  if (/^\s+cmd LC_BUILD_VERSION$/m.test(command)) {
    const platform = command.match(/^\s+platform (\S+)$/m)?.[1];
    assert(platform === '1' || platform === 'MACOS', `native ${architecture} must target macOS`);
    minimum = command.match(/^\s+minos (\S+)$/m)?.[1];
  } else {
    assert(/^\s+cmd LC_VERSION_MIN_MACOSX$/m.test(command), `native ${architecture} must target macOS`);
    minimum = command.match(/^\s+version (\S+)$/m)?.[1];
  }
  assert(normalizedVersion(minimum) === declaredMinimum, `declared OS minimum must match native ${architecture}`);
}

// No developer home or build path may appear in the public artifact.
const needles = [...forbidden, app].filter(Boolean);
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { scan(path); continue; }
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const size = statSync(path).size;
    if (size > 2 * 1024 * 1024) continue;
    const text = readFileSync(path, 'latin1');
    for (const needle of needles) assert(!text.includes(needle), `artifact must not contain build path ${needle} (${path})`);
  }
}
scan(app);

console.log(`STAGED-APP-PROOF PASS app=${app} keys=7 node=regular`);
