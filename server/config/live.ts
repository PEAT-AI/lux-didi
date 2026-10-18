import { canonicalSpeechLanguage, composeLiveInstruction, loadPersonaOverlay, NAYA_LIVE_BASE, PersonaOverlayError, publicOwnerProfile, TRUSTED_SYSTEM_CODE_UNIT_LIMIT, LIVE_ACCENTS, LIVE_DEFAULT_ACCENT, type LiveAccent, type OwnerProfileSnapshot } from '../prompt/index.js';
import { dirname, join } from 'node:path';
import { isLiveVoiceProvider, type DataClass, type LiveVoiceProvider } from '../adapters/live-voice/index.js';
import { isCustomVoiceId } from '../adapters/live-voice/openai.js';
import { compileVoiceInstruction, createCapabilitySnapshot, PROMPT_VERSION, validatePreferences, type ValidatedPreferences } from '../prompt/index.js';
import { liveIdentityOf, validateLiveProfile } from '../live/config.js';
import { LiveConfigError, type LiveProfile } from '../live/types.js';
import { ConfigError, fail, parseJson, readPrivate, safeError, validateRoot } from './files.js';
import { configureDebugJournal } from '../host/journal.js';
import { renameSync } from 'node:fs';
import { defaultLiveProvider, requireAbsolutePath, slotFor, slotKeyPresent, writePrivateFile } from './index.js';

const liveLimit = 16 * 1024;
/** The longest accepted voice: a custom id is `voice_` plus 64 hex characters. */
const MAX_VOICE_CHARS = 70;
/** The documented ceiling for the optional voice description; it mirrors one voice prompt. */
const MAX_VOICE_DESCRIPTION_CHARS = 1_500;
const liveKeys = ['schemaVersion', 'enabled', 'provider', 'modelId', 'voice', 'accent', 'voiceDescription', 'keyReference', 'dataClasses', 'preferences', 'limits'];
// PV1: the owner's accent selection is its own live.json field, beside provider and voice. It applies from the
// next session start, so it is kept as a process-current value rather than only inside the frozen profile.
let currentAccent: LiveAccent = LIVE_DEFAULT_ACCENT;

/** The owner's accent selection for the next session start; the default until a live.json or a save says otherwise. */
export function currentLiveAccent(): LiveAccent { return currentAccent; }

/** Validate one accent value: a listed selection, or the default when the field is absent. */
export function liveAccent(value: unknown): LiveAccent {
  if (value === undefined) return LIVE_DEFAULT_ACCENT;
  if (typeof value !== 'string' || !(LIVE_ACCENTS as readonly string[]).includes(value)) throw new LiveConfigError('invalid_accent');
  return value as LiveAccent;
}
/**
 * The optional voice description (PV2): the voice-prompt text the owner asked for, mirrored in the
 * instructions under a `Voice description:` line. Absent or empty means none; present is a non-empty
 * string of at most 1,500 characters.
 */
export function liveVoiceDescription(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > MAX_VOICE_DESCRIPTION_CHARS) throw new LiveConfigError('invalid_voice_description');
  return value;
}
// The debug journal is a host setting that lives beside the prompt preferences: owner content
// stays on this computer, on by default. It is stripped before the prompt preferences validate.
const journalKey = 'debugJournal';
const requiredKeys = ['schemaVersion', 'enabled', 'dataClasses', 'preferences'];
const classes: readonly DataClass[] = ['ordinary', 'private', 'sensitive'];

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
  readonly provider: LiveVoiceProvider;
  readonly preferences: ValidatedPreferences;
  readonly model: string;
  readonly voice: string;
  readonly dataClasses: readonly DataClass[];
  readonly profileIdentity: string;
  /** The private debug journal preference; absent files default to on. */
  readonly debugJournal: boolean;
}
export interface LiveReadyProfile extends LiveConfiguredProfile { readonly profile: LiveProfile }

export type LiveConfigStatus =
  | { status: 'unconfigured' }
  | { status: 'disabled'; config: LiveConfiguredProfile }
  | { status: 'configured'; config: LiveReadyProfile }
  | { status: 'error'; code: string };

/** The provider's own model-id dialect: each slot pins the ids it can serve, never a shared pattern. */
function modelId(provider: LiveVoiceProvider, value: unknown): string {
  if (typeof value !== 'string' || !slotFor(provider).modelPattern.test(value)) throw new LiveConfigError('invalid_model');
  return value;
}
function voice(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > MAX_VOICE_CHARS) throw new LiveConfigError('invalid_voice');
  return value;
}

/**
 * The voices each provider can serve, the same list the settings switch offers. A saved pair outside the
 * provider's own list is refused rather than stored, so a Gemini session can never be saved with marin.
 */
const providerVoices: Readonly<Record<LiveVoiceProvider, readonly string[]>> = Object.freeze({
  openai: Object.freeze(['marin', 'vesper', 'ripple', 'willow', 'gleam', 'meridian', 'stone', 'quartz', 'beacon', 'delta', 'cinder', 'nira']),
  gemini: Object.freeze(['Aoede']),
});
/** A stored voice: any preset name the file holds, and a custom id only for the OpenAI provider. */
function storedVoice(provider: LiveVoiceProvider, value: unknown): string {
  const chosen = voice(value);
  if (isCustomVoiceId(chosen) && provider !== 'openai') throw new LiveConfigError('invalid_voice');
  return chosen;
}
/**
 * One voice a provider can serve: a listed preset, or (PV2) an OpenAI custom voice id stored as is. The
 * custom form is the documented `voice_` plus 16 to 64 lowercase hex characters, so it is 22 to 70
 * characters; every other provider and every unknown name stay refused.
 */
function providerVoice(provider: LiveVoiceProvider, value: unknown): string {
  if (typeof value === 'string' && isCustomVoiceId(value)) {
    if (provider !== 'openai') throw new LiveConfigError('invalid_voice');
    return value;
  }
  const chosen = voice(value);
  if (!providerVoices[provider].includes(chosen)) throw new LiveConfigError('invalid_voice');
  return chosen;
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
    // The debug journal is a host setting with its own default, so it is installed before live.json is
    // read: a host with no live.json, or none this run can reach, still journals; the file can only
    // turn it off. This is the same data directory the persona overlay below resolves.
    configureDebugJournal(dirname(options.configDir), true);
    // A load is the one authority on the accent this process composes with, so a file that is gone or
    // unreadable falls back to the default rather than keeping a value a previous fixture left behind.
    currentAccent = LIVE_DEFAULT_ACCENT;
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
    // A live.json that names no provider is the OpenAI default (GPT-Live, marin); Gemini stays selectable by
    // name. An explicit provider still pins its own model-id dialect and credential slot.
    const named = input['provider'];
    if (named !== undefined && !isLiveVoiceProvider(named)) throw new LiveConfigError('invalid_provider');
    const provider = named === undefined ? defaultLiveProvider : named;
    const slot = slotFor(provider);
    const reference = input['keyReference'];
    if (reference !== undefined && reference !== slot.keyReference) fail('invalid_reference');
    const model = modelId(provider, input['modelId'] ?? slot.defaultLiveModelId);
    const chosenVoice = input['voice'] === undefined ? slot.defaultVoice : storedVoice(provider, input['voice']);
    const description = liveVoiceDescription(input['voiceDescription']);
    // The accent selection is read here and published as the process-current value: the next session start
    // composes its anchors from it, so a later save needs no restart.
    const chosenAccent = liveAccent(input['accent']);
    currentAccent = chosenAccent;
    const dataClasses = classList(input['dataClasses']);
    // One host setting rides beside the prompt preferences, which keep their own exact key set.
    const declared = input['preferences'];
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) fail('invalid_profile');
    const declaredKeys = { ...(declared as Record<string, unknown>) };
    const journalValue = declaredKeys[journalKey];
    if (journalValue !== undefined && typeof journalValue !== 'boolean') fail('invalid_profile');
    const debugJournal = journalValue !== false;
    delete declaredKeys[journalKey];
    const preferences = validatePreferences({ ...declaredKeys, schemaVersion: 1, ownerId: options.ownerId }, options.ownerId);
    const config: LiveConfiguredProfile = Object.freeze({
      provider, preferences, model, voice: chosenVoice, dataClasses, debugJournal,
      profileIdentity: liveIdentityOf({ provider, liveModelId: model, voice: chosenVoice, keyReference: slot.keyReference, modelId: model, dataClasses }),
    });
    // The debug journal is rooted at the host data directory, the same place the persona overlay
    // lives, and it is installed here so one owner preference governs both the live and chat paths.
    configureDebugJournal(dirname(options.configDir), debugJournal);
    // The optional local overlay lives beside the data directory, outside Git; an invalid file
    // fails closed into a typed status instead of silently falling back to the public base.
    const overlay = loadPersonaOverlay({ dataDir: dirname(options.configDir) });
    const language = canonicalSpeechLanguage(preferences.language);
    const setupLanguage = liveSetupLanguage(preferences.language);
    if (input['enabled'] === false) return { status: 'disabled', config };
    // Freeze the Naya baseline and voice anchor; the validated overlay joins at session CREATE.
    // The optional voice description rides inside the accent tail of both compositions (PV2).
    const composed = composeLiveInstruction({
      base: NAYA_LIVE_BASE,
      ...(overlay?.accent !== undefined ? { accent: overlay.accent } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(description !== undefined ? { voiceDescription: description } : {}),
      accentSelection: chosenAccent,
    });
    const ownerProfile = options.ownerProfile ?? publicOwnerProfile(options.ownerId);
    const instruction = compileVoiceInstruction({
      ownerId: options.ownerId, ownerProfile, promptVersion: PROMPT_VERSION, preferences,
      capabilities: createCapabilitySnapshot([], []), trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
    });
    const accepted = composeLiveInstruction({
      base: NAYA_LIVE_BASE, ownerProfile,
      ...(overlay?.accent !== undefined ? { accent: overlay.accent } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(description !== undefined ? { voiceDescription: description } : {}),
      accentSelection: chosenAccent,
    });
    const profile = validateLiveProfile({
      provider, liveModelId: model, voice: chosenVoice, keyReference: slot.keyReference,
      language: setupLanguage,
      route: { enabled: true, provider, modelId: model, dataClasses },
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

/** The provider/voice pairs the owner can pick, in switch order, from the one slot table. */
export const liveProviderChoices: readonly { provider: LiveVoiceProvider; label: string; modelId: string; voice: string }[] =
  Object.freeze([
    Object.freeze({ provider: 'openai', label: 'OpenAI GPT-Live', ...slotChoice('openai') }),
    Object.freeze({ provider: 'gemini', label: 'Gemini 3.8 Live', ...slotChoice('gemini') }),
  ] as const);
function slotChoice(provider: LiveVoiceProvider): { modelId: string; voice: string } {
  const slot = slotFor(provider);
  return { modelId: slot.defaultLiveModelId, voice: slot.defaultVoice };
}

/**
 * Persist the owner's provider and voice choice into live.json, in place, atomically and owner-only. The
 * model follows the provider's dialect; the running host keeps the profile it loaded, so a change never
 * reaches a call in flight. Only the three selection fields are rewritten; limits, classes and persona
 * preferences survive byte for byte.
 */
export function saveLiveSelection(options: { configDir: string; ownerId?: string; provider: unknown; voice?: unknown; accent?: unknown; voiceDescription?: unknown }): {
  provider: LiveVoiceProvider; modelId: string; voice: string; accent: LiveAccent;
} {
  try {
    requireAbsolutePath(options.configDir);
    if (!isLiveVoiceProvider(options.provider)) throw new LiveConfigError('invalid_provider');
    const provider = options.provider;
    const slot = slotFor(provider);
    // A provider whose credential slot is empty is refused here; the switch never falls back to another key.
    if (!slotKeyPresent(options.configDir, slot.keyReference)) fail('file_missing');
    const chosenVoice = options.voice === undefined ? slot.defaultVoice : providerVoice(provider, options.voice);
    if (!validateRoot(options.configDir)) fail('file_missing');
    const input = parseJson(readPrivate(join(options.configDir, 'live.json'), liveLimit)) as Record<string, unknown>;
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_profile');
    // A saved accent takes the next session start, so the process-current value moves with the file. A save
    // that names no accent keeps the file's own choice instead of resetting it.
    const chosenAccent = options.accent === undefined ? liveAccent(input['accent']) : liveAccent(options.accent);
    // A save that names no description keeps the file's own one, and the file's one still validates.
    const description = options.voiceDescription === undefined
      ? liveVoiceDescription(input['voiceDescription'])
      : liveVoiceDescription(options.voiceDescription);
    const model = modelId(provider, slot.defaultLiveModelId);
    const next: Record<string, unknown> = {
      ...input, provider, modelId: model, voice: chosenVoice, accent: chosenAccent, keyReference: slot.keyReference,
      ...(description !== undefined ? { voiceDescription: description } : {}),
    };
    // Validate the document we are about to publish through the same loader rules, minus prompt composition.
    const allowed = new Set(liveKeys);
    for (const key of Object.keys(next)) if (!allowed.has(key)) fail('invalid_profile');
    for (const key of requiredKeys) if (!(key in next)) fail('invalid_profile');
    if (next['schemaVersion'] !== 1 || typeof next['enabled'] !== 'boolean') fail('invalid_profile');
    classList(next['dataClasses']);
    const pending = join(options.configDir, '.live.pending');
    writePrivateFile(pending, JSON.stringify(next), liveLimit);
    renameSync(pending, join(options.configDir, 'live.json'));
    currentAccent = chosenAccent;
    return { provider, modelId: model, voice: chosenVoice, accent: chosenAccent };
  } catch (error) {
    if (error instanceof LiveConfigError) throw error;
    throw safeError(error);
  }
}
