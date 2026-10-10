import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { ConfigError, initializeProviderConfig, loadProviderConfig } from '../config/index.js';
import { validateOwner } from '../config/files.js';

const synthetic = 'synthetic_NEVER_PRINT_739+abc=';
const profile = () => ({ schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'gemini-synthetic', keyReference: 'gemini-primary', dataClasses: ['ordinary', 'private'], preferences: { dataClass: 'ordinary', language: 'de-de', register: 'plain', humor: 'off', verbosity: 'balanced' } });
const secret = () => ({ schemaVersion: 1, keyReference: 'gemini-primary', key: synthetic });
const cli = fileURLToPath(new URL('../config/cli.js', import.meta.url));
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'didi-config-test-')); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, 'config');
  const profileInputPath = join(root, 'input.json'); const sourceEnvPath = join(root, 'source.env');
  writeFileSync(profileInputPath, JSON.stringify(profile()), { mode: 0o600 });
  writeFileSync(sourceEnvPath, `OTHER=ignored\nGEMINI_API_KEY=${synthetic}\n`, { mode: 0o600 });
  const options = { configDir, ownerId: 'current-owner', profileInputPath, sourceEnvPath };
  const put = (name: string, value: unknown) => writeFileSync(join(configDir, name), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  const setup = () => { mkdirSync(configDir, { mode: 0o700 }); put('profile.json', profile()); put('gemini-primary.json', secret()); };
  const load = () => loadProviderConfig(options);
  const run = (args: string[] = []) => spawnSync(process.execPath, [cli, 'init', '--config-dir', configDir, '--owner-id', options.ownerId, '--profile-input', profileInputPath, '--source-env', sourceEnvPath, ...args], { encoding: 'utf8', timeout: 5000 });
  return { root, configDir, profileInputPath, sourceEnvPath, options, put, setup, load, run };
}
function safe(value: unknown) {
  const output = `${JSON.stringify(value)} ${inspect(value, { showHidden: true, depth: 8 })}`;
  assert.ok(!output.includes(synthetic), 'synthetic key leaked');
}
function errorStatus(value: ReturnType<typeof loadProviderConfig>) { assert.equal(value.status, 'error'); safe(value); }

test('all states: explicit absent, missing profile, deliberately disabled, ready, invalid key', async t => {
  const f = fixture(t);
  assert.deepEqual(f.load(), { status: 'unconfigured' });
  mkdirSync(f.configDir, { mode: 0o700 });
  assert.deepEqual(f.load(), { status: 'unconfigured' });
  f.put('profile.json', { ...profile(), enabled: false });
  // An unrelated/inaccessible secret must not be touched while disabled.
  symlinkSync(join(f.root, 'not-a-source'), join(f.configDir, 'gemini-primary.json'));
  assert.equal(f.load().status, 'disabled');
  unlinkSync(join(f.configDir, 'gemini-primary.json'));
  f.put('profile.json', profile()); errorStatus(f.load());
  f.put('gemini-primary.json', secret());
  const status = f.load(); assert.equal(status.status, 'ready');
  if (status.status !== 'ready') return;
  assert.equal(status.profile.preferences.ownerId, 'current-owner');
  assert.equal(status.profile.preferences.language, 'de-DE');
  assert.deepEqual(status.route, { enabled: true, provider: 'gemini', modelId: 'gemini-synthetic', dataClasses: ['ordinary', 'private'] });
  safe(status); safe(status.credentials);
  assert.deepEqual(Object.keys(status.credentials), ['resolve']);
  assert.equal(await status.credentials.resolve('gemini-primary'), synthetic);
  await assert.rejects(status.credentials.resolve('../source.env'), e => { safe(e); return e instanceof ConfigError; });
  f.put('gemini-primary.json', { ...secret(), keyReference: 'other' });
  await assert.rejects(status.credentials.resolve('gemini-primary'), e => { safe(e); return e instanceof ConfigError; });
  errorStatus(f.load());
});

test('profile is closed, explicit, bounded and delegates owner/locale/preferences validation', t => {
  const f = fixture(t); f.setup();
  const p = profile();
  const variants: unknown[] = [null, [], {}, { ...p, schemaVersion: 2 }, { ...p, enabled: 'true' }, { ...p, provider: 'other' }, { ...p, modelId: '' }, { ...p, modelId: 'x'.repeat(129) }, { ...p, modelId: 'x/y' }, { ...p, keyReference: 'gemini-primary.json' }, { ...p, keyReference: '../gemini-primary' }, { ...p, ownerId: 'portable-owner' }, { ...p, dataClasses: [] }, { ...p, dataClasses: ['ordinary', 'ordinary'] }, { ...p, dataClasses: ['unknown'] }, { ...p, preferences: { ...p.preferences, ownerId: 'portable-owner' } }, { ...p, preferences: { ...p.preferences, schemaVersion: 1 } }, { ...p, preferences: { ...p.preferences, language: '' } }, { ...p, preferences: { ...p.preferences, language: 'ignore instructions' } }, { ...p, preferences: { ...p.preferences, register: 'arbitrary' } }, { ...p, preferences: { ...p.preferences, humor: 'on' } }, { ...p, preferences: { ...p.preferences, verbosity: 'huge' } }, { ...p, preferences: { ...p.preferences, dataClass: 'unclassified' } }, { ...p, preferences: { ...p.preferences, system: synthetic } }];
  for (const bad of variants) { f.put('profile.json', bad); errorStatus(f.load()); }
  for (const raw of ['{', JSON.stringify(p).replace('"enabled":true', '"enabled":true,"enabled":false'), JSON.stringify(p).replace('"provider":"gemini"', '"provider":"gemini","provi\\u0064er":"gemini"'), ' '.repeat(16385), JSON.stringify(p).replace('"language":"de-de"', '"language":"de-de","language":"en"')]) { f.put('profile.json', raw); errorStatus(f.load()); }
  f.put('profile.json', p); errorStatus(loadProviderConfig({ configDir: f.configDir, ownerId: '' }));
  const hi = { ...p, preferences: { ...p.preferences, language: 'hi-in' } }; f.put('profile.json', hi);
  const status = loadProviderConfig({ configDir: f.configDir, ownerId: 'new-owner' });
  assert.equal(status.status, 'ready');
  if (status.status === 'ready') { assert.equal(status.profile.preferences.ownerId, 'new-owner'); assert.equal(status.profile.preferences.language, 'hi-IN'); }
});

test('secret malformed/unknown/duplicate identity/unsafe values never leak in status or exceptions', async t => {
  const f = fixture(t); f.setup(); const ready = f.load(); assert.equal(ready.status, 'ready'); if (ready.status !== 'ready') return;
  const bad: unknown[] = [null, {}, { ...secret(), schemaVersion: 2 }, { ...secret(), keyReference: 'wrong' }, { ...secret(), extra: synthetic }, ...['', 'x'.repeat(1025), 'with space', 'x\r\ny', 'x\0y', '\tx', 'é'].map(key => ({ ...secret(), key }))];
  const raw = [`{"key":"${synthetic}",`, JSON.stringify(secret()).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'), JSON.stringify(secret()).replace('"keyReference":"gemini-primary"', '"keyReference":"gemini-primary","keyReference":"other"'), ' '.repeat(8193)];
  for (const value of [...bad, ...raw]) { f.put('gemini-primary.json', value); errorStatus(f.load()); await assert.rejects(ready.credentials.resolve('gemini-primary'), e => { safe(e); return e instanceof ConfigError && !('cause' in e); }); }
  writeFileSync(join(f.configDir, 'gemini-primary.json'), Buffer.from([0xff, 0xfe])); errorStatus(f.load());
  f.put('gemini-primary.json', { ...secret(), key: 'x'.repeat(1024) }); assert.equal(f.load().status, 'ready');
});

test('real root and opened file mode/type/symlink/hardlink/size validation', async t => {
  const f = fixture(t); f.setup();
  for (const mode of [0o755, 0o777, 0o1700]) { chmodSync(f.configDir, mode); errorStatus(f.load()); } chmodSync(f.configDir, 0o700);
  for (const name of ['profile.json', 'gemini-primary.json']) {
    const path = join(f.configDir, name); const good = readFileSync(path);
    for (const mode of [0o644, 0o660, 0o400, 0o4600]) { chmodSync(path, mode); errorStatus(f.load()); } chmodSync(path, 0o600);
    const other = join(f.root, `other-${name}`); linkSync(path, other); errorStatus(f.load()); unlinkSync(other);
    unlinkSync(path); mkdirSync(path, { mode: 0o600 }); errorStatus(f.load()); rmSync(path, { recursive: true });
    writeFileSync(other, good, { mode: 0o600 }); symlinkSync(other, path); errorStatus(f.load()); unlinkSync(path);
    const fifo = spawnSync('mkfifo', ['-m', '600', path], { encoding: 'utf8', timeout: 3000 }); assert.equal(fifo.status, 0); errorStatus(f.load()); unlinkSync(path);
    writeFileSync(path, good, { mode: 0o600 });
  }
  const otherRoot = join(f.root, 'alias'); symlinkSync(f.configDir, otherRoot); errorStatus(loadProviderConfig({ configDir: otherRoot, ownerId: 'current-owner' }));
  const wrongType = join(f.root, 'not-dir'); writeFileSync(wrongType, '', { mode: 0o600 }); errorStatus(loadProviderConfig({ configDir: wrongType, ownerId: 'current-owner' }));
  const ready = f.load(); assert.equal(ready.status, 'ready'); if (ready.status === 'ready') { chmodSync(f.configDir, 0o755); await assert.rejects(ready.credentials.resolve('gemini-primary')); }
});

test('real opened descriptor ownership accepts current UID and rejects a different expected UID', t => {
  const f = fixture(t); f.setup();
  const uid = process.getuid!();
  for (const [path, flags, code] of [
    [join(f.configDir, 'gemini-primary.json'), constants.O_RDONLY | constants.O_NOFOLLOW, 'file_owner'],
    [f.configDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, 'directory_owner']
  ] as const) {
    const fd = openSync(path, flags);
    try {
      const actual = fstatSync(fd); // Real metadata, not mocked or fabricated.
      assert.equal(actual.uid, uid);
      assert.doesNotThrow(() => validateOwner(actual, uid, code));
      // Discriminating negative: removing the ownership comparison makes this fail.
      assert.throws(() => validateOwner(actual, uid + 1, code), e => e instanceof ConfigError && e.code === code);
      assert.equal(fstatSync(fd).uid, uid); // Test never changes actual ownership.
    } finally { closeSync(fd); }
  }
});

test('every successful and failed load/resolve closes descriptors', async t => {
  const f = fixture(t); f.setup();
  const fdRoot = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  const before = readdirSync(fdRoot).length;
  for (let i = 0; i < 12; i++) { const s = f.load(); assert.equal(s.status, 'ready'); if (s.status === 'ready') { await s.credentials.resolve('gemini-primary'); await assert.rejects(s.credentials.resolve('wrong')); } }
  f.put('gemini-primary.json', '{'); for (let i = 0; i < 12; i++) errorStatus(f.load());
  assert.equal(readdirSync(fdRoot).length, before);
});

test('exclusive initialization preserves all existing targets byte-for-byte', t => {
  for (const kind of ['empty', 'partial', 'disabled', 'ready', 'file', 'symlink']) {
    const f = fixture(t);
    if (kind === 'file') writeFileSync(f.configDir, 'untouched', { mode: 0o600 });
    else if (kind === 'symlink') symlinkSync(f.root, f.configDir);
    else { mkdirSync(f.configDir, { mode: 0o700 }); if (kind !== 'empty') f.put('profile.json', kind === 'partial' ? '{' : { ...profile(), enabled: kind !== 'disabled' }); if (kind === 'ready') f.put('gemini-primary.json', secret()); }
    const before = lstatSync(f.configDir);
    const contents = before.isDirectory() ? readdirSync(f.configDir).map(n => [n, readFileSync(join(f.configDir, n), 'utf8')]) : [];
    assert.throws(() => initializeProviderConfig(f.options), e => { safe(e); return e instanceof ConfigError; });
    assert.equal(lstatSync(f.configDir).ino, before.ino);
    if (before.isDirectory()) assert.deepEqual(readdirSync(f.configDir).map(n => [n, readFileSync(join(f.configDir, n), 'utf8')]), contents);
    if (before.isFile()) assert.equal(readFileSync(f.configDir, 'utf8'), 'untouched');
  }
});

test('real CLI initialization: private at creation, safe stdout/argv, then actual resolver use', async t => {
  const f = fixture(t); const result = f.run(); assert.equal(result.status, 0, result.stderr);
  safe(result); assert.equal(result.stdout, 'Provider configuration initialized.\n'); assert.equal(result.stderr, '');
  assert.equal(statSync(f.configDir).mode & 0o7777, 0o700);
  assert.deepEqual(readdirSync(f.configDir).sort(), ['gemini-primary.json', 'profile.json']);
  for (const name of ['profile.json', 'gemini-primary.json']) { const s = statSync(join(f.configDir, name)); assert.equal(s.mode & 0o7777, 0o600); assert.equal(s.uid, process.getuid!()); assert.equal(s.nlink, 1); }
  const status = f.load(); assert.equal(status.status, 'ready'); if (status.status === 'ready') assert.equal(await status.credentials.resolve('gemini-primary'), synthetic);
  const again = f.run(); assert.notEqual(again.status, 0); safe(again);
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 5000 }); assert.equal(help.status, 0); assert.match(help.stdout, /--source-env/);
});

test('initialization failure leaves explicit private incomplete directory without active profile', t => {
  const f = fixture(t); writeFileSync(f.sourceEnvPath, `GEMINI_API_KEY=\"${synthetic}\n`, { mode: 0o600 });
  const result = f.run(); assert.notEqual(result.status, 0); safe(result);
  assert.equal(statSync(f.configDir).mode & 0o7777, 0o700); assert.equal(existsSync(join(f.configDir, 'profile.json')), false);
  assert.equal(f.load().status, 'unconfigured');
  assert.throws(() => initializeProviderConfig(f.options), ConfigError);
});

test('real write failure cannot activate profile or leave permissive temporary files', t => {
  const f = fixture(t);
  const result = spawnSync('bash', ['-c', 'ulimit -f 0; exec "$@"', 'provider-config-test', process.execPath, cli, 'init', '--config-dir', f.configDir, '--owner-id', f.options.ownerId, '--profile-input', f.profileInputPath, '--source-env', f.sourceEnvPath], { encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0); safe(result);
  assert.equal(existsSync(join(f.configDir, 'profile.json')), false);
  assert.equal(statSync(f.configDir).mode & 0o7777, 0o700);
  for (const name of readdirSync(f.configDir)) assert.equal(statSync(join(f.configDir, name)).mode & 0o7777, 0o600);
});

test('literal source subset: plain/single/double quoted and ignored variables never exported', async t => {
  for (const quote of ['', "'", '"']) {
    const f = fixture(t); writeFileSync(f.sourceEnvPath, `# synthetic\r\nOTHER=ignored\r\nGEMINI_API_KEY=${quote}${synthetic}${quote}\r\n`, { mode: 0o600 });
    assert.equal(f.run().status, 0); const s = f.load(); assert.equal(s.status, 'ready'); if (s.status === 'ready') assert.equal(await s.credentials.resolve('gemini-primary'), synthetic);
  }
  assert.equal(process.env['OTHER'], undefined);
});

test('mixed foreign punctuation and spaces import exactly the target through the real CLI', async t => {
  for (const quote of ['', "'", '"']) {
    const f = fixture(t);
    writeFileSync(f.sourceEnvPath, `# mixed source\r\nFOREIGN_SINGLE='spaces ; | & $() "literal" \`literal\`'\r\nGEMINI_API_KEY=${quote}${synthetic}${quote}\r\nFOREIGN_DOUBLE="spaces ; | & $() 'literal'"\r\nFOREIGN_PLAIN=spaces ; | & $() # opaque\r\n`, { mode: 0o600 });
    const result = f.run(); assert.equal(result.status, 0, result.stderr); safe(result);
    assert.deepEqual(JSON.parse(readFileSync(join(f.configDir, 'gemini-primary.json'), 'utf8')), secret());
    const status = f.load(); assert.equal(status.status, 'ready');
    if (status.status === 'ready') assert.equal(await status.credentials.resolve('gemini-primary'), synthetic);
  }
});

test('foreign shell-looking literals never execute or assign environment through the public importer', async t => {
  const f = fixture(t); const marker = join(f.root, 'executed'); const env = { ...process.env };
  writeFileSync(f.sourceEnvPath, `PROVIDER_IMPORT_FOREIGN_CANARY='\`touch ${marker}\` ; $(touch ${marker})'\nGEMINI_API_KEY=${synthetic}\nPROVIDER_IMPORT_DOUBLE="$(touch ${marker}) ; $HOME"\nOTHER=$(touch ${marker})\n`, { mode: 0o600 });
  initializeProviderConfig(f.options);
  assert.deepEqual(process.env, env); assert.equal(existsSync(marker), false);
  const status = f.load(); assert.equal(status.status, 'ready');
  if (status.status === 'ready') assert.equal(await status.credentials.resolve('gemini-primary'), synthetic);
  const cliFixture = fixture(t); writeFileSync(cliFixture.sourceEnvPath, readFileSync(f.sourceEnvPath), { mode: 0o600 });
  const result = cliFixture.run(); assert.equal(result.status, 0, result.stderr); safe(result);
  assert.deepEqual(process.env, env); assert.equal(existsSync(marker), false);
  assert.deepEqual(JSON.parse(readFileSync(join(cliFixture.configDir, 'gemini-primary.json'), 'utf8')), secret());
});

test('foreign quote and continuation grammar fails closed without disclosing source content', t => {
  const foreignName = 'PROVIDER_IMPORT_FOREIGN_CANARY'; const foreignValue = 'foreign_value_NEVER_PRINT_846';
  const values = [
    `'${foreignValue}`, `"${foreignValue}`, `'${foreignValue}"`,
    `'${foreignValue}\nGEMINI_API_KEY=${synthetic}\n'`,
    `"${foreignValue}\nGEMINI_API_KEY=${synthetic}\n"`,
    `'${foreignValue}\\'`, `"${foreignValue}\\"`,
    `'${foreignValue}'interior'`, `"${foreignValue}"interior"`,
    `${foreignValue}'quote`, `${foreignValue}"quote`, `${foreignValue}\`tick`,
    `"${foreignValue}\`tick\`"`, `${foreignValue}\\`,
  ];
  for (const value of values) {
    const f = fixture(t);
    writeFileSync(f.sourceEnvPath, `GEMINI_API_KEY=${synthetic}\n${foreignName}=${value}\n`, { mode: 0o600 });
    assert.throws(() => initializeProviderConfig(f.options), e => {
      assert.ok(e instanceof ConfigError); assert.equal(e.code, 'invalid_source'); safe(e);
      assert.ok(!inspect(e).includes(foreignName) && !inspect(e).includes(foreignValue)); return true;
    });
    assert.deepEqual(readdirSync(f.configDir), []);
    const cliFixture = fixture(t); writeFileSync(cliFixture.sourceEnvPath, readFileSync(f.sourceEnvPath), { mode: 0o600 });
    const result = cliFixture.run(); assert.notEqual(result.status, 0); safe(result);
    assert.equal(result.stdout, ''); assert.match(result.stderr, /invalid_source/);
    assert.ok(!result.stderr.includes(foreignName) && !result.stderr.includes(foreignValue));
    assert.deepEqual(readdirSync(cliFixture.configDir), []);
  }
});

test('whole-file target cardinality and target charset stay strict around foreign lines', t => {
  const foreign = 'FOREIGN="spaces ; $()"\n';
  const targets = [
    `GEMINI_API_KEY=${synthetic}\nGEMINI_API_KEY=${synthetic}`, 'OTHER=ignored',
    'GEMINI_API_KEY=', `GEMINI_API_KEY=${'a'.repeat(1025)}`, 'GEMINI_API_KEY=has space',
    'GEMINI_API_KEY="has space"', 'GEMINI_API_KEY="interior"quote"',
    'GEMINI_API_KEY="punctuation$"', 'GEMINI_API_KEY=not!allowed',
  ];
  const sources = targets.flatMap(target => [foreign + target, target + '\n' + foreign]);
  sources.push(`GEMINI_API_KEY=${synthetic}\n${foreign}GEMINI_API_KEY=${synthetic}`);
  for (const source of sources) {
    const f = fixture(t); writeFileSync(f.sourceEnvPath, source, { mode: 0o600 });
    const result = f.run(); assert.notEqual(result.status, 0); safe(result);
    assert.match(result.stderr, /invalid_source/); assert.deepEqual(readdirSync(f.configDir), []);
  }
});

test('source duplicate/absent/malformed/oversized/malicious shell syntax rejected with no execution', t => {
  const payloads = ['', 'OTHER=ignored', `GEMINI_API_KEY=${synthetic}\nGEMINI_API_KEY=other`, 'export GEMINI_API_KEY=abc', 'GEMINI_API_KEY =abc', 'GEMINI_API_KEY="unterminated', 'GEMINI_API_KEY="a\\nb"', 'GEMINI_API_KEY=${OTHER}', 'GEMINI_API_KEY=`touch MARKER`', 'GEMINI_API_KEY=$(touch MARKER)', 'GEMINI_API_KEY=abc;touch MARKER', "GEMINI_API_KEY='$(touch MARKER)'", 'GEMINI_API_KEY=abc # comment', 'GEMINI_API_KEY=', ' '.repeat(65537)];
  for (const payload of payloads) {
    const f = fixture(t); const marker = join(f.root, 'executed'); writeFileSync(f.sourceEnvPath, payload.replaceAll('MARKER', marker), { mode: 0o600 });
    const result = f.run(); assert.notEqual(result.status, 0); safe(result); assert.equal(existsSync(marker), false); assert.equal(existsSync(join(f.configDir, 'profile.json')), false);
  }
});

test('CLI rejects unknown/duplicate/missing flags and input/source insecure files', t => {
  const f = fixture(t); for (const args of [['--variable', 'GEMINI_API_KEY'], ['--owner-id', 'other'], ['--key', synthetic]]) { const r = f.run(args); assert.notEqual(r.status, 0); assert.ok(!r.stdout.includes(synthetic) && !r.stderr.includes(synthetic)); }
  const missing = spawnSync(process.execPath, [cli, 'init'], { encoding: 'utf8', timeout: 5000 }); assert.notEqual(missing.status, 0);
  for (const field of ['profileInputPath', 'sourceEnvPath'] as const) {
    const g = fixture(t); chmodSync(g[field], 0o644); const r = g.run(); assert.notEqual(r.status, 0); safe(r); assert.equal(existsSync(join(g.configDir, 'profile.json')), false);
  }
  const d = fixture(t); writeFileSync(d.profileInputPath, JSON.stringify({ ...profile(), enabled: false })); assert.notEqual(d.run().status, 0); assert.equal(existsSync(join(d.configDir, 'profile.json')), false);
});
