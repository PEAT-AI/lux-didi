import { boundTextModel, pinProviderBinding, type PinnedProviderBinding } from './provider-binding.js';
import { ConfigError } from '../config/files.js';
import { validateLiveProfile } from '../live/config.js';
import * as memory from '../domain/memory.js';
import { entryAndParentOrdinary } from '../domain/labels.js';
import { listStandingMemory, type StandingMemoryItem } from '../memory/import.js';
import type { LiveMemorySource } from '../live/types.js';
import type { OwnerProfileSnapshot } from '../prompt/types.js';
import { NAYA_BACKEND_PROCEDURE } from '../prompt/backend-procedure.js';
import { loadProviderConfig, seedScope } from '../config/index.js';
import { loadLiveConfig, saveLiveSelection, currentLivePlaybackRate, type LiveConfiguredProfile, type LiveConfigStatus } from '../config/live.js';
import { createLiveVoiceAdapter, LiveVoiceError, type DataClass, type LiveSocketFactory } from '../adapters/live-voice/index.js';
import type { Credentials } from '../adapters/model/types.js';
import { createLiveSessionOwner, defaultLiveLimits, liveProfileIdentity, type LiveAttachment, type LiveContext, type LiveToolsComposition, type LivePageProjection, type LiveFragmentPage, type LiveProfile, type LiveSessionOwner, type LiveSessionSnapshot } from '../live/index.js';
import type { Store } from '../runtime/store.js';
import type { LiveSelectionResult, LiveService, LiveStatusPayload } from '../http/live-upgrade.js';
import { hostLogEvent } from './log.js';
import { createGeminiSelector, type ResearchSelector } from '../tools/research.js';
import type { CalendarDigestSnapshot } from '../live/warm-context.js';
import type { WarmPrewarmReceipt } from '../live/index.js';

const maxIncomingBytes = 64 * 1024;

/**
 * Trusted in-process seam only: never accepted by CLI/HTTP/env. `profile` lets auth/wire tests drive a
 * validated LiveProfile while LIVE-GATEWAY-R1 blocks the config file from producing one itself.
 */
export interface LiveTesting { credentials?: Credentials; socketFactory?: LiveSocketFactory; profile?: LiveProfile; now?: () => number; researchSelector?: ResearchSelector }

function statusFromProfile(profile: LiveProfile): LiveStatusPayload {
  return {
    service: 'live', status: 'configured', provider: profile.provider, model: profile.liveModelId, voice: profile.voice,
    dataClasses: [...profile.route.dataClasses], profileIdentity: liveProfileIdentity(profile),
    playbackRate: currentLivePlaybackRate(),
    limits: { sessionMs: profile.limits.sessionMs, idleMs: profile.limits.idleMs },
  };
}

/** Safe status projection. Never carries key bytes, prompt text or private paths. */
function statusPayload(loaded: LiveConfigStatus, profile: LiveProfile | undefined): LiveStatusPayload {
  if (profile) return statusFromProfile(profile);
  if (loaded.status === 'unconfigured') return { service: 'live', status: 'unconfigured' };
  if (loaded.status === 'error') return { service: 'live', status: 'error', code: loaded.code };
  const config: LiveConfiguredProfile = loaded.config;
  return {
    service: 'live', status: loaded.status, provider: config.provider, model: config.model, voice: config.voice,
    dataClasses: [...config.dataClasses], profileIdentity: config.profileIdentity, playbackRate: config.playbackRate,
  };
}

function unavailable(code: string): never {
  const error = new Error(code) as Error & { code: string };
  error.name = 'LiveUnavailable';
  error.code = code;
  throw error;
}

class HostLiveService implements LiveService {
  readonly enabled = true;
  readonly maxIncomingBytes = maxIncomingBytes;
  readonly maxBufferedBytes: number;
  readonly profileIdentity: string;
  constructor(private readonly profile: LiveProfile, private readonly owner: LiveSessionOwner, private readonly store: Store,
    private readonly configDir: string, private readonly keyPresent: boolean, private readonly binding?: PinnedProviderBinding) {
    this.maxBufferedBytes = profile.limits.wsBufferedBytes;
    this.profileIdentity = liveProfileIdentity(profile);
  }
  current(cursor = 0): LivePageProjection { return this.owner.current(cursor); }
  prepareCalendar(): Promise<CalendarDigestSnapshot> { return this.owner.prepareCalendar(); }
  prewarm(): Promise<WarmPrewarmReceipt> { return this.owner.prewarm(); }
  lookupAuthority(runId: string) { return this.owner.lookupAuthority(runId); }
  status(): LiveStatusPayload { return { ...statusFromProfile(this.profile), ...{ memory: this.owner.profileProjection().memory } }; }
  /** Owner choice persisted into live.json; the loaded profile here keeps the call in flight untouched. */
  saveSelection(input: { provider: unknown; voice?: unknown; accent?: unknown }): LiveSelectionResult {
    const saved = saveLiveSelection({ configDir: this.configDir, ownerId: this.store.assistantId, provider: input.provider,
      ...(input.voice !== undefined ? { voice: input.voice } : {}), ...(input.accent !== undefined ? { accent: input.accent } : {}) });
    return { ...saved, appliesAt: 'next_start' };
  }
  private requireKey(): void { if (!this.keyPresent) unavailable('key_missing'); this.binding?.check(); }
  create(inputClass: DataClass, idempotencyKey: string, context: LiveContext): LiveSessionSnapshot {
    this.requireKey();
    const created = this.owner.create({ inputClass, idempotencyKey }, context);
    this.supersedeOtherSessions(created.liveSessionId);
    return created;
  }
  pendingJobs() { return this.owner.pendingJobs(); }
  createWithPending(inputClass: DataClass, idempotencyKey: string, context: LiveContext, pickupJobId?: string): LiveSessionSnapshot {
    this.requireKey();
    const created = this.owner.createWithPending({ inputClass, idempotencyKey, ...(pickupJobId ? { pickupJobId } : {}) }, context);
    this.supersedeOtherSessions(created.liveSessionId);
    return created;
  }
  /** At most one Live session per owner: end every other non-terminal row through the normal path. */
  private supersedeOtherSessions(keep: string): void {
    const rows = this.store.transaction(tx => tx.all(
      "SELECT live_session_id FROM live_sessions WHERE owner_assistant_id=? AND live_session_id<>? AND lifecycle IN ('accepted','opening','active')",
      [this.store.assistantId, keep]));
    for (const row of rows) {
      const liveSessionId = String(row['live_session_id']);
      this.owner.revoke(liveSessionId);
      hostLogEvent({ event: 'live_session_superseded', liveSessionId });
    }
  }
  snapshot(liveSessionId: string): LiveSessionSnapshot { return this.owner.get(liveSessionId); }
  journal(liveSessionId: string, cursor: number | undefined, limit: number | undefined): LiveFragmentPage {
    return this.owner.listFragments({ liveSessionId, ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) });
  }
  revoke(liveSessionId: string): void { this.owner.revoke(liveSessionId); }
  attach(liveSessionId: string, context: LiveContext): LiveAttachment { this.requireKey(); return this.owner.attach({ liveSessionId }, context); }
  text(text: string): void { this.owner.text(text); }
  shutdown(): Promise<void> { return this.owner.shutdown(); }
}

class UnconfiguredLive implements LiveService {
  readonly enabled = false;
  readonly profileIdentity = '';
  readonly maxIncomingBytes = maxIncomingBytes;
  readonly maxBufferedBytes = defaultLiveLimits.wsBufferedBytes;
  constructor(private readonly payload: LiveStatusPayload) {}
  current(cursor = 0): LivePageProjection { return { state: 'idle', since: null, entries: [], cursor }; }
  lookupAuthority(_runId: string) { return null; }
  async prepareCalendar(): Promise<CalendarDigestSnapshot> {
    return { state: 'unconfigured', text: undefined, items: 0, fetchedAt: Date.now() };
  }
  async prewarm(): Promise<WarmPrewarmReceipt> {
    return { ageBeforeMs: null, ageAfterMs: null, assembled: false, reason: 'unconfigured' };
  }
  status(): LiveStatusPayload { return this.payload; }
  create(): never { return unavailable('LIVE_NOT_CONFIGURED'); }
  snapshot(): never { return unavailable('LIVE_NOT_CONFIGURED'); }
  journal(): never { return unavailable('LIVE_NOT_CONFIGURED'); }
  revoke(): never { return unavailable('LIVE_NOT_CONFIGURED'); }
  attach(): never { return unavailable('LIVE_NOT_CONFIGURED'); }
  text(): never { return unavailable('LIVE_NOT_CONFIGURED'); }
  async shutdown(): Promise<void> {}
}

/**
 * Compose the accepted Live owner into the canonical host on the SAME Store. Configuration is frozen at
 * startup; recovery completes before the listener announces readiness. No secret is read unless a
 * profile exists; each provider open resolves its exact pinned receipt.
 */
export function composeLive(store: Store, configDir: string, testing?: LiveTesting, now?: () => number, ownerProfile?: OwnerProfileSnapshot, tools?: LiveToolsComposition): { service: LiveService; status: LiveStatusPayload } {
  const loaded = loadLiveConfig({ configDir, ownerId: store.assistantId, ...(ownerProfile ? { ownerProfile } : {}) });
  let profile = testing?.profile ?? (loaded.status === 'configured' ? loaded.config.profile : undefined);
  const status = statusPayload(loaded, profile);
  if (!profile) return { service: new UnconfiguredLive(status), status };
  let binding: PinnedProviderBinding | undefined;
  let researchSelector = testing?.researchSelector;
  try {
    if (!testing?.credentials) {
      if (profile.provider === 'gemini') throw new ConfigError('shared_slot_conflict');
      binding = pinProviderBinding(configDir, seedScope(profile.provider, profile.liveModelId, profile.route.dataClasses));
      profile = validateLiveProfile({ ...profile, credentialBinding: binding.identity });
    }
    if (!researchSelector) {
      const provider = loadProviderConfig({ configDir, ownerId: store.assistantId });
      if (provider.status === 'ready') researchSelector = createGeminiSelector(boundTextModel(configDir, provider, testing).model);
    }
  } catch (error) {
    return { service: new UnconfiguredLive({ ...status, status: 'error', code: error instanceof ConfigError ? error.code : 'binding_unavailable' }), status: { ...status, status: 'error', code: error instanceof ConfigError ? error.code : 'binding_unavailable' } };
  }
  const boundProfile = profile;
  let voice: ReturnType<typeof createLiveVoiceAdapter>;
  try {
    const create = () => createLiveVoiceAdapter({
    modelId: boundProfile.liveModelId, voice: boundProfile.voice, keyReference: boundProfile.keyReference, credentials: testing?.credentials ?? binding!.credentials(),
    route: { enabled: true, provider: boundProfile.provider, modelId: boundProfile.liveModelId, dataClasses: [...boundProfile.route.dataClasses] },
    // wsBufferedBytes belongs to the gateway consumer socket, not this provider socket.
    limits: {
      handshakeMs: boundProfile.limits.handshakeMs, idleMs: boundProfile.limits.idleMs,
      sessionMs: boundProfile.limits.sessionMs, closeMs: boundProfile.limits.closeMs,
    },
    ...(testing?.socketFactory ? { socketFactory: testing.socketFactory } : {}),
    // S4b: only the delegated backend executes the lookups; a direct-tool provider has no backend to instruct.
    ...(boundProfile.provider === 'openai' ? { backendProcedure: NAYA_BACKEND_PROCEDURE } : {}),
    });
    const initial = create(); voice = { capabilities: initial.capabilities, open: (request, control) => create().open(request, control) };
  } catch (error) {
    // A provider with no adapter yet (or one that rejects its settings) reports its own code, never a fallback.
    const code = error instanceof LiveVoiceError ? error.code : 'unsupported_provider';
    const failed: LiveStatusPayload = { ...status, status: 'error', code };
    return { service: new UnconfiguredLive(failed), status: failed };
  }
  const owner = createLiveSessionOwner({ store, voice, profile, memorySource: resolveLiveMemory, ...(tools ? { tools } : {}), ...(researchSelector ? { research: researchSelector } : {}), ...(now ? { now } : {}) });
  binding?.onInvalidated(() => owner.invalidate('profile'));
  tools?.registerAuthoritySource?.(async (runId, signal) => signal.aborted ? null : owner.lookupAuthority(runId) ?? owner.lookupJobAuthority(runId));
  return { service: new HostLiveService(profile, owner, store, configDir, true, binding), status: statusFromProfile(profile) };
}

/** Same durable entries and routing labels as text chat. Unknown or non-ordinary labels never leave this port. */
export const resolveLiveMemory: LiveMemorySource = tx => {
  const ids = tx.all('SELECT id,session_id FROM entries ORDER BY id').filter(row =>
    entryAndParentOrdinary(tx, String(row['id']), String(row['session_id']))
  ).map(row => String(row['id']));
  const records: ReturnType<typeof memory.resolveEntries> = [];
  for (let offset = 0; offset < ids.length; offset += memory.MAX_RESOLVE_ENTRIES) {
    records.push(...memory.resolveEntries(tx, ids.slice(offset, offset + memory.MAX_RESOLVE_ENTRIES)));
  }
  // An imported note carries its ranking with it, and the standing records lead the list in rank order:
  // the prompt renders them as given, so entry-id order never decides the section.
  const ranked = listStandingMemory(tx);
  const resolved = new Map(records.map(record => [record.entryId, record]));
  const standing = ranked.flatMap((item): { id: string; text: string; dataClass: 'ordinary'; standing?: StandingMemoryItem }[] => {
    const record = resolved.get(item.id);
    return record === undefined ? [] : [{ id: record.entryId, text: record.text, dataClass: 'ordinary', standing: item }];
  });
  const taken = new Set(standing.map(record => record.id));
  const plain = records.filter(record => !taken.has(record.entryId)).map(record => ({ id: record.entryId, text: record.text, dataClass: 'ordinary' as const }));
  return [...standing, ...plain];
};
