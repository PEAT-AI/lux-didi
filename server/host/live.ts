import { activeItems } from '../domain/memory-items.js';
import { historySessionEvidence } from '../domain/history-lifecycle.js';
import { VaultWriter } from '../tools/vault-write.js';
import { createLuxWriteTransport, luxWriteEndpoint } from '../adapters/lux-write/client.js';
import { hostTaskFactory } from '../tasks/host.js';
import { loadTaskModels } from '../config/tasks.js';
import { boundTextModel, pinProviderBinding, type PinnedProviderBinding } from './provider-binding.js';
import { ConfigError } from '../config/files.js';
import { validateLiveProfile } from '../live/config.js';
import { HISTORY_CLASSES } from '../domain/history-lifecycle.js';
import { listStandingMemory } from '../memory/import.js';
import type { LiveMemorySource } from '../live/types.js';
import type { OwnerProfileSnapshot } from '../prompt/types.js';
import { credentialsFor, loadProviderConfig, seedScope, slotKeyPresent } from '../config/index.js';
import { loadLiveConfig, saveLiveSelection, currentLivePlaybackRate, type LiveConfiguredProfile, type LiveConfigStatus } from '../config/live.js';
import { createLiveVoiceAdapter, LiveVoiceError, type DataClass, type LiveSocketFactory } from '../adapters/live-voice/index.js';
import type { Credentials } from '../adapters/model/types.js';
import { createLiveSessionOwner, defaultLiveLimits, liveProfileIdentity, type LiveAttachment, type LiveContext, type LiveToolsComposition, type LivePageProjection, type LiveFragmentPage, type LiveProfile, type LiveSessionOwner, type LiveSessionSnapshot } from '../live/index.js';
import type { Store } from '../runtime/store.js';
import type { LiveSelectionResult, LiveService, LiveStatusPayload } from '../http/live-upgrade.js';
import { hostLogEvent } from './log.js';
import { createWebSearch, type WebSearchPort } from '../tools/web-search.js';
import type { CalendarDigestSnapshot } from '../live/warm-context.js';
import type { WarmPrewarmReceipt } from '../live/index.js';

const maxIncomingBytes = 64 * 1024;

/**
 * Trusted in-process seam only: never accepted by CLI/HTTP/env. `profile` lets auth/wire tests drive a
 * validated LiveProfile while LIVE-GATEWAY-R1 blocks the config file from producing one itself.
 */
export interface LiveTesting {
  schedule?: Parameters<typeof createLiveSessionOwner>[0]['schedule'];
  createTaskRuntime?: import('../tasks/host.js').HostTaskFactory; credentials?: Credentials; socketFactory?: LiveSocketFactory; profile?: LiveProfile; now?: () => number; researchWeb?: WebSearchPort }

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
  createAlarm(alarm: import('../live/types.js').AlarmSessionSetup, idempotencyKey: string, context: LiveContext): LiveSessionSnapshot {
    this.requireKey();
    return this.owner.announceAlarm(alarm) ?? this.owner.create({ inputClass: 'ordinary', idempotencyKey, alarm }, context);
  }
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
  providerReady(liveSessionId: string): boolean { return this.owner.providerReady(liveSessionId); }
  journal(liveSessionId: string, cursor: number | undefined, limit: number | undefined): LiveFragmentPage {
    return this.owner.listFragments({ liveSessionId, ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) });
  }
  revoke(liveSessionId: string): void { this.owner.revoke(liveSessionId); }
  attach(liveSessionId: string, context: LiveContext): LiveAttachment { this.requireKey(); return this.owner.attach({ liveSessionId }, context); }
  text(text: string): void { this.owner.text(text); }
  shutdown(reason?: string): Promise<void> { return this.owner.shutdown(reason); }
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
  async shutdown(_reason?: string): Promise<void> {}
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
  let researchWeb = testing?.researchWeb;
  // TRAIN3J-R3: the key slot is a create-time gate, never a status one. Status stays local validation
  // (configured without reading the secret); a session for a slot with no key fails loud, never as Gemini.
  const keyPresent = testing?.credentials !== undefined || slotKeyPresent(configDir, profile.keyReference);
  try {
    // A gemini live route shares the text slot, so no per-route receipt exists to pin. A slot with no
    // receipt is a create-time gate too: status stays local validation and create() fails closed.
    if (!testing?.credentials && profile.provider !== 'gemini') {
      try {
        binding = pinProviderBinding(configDir, seedScope(profile.provider, profile.liveModelId, profile.route.dataClasses));
        profile = validateLiveProfile({ ...profile, credentialBinding: binding.identity });
      } catch (error) { if (keyPresent) throw error; binding = undefined; }
    }
    if (!researchWeb) {
      try {
        const provider = loadProviderConfig({ configDir, ownerId: store.assistantId });
        if (provider.status === 'ready') {
          const bound = boundTextModel(configDir, provider, testing);
          researchWeb = createWebSearch({ credentials: testing?.credentials ?? bound.binding!.credentials() });
        }
      } catch { researchWeb = undefined; }
    }
  } catch (error) {
    return { service: new UnconfiguredLive({ ...status, status: 'error', code: error instanceof ConfigError ? error.code : 'binding_unavailable' }), status: { ...status, status: 'error', code: error instanceof ConfigError ? error.code : 'binding_unavailable' } };
  }
  const boundProfile = profile;
  let voice: ReturnType<typeof createLiveVoiceAdapter>;
  try {
    const create = () => createLiveVoiceAdapter({
    modelId: boundProfile.liveModelId, voice: boundProfile.voice, keyReference: boundProfile.keyReference, credentials: testing?.credentials ?? binding?.credentials() ?? credentialsFor(configDir),
    route: { enabled: true, provider: boundProfile.provider, modelId: boundProfile.liveModelId, dataClasses: [...boundProfile.route.dataClasses] },
    // wsBufferedBytes belongs to the gateway consumer socket, not this provider socket.
    limits: {
      handshakeMs: boundProfile.limits.handshakeMs, idleMs: boundProfile.limits.idleMs,
      sessionMs: boundProfile.limits.sessionMs, closeMs: boundProfile.limits.closeMs,
    },
    ...(testing?.socketFactory ? { socketFactory: testing.socketFactory } : {}),
    });
    const initial = create(); voice = { capabilities: initial.capabilities, open: (request, control) => create().open(request, control) };
  } catch (error) {
    // A provider with no adapter yet (or one that rejects its settings) reports its own code, never a fallback.
    const code = error instanceof LiveVoiceError ? error.code : 'unsupported_provider';
    const failed: LiveStatusPayload = { ...status, status: 'error', code };
    return { service: new UnconfiguredLive(failed), status: failed };
  }
  // M2: the owner's own zone wins over the machine's, so a host clock on the wrong zone is correctable.
  const preferencesZone = loaded.status === 'configured' ? loaded.config.preferences.timeZone : undefined;
  const ownerZone = preferencesZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const vault = new VaultWriter({ store, transport: createLuxWriteTransport(luxWriteEndpoint()), now: now ?? Date.now, log: event => hostLogEvent(event) });
  const createTaskRuntime = testing?.createTaskRuntime ?? hostTaskFactory({ store, vault, models: loadTaskModels(configDir),
    credentials: testing?.credentials ?? credentialsFor(configDir), bindings: () => tools?.owner.taskBindings(tools.connectionIds()) ?? [],
    executors: sessionId => tools?.owner.taskExecutors(sessionId) ?? {},
    ...(tools?.draftChat ? { draftChat: tools.draftChat.bind(tools) } : {}),
    timeZone: ownerZone,
    // D3: the helper's memory search is admitted by the same route classes the start block uses.
    dataClasses: [...profile.route.dataClasses],
    ...(researchWeb ? { web: researchWeb } : {}), log: event => hostLogEvent(event),
  });
  // The host zone is never pinned: #ownerTimeZone resolves Intl at compose time, so a Mac zone change between
  // calls reaches the next call. Only the owner's own settings zone is pinned, because nothing else knows it.
  const owner = createLiveSessionOwner({ store, voice, profile, createTaskRuntime,
    ...(preferencesZone === undefined ? {} : { timeZone: preferencesZone, timeZoneSource: 'settings' as const }),
    ...(testing?.schedule ? { schedule: testing.schedule } : {}), memorySource: resolveLiveMemory, ...(tools ? { tools } : {}), ...(researchWeb ? { web: researchWeb } : {}), ...(now ? { now } : {}) });
  binding?.onInvalidated(() => owner.invalidate('profile'));
  tools?.registerAuthoritySource?.(async (runId, signal) => signal.aborted ? null : owner.lookupAuthority(runId) ?? owner.lookupJobAuthority(runId));
  return { service: new HostLiveService(profile, owner, store, configDir, keyPresent, binding), status: statusFromProfile(profile) };
}

/**
 * Resolve durable candidates once; the Live owner applies its route's class set at admission.
 * D6: one indexed read per store, never a scan plus a round trip per row: the entries read
 * carries its own text inside the same left join, the items read is one statement, and the
 * source sessions of every item arrive together with one memoized evidence walk.
 */
export const resolveLiveMemory: LiveMemorySource = tx => {
  const rows = tx.all(`SELECT e.id,e.text,e.captured_at,el.data_class AS entry_class,pl.data_class AS parent_class
    FROM entries e JOIN sessions s ON s.id=e.session_id
    LEFT JOIN routing_labels el ON el.subject_kind='entry' AND el.subject_id=e.id
      AND el.revision=(SELECT MAX(revision) FROM routing_labels WHERE subject_kind='entry' AND subject_id=e.id)
    LEFT JOIN routing_labels pl ON pl.subject_kind='session' AND pl.subject_id=s.id
      AND pl.revision=(SELECT MAX(revision) FROM routing_labels WHERE subject_kind='session' AND subject_id=s.id)
    ORDER BY e.captured_at DESC,e.id`);
  const records = rows.map(row => {
    const entry = HISTORY_CLASSES.find(value => value === row['entry_class']);
    const parent = HISTORY_CLASSES.find(value => value === row['parent_class']);
    const dataClass = entry === undefined || parent === undefined ? 'unknown' as const
      : HISTORY_CLASSES[Math.max(HISTORY_CLASSES.indexOf(entry), HISTORY_CLASSES.indexOf(parent))]!;
    return { id: String(row['id']), text: String(row['text']), capturedAt: Number(row['captured_at']), dataClass };
  });
  const ranked = listStandingMemory(tx);
  const resolved = new Map(records.map(record => [record.id, record]));
  const standing = ranked.flatMap(item => {
    const record = resolved.get(item.id);
    return record === undefined ? [] : [{ id: record.id, text: record.text, capturedAt: record.capturedAt,
      dataClass: record.dataClass, standing: item }];
  });
  const taken = new Set(standing.map(record => record.id));
  const plain = records.filter(record => !taken.has(record.id));
  const order = ['ordinary', 'private', 'sensitive', 'unknown'] as const;
  // One read of every active item, in the subject order the typed part has always had. `activeItems`
  // orders by creation, so the subject order is restored here rather than re-queried per subject; the
  // start block admits before the budget does, so this read is not capped.
  const items = activeItems(tx, { limit: Number.MAX_SAFE_INTEGER })
    .sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0)
      || b.createdAt - a.createdAt
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sources = new Map<string, string[]>();
  for (const row of tx.all('SELECT memory_id, session_id FROM memory_sources ORDER BY memory_id, session_id')) {
    const memoryId = String(row['memory_id']);
    const sessionId = String(row['session_id']);
    const list = sources.get(memoryId) ?? [];
    if (!list.includes(sessionId)) list.push(sessionId);
    sources.set(memoryId, list);
  }
  const evidence = new Map<string, ReturnType<typeof historySessionEvidence>>();
  const typed = items.map(memoryItem => {
    const sourceSessionIds = sources.get(memoryItem.id) ?? [];
    const sourceClasses = sourceSessionIds.map(id => historySessionEvidence(tx, id, evidence)?.dataClass ?? 'unknown');
    const dataClass = order[sourceClasses.length ? Math.max(...sourceClasses.map(value => order.indexOf(value))) : 3]!;
    return { id: memoryItem.id, text: memoryItem.text, dataClass, memoryItem, sourceSessionIds };
  });
  return [...standing, ...plain, ...typed];
};
