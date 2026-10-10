import { credentialsFor } from '../config/index.js';
import { loadLiveConfig, type LiveConfiguredProfile, type LiveConfigStatus } from '../config/live.js';
import { GeminiLiveVoiceAdapter, type DataClass, type LiveSocketFactory } from '../adapters/live-voice/index.js';
import type { Credentials } from '../adapters/model/types.js';
import { createLiveSessionOwner, defaultLiveLimits, liveProfileIdentity, type LiveAttachment, type LiveContext, type LiveFragmentPage, type LiveProfile, type LiveSessionOwner, type LiveSessionSnapshot } from '../live/index.js';
import type { Store } from '../runtime/store.js';
import type { LiveService, LiveStatusPayload } from '../http/live-upgrade.js';

const maxIncomingBytes = 64 * 1024;

/**
 * Trusted in-process seam only: never accepted by CLI/HTTP/env. `profile` lets auth/wire tests drive a
 * validated LiveProfile while LIVE-GATEWAY-R1 blocks the config file from producing one itself.
 */
export interface LiveTesting { credentials?: Credentials; socketFactory?: LiveSocketFactory; profile?: LiveProfile; now?: () => number }

function statusFromProfile(profile: LiveProfile): LiveStatusPayload {
  return {
    service: 'live', status: 'configured', provider: 'gemini', model: profile.liveModelId, voice: profile.voice,
    dataClasses: [...profile.route.dataClasses], profileIdentity: liveProfileIdentity(profile),
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
  constructor(private readonly profile: LiveProfile, private readonly owner: LiveSessionOwner) {
    this.maxBufferedBytes = profile.limits.wsBufferedBytes;
    this.profileIdentity = liveProfileIdentity(profile);
  }
  status(): LiveStatusPayload { return statusFromProfile(this.profile); }
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
  readonly maxBufferedBytes = defaultLiveLimits.wsBufferedBytes;
  constructor(private readonly payload: LiveStatusPayload) {}
  status(): LiveStatusPayload { return this.payload; }
  create(): never { return unavailable('LIVE_NOT_CONFIGURED'); }
  snapshot(): never { return unavailable('LIVE_NOT_CONFIGURED'); }
  journal(): never { return unavailable('LIVE_NOT_CONFIGURED'); }
  revoke(): never { return unavailable('LIVE_NOT_CONFIGURED'); }
  attach(): never { return unavailable('LIVE_NOT_CONFIGURED'); }
  async shutdown(): Promise<void> {}
}

/**
 * Compose the accepted Live owner into the canonical host on the SAME Store. Configuration is frozen at
 * startup; recovery completes before the listener announces readiness. No secret is read unless a
 * profile exists, and then only lazily through the credentialsFor seam.
 */
export function composeLive(store: Store, configDir: string, testing?: LiveTesting, now?: () => number): { service: LiveService; status: LiveStatusPayload } {
  const loaded = loadLiveConfig({ configDir, ownerId: store.assistantId });
  const profile = testing?.profile ?? (loaded.status === 'configured' ? loaded.config.profile : undefined);
  const status = statusPayload(loaded, profile);
  if (!profile) return { service: new UnconfiguredLive(status), status };
  const credentials = testing?.credentials ?? credentialsFor(configDir);
  const voice = new GeminiLiveVoiceAdapter({
    modelId: profile.liveModelId, voice: profile.voice, keyReference: profile.keyReference, credentials,
    route: { enabled: true, provider: 'gemini', modelId: profile.liveModelId, dataClasses: [...profile.route.dataClasses] },
    limits: {
      handshakeMs: profile.limits.handshakeMs, idleMs: profile.limits.idleMs,
      sessionMs: profile.limits.sessionMs, closeMs: profile.limits.closeMs,
      maxBufferedBytes: profile.limits.wsBufferedBytes,
    },
    ...(testing?.socketFactory ? { socketFactory: testing.socketFactory } : {}),
  });
  const owner = createLiveSessionOwner({ store, voice, profile, ...(now ? { now } : {}) });
  return { service: new HostLiveService(profile, owner), status };
}
