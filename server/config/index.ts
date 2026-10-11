import { constants, closeSync, copyFileSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Credentials, DataClass, Route } from '../adapters/model/types.js';
import { validatePreferences, type ValidatedPreferences } from '../prompt/index.js';
import { ConfigError, type ConfigErrorCode, currentUid, fail, fields, parseJson, readPrivate, safeError, validateFile, validateRoot } from './files.js';
export { ConfigError, type ConfigErrorCode } from './files.js';

export const reference = 'gemini-primary';
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
export interface InitializeOptions extends ConfigOptions { profileInputPath: string; sourceEnvPath: string; bindingInputPath?: string }
export interface MigrateBindingOptions extends ConfigOptions { bindingInputPath: string }
/** Exact text route. Configured account is an operator assertion, never provider verification. */
export interface CredentialRouteScope {
  readonly provider: 'gemini'; readonly modelId: string;
  readonly endpoint: 'https://generativelanguage.googleapis.com'; readonly apiVersion: 'v1beta';
  readonly keyReference: 'gemini-primary'; readonly allowedClasses: readonly DataClass[];
}
export interface CredentialBindingReceipt {
  readonly schemaVersion: 1; readonly keyReference: 'gemini-primary'; readonly configuredAccount: string;
  readonly routeScope: CredentialRouteScope; readonly bindingGeneration: string;
}
export interface RequestCredentials {
  readonly credentials: Credentials;
  /** Last successful resolution in THIS invocation; undefined initially or after a failed resolve. */
  readonly resolvedReceipt: () => CredentialBindingReceipt | undefined;
}
const endpoint = 'https://generativelanguage.googleapis.com';
const apiVersion = 'v1beta';
function routeScopeFrom(raw: unknown): CredentialRouteScope {
  const s = fields(raw, ['provider', 'modelId', 'endpoint', 'apiVersion', 'keyReference', 'allowedClasses'], 'invalid_secret');
  if (s['provider'] !== 'gemini' || s['endpoint'] !== endpoint || s['apiVersion'] !== apiVersion ||
      typeof s['modelId'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s['modelId'])) fail('invalid_secret');
  if (s['keyReference'] !== reference) fail('invalid_reference');
  const classes = s['allowedClasses'];
  const order: DataClass[] = ['ordinary', 'private', 'sensitive'];
  if (!Array.isArray(classes) || classes.length === 0 || classes.length > 3 ||
      new Set(classes).size !== classes.length || classes.some(c => !order.includes(c))) fail('invalid_secret');
  return Object.freeze({ provider: 'gemini', modelId: s['modelId'], endpoint, apiVersion, keyReference: reference,
    allowedClasses: Object.freeze(order.filter(c => classes.includes(c))) });
}
function labelValid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}
function receiptFrom(s: Record<string, unknown>): CredentialBindingReceipt {
  if (!labelValid(s['configuredAccount']) || !labelValid(s['bindingGeneration'])) fail('invalid_secret');
  return Object.freeze({ schemaVersion: 1, keyReference: reference, configuredAccount: s['configuredAccount'],
    routeScope: routeScopeFrom(s['routeScope']), bindingGeneration: s['bindingGeneration'] });
}
function sameScope(a: CredentialRouteScope, b: CredentialRouteScope): boolean {
  return JSON.stringify(a) === JSON.stringify(b); // Both inputs are full canonical non-secret scopes.
}
function bindingFrom(text: string, profile: ProviderProfile): CredentialBindingReceipt {
  const b = fields(parseJson(text), ['schemaVersion', 'configuredAccount', 'routeScope', 'bindingGeneration'], 'invalid_secret');
  if (b['schemaVersion'] !== 1) fail('invalid_secret');
  const receipt = receiptFrom(b);
  const expected = routeScopeFrom({ provider: profile.provider, modelId: profile.modelId, endpoint, apiVersion,
    keyReference: profile.keyReference, allowedClasses: profile.dataClasses });
  if (!sameScope(receipt.routeScope, expected)) fail('invalid_secret');
  return receipt;
}
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
function secretRecordFrom(text: string): { key: string; receipt?: CredentialBindingReceipt } {
  const raw = parseJson(text);
  const version = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['schemaVersion'] : undefined;
  const s = fields(raw, version === 2 ? ['schemaVersion', 'keyReference', 'key', 'configuredAccount', 'routeScope', 'bindingGeneration'] : ['schemaVersion', 'keyReference', 'key'], 'invalid_secret');
  if ((version !== 1 && version !== 2) || !keyValid(s['key'])) fail('invalid_secret');
  if (s['keyReference'] !== reference) fail('invalid_reference');
  return version === 2 ? { key: s['key'], receipt: receiptFrom(s) } : { key: s['key'] };
}
function secretFrom(text: string): string { return secretRecordFrom(text).key; }
function readRecord(configDir: string): { key: string; receipt?: CredentialBindingReceipt } {
  if (!validateRoot(configDir)) fail('file_missing');
  return secretRecordFrom(readPrivate(join(configDir, 'gemini-primary.json'), secretLimit));
}
function readKey(configDir: string): string { return readRecord(configDir).key; }
function boundRecord(configDir: string, expected: CredentialRouteScope): { key: string; receipt: CredentialBindingReceipt } {
  const record = readRecord(configDir);
  if (!record.receipt || !sameScope(record.receipt.routeScope, expected)) fail('invalid_secret');
  return { key: record.key, receipt: record.receipt };
}
/** Fresh current-locator validation, including key validity/revocation; never last resolve's cache. */
export function credentialReceiptFor(configDir: string, expectedScope: CredentialRouteScope): CredentialBindingReceipt {
  try {
    pathArgument(configDir);
    return boundRecord(configDir, routeScopeFrom(expectedScope)).receipt;
  } catch (e) { throw safeError(e); }
}
/** Allocate inside every generate invocation, not at host startup or on a shared adapter. */
export function requestCredentialsFor(configDir: string, expectedScope: CredentialRouteScope): RequestCredentials {
  try {
    pathArgument(configDir);
    const expected = routeScopeFrom(expectedScope); // Detached/frozen snapshot of the requested scope.
    let receipt: CredentialBindingReceipt | undefined;
    const credentials: Credentials = Object.freeze({ resolve: async (requested: string): Promise<string | undefined> => {
      receipt = undefined;
      try {
        if (requested !== reference) fail('invalid_reference');
        const record = boundRecord(configDir, expected); // One descriptor/parse yields key AND receipt.
        receipt = record.receipt;
        return record.key;
      } catch (e) { throw safeError(e); }
    } });
    return Object.freeze({ credentials, resolvedReceipt: () => receipt });
  } catch (e) { throw safeError(e); }
}
export function credentialsFor(configDir: string): Credentials {
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
      const quote = value[0]!;
      if (value.length < 2 || value[value.length - 1] !== quote) fail('invalid_source');
      value = value.slice(1, -1);
      if (value.includes(quote) || (quote === '"' && value.includes('`'))) fail('invalid_source');
    } else if (/['"`]/.test(value)) fail('invalid_source');
    if (value.endsWith('\\')) fail('invalid_source');
    if (assignment[1] !== 'GEMINI_API_KEY') continue;
    if (!/^[A-Za-z0-9_.:/+,=@%\-]*$/.test(value)) fail('invalid_source');
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
    let binding: CredentialBindingReceipt | undefined;
    if (options.bindingInputPath !== undefined) {
      pathArgument(options.bindingInputPath);
      binding = bindingFrom(readPrivate(options.bindingInputPath, secretLimit), profile);
    }
    const secret = binding ? boundSecret(key, binding) : JSON.stringify({ schemaVersion: 1, keyReference: reference, key });
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

function boundSecret(key: string, receipt: CredentialBindingReceipt): string {
  return JSON.stringify({ schemaVersion: 2, keyReference: reference, key, configuredAccount: receipt.configuredAccount,
    routeScope: receipt.routeScope, bindingGeneration: receipt.bindingGeneration });
}
function syncPrivate(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { validateFile(fstatSync(fd), secretLimit); fsyncSync(fd); }
  finally { closeSync(fd); }
}
/** Explicit retained migration only; loading never upgrades legacy records. */
export function migrateProviderBinding(options: MigrateBindingOptions): void {
  const pending = join(options.configDir, '.binding.pending');
  let ownPending = false;
  try {
    optionsValid(options); pathArgument(options.bindingInputPath);
    if (!validateRoot(options.configDir)) fail('file_missing');
    const profile = profileFrom(readPrivate(join(options.configDir, 'profile.json'), profileLimit), options.ownerId);
    const active = join(options.configDir, 'gemini-primary.json');
    const legacy = secretRecordFrom(readPrivate(active, secretLimit));
    if (legacy.receipt) fail('invalid_secret'); // Never reinterpret/rebind a v2 record as a legacy migration.
    const binding = bindingFrom(readPrivate(options.bindingInputPath, secretLimit), profile);
    const replacement = boundSecret(legacy.key, binding);
    secretRecordFrom(replacement);
    const backup = join(options.configDir, 'gemini-primary.legacy.json');
    // Copy exact bytes (including a possible UTF-8 BOM), never a decoded/normalized serialization.
    // Paths were privately validated above; same-UID malicious replacement remains out of boundary.
    try { copyFileSync(active, backup, constants.COPYFILE_EXCL); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('destination_exists'); throw e; }
    const retained = secretRecordFrom(readPrivate(backup, secretLimit));
    if (retained.receipt || retained.key !== legacy.key) fail('invalid_secret'); // Concurrent key/version change: do not activate a mismatched snapshot.
    syncPrivate(backup); // Retained bytes are durable before activation. Never unlink this backup.
    createPrivate(pending, replacement, secretLimit);
    ownPending = true;
    renameSync(pending, active); // Atomic replace; old or new active record remains usable on failure.
    ownPending = false;
    const fd = openSync(options.configDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (e) { throw safeError(e); }
  finally {
    if (ownPending) {
      try { unlinkSync(pending); } catch (e) { throw safeError(e); }
    }
  } // Only our successfully created unpublished file.
}
