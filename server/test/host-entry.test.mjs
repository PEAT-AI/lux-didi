import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Store } from '../dist/runtime/store.js';
import { Outbox } from '../dist/runtime/outbox.js';
import { createDomainPort } from '../dist/domain/index.js';
import { chatMigrations } from '../dist/chat/index.js';
import { liveMigrations } from '../dist/live/index.js';

const entry = resolve(import.meta.dirname, '../dist/host/index.js');

function launch(argv, cwd) {
  const child = spawn(process.execPath, argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, killSignal: 'SIGKILL' });
  let stdout = '', stderr = '';
  let acceptLine;
  const line = new Promise(resolve => { acceptLine = resolve; });
  child.stdout.on('data', chunk => {
    stdout += String(chunk);
    if (stdout.includes('\n')) acceptLine(stdout.slice(0, stdout.indexOf('\n')));
  });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return {
    child, closed,
    line: Promise.race([line, closed.then(result => { throw new Error(`Host exited before ready: ${JSON.stringify(result)}`); })]),
  };
}

async function stop(process) {
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.stdin.end();
  await process.closed;
}

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'didi-entry-fixture-'));
  try {
    const linked = join(dir, 'host.js');
    await symlink(entry, linked);
    await run({ dir, linked });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function invoke(argv, cwd) {
  const process = launch(argv, cwd);
  // Non-supervised invocations do not consume readiness; observe their actual exit.
  process.line.catch(() => {});
  process.child.stdin.end();
  return process.closed;
}

test('canonical and symlink-addressed compiled entry print the same CLI help', async t => {
  await fixture(async ({ dir, linked }) => {
    const canonical = await invoke([entry, '--help'], dir);
    assert.equal(canonical.code, 0); assert.equal(canonical.signal, null); assert.equal(canonical.stderr, '');
    assert.match(canonical.stdout, /^Usage: node server\/dist\/host\/index\.js/);
    const symlinked = await invoke([linked, '--help'], dir);
    assert.equal(symlinked.code, 0); assert.equal(symlinked.signal, null); assert.equal(symlinked.stderr, '');
    assert.equal(symlinked.stdout, canonical.stdout, 'symlink-addressed actual entry must execute main');
    t.diagnostic(`canonical help=${Buffer.byteLength(canonical.stdout)} bytes; symlink help=${Buffer.byteLength(symlinked.stdout)} bytes; both exit0`);
  });
});

test('both entry spellings reject invalid CLI configuration without creating state', async t => {
  await fixture(async ({ dir, linked }) => {
    for (const path of [entry, linked]) {
      const result = await invoke([path, '--invalid-option'], dir);
      assert.deepEqual(result, { code: 1, signal: null, stdout: '', stderr: 'Invalid host configuration; see --help\n' });
      assert.deepEqual(await readdir(dir), ['host.js']);
    }
    t.diagnostic('canonical and symlink invalid flag: exit1, expected diagnostic, no state');
  });
});

test('importing the actual compiled entry through either spelling stays inert', async t => {
  await fixture(async ({ dir, linked }) => {
    for (const path of [entry, linked]) {
      const dataDir = join(dir, 'must-not-create-state');
      const result = await invoke(['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(path).href)})`,
        '--', '--supervised', '--data-dir', dataDir, '--web-root', join(dir, 'absent-web'), '--port', '0'], dir);
      assert.deepEqual(result, { code: 0, signal: null, stdout: '', stderr: '' });
      assert.deepEqual(await readdir(dir), ['host.js'], 'import must not create state or a listener that keeps the process alive');
    }
    t.diagnostic('both imported actual entry spellings: exit0, no stdout/stderr, no state, no live process/listener');
  });
});

test('symlink-addressed supervised host serves durable commands and closes on owned pipe EOF', async t => {
  await fixture(async ({ dir, linked }) => {
    // Synthetic static host fixture only: not a rendered UI or browser proof.
    const webRoot = join(dir, 'static-fixture'), dataDir = join(dir, 'isolated-state');
    await mkdir(join(webRoot, 'assets'), { recursive: true });
    for (const [file, content] of Object.entries({
      'index.html': '<script src="/assets/fixture.js"></script><link href="/assets/fixture.css" rel="stylesheet">',
      'assets/fixture.js': '// host process fixture', 'assets/fixture.css': '/* host process fixture */',
      'sw.js': '// host process fixture', 'manifest.webmanifest': '{}', 'icon.svg': '<svg/>',
    })) await writeFile(join(webRoot, file), content);
    const process = launch([linked, '--supervised', '--data-dir', dataDir, '--web-root', webRoot, '--port', '0'], dir);
    // Observe early failure too; cleanup below only owns this child and its pipe.
    process.line.catch(() => {});
    try {
      const nonce = randomUUID();
      process.child.stdin.write(`${JSON.stringify({ type: 'start', schemaVersion: 1, nonce })}\n`);
      const line = await process.line;
      assert.ok(Buffer.byteLength(line + '\n') <= 1024);
      const ready = JSON.parse(line);
      assert.deepEqual(Object.keys(ready).sort(), ['assistantId', 'authorityEpoch', 'nonce', 'origin', 'pid', 'schemaVersion', 'type'].sort());
      assert.equal(ready.type, 'ready'); assert.equal(ready.schemaVersion, 1);
      assert.equal(ready.nonce, nonce); assert.equal(ready.pid, process.child.pid);
      assert.match(ready.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      const descriptor = JSON.parse(await readFile(join(dataDir, 'host-runtime.json'), 'utf8'));
      assert.equal(ready.origin, descriptor.origin); assert.equal(ready.authorityEpoch, descriptor.authorityEpoch);
      const credential = (await readFile(join(dataDir, 'admin-credential'), 'utf8')).trim();
      assert.ok(!line.includes(credential));
      const headers = { Authorization: `Bearer ${credential}` };
      const status = await fetch(ready.origin + '/api/v1/status', { headers, signal: AbortSignal.timeout(3000) });
      assert.equal(status.status, 200); assert.equal((await status.json()).data.assistantId, ready.assistantId);
      const title = 'Synthetic symlink entry session';
      const saved = await fetch(ready.origin + '/api/v1/sessions', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Didi-Authority-Epoch': ready.authorityEpoch },
        body: JSON.stringify({ title, timeZone: 'UTC' }), signal: AbortSignal.timeout(3000),
      });
      assert.equal(saved.status, 200);
      const session = (await saved.json()).data;
      const recalled = await fetch(`${ready.origin}/api/v1/sessions/${session.id}`, { headers, signal: AbortSignal.timeout(3000) });
      assert.equal(recalled.status, 200); assert.equal((await recalled.json()).data.session.title, title);
      process.child.stdin.end();
      const result = await process.closed;
      assert.deepEqual(result, { code: 0, signal: null, stdout: line + '\n', stderr: '' });
      await assert.rejects(fetch(ready.origin + '/api/v1/status', { headers, signal: AbortSignal.timeout(3000) }));
      // Reopening the real Store proves EOF releases the single-writer lease and preserves its identity.
      // The reopen imports the complete current owner migration set (domain + chat + live).
      const store = new Store(dataDir, [...createDomainPort({ outbox: Outbox }).migrations, ...chatMigrations, ...liveMigrations]);
      try { assert.equal(store.assistantId, ready.assistantId); } finally { store.close(); }
      t.diagnostic('symlink start/ready nonce+pid matched; session POST200/GET200 with matching title; EOF exit0; listener refused; real Store reopened with stable identity');
    } finally { await stop(process); }
  });
});
