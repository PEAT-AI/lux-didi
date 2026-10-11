import { createHash } from 'node:crypto';
import type { DataClass } from '../adapters/live-voice/index.js';
import { ownerProfileClasses, PROMPT_VERSION, validateOwnerProfile } from '../prompt/index.js';
import { LiveConfigError, type AcceptedPromptSnapshot, type LiveLimits, type LiveProfile } from './types.js';

const classes: readonly DataClass[] = ['ordinary', 'private', 'sensitive'];
const modelPattern = /^models\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const maxTimer = 2_147_483_647;
const limitBounds: Readonly<Record<keyof LiveLimits, number>> = {
  sessionMs: maxTimer, idleMs: maxTimer, unusedMs: maxTimer, handshakeMs: maxTimer, closeMs: maxTimer,
  journalMaxEvents: 1_000_000, journalMaxBytes: 1024 * 1024 * 1024,
  consumerQueueEvents: 65_536, consumerQueueBytes: 64 * 1024 * 1024, wsBufferedBytes: 64 * 1024 * 1024,
};
export const defaultLiveLimits: Readonly<LiveLimits> = Object.freeze({
  sessionMs: 900_000, idleMs: 60_000, unusedMs: 300_000, handshakeMs: 15_000, closeMs: 1_000,
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
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > limitBounds[name]) fail('invalid_limit');
  return value;
}
function limits(value: unknown): LiveLimits {
  if (value !== undefined && !object(value)) fail('invalid_limit');
  for (const key of Object.keys(object(value) ? value : {})) if (!(key in limitBounds)) fail('invalid_limit');
  const source = object(value) ? value : {};
  return Object.freeze({
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
  if (!object(input) || Object.keys(input).length !== 5
    || Object.keys(input).some(k => !['schemaVersion','ownerProfile','compilerVersion','system','dataClasses'].includes(k))
    || input['schemaVersion'] !== 1 || input['compilerVersion'] !== PROMPT_VERSION) fail('invalid_prompt');
  try {
    const raw = input['ownerProfile'];
    if (!object(raw) || typeof raw['ownerId'] !== 'string') fail('invalid_prompt');
    const ownerProfile = validateOwnerProfile(raw, ownerId ?? raw['ownerId']);
    const dataClasses = classList(input['dataClasses']);
    if (ownerProfileClasses(ownerProfile).some(c => !dataClasses.includes(c))) fail('invalid_prompt');
    return Object.freeze({ schemaVersion: 1, ownerProfile, compilerVersion: PROMPT_VERSION,
      system: text(input['system'], 'invalid_prompt'), dataClasses: Object.freeze(dataClasses) });
  } catch { fail('invalid_prompt'); }
}

export function validateLiveProfile(input: unknown): LiveProfile {
  if (!object(input)) fail('invalid_object');
  if (input['provider'] !== 'gemini') fail('invalid_provider');
  const liveModelId = text(input['liveModelId'], 'invalid_model');
  if (!modelPattern.test(liveModelId)) fail('invalid_model');
  const voice = text(input['voice'], 'invalid_voice');
  const keyReference = text(input['keyReference'], 'invalid_key_reference');
  const route = input['route'];
  if (!object(route) || route['enabled'] !== true || route['provider'] !== 'gemini' || route['modelId'] !== liveModelId) fail('invalid_route');
  const dataClasses = Object.freeze(classList(route['dataClasses']));
  const prompt = input['prompt'];
  if (!object(prompt)) fail('invalid_prompt');
  const promptText = text(prompt['text'], 'invalid_prompt');
  if (!classes.includes(prompt['dataClass'] as DataClass) || !dataClasses.includes(prompt['dataClass'] as DataClass)) fail('invalid_prompt');
  const dataClass = prompt['dataClass'] as DataClass;
  return Object.freeze({
    ...(input['acceptedPrompt'] !== undefined ? { acceptedPrompt: validateAcceptedPrompt(input['acceptedPrompt']) } : {}),
    provider: 'gemini', liveModelId, voice, keyReference,
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
