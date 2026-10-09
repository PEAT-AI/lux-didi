import { constants, closeSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Credentials, DataClass, Route } from '../adapters/model/types.js';
import { validatePreferences, type ValidatedPreferences } from '../prompt/index.js';
import { ConfigError, type ConfigErrorCode, currentUid, fail, fields, parseJson, readPrivate, safeError, validateFile, validateRoot } from './files.js';
export { ConfigError, type ConfigErrorCode } from './files.js';

const reference = 'gemini-primary';
const profileLimit = 16 * 1024;
const secretLimit = 8 * 1024;
const sourceLimit = 64 * 1024;
export interface ProviderProfile {
  schemaVersion: 1; enabled: boolean; provider: 'gemini'; modelId: string; keyReference: 'gemini-primary';
  dataClasses: DataClass[]; preferences: ValidatedPreferences;
}
export type ProviderStatus =
  | { status: 'unconfigured' }
  | { status: 'disabled'; profile: ProviderProfile }
  | { status: 'error'; code: ConfigErrorCode }
  | { status: 'ready'; profile: ProviderProfile; route: Route; credentials: Credentials };
export interface ConfigOptions { configDir: string; ownerId: string }
export interface InitializeOptions extends ConfigOptions { profileInputPath: string; sourceEnvPath: string }
function pathArgument(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) fail('invalid_arguments');
}
function optionsValid(options: ConfigOptions): void {
  pathArgument(options.configDir);
  if (typeof options.ownerId !== 'string' || options.ownerId.length === 0 || options.ownerId.length > 128) fail('invalid_arguments');
  currentUid();
}
function profileFrom(text: string, ownerId: string): ProviderProfile {
  const p = fields(parseJson(text), ['schemaVersion', 'enabled', 'provider', 'modelId', 'keyReference', 'dataClasses', 'preferences'], 'invalid_profile');
  if (p['schemaVersion'] !== 1 || typeof p['enabled'] !== 'boolean' || p['provider'] !== 'gemini' || typeof p['modelId'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(p['modelId'])) fail('invalid_profile');
  if (p['keyReference'] !== reference) fail('invalid_reference');
  const dataClasses = p['dataClasses'];
  if (!Array.isArray(dataClasses) || dataClasses.length === 0 || dataClasses.length > 3 || new Set(dataClasses).size !== dataClasses.length || dataClasses.some(c => !['ordinary', 'private', 'sensitive'].includes(c as string))) fail('invalid_profile');
  const input = fields(p['preferences'], ['dataClass', 'language', 'register', 'humor', 'verbosity'], 'invalid_profile');
  let preferences: ValidatedPreferences;
  try { preferences = validatePreferences({ ...input, schemaVersion: 1, ownerId }, ownerId); }
  catch { return fail('invalid_profile'); }
  // Freeze sanitized values. Route receives its own array because the existing port uses mutable arrays.
  const profile: ProviderProfile = { schemaVersion: 1, enabled: p['enabled'] as boolean, provider: 'gemini', modelId: p['modelId'] as string, keyReference: reference, dataClasses: [...dataClasses] as DataClass[], preferences };
  Object.freeze(profile.dataClasses);
  return Object.freeze(profile);
}
function keyValid(key: unknown): key is string {
  return typeof key === 'string' && key.length <= 1024 && /^[\x21-\x7e]+$/.test(key);
}
function secretFrom(text: string): string {
  const s = fields(parseJson(text), ['schemaVersion', 'keyReference', 'key'], 'invalid_secret');
  if (s['schemaVersion'] !== 1 || !keyValid(s['key'])) fail('invalid_secret');
  if (s['keyReference'] !== reference) fail('invalid_reference');
  return s['key'] as string;
}
function readKey(configDir: string): string {
  if (!validateRoot(configDir)) fail('file_missing');
  return secretFrom(readPrivate(join(configDir, 'gemini-primary.json'), secretLimit));
}
function credentialsFor(configDir: string): Credentials {
  // Capture only the trusted path, never key bytes or raw input.
  return Object.freeze({ resolve: async (requested: string): Promise<string | undefined> => {
    try {
      if (requested !== reference) fail('invalid_reference');
      return readKey(configDir);
    } catch (e) { throw safeError(e); }
  } });
}
export function loadProviderConfig(options: ConfigOptions): ProviderStatus {
  try {
    optionsValid(options);
    if (!validateRoot(options.configDir)) return { status: 'unconfigured' };
    let text: string;
    try { text = readPrivate(join(options.configDir, 'profile.json'), profileLimit); }
    catch (e) { if (e instanceof ConfigError && e.code === 'file_missing') return { status: 'unconfigured' }; throw e; }
    const profile = profileFrom(text, options.ownerId);
    if (!profile.enabled) return { status: 'disabled', profile };
    readKey(options.configDir); // Validate now; missing/invalid configured key is a visible error.
    return { status: 'ready', profile, route: { enabled: true, provider: 'gemini', modelId: profile.modelId, dataClasses: [...profile.dataClasses] }, credentials: credentialsFor(options.configDir) };
  } catch (e) { return { status: 'error', code: safeError(e).code }; }
}
function sourceKey(text: string): string {
  let found: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!assignment) fail('invalid_source');
    let value = assignment[2]!;
    if (value.startsWith("'") || value.startsWith('"')) {
      if (value.length < 2 || value[value.length - 1] !== value[0]) fail('invalid_source');
      value = value.slice(1, -1);
    }
    if (!/^[A-Za-z0-9_.:/+,=@%\-]*$/.test(value)) fail('invalid_source');
    if (assignment[1] !== 'GEMINI_API_KEY') continue;
    if (found !== undefined || !keyValid(value)) fail('invalid_source');
    found = value;
  }
  if (found === undefined) return fail('invalid_source');
  return found;
}
function createPrivate(path: string, text: string, limit: number): void {
  if (Buffer.byteLength(text, 'utf8') > limit) fail('too_large');
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    validateFile(fstatSync(fd), limit);
    writeFileSync(fd, text, { encoding: 'utf8' });
    fsyncSync(fd);
    validateFile(fstatSync(fd), limit);
  } catch (e) { throw safeError(e); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function initializeProviderConfig(options: InitializeOptions): void {
  try {
    optionsValid(options); pathArgument(options.profileInputPath); pathArgument(options.sourceEnvPath);
    try { mkdirSync(options.configDir, { mode: 0o700 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('destination_exists'); throw e; }
    if (!validateRoot(options.configDir)) fail('initialization_failed');
    const profile = profileFrom(readPrivate(options.profileInputPath, profileLimit), options.ownerId);
    if (!profile.enabled) fail('invalid_profile');
    const key = sourceKey(readPrivate(options.sourceEnvPath, sourceLimit));
    const secret = JSON.stringify({ schemaVersion: 1, keyReference: reference, key });
    secretFrom(secret); // Full secret validation precedes profile activation.
    createPrivate(join(options.configDir, 'gemini-primary.json'), secret, secretLimit);
    // Portable serialization deliberately omits injected ownership/schema from preferences.
    const { dataClass, language, register, humor, verbosity } = profile.preferences;
    const portable = JSON.stringify({ ...profile, preferences: { dataClass, language, register, humor, verbosity } });
    const pending = join(options.configDir, '.profile.pending');
    createPrivate(pending, portable, profileLimit);
    linkSync(pending, join(options.configDir, 'profile.json')); // Exclusive atomic publication, never overwrite.
    unlinkSync(pending); // Only our newly-created pending file; no unknown-file cleanup.
  } catch (e) { throw safeError(e); }
}
