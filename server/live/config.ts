import { liveVoiceTimerDefaults } from '../adapters/live-voice/types.js';
import { createHash } from 'node:crypto';
import type { DataClass } from '../adapters/live-voice/index.js';
import { validatePersonaOverlay } from '../prompt/live-persona.js';
import { ownerProfileClasses, PROMPT_VERSION, validateOwnerProfile } from '../prompt/index.js';
import { LiveConfigError, type AcceptedPromptSnapshot, type LiveLimits, type LiveProfile, type LiveMemoryProvenance } from './types.js';

const classes: readonly DataClass[] = ['ordinary', 'private', 'sensitive'];
const modelPattern = /^models\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const maxTimer = 2_147_483_647;
const limitBounds: Readonly<Record<keyof LiveLimits, number>> = {
  toolDeferralMs: 30_000,
  sessionMs: maxTimer, idleMs: maxTimer, unusedMs: maxTimer, handshakeMs: maxTimer, closeMs: maxTimer,
  journalMaxEvents: 1_000_000, journalMaxBytes: 1024 * 1024 * 1024,
  consumerQueueEvents: 65_536, consumerQueueBytes: 64 * 1024 * 1024, wsBufferedBytes: 64 * 1024 * 1024,
};
export const defaultLiveLimits: Readonly<LiveLimits> = Object.freeze({
  toolDeferralMs: 4000,
  ...liveVoiceTimerDefaults, unusedMs: 300_000,
  journalMaxEvents: 16_384, journalMaxBytes: 16 * 1024 * 1024,
  consumerQueueEvents: 256, consumerQueueBytes: 2 * 1024 * 1024, wsBufferedBytes: 4 * 1024 * 1024,
});

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fail(code: ConstructorParameters<typeof LiveConfigError>[0]): never { throw new LiveConfigError(code); }
function text(value: unknown, code: ConstructorParameters<typeof LiveConfigError>[0]): string {
  if (typeof value !== 'string' || !value.length || value.length > 4096) fail(code);
  return value;
}
function limit(value: unknown, name: keyof LiveLimits): number {
  if (value === undefined) return defaultLiveLimits[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (name === 'toolDeferralMs' ? 1000 : 1) || value > limitBounds[name]) fail('invalid_limit');
  return value;
}
function limits(value: unknown): LiveLimits {
  if (value !== undefined && !object(value)) fail('invalid_limit');
  for (const key of Object.keys(object(value) ? value : {})) if (!(key in limitBounds)) fail('invalid_limit');
  const source = object(value) ? value : {};
  return Object.freeze({
    toolDeferralMs: limit(source['toolDeferralMs'], 'toolDeferralMs'),
    sessionMs: limit(source['sessionMs'], 'sessionMs'), idleMs: limit(source['idleMs'], 'idleMs'),
    unusedMs: limit(source['unusedMs'], 'unusedMs'), handshakeMs: limit(source['handshakeMs'], 'handshakeMs'),
    closeMs: limit(source['closeMs'], 'closeMs'), journalMaxEvents: limit(source['journalMaxEvents'], 'journalMaxEvents'),
    journalMaxBytes: limit(source['journalMaxBytes'], 'journalMaxBytes'),
    consumerQueueEvents: limit(source['consumerQueueEvents'], 'consumerQueueEvents'),
    consumerQueueBytes: limit(source['consumerQueueBytes'], 'consumerQueueBytes'),
    wsBufferedBytes: limit(source['wsBufferedBytes'], 'wsBufferedBytes'),
  });
}
function classList(value: unknown): DataClass[] {
  if (!Array.isArray(value) || !value.length || value.some(item => !classes.includes(item as DataClass)) || new Set(value).size !== value.length) fail('invalid_classes');
  return [...value] as DataClass[];
}

/** Trusted typed in-process validation. No file loader, no environment convention. */
/** Closed accepted wire record; unsupported, corrupt or under-classified records fail closed. */
export function validateAcceptedPrompt(input: unknown, ownerId?: string): AcceptedPromptSnapshot {
  if (!object(input) || Object.keys(input).length < 5 || Object.keys(input).length > 7
    || Object.keys(input).some(k => !['schemaVersion','ownerProfile','compilerVersion','system','dataClasses','memory','pickup'].includes(k))
    || input['schemaVersion'] !== 1 || input['compilerVersion'] !== PROMPT_VERSION) fail('invalid_prompt');
  try {
    const raw = input['ownerProfile'];
    if (!object(raw) || typeof raw['ownerId'] !== 'string') fail('invalid_prompt');
    const ownerProfile = validateOwnerProfile(raw, ownerId ?? raw['ownerId']);
    const dataClasses = classList(input['dataClasses']);
    if (ownerProfileClasses(ownerProfile).some(c => !dataClasses.includes(c))) fail('invalid_prompt');
    let memory: LiveMemoryProvenance | undefined;
    if (input['memory'] !== undefined) {
      const value = input['memory'];
      if (!object(value) || Object.keys(value).some(k => !['status', 'selectedIds', 'omitted'].includes(k))
        || !Array.isArray(value['selectedIds']) || !value['selectedIds'].every(id => typeof id === 'string' && id.length > 0)
        || !Array.isArray(value['omitted']) || !value['omitted'].every(item => object(item) && Object.keys(item).length === 2 && typeof item['id'] === 'string' && item['id'].length > 0 && item['reason'] === 'budget')) fail('invalid_prompt');
      const selectedIds = value['selectedIds'] as string[];
      const omitted = value['omitted'] as { id: string; reason: 'budget' }[];
      const status = omitted.length ? selectedIds.length ? 'partial' : 'omitted' : selectedIds.length ? 'selected' : 'empty';
      if (value['status'] !== status || new Set([...selectedIds, ...omitted.map(item => item.id)]).size !== selectedIds.length + omitted.length) fail('invalid_prompt');
      memory = Object.freeze({ status, selectedIds: Object.freeze([...selectedIds]), omitted: Object.freeze(omitted.map(item => Object.freeze({ ...item }))) });
    }
    let pickup: AcceptedPromptSnapshot['pickup'];
    if (input['pickup'] !== undefined) {
      const value = input['pickup'];
      if (!object(value) || Object.keys(value).length !== 2 || typeof value['jobId'] !== 'string' || !value['jobId'].length || typeof value['identity'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['identity'])) fail('invalid_prompt');
      pickup = Object.freeze({ jobId: value['jobId'], identity: value['identity'] });
    }
    return Object.freeze({ schemaVersion: 1, ownerProfile, compilerVersion: PROMPT_VERSION,
      ...(memory ? { memory } : {}), ...(pickup ? { pickup } : {}),
      system: acceptedInstruction(input['system']), dataClasses: Object.freeze(dataClasses) });
  } catch { fail('invalid_prompt'); }
}

export function validateLiveProfile(input: unknown): LiveProfile {
  if (!object(input)) fail('invalid_object');
  if (input['provider'] !== 'gemini') fail('invalid_provider');
  const liveModelId = text(input['liveModelId'], 'invalid_model');
  if (!modelPattern.test(liveModelId)) fail('invalid_model');
  const voice = text(input['voice'], 'invalid_voice');
  const keyReference = text(input['keyReference'], 'invalid_key_reference');
  const language = input['language'];
  if (language !== undefined && (typeof language !== 'string' || !/^[a-z]{2}$/.test(language))) fail('invalid_language');
  const route = input['route'];
  if (!object(route) || route['enabled'] !== true || route['provider'] !== 'gemini' || route['modelId'] !== liveModelId) fail('invalid_route');
  const dataClasses = Object.freeze(classList(route['dataClasses']));
  const prompt = input['prompt'];
  if (!object(prompt)) fail('invalid_prompt');
  const promptText = text(prompt['text'], 'invalid_prompt');
  if (!classes.includes(prompt['dataClass'] as DataClass) || !dataClasses.includes(prompt['dataClass'] as DataClass)) fail('invalid_prompt');
  const dataClass = prompt['dataClass'] as DataClass;
  return Object.freeze({
    ...(input['overlay'] !== undefined ? { overlay: validatePersonaOverlay(input['overlay']) } : {}),
    ...(input['acceptedPrompt'] !== undefined ? { acceptedPrompt: validateAcceptedPrompt(input['acceptedPrompt']) } : {}),
    provider: 'gemini', liveModelId, voice, keyReference,
    ...(language !== undefined ? { language } : {}),
    route: Object.freeze({ enabled: true, provider: 'gemini', modelId: liveModelId, dataClasses }),
    prompt: Object.freeze({ text: promptText, dataClass }), limits: limits(input['limits']),
  });
}

/** Canonical frozen identity from sanitized fields. Shared by the owner, config and status projection. */
export function liveIdentityOf(input: { provider: 'gemini'; liveModelId: string; voice: string; keyReference: string; modelId: string; dataClasses: readonly DataClass[] }): string {
  return createHash('sha256').update(JSON.stringify({
    provider: input.provider, liveModelId: input.liveModelId, voice: input.voice,
    keyReference: input.keyReference,
    route: { enabled: true, modelId: input.modelId, dataClasses: input.dataClasses },
  })).digest('hex');
}

/** Canonical frozen identity of a validated profile. */
export function liveProfileIdentity(profile: LiveProfile): string {
  return liveIdentityOf({
    provider: profile.provider, liveModelId: profile.liveModelId, voice: profile.voice,
    keyReference: profile.keyReference, modelId: profile.route.modelId, dataClasses: profile.route.dataClasses,
  });
}

function acceptedInstruction(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 20000) fail('invalid_prompt');
  return value;
}
