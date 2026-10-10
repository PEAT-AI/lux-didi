import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConfigError, credentialReceiptFor, credentialsFor, loadProviderConfig, requestCredentialsFor, type CredentialRouteScope } from '../config/index.js';
import { GeminiAdapter } from '../adapters/model/gemini.js';
import type { ModelRequest, Transport } from '../adapters/model/types.js';

const key = 'synthetic_BINDING_SECRET_never_public';
const nextKey = 'synthetic_ROTATED_SECRET_never_public';
const scope: CredentialRouteScope = { provider: 'gemini', modelId: 'gemini-synthetic', endpoint: 'https://generativelanguage.googleapis.com', apiVersion: 'v1beta', keyReference: 'gemini-primary', allowedClasses: ['ordinary', 'private'] };
const binding = () => ({ schemaVersion: 1, configuredAccount: 'operator-account-A', routeScope: { ...scope, allowedClasses: ['private', 'ordinary'] }, bindingGeneration: 'generation-A' });
const profile = () => ({ schemaVersion: 1, enabled: true, provider: 'gemini', modelId: scope.modelId, keyReference: scope.keyReference, dataClasses: ['ordinary', 'private'], preferences: { dataClass: 'ordinary', language: 'de-de', register: 'plain', humor: 'off', verbosity: 'balanced' } });
const cli = fileURLToPath(new URL('../config/cli.js', import.meta.url));
const error = (e: unknown) => e instanceof ConfigError && !e.message.includes(key) && !e.message.includes(nextKey);
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'didi-binding-')); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'config');
  const profilePath = join(root, 'profile-input.json');
  const sourcePath = join(root, 'source.env');
  const bindingPath = join(root, 'binding-input.json');
  const put = (path: string, text: string) => { writeFileSync(path, text, { mode: 0o600 }); chmodSync(path, 0o600); };
  put(profilePath, JSON.stringify(profile())); put(sourcePath, `GEMINI_API_KEY=${key}\n`); put(bindingPath, JSON.stringify(binding()));
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
  const init = (bound = true) => run(['init', '--config-dir', dir, '--owner-id', 'owner', '--profile-input', profilePath, '--source-env', sourcePath, ...(bound ? ['--binding-input', bindingPath] : [])]);
  const migrate = () => run(['migrate-binding', '--config-dir', dir, '--owner-id', 'owner', '--binding-input', bindingPath]);
  const secretPath = join(dir, 'gemini-primary.json');
  const replace = (change: Record<string, unknown>) => {
    const current = JSON.parse(readFileSync(secretPath, 'utf8')) as Record<string, unknown>;
    const pending = join(dir, 'replacement.json'); put(pending, JSON.stringify({ ...current, ...change })); renameSync(pending, secretPath);
  };
  return { root, dir, put, run, init, migrate, secretPath, bindingPath, profilePath, replace };
}
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const request: ModelRequest = { system: 'synthetic instruction', promptVersion: 'test', contents: [{ role: 'user', parts: [{ text: 'synthetic question' }] }], dataClasses: ['ordinary'], context: { items: [], selectedIds: [], maxChars: 100 } };
function adapter(credentials: { resolve(reference: string): Promise<string | undefined> }, transport: Transport) {
  return new GeminiAdapter({ modelId: scope.modelId, keyReference: scope.keyReference, credentials, transport, route: { enabled: true, provider: 'gemini', modelId: scope.modelId, dataClasses: ['ordinary', 'private'] } });
}
const response = () => new Response('data: {"candidates":[{"content":{"parts":[{"text":"synthetic answer"}]},"finishReason":"STOP"}]}\n\n', { status: 200 });

test('A1 actual CLI v2 import, protected load and string resolution; detached non-secret receipt', async t => {
  const f = fixture(t); const imported = f.init(); assert.equal(imported.status, 0, imported.stderr);
  assert.equal(loadProviderConfig({ configDir: f.dir, ownerId: 'owner' }).status, 'ready');
  assert.equal(await credentialsFor(f.dir).resolve('gemini-primary'), key);
  const invocation = requestCredentialsFor(f.dir, scope);
  assert.equal(invocation.resolvedReceipt(), undefined);
  assert.equal(await invocation.credentials.resolve('gemini-primary'), key);
  const receipt = invocation.resolvedReceipt()!;
  assert.equal(receipt.configuredAccount, 'operator-account-A'); assert.equal(receipt.schemaVersion, 1);
  assert.deepEqual(receipt.routeScope.allowedClasses, ['ordinary', 'private']);
  assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.routeScope) && Object.isFrozen(receipt.routeScope.allowedClasses));
  assert.ok(!JSON.stringify({ receipt, imported }).includes(key));
  assert.deepEqual(credentialReceiptFor(f.dir, scope), receipt);
});

test('A1 rejected protected records yield sanitized errors and zero actual adapter transport', async t => {
  const f = fixture(t); assert.equal(f.init().status, 0);
  const valid = readFileSync(f.secretPath, 'utf8'); let calls = 0;
  const transport: Transport = async () => { calls++; return response(); };
  const cases: (() => void)[] = [
    () => f.put(f.secretPath, '{malformed'),
    () => f.put(f.secretPath, valid.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2')),
    () => f.put(f.secretPath, ' '.repeat(8193)),
    () => chmodSync(f.secretPath, 0o644),
    () => { unlinkSync(f.secretPath); symlinkSync(f.bindingPath, f.secretPath); },
    () => f.replace({ key: key + '\n' }),
    () => f.replace({ extra: key }),
    () => f.replace({ schemaVersion: 3 }),
  ];
  for (const corrupt of cases) {
    if (existsSync(f.secretPath)) unlinkSync(f.secretPath); f.put(f.secretPath, valid); corrupt();
    assert.throws(() => credentialReceiptFor(f.dir, scope), error);
    const result = await adapter(requestCredentialsFor(f.dir, scope).credentials, transport).generate(request, { signal: new AbortController().signal, deadlineMs: Date.now() + 3000 });
    assert.equal(result.status, 'error'); assert.ok(!JSON.stringify(result).includes(key));
  }
  assert.equal(calls, 0);
  if (process.getuid?.() === 0) { // A non-root process cannot manufacture a foreign-owned inode.
    unlinkSync(f.secretPath); f.put(f.secretPath, valid); chownSync(f.secretPath, 1, 1);
    assert.throws(() => credentialReceiptFor(f.dir, scope), error);
  }
});

test('A2 keys and receipts share one record, concurrent invocations keep private receipts', async t => {
  const f = fixture(t); assert.equal(f.init().status, 0);
  const first = requestCredentialsFor(f.dir, scope); const second = requestCredentialsFor(f.dir, scope);
  const barrier = deferred(); const observed = deferred(); const sent: string[] = [];
  const delayed = { resolve: async (ref: string) => { const value = await first.credentials.resolve(ref); observed.release(); await barrier.promise; return value; } };
  const transport: Transport = async (_url, init) => { sent.push(new Headers(init.headers).get('x-goog-api-key')!); return response(); };
  const firstRun = adapter(delayed, transport).generate(request, { signal: new AbortController().signal, deadlineMs: Date.now() + 3000 });
  await observed.promise;
  f.replace({ key: nextKey, configuredAccount: 'operator-account-B', bindingGeneration: 'generation-B' });
  const secondRun = await adapter(second.credentials, transport).generate(request, { signal: new AbortController().signal, deadlineMs: Date.now() + 3000 });
  barrier.release(); const firstResult = await firstRun;
  assert.equal(secondRun.status, 'complete'); assert.equal(firstResult.status, 'complete');
  assert.deepEqual(sent, [nextKey, key]);
  assert.equal(first.resolvedReceipt()!.configuredAccount, 'operator-account-A');
  assert.equal(second.resolvedReceipt()!.configuredAccount, 'operator-account-B');
  assert.equal(first.resolvedReceipt()!.bindingGeneration, 'generation-A');
  assert.equal(second.resolvedReceipt()!.bindingGeneration, 'generation-B');
  assert.ok(!JSON.stringify([first.resolvedReceipt(), second.resolvedReceipt(), firstResult, secondRun]).includes(key));
});

test('A3 fresh current locator detects post-resolve rebind, invalidation, deletion and full scope mismatch', async t => {
  const f = fixture(t); assert.equal(f.init().status, 0);
  const invocation = requestCredentialsFor(f.dir, scope); await invocation.credentials.resolve('gemini-primary');
  const resolved = invocation.resolvedReceipt()!; const barrier = deferred();
  const guard = async () => { await barrier.promise; return JSON.stringify(credentialReceiptFor(f.dir, scope)) === JSON.stringify(resolved); };
  const pending = guard(); f.replace({ configuredAccount: 'operator-account-B' }); barrier.release(); assert.equal(await pending, false);
  for (const change of [{ modelId: 'gemini-other' }, { provider: 'other' }, { endpoint: 'https://invalid.example' }, { apiVersion: 'v1' }, { keyReference: 'wrong' }, { allowedClasses: ['ordinary'] }]) {
    assert.throws(() => credentialReceiptFor(f.dir, { ...scope, ...change } as CredentialRouteScope), error);
  }
  f.replace({ key: '' }); assert.throws(() => credentialReceiptFor(f.dir, scope), error);
  unlinkSync(f.secretPath); assert.throws(() => credentialReceiptFor(f.dir, scope), error);
});

test('A4 equal binding permits key rotation, account/scope/generation changes differ and failures clear invocation receipt', async t => {
  const f = fixture(t); assert.equal(f.init().status, 0);
  const old = credentialReceiptFor(f.dir, scope); f.replace({ key: nextKey });
  const invocation = requestCredentialsFor(f.dir, scope); assert.equal(await invocation.credentials.resolve('gemini-primary'), nextKey);
  assert.deepEqual(invocation.resolvedReceipt(), old);
  f.replace({ bindingGeneration: 'generation-B' }); assert.notDeepEqual(credentialReceiptFor(f.dir, scope), old);
  f.replace({ bindingGeneration: 'generation-A', configuredAccount: 'operator-account-B' }); assert.notDeepEqual(credentialReceiptFor(f.dir, scope), old);
  f.replace({ configuredAccount: 'operator-account-A', routeScope: { ...scope, allowedClasses: ['ordinary'] } });
  assert.notDeepEqual(credentialReceiptFor(f.dir, { ...scope, allowedClasses: ['ordinary'] }), old);
  await assert.rejects(invocation.credentials.resolve('wrong'), error); assert.equal(invocation.resolvedReceipt(), undefined);
});

test('A5 legacy remains readable, explicit migration retains exact sensitive legacy and profile bytes', async t => {
  const f = fixture(t); assert.equal(f.init(false).status, 0);
  const original = readFileSync(f.secretPath); const oldProfile = readFileSync(join(f.dir, 'profile.json'));
  assert.equal(await credentialsFor(f.dir).resolve('gemini-primary'), key);
  assert.throws(() => credentialReceiptFor(f.dir, scope), error);
  await assert.rejects(requestCredentialsFor(f.dir, scope).credentials.resolve('gemini-primary'), error);
  const migrated = f.migrate(); assert.equal(migrated.status, 0, migrated.stderr);
  assert.deepEqual(readFileSync(join(f.dir, 'gemini-primary.legacy.json')), original);
  assert.deepEqual(readFileSync(join(f.dir, 'profile.json')), oldProfile);
  assert.equal(await credentialsFor(f.dir).resolve('gemini-primary'), key);
  assert.equal(credentialReceiptFor(f.dir, scope).configuredAccount, 'operator-account-A');
  assert.ok(!JSON.stringify(migrated).includes(key));
  assert.notEqual(f.migrate().status, 0); assert.deepEqual(readFileSync(join(f.dir, 'gemini-primary.legacy.json')), original);
});

test('A5 migration validates before activation; backup collision and interrupted retry retain usable state', async t => {
  const f = fixture(t); assert.equal(f.init(false).status, 0); const original = readFileSync(f.secretPath);
  for (const input of [{ ...binding(), unknown: key }, { ...binding(), configuredAccount: '' }, { ...binding(), bindingGeneration: '' }, { ...binding(), routeScope: { ...scope, modelId: 'wrong' } }, { ...binding(), routeScope: { ...scope, keyReference: 'wrong' } }, { ...binding(), routeScope: { ...scope, allowedClasses: ['ordinary'] } }]) {
    f.put(f.bindingPath, JSON.stringify(input)); const failed = f.migrate(); assert.notEqual(failed.status, 0); assert.ok(!JSON.stringify(failed).includes(key));
    assert.deepEqual(readFileSync(f.secretPath), original); assert.equal(existsSync(join(f.dir, 'gemini-primary.legacy.json')), false);
  }
  f.put(f.bindingPath, JSON.stringify(binding()));
  const backup = join(f.dir, 'gemini-primary.legacy.json'); f.put(backup, original.toString());
  assert.notEqual(f.migrate().status, 0); assert.deepEqual(readFileSync(backup), original); assert.deepEqual(readFileSync(f.secretPath), original);
  unlinkSync(backup);
  mkdirSync(join(f.dir, '.binding.pending'), { mode: 0o700 });
  assert.notEqual(f.migrate().status, 0); assert.equal(await credentialsFor(f.dir).resolve('gemini-primary'), key);
  rmSync(join(f.dir, '.binding.pending'), { recursive: true });
  // A failure must not overwrite a retained backup; retry remains visibly blocked if one was already published.
  const retried = f.migrate(); if (existsSync(backup) && retried.status !== 0) {
    assert.deepEqual(readFileSync(backup), original); assert.equal(await credentialsFor(f.dir).resolve('gemini-primary'), key);
  } else { assert.equal(retried.status, 0); assert.deepEqual(readFileSync(backup), original); }
});

test('A1 binding inputs and CLI reject duplicate/unknown metadata, wrong protections and implicit flags', t => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.put(f.bindingPath, JSON.stringify(binding()).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
    (f: ReturnType<typeof fixture>) => f.put(f.bindingPath, JSON.stringify({ ...binding(), key })),
    (f: ReturnType<typeof fixture>) => chmodSync(f.bindingPath, 0o644),
    (f: ReturnType<typeof fixture>) => { unlinkSync(f.bindingPath); symlinkSync(f.profilePath, f.bindingPath); },
    (f: ReturnType<typeof fixture>) => f.put(f.bindingPath, ' '.repeat(8193)),
  ]) { const f = fixture(t); mutate(f); const result = f.init(); assert.notEqual(result.status, 0); assert.ok(!JSON.stringify(result).includes(key)); assert.equal(loadProviderConfig({ configDir: f.dir, ownerId: 'owner' }).status, 'unconfigured'); }
  const f = fixture(t); assert.equal(f.run(['--help']).status, 0);
  for (const args of [['migrate-binding'], ['init', '--binding-input', 'relative'], ['migrate-binding', '--config-dir', f.dir, '--owner-id', 'owner', '--binding-input', f.bindingPath, '--key', key]]) {
    const result = f.run(args); assert.notEqual(result.status, 0); assert.ok(!JSON.stringify({ stdout: result.stdout, stderr: result.stderr }).includes(key));
  }
});

test('A6 per-generate factory pre-abort/delayed-resolve abort never calls transport', async t => {
  const f = fixture(t); assert.equal(f.init().status, 0); let calls = 0;
  const transport: Transport = async () => { calls++; return response(); };
  const generate = async (signal: AbortSignal, hold?: ReturnType<typeof deferred>, entered?: ReturnType<typeof deferred>) => {
    const invocation = requestCredentialsFor(f.dir, scope);
    const credentials = { resolve: async (ref: string) => { const value = await invocation.credentials.resolve(ref); entered?.release(); if (hold) await hold.promise; return value; } };
    const result = await adapter(credentials, transport).generate(request, { signal, deadlineMs: Date.now() + 3000 });
    return { result, receipt: invocation.resolvedReceipt() };
  };
  const pre = new AbortController(); pre.abort(); assert.equal((await generate(pre.signal)).result.status, 'cancelled');
  const abort = new AbortController(); const hold = deferred(); const entered = deferred(); const pending = generate(abort.signal, hold, entered);
  await entered.promise; abort.abort(); hold.release(); assert.equal((await pending).result.status, 'cancelled'); assert.equal(calls, 0);
});
