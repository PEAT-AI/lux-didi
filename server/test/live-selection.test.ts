import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentLiveAccent, loadLiveConfig, saveLiveSelection } from '../config/live.js';
import { resolveRoute } from '../http/routes.js';
import { ServiceError } from '../contracts/errors.js';
import { LiveConfigError } from '../live/types.js';

/** A private config dir with both credential slots seeded: the switch never has to borrow a key. */
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'didi-live-selection-')); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, 'config');
  mkdirSync(configDir, { mode: 0o700 }); chmodSync(configDir, 0o700);
  const put = (name: string, value: unknown) => writeFileSync(join(configDir, name), JSON.stringify(value), { mode: 0o600 });
  put('live.json', {
    schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'models/gemini-3.8-live', voice: 'Aoede',
    keyReference: 'gemini-primary', dataClasses: ['ordinary'],
    preferences: { dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'dry', verbosity: 'balanced' },
    limits: { sessionMs: 900000 },
  });
  put('gemini-primary.json', { schemaVersion: 1, keyReference: 'gemini-primary', key: 'gemini_NEVER_PRINT' });
  put('openai-primary.json', { schemaVersion: 1, keyReference: 'openai-primary', key: 'openai_NEVER_PRINT' });
  return { configDir, saved: () => JSON.parse(readFileSync(join(configDir, 'live.json'), 'utf8')) as Record<string, unknown> };
}

test('a voice outside the provider own list is refused with the typed invalid_voice error', t => {
  const f = fixture(t);
  for (const [provider, voice] of [['gemini', 'marin'], ['gemini', 'Puck'], ['openai', 'Aoede'], ['openai', 'nira']] as const) {
    assert.throws(() => saveLiveSelection({ configDir: f.configDir, provider, voice }), (thrown: unknown) => {
      if (!(thrown instanceof LiveConfigError)) return false;
      assert.equal(thrown.code, 'invalid_voice');
      return true;
    }, `${provider}/${voice} is outside the provider list`);
  }
  // A refused save never rewrites what the next start will use.
  assert.equal(f.saved()['provider'], 'gemini');
  assert.equal(f.saved()['voice'], 'Aoede');
});

test('each provider saves its own voice, and the default stays the provider default', t => {
  const f = fixture(t);
  // PV1: the selection result now carries the accent too, and an absent accent is indian-strong.
  assert.deepEqual(saveLiveSelection({ configDir: f.configDir, provider: 'openai', voice: 'marin' }),
    { provider: 'openai', modelId: 'gpt-live-1', voice: 'marin', accent: 'indian-strong' });
  assert.equal(f.saved()['provider'], 'openai');
  assert.deepEqual(saveLiveSelection({ configDir: f.configDir, provider: 'gemini' }),
    { provider: 'gemini', modelId: 'models/gemini-3.8-live', voice: 'Aoede', accent: 'indian-strong' });
  assert.deepEqual(saveLiveSelection({ configDir: f.configDir, provider: 'openai', voice: 'cinder' }),
    { provider: 'openai', modelId: 'gpt-live-1', voice: 'cinder', accent: 'indian-strong' });
  assert.equal(f.saved()['voice'], 'cinder');
});

test('PV1: the accent selection validates, defaults and reaches the next session start', t => {
  const f = fixture(t);
  // Absent from live.json means indian-strong, and a load publishes that current value.
  const loaded = loadLiveConfig({ configDir: f.configDir, ownerId: 'owner-fixture' });
  assert.equal(loaded.status, 'configured');
  assert.equal(currentLiveAccent(), 'indian-strong', 'an absent accent means indian-strong');
  // A value outside the closed set is refused with its own typed code, which the route answers as a 400.
  assert.throws(() => saveLiveSelection({ configDir: f.configDir, provider: 'openai', accent: 'fake-indian' }),
    (error: unknown) => error instanceof LiveConfigError && error.code === 'invalid_accent');
  assert.equal(f.saved()['accent'], undefined, 'a refused save writes nothing');
  // A listed value is persisted and becomes the value the next session start composes with, with no restart.
  assert.deepEqual(saveLiveSelection({ configDir: f.configDir, provider: 'openai', voice: 'marin', accent: 'indian-light' }),
    { provider: 'openai', modelId: 'gpt-live-1', voice: 'marin', accent: 'indian-light' });
  assert.equal(f.saved()['accent'], 'indian-light');
  assert.equal(currentLiveAccent(), 'indian-light');
  // The voice's own accent is a real selection, not an absence.
  assert.equal(saveLiveSelection({ configDir: f.configDir, provider: 'openai', accent: 'voice-default' }).accent, 'voice-default');
  assert.equal(currentLiveAccent(), 'voice-default');
});

test('PV1-R3: the settings route accepts the accent field and the config layer answers a typed 400', t => {
  const url = new URL('http://didi.test/api/v1/live/settings');
  // The closed field list admits the accent, so a provider, voice and accent save is no longer refused here.
  const route = resolveRoute('POST', url, { provider: 'openai', voice: 'marin', accent: 'indian-light' });
  assert.equal(route.kind, 'live');
  assert.equal(route.action, 'settings');
  assert.equal(route.input['accent'], 'indian-light');
  // A wrong type is the route's own typed refusal, and it fires before any file is touched.
  assert.throws(() => resolveRoute('POST', url, { provider: 'openai', accent: 42 }),
    (error: unknown) => error instanceof ServiceError && error.status === 400 && error.message === 'Invalid accent');
  // A value outside the closed set passes the route and fails the config layer with its own typed code, which
  // server.ts answers as a 400 carrying invalid_accent.
  const f = fixture(t);
  assert.throws(() => saveLiveSelection({ configDir: f.configDir, provider: 'openai', voice: 'marin', accent: 'fake-indian' }),
    (error: unknown) => error instanceof LiveConfigError && error.code === 'invalid_accent');
  // And the same save with a listed value lands, which is the path the page takes.
  assert.equal(saveLiveSelection({ configDir: f.configDir, provider: 'openai', voice: 'marin', accent: 'indian-light' }).accent, 'indian-light');
});
