import * as memory from '../domain/memory.js';
import * as labels from '../domain/labels.js';
import type { LiveMemorySource } from '../live/types.js';
import type { OwnerProfileSnapshot } from '../prompt/types.js';
import { credentialsFor, loadProviderConfig } from '../config/index.js';
import { loadLiveConfig, type LiveConfiguredProfile, type LiveConfigStatus } from '../config/live.js';
import { GeminiLiveVoiceAdapter, type DataClass, type LiveSocketFactory } from '../adapters/live-voice/index.js';
import { GeminiAdapter } from '../adapters/model/index.js';
import type { Credentials } from '../adapters/model/types.js';
import { createLiveSessionOwner, defaultLiveLimits, liveProfileIdentity, type LiveAttachment, type LiveContext, type LiveToolsComposition, type LivePageProjection, type LiveFragmentPage, type LiveProfile, type LiveSessionOwner, type LiveSessionSnapshot } from '../live/index.js';
import type { Store } from '../runtime/store.js';
import type { LiveService, LiveStatusPayload } from '../http/live-upgrade.js';
import { hostLogEvent } from './log.js';
import { createGeminiSelector, type ResearchSelector } from '../tools/research.js';

const maxIncomingBytes = 64 * 1024;

/**
 * Trusted in-process seam only: never accepted by CLI/HTTP/env. `profile` lets auth/wire tests drive a
 * validated LiveProfile while LIVE-GATEWAY-R1 blocks the config file from producing one itself.
 */
export interface LiveTesting { credentials?: Credentials; socketFactory?: LiveSocketFactory; profile?: LiveProfile; now?: () => number; researchSelector?: ResearchSelector }

function statusFromProfile(profile: LiveProfile): LiveStatusPayload {
  return {
    service: 'live', status: 'configured', provider: 'gemini', model: profile.liveModelId, voice: profile.voice,
    dataClasses: [...profile.route.dataClasses], profileIdentity: liveProfileIdentity(profile),
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
    service: 'live', status: loaded.status, provider: 'gemini', model: config.model, voice: config.voice,
    dataClasses: [...config.dataClasses], profileIdentity: config.profileIdentity,
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
  constructor(private readonly profile: LiveProfile, private readonly owner: LiveSessionOwner, private readonly store: Store) {
    this.maxBufferedBytes = profile.limits.wsBufferedBytes;
    this.profileIdentity = liveProfileIdentity(profile);
  }
  current(cursor = 0): LivePageProjection { return this.owner.current(cursor); }
  lookupAuthority(runId: string) { return this.owner.lookupAuthority(runId); }
  status(): LiveStatusPayload { return { ...statusFromProfile(this.profile), ...{ memory: this.owner.profileProjection().memory } }; }
  create(inputClass: DataClass, idempotencyKey: string, context: LiveContext): LiveSessionSnapshot {
    const created = this.owner.create({ inputClass, idempotencyKey }, context);
    this.supersedeOtherSessions(created.liveSessionId);
    return created;
  }
  pendingJobs() { return this.owner.pendingJobs(); }
  createWithPending(inputClass: DataClass, idempotencyKey: string, context: LiveContext, pickupJobId?: string): LiveSessionSnapshot {
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
  attach(liveSessionId: string, context: LiveContext): LiveAttachment { return this.owner.attach({ liveSessionId }, context); }
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
 * profile exists, and then only lazily through the credentialsFor seam.
 */
export function composeLive(store: Store, configDir: string, testing?: LiveTesting, now?: () => number, ownerProfile?: OwnerProfileSnapshot, tools?: LiveToolsComposition): { service: LiveService; status: LiveStatusPayload } {
  const loaded = loadLiveConfig({ configDir, ownerId: store.assistantId, ...(ownerProfile ? { ownerProfile } : {}) });
  const profile = testing?.profile ?? (loaded.status === 'configured' ? loaded.config.profile : undefined);
  const status = statusPayload(loaded, profile);
  if (!profile) return { service: new UnconfiguredLive(status), status };
  const credentials = testing?.credentials ?? credentialsFor(configDir);
  const provider = testing?.researchSelector === undefined ? loadProviderConfig({ configDir, ownerId: store.assistantId }) : undefined;
  const researchSelector = testing?.researchSelector ?? (provider?.status === 'ready'
    ? createGeminiSelector(new GeminiAdapter({ modelId: provider.profile.modelId, keyReference: provider.profile.keyReference, credentials }))
    : undefined);
  const voice = new GeminiLiveVoiceAdapter({
    modelId: profile.liveModelId, voice: profile.voice, keyReference: profile.keyReference, credentials,
    route: { enabled: true, provider: 'gemini', modelId: profile.liveModelId, dataClasses: [...profile.route.dataClasses] },
    // wsBufferedBytes belongs to the gateway consumer socket, not this provider socket.
    limits: {
      handshakeMs: profile.limits.handshakeMs, idleMs: profile.limits.idleMs,
      sessionMs: profile.limits.sessionMs, closeMs: profile.limits.closeMs,
    },
    ...(testing?.socketFactory ? { socketFactory: testing.socketFactory } : {}),
  });
  const owner = createLiveSessionOwner({ store, voice, profile, memorySource: resolveLiveMemory, ...(tools ? { tools } : {}), ...(researchSelector ? { research: researchSelector } : {}), ...(now ? { now } : {}) });
  tools?.registerAuthoritySource?.(async (runId, signal) => signal.aborted ? null : owner.lookupAuthority(runId) ?? owner.lookupJobAuthority(runId));
  return { service: new HostLiveService(profile, owner, store), status };
}

/** Same durable entries and routing labels as text chat. Unknown or non-ordinary labels never leave this port. */
export const resolveLiveMemory: LiveMemorySource = tx => {
  const ids = tx.all('SELECT id,session_id FROM entries ORDER BY id').filter(row =>
    labels.current(tx, { kind: 'entry', id: String(row['id']) }).dataClass === 'ordinary'
    && labels.current(tx, { kind: 'session', id: String(row['session_id']) }).dataClass === 'ordinary'
  ).map(row => String(row['id']));
  const records: ReturnType<typeof memory.resolveEntries> = [];
  for (let offset = 0; offset < ids.length; offset += memory.MAX_RESOLVE_ENTRIES) {
    records.push(...memory.resolveEntries(tx, ids.slice(offset, offset + memory.MAX_RESOLVE_ENTRIES)));
  }
  return records.map(record => ({ id: record.entryId, text: record.text, dataClass: 'ordinary' }));
};
