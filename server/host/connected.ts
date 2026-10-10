import type { OwnerProfileSnapshot } from '../prompt/types.js';
import type { DomainPort } from '../contracts/domain.js';
import type { Transaction } from '../contracts/storage.js';
import type { Store } from '../runtime/store.js';
import { ChatService, type ChatToolComposition, type CurrentAuthority, type RunBinding, type RunRunner } from '../chat/index.js';
import { credentialReceiptFor, loadProviderConfig, requestCredentialsFor, type CredentialBindingReceipt, type CredentialRouteScope } from '../config/index.js';
import { GeminiAdapter, runTools, type Authority, type Credentials, type DataClass, type HostContext, type LoopResult, type ToolResultBinding, type ToolResultGate, type Transport } from '../adapters/model/index.js';
import { createToolsOwner } from '../tools/index.js';
import type { ConnectionPolicy, LiveAuthority, OwnerConnection, RunAcceptance, ToolsOwner } from '../tools/types.js';
import { canonicalJSON } from '../tools/canonical.js';
import type { McpPort } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';
import { validatePreferences } from '../prompt/index.js';

export type ConnectedStatus = { status: 'unconfigured' } | { status: 'error'; code: string }
  | { status: 'disabled' | 'configured'; provider: 'gemini'; model: string };
/** Trusted in-process construction seam only: never accepted by CLI/HTTP/env. */
export interface ModelTesting { credentials?: Credentials; transport?: Transport; deadlineMs?: number; requestCredentials?: () => RequestCredentialAllocation }
/** One per-generate allocation from the protected credential owner; the public shape is a plain string resolver. */
export interface RequestCredentialAllocation { resolve(reference: string): Promise<string | undefined>; resolvedReceipt(): CredentialBindingReceipt | undefined }
/**
 * Trusted host composition input built only by the actual host entry, never by
 * CLI/HTTP/auth input. `registry`/`port` are the accepted MCP owners; `connections`
 * are already-applied owner policies. An unconfigured assembly means text-only.
 */
export interface ToolChatAssembly {
  registry: McpRegistry; port: McpPort; connections: readonly ConnectionPolicy[];
}
const baseEndpoint = 'https://generativelanguage.googleapis.com';
/** Safe, operator-asserted optional-integration status; never a credential, account payload or catalog. */
export interface ConnectionStatus { id: string; label: string; state: 'ready' | 'needs_setup' | 'unavailable'; lastKnown: boolean }
function safeLabel(value: string): string { return value.replace(/[^\x20-\x7e]/g, '').slice(0, 64); }
/**
 * Actual owner state only, never inferred from a configured URL or a successful
 * startup. A current registry grant is approval+discovery evidence, NOT present
 * transport liveness, so a granted connection is labelled `ready` (last checked),
 * never claimed `connected`. A durable-but-unapproved connection is `needs_setup`;
 * a locally disabled one is `unavailable`. No credentials, payloads, paths or
 * catalogs; the connection list comes through the owner read API, not raw SQL.
 */
function connectionStatus(owner: ToolsOwner, registry: McpRegistry): ConnectionStatus[] {
  let rows: OwnerConnection[];
  try { rows = owner.connections(); } catch { return []; }
  return rows.map(row => {
    const label = safeLabel(row.endpointId);
    if (!row.enabled) return { id: row.connectionId, label, state: 'unavailable' as const, lastKnown: true };
    let ready = false;
    try {
      const grant = registry.currentGrant(row.endpointId);
      ready = !!grant && grant.generation === row.generation && grant.schemaDigest === row.schemaDigest
        && canonicalJSON([...grant.toolNames].sort()) === canonicalJSON([...row.toolNames].sort());
    } catch { ready = false; }
    return { id: row.connectionId, label, state: ready ? ('ready' as const) : ('needs_setup' as const), lastKnown: true };
  });
}

export function composeChat(store: Store, domain: DomainPort, configDir: string, testing: ModelTesting | undefined, now: (() => number) | undefined, ownerProfile: OwnerProfileSnapshot | undefined, assembly: ToolChatAssembly): { chat: ChatService; status: ConnectedStatus; tools: ToolsOwner; connections: () => ConnectionStatus[] };
export function composeChat(store: Store, domain: DomainPort, configDir: string, testing?: ModelTesting, now?: () => number, ownerProfile?: OwnerProfileSnapshot): { chat: ChatService; status: ConnectedStatus };
export function composeChat(store: Store, domain: DomainPort, configDir: string, testing?: ModelTesting, now?: () => number, ownerProfile?: OwnerProfileSnapshot, assembly?: ToolChatAssembly) {
  const clock = now ?? Date.now;
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
  const scope: CredentialRouteScope = { provider: 'gemini', modelId: ready?.profile.modelId ?? '', endpoint: baseEndpoint,
    apiVersion: 'v1beta', keyReference: 'gemini-primary', allowedClasses: route?.dataClasses ?? [] };
  // Chat-owned synchronous current-authority check, reused by the final-egress guard.
  let chat!: ChatService;
  const owner: ToolsOwner | null = assembly ? createToolsOwner({ store, ownerId: store.assistantId, registry: assembly.registry, port: assembly.port,
    lookupAuthority: async (runId, signal) => {
      if (signal.aborted) return null;
      chat.authority(runId); // Chat owns nonterminal/owner/epoch/consent/label/route; throws when stale.
      const row = store.transaction(tx => tx.get('SELECT snapshot_json,snapshot_sha256 FROM tool_runs WHERE owner_id=? AND run_id=?', [store.assistantId, runId]));
      if (!row) return null;
      const snapshot = JSON.parse(String(row.snapshot_json)) as { acceptance: RunAcceptance };
      return { ...snapshot.acceptance, acceptedRunHash: String(row.snapshot_sha256) } as LiveAuthority;
    } }) : null;
  if (owner) for (const connection of assembly!.connections) owner.applyConnection(connection);
  const allocate = testing?.requestCredentials ?? (() => {
    const allocation = requestCredentialsFor(configDir, scope);
    return { resolve: (reference: string) => allocation.credentials.resolve(reference), resolvedReceipt: () => allocation.resolvedReceipt() };
  });
  const actual: Transport = testing?.transport ?? fetch;

  const tools: ChatToolComposition | undefined = owner && assembly ? {
    accept(tx: Transaction, binding: RunBinding) {
      // One synchronous current-locator read supplies the non-secret binding metadata.
      const credential = credentialReceiptFor(configDir, scope);
      const acceptance: RunAcceptance = { ownerId: store.assistantId, actorId: binding.actorId, runId: binding.runId,
        authorityEpoch: binding.authorityEpoch, revision: binding.revision,
        route: { identity: binding.route.identity, provider: 'gemini', modelId: binding.route.model, allowedClasses: [...binding.route.allowedClasses] },
        allowedClasses: [...binding.route.allowedClasses], connectionIds: [...binding.connectionIds] };
      const { sha256 } = owner.snapshotRun(tx, acceptance);
      return { hash: sha256, credential };
    },
    definitions(runId: string) { return owner.definitions(runId); },
    receipts(runId: string) { return owner.receipts(runId).map(receipt => ({ executionId: receipt.executionId, name: receipt.name, result: receipt.result, connection: receipt.connection })); },
    runner(runId: string, deadlineMs: number, current: () => CurrentAuthority): RunRunner {
      const acceptedRow = store.transaction(tx => tx.get('SELECT snapshot_json FROM tool_runs WHERE owner_id=? AND run_id=?', [store.assistantId, runId]));
      const acceptance = acceptedRow ? (JSON.parse(String(acceptedRow.snapshot_json)) as { acceptance: RunAcceptance }).acceptance : null;
      const credentialLink = store.transaction(tx => tx.get('SELECT credential_json FROM chat_run_tools WHERE run_id=?', [runId]));
      const acceptedCredential = credentialLink?.credential_json ? JSON.parse(String(credentialLink.credential_json)) as CredentialBindingReceipt : null;
      const registry = owner.definitions(runId);
      const host: HostContext = { runId, actorId: acceptance?.actorId ?? '', authorityEpoch: acceptance?.authorityEpoch ?? '',
        revision: acceptance?.revision ?? 0, grants: registry.map(d => ({ tool: d.name, effect: d.effect, accountId: d.accountId, resourceId: d.resourceId })) };
      // Per-run gate-to-generate handoff: each generate consumes its own detached record once.
      let pending: { bindings: readonly ToolResultBinding[]; baseClasses: readonly DataClass[] } | null = null;
      const gate: ToolResultGate = { async authorize(h, bindings, baseClasses, signal) {
        const decision = await owner.resultGate.authorize(h, bindings, baseClasses, signal);
        if (decision.state === 'allowed' && bindings.length) pending = { bindings: structuredClone([...bindings]), baseClasses: [...baseClasses] };
        return decision;
      } };
      const authority: Authority = { isCurrent: async () => { try { current(); return true; } catch { return false; } } };
      return { async run(request, control) {
        const allocation = allocate();
        const guarded: Transport = async (url, init) => {
          const captured = pending; pending = null;
          if (captured) {
            const decision = await owner.resultGate.authorize(host, captured.bindings, captured.baseClasses, control.signal);
            if (decision.state !== 'allowed') throw Error('tool_result_denied');
          }
          // From here to the lower transport there is NO await: every authority is re-read synchronously.
          current();
          const fresh = loadProviderConfig({ configDir, ownerId: store.assistantId });
          if (!acceptance || fresh.status !== 'ready' || fresh.route.modelId !== acceptance.route.modelId || !fresh.route.enabled
            || canonicalJSON([...fresh.route.dataClasses].sort()) !== canonicalJSON([...acceptance.route.allowedClasses].sort())) throw Error('route_changed');
          const freshReceipt = credentialReceiptFor(configDir, scope);
          const resolved = allocation.resolvedReceipt();
          if (!resolved || !acceptedCredential) throw Error('credential_binding_changed');
          if (freshReceipt.configuredAccount !== acceptedCredential.configuredAccount || freshReceipt.bindingGeneration !== acceptedCredential.bindingGeneration
            || resolved.configuredAccount !== acceptedCredential.configuredAccount || resolved.bindingGeneration !== acceptedCredential.bindingGeneration
            || canonicalJSON(freshReceipt.routeScope) !== canonicalJSON(acceptedCredential.routeScope)) throw Error('credential_binding_changed');
          if (clock() >= deadlineMs) throw Error('deadline');
          return actual(url, init);
        };
        const adapter = new GeminiAdapter({ modelId: acceptance?.route.modelId ?? ready?.profile.modelId ?? '', keyReference: 'gemini-primary',
          ...(route ? { route } : {}), credentials: { resolve: (reference: string) => allocation.resolve(reference) }, transport: guarded, now: clock });
        return runTools({ model: adapter, request, registry, host, authority, maxSteps: 8, control, journal: owner.journal, resultGate: gate });
      } };
    }
  } : undefined;

  chat = new ChatService({
    ...(ownerProfile ? { ownerProfile } : {}), store, domain, model,
    ...(tools ? { tools } : {}),
    route: { provider: 'gemini', model: ready?.profile.modelId ?? '', available: !!ready,
      endpoint: `${baseEndpoint}/v1beta/models/${ready?.profile.modelId ?? ''}:streamGenerateContent?alt=sse`, apiVersion: 'v1beta', keyReference: 'gemini-primary',
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
  return { chat, status, ...(owner ? { tools: owner, connections: () => (assembly ? connectionStatus(owner, assembly.registry) : []) } : {}) };
}
export type { LoopResult };
