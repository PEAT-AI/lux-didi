import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMongooseSignIn } from '../host/runtime.js';

// Fakes only: the login is injected, so no browser opens and no OAuth server answers. The catalogue is
// the installed three-endpoint shape from server/test/fixtures/installed-mcp-config.json.
// --- #649: the button and the CLI sign in one Mongoose endpoint, and only that one. ---

/** The installed three-endpoint Mongoose catalogue, values replaced by synthetic ones. */
function mongooseCatalogue(): Record<string, unknown>[] {
  return ['knowledge', 'data', 'crm'].map(name => ({
    id: `mongoose-${name}`, unknownClass: 'sensitive', transport: 'streamable-http', connector: 'mongoose',
    account: 'local', resource: `mongoose:${name}`, credentialRef: `mongoose-${name}`, enabled: true, allowEgress: true,
    url: `https://mongoose.example.invalid/mcp/${name}`,
  }));
}

/** A private configuration directory holding the three catalogue entries and one synthetic record each. */
function mongooseConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'didi-mongoose-signin-'));
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: 'owner@example.invalid', endpoints: mongooseCatalogue() }), { mode: 0o600 });
  for (const name of ['knowledge', 'data', 'crm']) writeFileSync(join(dir, `mongoose-${name}.json`), JSON.stringify({ schemaVersion: 1, token: `synthetic-${name}` }), { mode: 0o600 });
  return dir;
}

/** The synthetic record a fake login writes: a schemaVersion 2 session for one endpoint, never a real token. */
function syntheticSession(name: string): string {
  return JSON.stringify({ schemaVersion: 2, base: 'https://mongoose.example.invalid', clientId: 'synthetic-client', redirectPort: 8768, account: 'local', endpoint: name, audience: `mongoose:${name}`, accessToken: `synthetic-access-${name}`, refreshToken: `synthetic-refresh-${name}`, expiresAt: 1, consentStartedAt: 1 });
}

test('#649: a sign-in for data leaves the knowledge and crm records untouched', async () => {
  const configDir = mongooseConfigDir();
  try {
    const opened: string[] = [];
    const signed: string[] = [];
    let recovered = 0;
    const signIn = createMongooseSignIn({
      configDir,
      recover: async () => { recovered += 1; },
      open: url => { opened.push(url); },
      login: async options => {
        signed.push(`${options.endpoint}:${options.reference}`);
        writeFileSync(join(configDir, `${options.reference}.json`), syntheticSession(options.endpoint), { mode: 0o600 });
        options.showAuthorizationUrl?.('http://127.0.0.1:8768/authorize?state=synthetic');
      },
    });
    const started = await signIn('data');
    assert.deepEqual(started, { status: 'started', url: 'http://127.0.0.1:8768/authorize?state=synthetic' });
    // The recovery follows the login on its own chain, so let the microtask queue drain before reading it.
    for (let tick = 0; tick < 20 && recovered === 0; tick += 1) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(signed, ['data:mongoose-data'], 'only the requested endpoint signs in');
    assert.deepEqual(opened, ['http://127.0.0.1:8768/authorize?state=synthetic'], 'one browser consent, for that endpoint');
    assert.equal(recovered, 1, 'the connector reconnects once the record lands');
    assert.equal(readFileSync(join(configDir, 'mongoose-data.json'), 'utf8'), syntheticSession('data'));
    for (const name of ['knowledge', 'crm']) {
      assert.equal(readFileSync(join(configDir, `mongoose-${name}.json`), 'utf8'), JSON.stringify({ schemaVersion: 1, token: `synthetic-${name}` }), `${name} is untouched`);
    }
  } finally { rmSync(configDir, { recursive: true, force: true }); }
});

test('#649: an unknown endpoint name is a closed failure, and one sign-in runs at a time', async () => {
  const configDir = mongooseConfigDir();
  try {
    const signed: string[] = [];
    let finish: () => void = () => {};
    let gate = Promise.resolve();
    const signIn = createMongooseSignIn({
      configDir,
      recover: async () => {},
      open: () => {},
      login: async options => {
        signed.push(options.endpoint);
        options.showAuthorizationUrl?.('http://127.0.0.1:8768/authorize?state=synthetic');
        await gate;
      },
    });
    assert.deepEqual(await signIn('admin'), { status: 'failed', reason: 'not-configured' }, 'an unknown name never opens a browser');
    assert.deepEqual(signed, [], 'and never runs a login');
    gate = new Promise<void>(resolve => { finish = resolve; });
    const first = signIn('knowledge');
    const second = signIn('data');
    assert.equal(second, first, 'a second click joins the pending sign-in instead of starting another');
    assert.deepEqual(await first, { status: 'started', url: 'http://127.0.0.1:8768/authorize?state=synthetic' });
    finish();
    await gate;
    assert.deepEqual(signed, ['knowledge'], 'the joined click never signs a second endpoint');
  } finally { rmSync(configDir, { recursive: true, force: true }); }
});
