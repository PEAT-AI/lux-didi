import { canonicalSpeechLanguage, composeLiveInstruction, loadPersonaOverlay, NAYA_BASE, PersonaOverlayError, publicOwnerProfile, TRUSTED_SYSTEM_CODE_UNIT_LIMIT, type OwnerProfileSnapshot } from '../prompt/index.js';
import { dirname, join } from 'node:path';
import { isLiveVoiceProvider, type DataClass } from '../adapters/live-voice/index.js';
import { compileVoiceInstruction, createCapabilitySnapshot, PROMPT_VERSION, validatePreferences, type ValidatedPreferences } from '../prompt/index.js';
import { liveIdentityOf, validateLiveProfile } from '../live/config.js';
import { LiveConfigError, type LiveProfile } from '../live/types.js';
import { ConfigError, fail, fields, parseJson, readPrivate, safeError, validateRoot } from './files.js';
import { reference } from './index.js';

const liveLimit = 16 * 1024;
const liveKeys = ['schemaVersion', 'enabled', 'provider', 'modelId', 'voice', 'keyReference', 'dataClasses', 'preferences', 'limits'];
const preferenceKeys = ['dataClass', 'language', 'register', 'humor', 'verbosity'];
const requiredKeys = ['schemaVersion', 'enabled', 'provider', 'modelId', 'voice', 'keyReference', 'dataClasses', 'preferences'];
const classes: readonly DataClass[] = ['ordinary', 'private', 'sensitive'];
const modelPattern = /^models\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A two-letter language with an optional two-letter region, case-normalised, or undefined when the
// tag carries a script/sub-language or no two-letter language. The setup languageCode keeps this
// end to end; the voice anchor (a separate consumer) still reduces to the bare primary locally.
function liveLanguageTag(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}(?:-[A-Za-z]{2})?$/.test(value)) return undefined;
  const [primary = '', region] = value.split('-');
  return region === undefined ? primary.toLowerCase() : `${primary.toLowerCase()}-${region.toUpperCase()}`;
}

/**
 * The explicit setup language every Live session sends, provider-neutral and never unset: the owner's
 * configured tag when it is a plain language-region (AC1, kept end to end), otherwise the bare primary
 * subtag of the owner's BCP-47 locale, otherwise `en`. The adapter receives it like any other setup field.
 */
export function liveSetupLanguage(locale: string | undefined): string {
  return liveLanguageTag(locale) ?? canonicalSpeechLanguage(locale) ?? 'en';
}

/** The frozen, sanitized Live identity. Never carries key bytes or prompt text. */
export interface LiveConfiguredProfile {
  readonly preferences: ValidatedPreferences;
  readonly model: string;
  readonly voice: string;
  readonly dataClasses: readonly DataClass[];
  readonly profileIdentity: string;
}
export interface LiveReadyProfile extends LiveConfiguredProfile { readonly profile: LiveProfile }

export type LiveConfigStatus =
  | { status: 'unconfigured' }
  | { status: 'disabled'; config: LiveConfiguredProfile }
  | { status: 'configured'; config: LiveReadyProfile }
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
 * R1 (LIVE-GATEWAY-R1, approved): a valid enabled file builds its LiveProfile through
 * `compileVoiceInstruction`, the shared canonical system assembly with no conversation turns; the text
 * path is unchanged and no turn is fabricated. The credential is never read here.
 */
export function loadLiveConfig(options: { configDir: string; ownerId: string; ownerProfile?: OwnerProfileSnapshot }): LiveConfigStatus {
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
    const provider = input['provider'];
    if (!isLiveVoiceProvider(provider)) throw new LiveConfigError('invalid_provider');
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
      profileIdentity: liveIdentityOf({ provider, liveModelId: model, voice: chosenVoice, keyReference: reference, modelId: model, dataClasses }),
    });
    // The optional local overlay lives beside the data directory, outside Git; an invalid file
    // fails closed into a typed status instead of silently falling back to the public base.
    const overlay = loadPersonaOverlay({ dataDir: dirname(options.configDir) });
    const language = canonicalSpeechLanguage(preferences.language);
    const setupLanguage = liveSetupLanguage(preferences.language);
    if (input['enabled'] === false) return { status: 'disabled', config };
    // Freeze the Naya baseline and voice anchor; the validated overlay joins at session CREATE.
    const composed = composeLiveInstruction({
      base: NAYA_BASE,
      ...(overlay?.accent !== undefined ? { accent: overlay.accent } : {}),
      ...(language !== undefined ? { language } : {}),
    });
    const ownerProfile = options.ownerProfile ?? publicOwnerProfile(options.ownerId);
    const instruction = compileVoiceInstruction({
      ownerId: options.ownerId, ownerProfile, promptVersion: PROMPT_VERSION, preferences,
      capabilities: createCapabilitySnapshot([], []), trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
    });
    const accepted = composeLiveInstruction({
      base: NAYA_BASE, ownerProfile,
      ...(overlay?.accent !== undefined ? { accent: overlay.accent } : {}),
      ...(language !== undefined ? { language } : {}),
    });
    const profile = validateLiveProfile({
      provider: input['provider'], liveModelId: model, voice: chosenVoice, keyReference: reference,
      language: setupLanguage,
      route: { enabled: true, provider: input['provider'], modelId: model, dataClasses },
      prompt: { text: composed.text, dataClass: preferences.dataClass },
      ...(overlay !== undefined ? { overlay } : {}),
      acceptedPrompt: { schemaVersion: 1, ownerProfile, compilerVersion: instruction.promptVersion,
        system: accepted.text, dataClasses: instruction.dataClasses },
      ...(input['limits'] !== undefined ? { limits: input['limits'] } : {}),
    });
    return { status: 'configured', config: Object.freeze({ ...config, profile }) };
  } catch (error) {
    const code = error instanceof LiveConfigError ? error.code
      : error instanceof ConfigError ? error.code
      : error instanceof PersonaOverlayError ? error.code : safeError(error).code;
    return { status: 'error', code };
  }
}
