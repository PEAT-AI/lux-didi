import { credentialsFor } from '../config/index.js';
import { loadLiveConfig, type LiveConfigStatus, type LiveConfiguredProfile } from '../config/live.js';
import { GeminiLiveVoiceAdapter, type DataClass, type LiveSocketFactory } from '../adapters/live-voice/index.js';
import type { Credentials } from '../adapters/model/types.js';
import { createLiveSessionOwner, defaultLiveLimits, type LiveAttachment, type LiveContext, type LiveFragmentPage, type LiveSessionOwner, type LiveSessionSnapshot } from '../live/index.js';
import type { Store } from '../runtime/store.js';
import type { LiveService, LiveStatusPayload } from '../http/live-upgrade.js';

const maxIncomingBytes = 64 * 1024;

/** Trusted in-process seam only: never accepted by CLI/HTTP/env. */
export interface LiveTesting { credentials?: Credentials; socketFactory?: LiveSocketFactory; now?: () => number }

/** Safe status projection. Never carries key bytes, prompt text or private paths. */
function statusPayload(loaded: LiveConfigStatus): LiveStatusPayload {
  if (loaded.status === 'unconfigured') return { service: 'live', status: 'unconfigured' };
  if (loaded.status === 'error') return { service: 'live', status: 'error', code: loaded.code };
  return {
    service: 'live', status: loaded.status, provider: 'gemini', model: loaded.config.model, voice: loaded.config.voice,
    dataClasses: [...loaded.config.dataClasses], profileIdentity: loaded.config.profileIdentity,
  };
}

function disabled(code: string, status: number): never {
  const error = new Error(code) as Error & { status: number };
  error.name = 'LiveUnconfigured';
  error.status = status;
  throw error;
}

class HostLiveService implements LiveService {
  readonly enabled = true;
  readonly maxIncomingBytes = maxIncomingBytes;
  readonly maxBufferedBytes: number;
  constructor(private readonly config: LiveConfiguredProfile, private readonly owner: LiveSessionOwner) {
    this.maxBufferedBytes = config.profile.limits.consumerQueueBytes;
  }
  get profileIdentity(): string { return this.config.profileIdentity; }
  status(): LiveStatusPayload {
    return {
      service: 'live', status: 'configured', provider: 'gemini', model: this.config.model, voice: this.config.voice,
      dataClasses: [...this.config.dataClasses], profileIdentity: this.config.profileIdentity,
    };
  }
  create(inputClass: DataClass, idempotencyKey: string, context: LiveContext): LiveSessionSnapshot {
    return this.owner.create({ inputClass, idempotencyKey }, context);
  }
  snapshot(liveSessionId: string): LiveSessionSnapshot { return this.owner.get(liveSessionId); }
  journal(liveSessionId: string, cursor: number | undefined, limit: number | undefined): LiveFragmentPage {
    return this.owner.listFragments({ liveSessionId, ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) });
  }
  revoke(liveSessionId: string): void { this.owner.revoke(liveSessionId); }
  attach(liveSessionId: string, context: LiveContext): LiveAttachment { return this.owner.attach({ liveSessionId }, context); }
  shutdown(): Promise<void> { return this.owner.shutdown(); }
}

class UnconfiguredLive implements LiveService {
  readonly enabled = false;
  readonly profileIdentity = '';
  readonly maxIncomingBytes = maxIncomingBytes;
  readonly maxBufferedBytes = defaultLiveLimits.consumerQueueBytes;
  constructor(private readonly payload: LiveStatusPayload) {}
  status(): LiveStatusPayload { return this.payload; }
  create(): LiveSessionSnapshot { return disabled('LIVE_NOT_CONFIGURED', 503); }
  snapshot(): LiveSessionSnapshot { return disabled('LIVE_NOT_CONFIGURED', 503); }
  journal(): LiveFragmentPage { return disabled('LIVE_NOT_CONFIGURED', 503); }
  revoke(): void { disabled('LIVE_NOT_CONFIGURED', 503); }
  attach(): LiveAttachment { return disabled('LIVE_NOT_CONFIGURED', 503); }
  async shutdown(): Promise<void> {}
}

/**
 * Compose the accepted Live owner into the canonical host on the SAME Store. Configuration is frozen
 * at startup; recovery completes before the listener announces readiness. No secret is read unless the
 * profile is configured, and then only lazily through the credentialsFor seam.
 */
export function composeLive(store: Store, configDir: string, testing?: LiveTesting, now?: () => number): { service: LiveService; status: LiveStatusPayload } {
  const loaded = loadLiveConfig({ configDir, ownerId: store.assistantId });
  const status = statusPayload(loaded);
  if (loaded.status !== 'configured') return { service: new UnconfiguredLive(status), status };
  const config: LiveConfiguredProfile = loaded.config;
  const credentials = testing?.credentials ?? credentialsFor(configDir);
  const voice = new GeminiLiveVoiceAdapter({
    modelId: config.model, voice: config.voice, keyReference: 'gemini-primary', credentials,
    route: { enabled: true, provider: 'gemini', modelId: config.model, dataClasses: [...config.dataClasses] },
    ...(testing?.socketFactory ? { socketFactory: testing.socketFactory } : {}),
  });
  const owner = createLiveSessionOwner({ store, voice, profile: config.profile, ...(now ? { now } : {}) });
  return { service: new HostLiveService(config, owner), status };
}
