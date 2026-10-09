import type { DomainPort } from '../contracts/domain.js';
import type { Store } from '../runtime/store.js';
import { ChatService } from '../chat/index.js';
import { loadProviderConfig } from '../config/index.js';
import { GeminiAdapter, type Credentials, type Transport } from '../adapters/model/index.js';
import { validatePreferences } from '../prompt/index.js';

export type ConnectedStatus = { status: 'unconfigured' } | { status: 'error'; code: string }
  | { status: 'disabled' | 'configured'; provider: 'gemini'; model: string };
/** Trusted in-process construction seam only: never accepted by CLI/HTTP/env. */
export interface ModelTesting { credentials?: Credentials; transport?: Transport; deadlineMs?: number }
export function composeChat(store: Store, domain: DomainPort, configDir: string, testing?: ModelTesting, now?: () => number) {
  const loaded = loadProviderConfig({ configDir, ownerId: store.assistantId });
  let ready = loaded.status === 'ready' ? loaded : null;
  let status: ConnectedStatus = ready ? { status: 'configured', provider: 'gemini', model: ready.profile.modelId }
    : loaded.status === 'disabled' ? { status: 'disabled', provider: 'gemini', model: loaded.profile.modelId }
    : loaded.status === 'error' ? { status: 'error', code: loaded.code } : { status: 'unconfigured' };
  let model: GeminiAdapter | null = null;
  if (ready) {
    try { model = new GeminiAdapter({ modelId: ready.profile.modelId, keyReference: ready.profile.keyReference,
      route: ready.route, credentials: testing?.credentials ?? ready.credentials, ...(testing?.transport ? { transport: testing.transport } : {}) }); }
    catch { ready = null; status = { status: 'error', code: 'ADAPTER_CONFIGURATION_INVALID' }; }
  }
  const route = ready?.route;
  const chat = new ChatService({ store, domain, model,
    route: { provider: 'gemini', model: ready?.profile.modelId ?? '', available: !!ready,
      endpoint: 'https://generativelanguage.googleapis.com', apiVersion: 'v1beta', keyReference: 'gemini-primary',
      allowedClasses: route?.dataClasses ?? [], allows: classes => !!route && classes.every(c => route.dataClasses.includes(c)) },
    preferences: ready?.profile.preferences ?? validatePreferences({ schemaVersion: 1, ownerId: store.assistantId, dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'off', verbosity: 'balanced' }, store.assistantId),
    classify: (subject, tx) => {
      if (subject.kind === 'recall') return null;
      const label = domain.getRoutingLabel(tx, { kind: subject.kind, id: subject.id });
      if (label.dataClass === 'unknown') return null;
      return { ownerId: store.assistantId, dataClass: label.dataClass, revision: label.revision };
    },
    context: { sources: [], budgets: { trustedChars: 20000, contextChars: 12000, historyChars: 12000 } },
    ...(testing?.deadlineMs ? { deadlineMs: testing.deadlineMs } : {}),
    ...(now ? { now } : {})
  });
  chat.recover({ assistantId: store.assistantId, authorityEpoch: store.authorityEpoch });
  return { chat, status };
}
