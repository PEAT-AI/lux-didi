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
    if (kind === 'live') assert.deepEqual(current.dataClasses, ['ordinary', 'private']);
    else for (const entry of current.endpoints) assert.equal(entry.unknownClass, 'private');
    const old = structuredClone(current);
    if (kind === 'live') old.dataClasses = ['ordinary'];
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
