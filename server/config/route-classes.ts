import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { bindingFrom, boundSecret, profileFrom, requireAbsolutePath, secretRecordFrom, seedScope, writePrivateFile, type ConfigOptions } from './index.js';
import { liveDocument } from './live.js';
import { ConfigError, fail, fields, parseJson, readPrivate, safeError, validateRoot } from './files.js';

const markerName = '.route-classes.pending', lockName = '.route-classes.lock', limit = 64 * 1024;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
interface Replacement { name: string; before: string; after: string; text: string }
interface Plan { version: 1; ownerId: string; surface: 'text' | 'live'; expectedGeneration: string; inputHash: string; files: Replacement[] }
export interface RouteClassOptions extends ConfigOptions {
  surface: 'text' | 'live'; bindingInputPath: string; expectedGeneration: string; dryRun?: boolean;
}
function syncDir(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function optional(path: string, maximum = limit): string | undefined {
  try { return readPrivate(path, maximum); } catch (error) { if (error instanceof ConfigError && error.code === 'file_missing') return undefined; throw error; }
}
function plan(options: RouteClassOptions, input: string): Plan {
  if (options.surface === 'text') {
    const live = optional(join(options.configDir, 'live.json'), 16384);
    if (live !== undefined) { const other = liveDocument(live, options.ownerId); if (other.input['enabled'] && other.provider === 'gemini') fail('shared_slot_conflict'); }
  }
  const name = options.surface === 'text' ? 'profile.json' : 'live.json', text = readPrivate(join(options.configDir, name), 16384);
  const document = parseJson(text) as Record<string, unknown>;
  const route = options.surface === 'text' ? profileFrom(text, options.ownerId) : liveDocument(text, options.ownerId);
  const model = 'modelId' in route ? route.modelId : route.model;
  if (route.provider === 'gemini' && options.surface === 'live') fail('shared_slot_conflict');
  const scope = seedScope(route.provider, model, route.dataClasses);
  const credentialName = `${scope.keyReference}.json`, old = readPrivate(join(options.configDir, credentialName), 8192);
  const existing = secretRecordFrom(old, scope.keyReference);
  if (!existing.receipt || JSON.stringify(existing.receipt.routeScope) !== JSON.stringify(scope)
    || existing.receipt.bindingGeneration !== options.expectedGeneration) fail('binding_changed');
  const requested = fields(parseJson(input), ['schemaVersion', 'configuredAccount', 'routeScope', 'bindingGeneration'], 'invalid_secret');
  const rawScope = requested['routeScope'] as Record<string, unknown>;
  const next = bindingFrom(input, { ...scope, allowedClasses: rawScope?.['allowedClasses'] as typeof scope.allowedClasses });
  if (next.configuredAccount !== existing.receipt.configuredAccount || next.bindingGeneration === existing.receipt.bindingGeneration) fail('binding_changed');
  const nextDoc = JSON.stringify({ ...document, dataClasses: next.routeScope.allowedClasses });
  if (options.surface === 'text') profileFrom(nextDoc, options.ownerId); else liveDocument(nextDoc, options.ownerId);
  const nextCredential = boundSecret(existing.key, next); secretRecordFrom(nextCredential, scope.keyReference);
  const replacement = (name: string, before: string, text: string): Replacement => ({ name, before: hash(before), after: hash(text), text });
  return { version: 1, ownerId: options.ownerId, surface: options.surface, expectedGeneration: options.expectedGeneration, inputHash: hash(input),
    files: [replacement(credentialName, old, nextCredential), replacement(name, text, nextDoc)] };
}
function resumed(text: string, options: RouteClassOptions, input: string): Plan {
  const value = fields(parseJson(text), ['version', 'ownerId', 'surface', 'expectedGeneration', 'inputHash', 'files'], 'configuration_pending');
  if (value['version'] !== 1 || value['ownerId'] !== options.ownerId || value['surface'] !== options.surface
    || value['expectedGeneration'] !== options.expectedGeneration || value['inputHash'] !== hash(input) || !Array.isArray(value['files']) || value['files'].length !== 2) fail('configuration_pending');
  const selected = value as unknown as Plan;
  for (const item of selected.files) {
    fields(item, ['name', 'before', 'after', 'text'], 'configuration_pending');
    if (!['profile.json', 'live.json', 'gemini-primary.json', 'openai-primary.json'].includes(item.name)
      || typeof item.text !== 'string' || !/^[a-f0-9]{64}$/.test(item.before) || item.after !== hash(item.text)) fail('configuration_pending');
  }
  const [credential, document] = selected.files as [Replacement, Replacement];
  if (document.name !== (options.surface === 'text' ? 'profile.json' : 'live.json')) fail('configuration_pending');
  const route = options.surface === 'text' ? profileFrom(document.text, options.ownerId) : liveDocument(document.text, options.ownerId);
  if (options.surface === 'live' && route.provider === 'gemini') fail('shared_slot_conflict');
  const scope = seedScope(route.provider, 'modelId' in route ? route.modelId : route.model, route.dataClasses);
  if (credential.name !== `${scope.keyReference}.json`) fail('configuration_pending');
  const binding = bindingFrom(input, scope), stored = secretRecordFrom(credential.text, scope.keyReference);
  if (JSON.stringify(binding) !== JSON.stringify(stored.receipt) || binding.bindingGeneration === options.expectedGeneration) fail('configuration_pending');
  return selected;
}
/** Only this invocation's validated lock is removed; a live concurrent owner is refused. */
function lock(dir: string): () => void {
  const path = join(dir, lockName), prior = optional(path, 256);
  if (prior !== undefined) {
    const pid = Number(prior); if (!Number.isSafeInteger(pid) || pid < 1) fail('configuration_pending');
    try { process.kill(pid, 0); fail('configuration_pending'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    unlinkSync(path);
  }
  writePrivateFile(path, String(process.pid), 256); const inode = lstatSync(path).ino;
  return () => { if (lstatSync(path).ino !== inode) fail('configuration_pending'); unlinkSync(path); syncDir(dir); };
}
/** Checkpoint is an in-process synthetic fault seam, never a CLI or environment option. */
export function setRouteClasses(options: RouteClassOptions, checkpoint?: (stage: string) => void): { surface: string; generation: string; dryRun: boolean } {
  requireAbsolutePath(options.configDir); requireAbsolutePath(options.bindingInputPath);
  if (!options.ownerId || options.ownerId.length > 128 || !['text', 'live'].includes(options.surface) || !options.expectedGeneration) fail('invalid_arguments');
  if (!validateRoot(options.configDir)) fail('file_missing');
  const input = readPrivate(options.bindingInputPath, 8192), marker = join(options.configDir, markerName);
  const release = options.dryRun ? undefined : lock(options.configDir);
  try {
    const pending = optional(marker), selected = pending === undefined ? plan(options, input) : resumed(pending, options, input);
    for (const item of selected.files) { const actual = hash(readPrivate(join(options.configDir, item.name), 16384)); if (actual !== item.before && actual !== item.after) fail('binding_changed'); }
    const generation = secretRecordFrom(selected.files[0]!.text, selected.files[0]!.name.replace(/\.json$/, '')).receipt!.bindingGeneration;
    if (options.dryRun) return { surface: options.surface, generation, dryRun: true };
    if (pending === undefined) { writePrivateFile(marker, JSON.stringify(selected), limit); syncDir(options.configDir); }
    checkpoint?.('marker');
    for (const [index, item] of selected.files.entries()) {
      const staged = join(options.configDir, `.route-classes.${index}`), current = optional(staged, 16384);
      if (current !== undefined && hash(current) !== item.after) fail('configuration_pending');
      if (current === undefined) writePrivateFile(staged, item.text, 16384);
      checkpoint?.(`stage${index}`);
    }
    for (const [index, item] of selected.files.entries()) {
      const active = join(options.configDir, item.name), actual = hash(readPrivate(active, 16384));
      if (actual !== item.before && actual !== item.after) fail('binding_changed');
      renameSync(join(options.configDir, `.route-classes.${index}`), active); checkpoint?.(`rename${index}`);
      syncDir(options.configDir); checkpoint?.(`sync${index}`);
    }
    for (const item of selected.files) if (hash(readPrivate(join(options.configDir, item.name), 16384)) !== item.after) fail('binding_changed');
    unlinkSync(marker); syncDir(options.configDir); checkpoint?.('complete');
    return { surface: options.surface, generation, dryRun: false };
  } catch (error) { throw safeError(error); }
  finally { release?.(); }
}
