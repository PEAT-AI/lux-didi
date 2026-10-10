import { join } from 'node:path';
import type { DataClass } from '../adapters/live-voice/index.js';
import { compilePrompt, createCapabilitySnapshot, PROMPT_VERSION, validatePreferences, type ValidatedPreferences } from '../prompt/index.js';
import { liveProfileIdentity, validateLiveProfile } from '../live/config.js';
import { LiveConfigError, type LiveProfile } from '../live/types.js';
import { ConfigError, fail, fields, parseJson, readPrivate, safeError, validateRoot } from './files.js';
import { reference } from './index.js';

const liveLimit = 16 * 1024;
const liveKeys = ['schemaVersion', 'enabled', 'provider', 'modelId', 'voice', 'keyReference', 'dataClasses', 'preferences', 'limits'];
const preferenceKeys = ['dataClass', 'language', 'register', 'humor', 'verbosity'];
const budgets = { trustedChars: 20000, contextChars: 12000, historyChars: 12000 };

/** The frozen, sanitized Live identity. Never carries key bytes or prompt text. */
export interface LiveConfiguredProfile {
  readonly preferences: ValidatedPreferences;
  readonly profile: LiveProfile;
  readonly model: string;
  readonly voice: string;
  readonly dataClasses: readonly DataClass[];
  readonly profileIdentity: string;
}

export type LiveConfigStatus =
  | { status: 'unconfigured' }
  | { status: 'disabled' | 'configured'; config: LiveConfiguredProfile }
  | { status: 'error'; code: string };

/**
 * Strict owner-only live.json in the existing configDir. Works with no text profile.json and never
 * borrows text consent. The secret is resolved later through the config/index.ts credentialsFor seam.
 */
export function loadLiveConfig(options: { configDir: string; ownerId: string }): LiveConfigStatus {
  try {
    if (!options || typeof options !== 'object' || typeof options.configDir !== 'string' || typeof options.ownerId !== 'string') fail('invalid_arguments');
    if (!validateRoot(options.configDir)) return { status: 'unconfigured' };
    let text: string;
    try { text = readPrivate(join(options.configDir, 'live.json'), liveLimit); }
    catch (error) { if (error instanceof ConfigError && error.code === 'file_missing') return { status: 'unconfigured' }; throw error; }
    const input = fields(parseJson(text), liveKeys, 'invalid_profile');
    if (input['schemaVersion'] !== 1) fail('invalid_profile');
    if (typeof input['enabled'] !== 'boolean') fail('invalid_profile');
    if (input['provider'] !== 'gemini') throw new LiveConfigError('invalid_provider');
    if (input['keyReference'] !== reference) fail('invalid_reference');
    const preferences = validatePreferences(
      { ...fields(input['preferences'], preferenceKeys, 'invalid_profile'), schemaVersion: 1, ownerId: options.ownerId },
      options.ownerId,
    );
    const compiled = compilePrompt({
      ownerId: options.ownerId, persona: 'didi', promptVersion: PROMPT_VERSION, preferences,
      capabilities: createCapabilitySnapshot([], []), evidence: [], history: [], budgets,
    });
    const profile = validateLiveProfile({
      provider: input['provider'], liveModelId: input['modelId'], voice: input['voice'], keyReference: input['keyReference'],
      route: { enabled: true, provider: input['provider'], modelId: input['modelId'], dataClasses: input['dataClasses'] },
      prompt: { text: compiled.system, dataClass: preferences.dataClass },
      ...(input['limits'] !== undefined ? { limits: input['limits'] } : {}),
    });
    const config: LiveConfiguredProfile = Object.freeze({
      preferences, profile, model: profile.liveModelId, voice: profile.voice,
      dataClasses: profile.route.dataClasses, profileIdentity: liveProfileIdentity(profile),
    });
    return input['enabled'] ? { status: 'configured', config } : { status: 'disabled', config };
  } catch (error) {
    const code = error instanceof LiveConfigError ? error.code
      : error instanceof ConfigError ? error.code : safeError(error).code;
    return { status: 'error', code };
  }
}
