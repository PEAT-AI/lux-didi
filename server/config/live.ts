import { join } from 'node:path';
import type { DataClass } from '../adapters/live-voice/index.js';
import { validatePreferences, type ValidatedPreferences } from '../prompt/index.js';
import { liveIdentityOf } from '../live/config.js';
import { LiveConfigError } from '../live/types.js';
import { ConfigError, fail, fields, parseJson, readPrivate, safeError, validateRoot } from './files.js';
import { reference } from './index.js';

const liveLimit = 16 * 1024;
const liveKeys = ['schemaVersion', 'enabled', 'provider', 'modelId', 'voice', 'keyReference', 'dataClasses', 'preferences', 'limits'];
const preferenceKeys = ['dataClass', 'language', 'register', 'humor', 'verbosity'];
const requiredKeys = ['schemaVersion', 'enabled', 'provider', 'modelId', 'voice', 'keyReference', 'dataClasses', 'preferences'];
const classes: readonly DataClass[] = ['ordinary', 'private', 'sensitive'];
const modelPattern = /^models\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The frozen, sanitized Live identity. Never carries key bytes or prompt text. */
export interface LiveConfiguredProfile {
  readonly preferences: ValidatedPreferences;
  readonly model: string;
  readonly voice: string;
  readonly dataClasses: readonly DataClass[];
  readonly profileIdentity: string;
}

export type LiveConfigStatus =
  | { status: 'unconfigured' }
  | { status: 'disabled' | 'configured'; config: LiveConfiguredProfile }
  | { status: 'error'; code: string };

function modelId(value: unknown): string {
  if (typeof value !== 'string' || !modelPattern.test(value)) throw new LiveConfigError('invalid_model');
  return value;
}
function voice(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 64) throw new LiveConfigError('invalid_voice');
  return value;
}
function classList(value: unknown): readonly DataClass[] {
  if (!Array.isArray(value) || !value.length || value.some(item => !classes.includes(item as DataClass)) || new Set(value).size !== value.length) throw new LiveConfigError('invalid_classes');
  return Object.freeze([...value] as DataClass[]);
}

/**
 * Strict owner-only live.json in the existing configDir. Works with no text profile.json, never borrows
 * text consent and never reads a secret (the credential is resolved lazily by the adapter).
 *
 * R1 (LIVE-GATEWAY-R1): a valid enabled file cannot yet produce a LiveProfile, because the canonical
 * `compilePrompt` requires at least one history turn and a voice session has none. Prompt construction
 * is blocked pending root authorization of a turn-less voice-instruction seam, so a valid enabled file
 * reports `error: invalid_prompt` until that seam lands. No turn is fabricated and no validation is
 * weakened: model/voice/classes/preferences are still validated here.
 */
export function loadLiveConfig(options: { configDir: string; ownerId: string }): LiveConfigStatus {
  try {
    if (!options || typeof options !== 'object' || typeof options.configDir !== 'string' || typeof options.ownerId !== 'string') fail('invalid_arguments');
    if (!validateRoot(options.configDir)) return { status: 'unconfigured' };
    let text: string;
    try { text = readPrivate(join(options.configDir, 'live.json'), liveLimit); }
    catch (error) { if (error instanceof ConfigError && error.code === 'file_missing') return { status: 'unconfigured' }; throw error; }
    const raw = parseJson(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_profile');
    const input = raw as Record<string, unknown>;
    const allowed = new Set(liveKeys);
    for (const key of Object.keys(input)) if (!allowed.has(key)) fail('invalid_profile');
    for (const key of requiredKeys) if (!(key in input)) fail('invalid_profile');
    if (input['schemaVersion'] !== 1) fail('invalid_profile');
    if (typeof input['enabled'] !== 'boolean') fail('invalid_profile');
    if (input['provider'] !== 'gemini') throw new LiveConfigError('invalid_provider');
    if (input['keyReference'] !== reference) fail('invalid_reference');
    const model = modelId(input['modelId']);
    const chosenVoice = voice(input['voice']);
    const dataClasses = classList(input['dataClasses']);
    const preferences = validatePreferences(
      { ...fields(input['preferences'], preferenceKeys, 'invalid_profile'), schemaVersion: 1, ownerId: options.ownerId },
      options.ownerId,
    );
    const config: LiveConfiguredProfile = Object.freeze({
      preferences, model, voice: chosenVoice, dataClasses,
      profileIdentity: liveIdentityOf({ provider: 'gemini', liveModelId: model, voice: chosenVoice, keyReference: reference, modelId: model, dataClasses }),
    });
    if (input['enabled'] === false) return { status: 'disabled', config };
    throw new LiveConfigError('invalid_prompt'); // R1: turn-less voice-instruction seam not yet authorized.
  } catch (error) {
    const code = error instanceof LiveConfigError ? error.code
      : error instanceof ConfigError ? error.code : safeError(error).code;
    return { status: 'error', code };
  }
}
