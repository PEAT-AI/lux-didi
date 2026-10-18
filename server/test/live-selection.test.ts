import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentLiveAccent, currentLivePlaybackRate, loadLiveConfig, saveLiveSelection } from '../config/live.js';
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
  for (const [provider, voice] of [['gemini', 'marin'], ['gemini', 'Puck'], ['openai', 'Aoede'], ['openai', 'marin2']] as const) {
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

/** The built config CLI, the surface an operator actually runs. */
const cliPath = new URL('../config/cli.js', import.meta.url).pathname;
function runCli(args: readonly string[]): { status: number | null; out: string; err: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

test('P9-R2 F3: select takes --accent, names a refused accent, and names a missing description file', t => {
  const f = fixture(t);
  const saved = runCli(['select', '--config-dir', f.configDir, '--provider', 'openai', '--accent', 'indian-light']);
  assert.equal(saved.status, 0, saved.err);
  assert.equal(f.saved()['accent'], 'indian-light');
  // A refused value names its own reason instead of the blanket initialization code.
  const refused = runCli(['select', '--config-dir', f.configDir, '--provider', 'openai', '--accent', 'bogus']);
  assert.equal(refused.status, 1);
  assert.match(refused.err, /invalid_accent/);
  const missing = runCli(['select', '--config-dir', f.configDir, '--provider', 'openai', '--voice-description-file', join(f.configDir, 'absent.txt')]);
  assert.equal(missing.status, 1);
  assert.match(missing.err, /file_missing/);
  const badVoice = runCli(['select', '--config-dir', f.configDir, '--provider', 'openai', '--voice', 'voice_0123']);
  assert.equal(badVoice.status, 1);
  assert.match(badVoice.err, /invalid_voice/);
  // A refused flag never rewrites what the next start will use.
  const afterSave = { accent: f.saved()['accent'], voice: f.saved()['voice'] };
  assert.deepEqual(afterSave, { accent: 'indian-light', voice: 'marin' });
});

test('PV2: nira is selectable for OpenAI and still refused for Gemini', t => {
  const f = fixture(t);
  const selected = saveLiveSelection({ configDir: f.configDir, provider: 'openai', voice: 'nira' });
  assert.equal(selected.voice, 'nira');
  assert.equal(f.saved()['voice'], 'nira');
  assert.throws(() => saveLiveSelection({ configDir: f.configDir, provider: 'gemini', voice: 'nira' }),
    (thrown: unknown) => thrown instanceof LiveConfigError && thrown.code === 'invalid_voice');
  // The refused save left the OpenAI selection in place.
  assert.equal(f.saved()['voice'], 'nira');
});

test('PV2: a custom voice id is stored as is for OpenAI and refused for Gemini', t => {
  const f = fixture(t);
  const custom = 'voice_0123456789abcdef';
  assert.equal(saveLiveSelection({ configDir: f.configDir, provider: 'openai', voice: custom }).voice, custom);
  assert.equal(f.saved()['voice'], custom);
  // It loads back as the same id, which is what the next session start sends as { id }.
  const loaded = loadLiveConfig({ configDir: f.configDir, ownerId: 'owner-fixture' });
  assert.equal(loaded.status, 'configured');
  assert.equal(loaded.status === 'configured' ? loaded.config.voice : undefined, custom);
  // The documented form is voice_ plus 16 to 64 lowercase hex characters; anything else is refused.
  for (const bad of ['voice_0123', 'voice_0123456789ABCDEF', 'voice-0123456789abcdef', 'custom-voice', 'voice_0123456789abcdef'.padEnd(71, 'a')]) {
    assert.throws(() => saveLiveSelection({ configDir: f.configDir, provider: 'openai', voice: bad }),
      (thrown: unknown) => thrown instanceof LiveConfigError && thrown.code === 'invalid_voice', bad);
  }
  assert.throws(() => saveLiveSelection({ configDir: f.configDir, provider: 'gemini', voice: custom }),
    (thrown: unknown) => thrown instanceof LiveConfigError && thrown.code === 'invalid_voice');
  assert.equal(f.saved()['voice'], custom);
});

test('PV2: the optional voice description is stored, validated and carried into the instruction tail', t => {
  const f = fixture(t);
  const description = 'A warm Indian English voice, unhurried, with clear consonants and a light lilt.';
  saveLiveSelection({ configDir: f.configDir, provider: 'openai', voice: 'marin', voiceDescription: description });
  assert.equal(f.saved()['voiceDescription'], description);
  // A save that names no description keeps the file's own one, and the composed prompt carries it once.
  saveLiveSelection({ configDir: f.configDir, provider: 'openai', voice: 'cinder' });
  assert.equal(f.saved()['voiceDescription'], description);
  const loaded = loadLiveConfig({ configDir: f.configDir, ownerId: 'owner-fixture' });
  assert.equal(loaded.status, 'configured');
  const text = loaded.status === 'configured' ? loaded.config.profile.acceptedPrompt?.system ?? '' : '';
  assert.equal(text.split('Voice description:').length - 1, 1, 'the description appears exactly once');
  assert.ok(text.trimEnd().endsWith(description), 'the description ends the accent tail');
  // Over the 1,500 character ceiling is its own typed refusal, and the file is untouched.
  assert.throws(() => saveLiveSelection({ configDir: f.configDir, provider: 'openai', voice: 'marin', voiceDescription: 'x'.repeat(1_501) }),
    (thrown: unknown) => thrown instanceof LiveConfigError && thrown.code === 'invalid_voice_description');
  assert.equal(f.saved()['voiceDescription'], description);
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

test('P3: the pitch-preserving pace is a live.json field the CLI saves, and anything outside 1.0 to 1.2 is refused', t => {
  const f = fixture(t);
  // A file that names no pace plays at today's speed, and a save records the band's floor explicitly.
  saveLiveSelection({ configDir: f.configDir, provider: 'openai', voice: 'marin' });
  assert.equal(f.saved()['playbackRate'], 1);
  // The operator surface: the flag lands in the file and moves the process-current value the next start reads.
  const saved = runCli(['select', '--config-dir', f.configDir, '--provider', 'openai', '--playback-rate', '1.08']);
  assert.equal(saved.status, 0, saved.err);
  assert.equal(f.saved()['playbackRate'], 1.08);
  // The next start is what reads it: the loader is the authority on the process-current pace.
  const loaded = loadLiveConfig({ configDir: f.configDir, ownerId: 'owner-fixture' });
  assert.equal(currentLivePlaybackRate(), 1.08);
  assert.equal(loaded.status, 'configured');
  assert.equal(loaded.status === 'configured' ? loaded.config.playbackRate : undefined, 1.08);
  // Both ends of the band are legal; 0.99, 1.21 and a non-number are not.
  saveLiveSelection({ configDir: f.configDir, provider: 'openai', playbackRate: 1.2 });
  assert.equal(f.saved()['playbackRate'], 1.2);
  saveLiveSelection({ configDir: f.configDir, provider: 'openai', playbackRate: 1 });
  assert.equal(f.saved()['playbackRate'], 1);
  for (const bad of ['0.99', '1.21', '0', 'faster']) {
    const refused = runCli(['select', '--config-dir', f.configDir, '--provider', 'openai', '--playback-rate', bad]);
    assert.equal(refused.status, 1, bad);
    assert.match(refused.err, /invalid_playback_rate/, bad);
  }
  for (const bad of [0.99, 1.21, 0, -1, Number.NaN, '1.08', null]) {
    assert.throws(() => saveLiveSelection({ configDir: f.configDir, provider: 'openai', playbackRate: bad }),
      (thrown: unknown) => thrown instanceof LiveConfigError && thrown.code === 'invalid_playback_rate', String(bad));
  }
  // A refused value never rewrites the pace the next start would use.
  assert.equal(f.saved()['playbackRate'], 1);
});
