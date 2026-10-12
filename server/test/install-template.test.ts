import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadMcpEndpoints } from '../config/mcp.js';

// Execute only the real installer's seeding block, never install an app or touch real HOME.
const installer = readFileSync(join(process.cwd(), 'scripts/install-macos-app.sh'), 'utf8');
const start = installer.indexOf('data_dir="${HOME}/Library/Application Support/ai.peat.lux-didi"');
const end = installer.indexOf("\nprintf 'INSTALL-MACOS-APP PASS", start);
assert(start >= 0 && end > start);
const seed = installer.slice(start, end);
for (const location of ['provider-config', 'provider-38']) for (const kind of ['live', 'mcp']) test(`R5 upgrades exact ${location}/${kind} template, preserves edits, then no-ops`, () => {
  const home = mkdtempSync(join(tmpdir(), 'didi-install-seed-'));
  const configDir = join(home, 'Library/Application Support/ai.peat.lux-didi', location);
  const path = join(configDir, `${kind}.json`);
  const run = () => { const result = spawnSync('/bin/bash', ['-euc', seed], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 3000 }); assert.equal(result.status, 0, result.stderr); };
  try {
    run();
    const current = JSON.parse(readFileSync(path, 'utf8'));
    if (kind === 'live') { assert.deepEqual(current.dataClasses, ['ordinary', 'private']); assert.deepEqual(current.limits, { sessionMs: 3600000, idleMs: 300000 }); }
    else for (const entry of current.endpoints) assert.equal(entry.unknownClass, 'private');
    const old = structuredClone(current);
    if (kind === 'live') { old.dataClasses = ['ordinary']; delete old.limits; }
    else for (const entry of old.endpoints) delete entry.unknownClass;
    writeFileSync(path, `${JSON.stringify(old)}\n`, { mode: 0o600 });
    run(); assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), current, 'exact old shipped seed upgrades');
    const before = statSync(path, { bigint: true }); run(); const after = statSync(path, { bigint: true });
    assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs, 'second run must not rewrite');
    const edited = structuredClone(old);
    if (kind === 'live') edited.voice = 'OwnerVoice';
    else edited.endpoints[0].account = 'owner-edited';
    const editedBytes = `${JSON.stringify(edited)}\n`; writeFileSync(path, editedBytes);
    const editedStat = statSync(path, { bigint: true }); run();
    assert.equal(readFileSync(path, 'utf8'), editedBytes, 'owner-edited file must stay byte-identical');
    assert.equal(statSync(path, { bigint: true }).mtimeNs, editedStat.mtimeNs);
    if (kind === 'live') assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).dataClasses, ['ordinary']);
    else { const loaded = loadMcpEndpoints({ configDir }); assert.equal(loaded.state, 'configured'); if (loaded.state !== 'configured') throw Error('missing'); for (const entry of loaded.catalog.endpoints) assert.equal(entry.configurationError, 'unknown-class-missing'); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('R5 upgrades the build-9 live.json seed and never rewrites an owner-edited one', () => {
  const home = mkdtempSync(join(tmpdir(), 'didi-install-build9-'));
  const configDir = join(home, 'Library/Application Support/ai.peat.lux-didi/provider-config');
  const path = join(configDir, 'live.json');
  const run = () => { const result = spawnSync('/bin/bash', ['-euc', seed], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 3000 }); assert.equal(result.status, 0, result.stderr); };
  try {
    run();
    const current = JSON.parse(readFileSync(path, 'utf8'));
    const build9 = structuredClone(current); delete build9.limits;
    writeFileSync(path, `${JSON.stringify(build9)}\n`, { mode: 0o600 });
    run();
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), current, 'build-9 seed upgrades to the owner limits');
    const edited = structuredClone(current); edited.limits = { sessionMs: 120000, idleMs: 30000 };
    const editedBytes = `${JSON.stringify(edited)}\n`; writeFileSync(path, editedBytes);
    const editedStat = statSync(path, { bigint: true }); run();
    assert.equal(readFileSync(path, 'utf8'), editedBytes, 'owner-edited limits stay byte-identical');
    assert.equal(statSync(path, { bigint: true }).mtimeNs, editedStat.mtimeNs);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the installed live.json seed parses as a Live profile exposing the owner limits', async () => {
  const { loadLiveConfig } = await import('../config/live.js');
  const home = mkdtempSync(join(tmpdir(), 'didi-install-live-config-'));
  const configDir = join(home, 'Library/Application Support/ai.peat.lux-didi/provider-config');
  const run = () => { const result = spawnSync('/bin/bash', ['-euc', seed], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 3000 }); assert.equal(result.status, 0, result.stderr); };
  try {
    run();
    const status = loadLiveConfig({ configDir, ownerId: 'synthetic-owner' });
    assert.equal(status.status, 'configured');
    if (status.status !== 'configured') throw Error('not configured');
    assert.equal(status.config.profile.limits.sessionMs, 3600000);
    assert.equal(status.config.profile.limits.idleMs, 300000);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const count of [1, 3]) test(`R5 recognizes the historical ${count}-connector template`, () => {
  const home = mkdtempSync(join(tmpdir(), 'didi-install-history-'));
  const path = join(home, 'Library/Application Support/ai.peat.lux-didi/provider-config/mcp.json');
  const run = () => { const result = spawnSync('/bin/bash', ['-euc', seed], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 3000 }); assert.equal(result.status, 0, result.stderr); };
  try {
    run(); const current = JSON.parse(readFileSync(path, 'utf8')); const old = structuredClone(current);
    old.endpoints = old.endpoints.slice(0, count); for (const entry of old.endpoints) delete entry.unknownClass;
    writeFileSync(path, `${JSON.stringify(old)}\n`); run();
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), current);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
