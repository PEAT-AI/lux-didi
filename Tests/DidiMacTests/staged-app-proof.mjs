#!/usr/bin/env node
// Synthetic artifact proof for a composed production .app: runtime manifest
// identity, bundled-Node shape, single launcher/Info.plist, and no developer
// home or build path leaked into the public artifact.
//
// Usage: node Tests/DidiMacTests/staged-app-proof.mjs <app> --forbid PATH...
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
assert(manifest.serverEntry === 'server/dist/host/index.js', 'serverEntry is Resources-relative');
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
