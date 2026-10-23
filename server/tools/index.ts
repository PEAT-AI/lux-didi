import { diagnosticContentAccess } from '../trace/content.js';
import { hostLogEvent } from './host-events.js';
import { createDispatchOwner, projectDiagnosticInput } from './dispatch.js';
import { RECEIVED_BODY, RECEIVED_BODY_TOOLS, RECEIVED_BODY_PARAMETERS, receivedBodyArguments, receivedBodyEnd, type ReceivedBodyPage, type RemoteResultLineage } from './received-body.js';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { SQLRow, Transaction } from '../contracts/storage.js';
import type { DataClass, HostContext, JsonObject, ToolCallIntent, ToolCallRefusal, ToolDefinition, ToolFailureCode, ToolResultBinding, ToolResultGate, ToolResultRef } from '../adapters/model/types.js';
import { isMcpFailureStage, isToolFailureCode } from '../adapters/model/types.js';
import { approvalQualifies, validateEndpointUrl, validateApprovedStdioEnv } from '../adapters/mcp/registry.js';
import { SOURCE_DISPATCH, SOURCE_CHILD_DISPATCHES, type SourceDispatchRef, endpointBinding, bindingDigestOf, sourceBindingOf } from '../adapters/mcp/port.js';
import { isLiveVoiceProvider } from '../adapters/live-voice/types.js';
import { ConnectorCompositionError, connectorDescriptor, mongooseModelToolName, CONNECTOR_ENVELOPES } from '../connectors/index.js';
import { canonicalJSON, detached, sha256 } from './canonical.js';
import { redactSecretsWithCount } from './redact.js';
import { createHistoryReader, historyEvidenceCurrent } from '../domain/history-reader.js';
import { HISTORY_IDENTITY, HISTORY_PARAMETERS, validateHistory } from './history.js';
import { HOST_EVIDENCE, type HostEvidenceRef } from './types.js';
import type { BoundConnection, ConnectionApplyResult, ConnectionPolicy, HttpConnectionEndpoint, ModelSnapshot, RunAcceptance, RunSnapshot, StdioConnectionEndpoint, ToolsOwner, ToolsOwnerOptions } from './types.js';
import { REMEMBER_IDENTITY, REMEMBER_PARAMETERS, validateRemember } from './remember.js';
import { researchDeclaration, researchSourcesFromToolNames } from './research.js';
import { OPEN_GUIDANCE, OPEN_IDENTITY, OPEN_TOOL_NAMES, OPEN_TOOLS, nativeActionReceipt, nativeActions, noteOpened, openParameters, openTarget, validateOpen } from './open.js';
export { toolsMigrations } from './schema.js';
export type * from './types.js';

const ownedStores = new WeakSet<object>();
/** One closed stage for a dispatched call's unknown outcome: a stage itself, else the policy reason's closest stage. */
function dispatchedFailureCode(reason: string): ToolFailureCode {
  if (isMcpFailureStage(reason)) return reason;
  return reason === 'response-oversize' ? 'invalid_result' : 'sdk_protocol_rejected';
}
const transactionDefinitions = new WeakMap<ToolsOwner, (runId: string, tx?: Transaction) => ToolDefinition[]>();
const ownerBindings = new WeakMap<object, Pick<ToolsOwnerOptions, 'store' | 'registry' | 'ownerId'>>();
/** Factory identity check: no second owner, port or registry may substitute for canonical authority. */
/** The names more than one connection grants: those are model-facing under their endpoint id. */
export function sharedGrantedNames(connections: readonly { toolNames: readonly string[] }[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const connection of connections) for (const name of connection.toolNames) counts.set(name, (counts.get(name) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

/** The model-facing name of one granted tool: namespaced only where two endpoints would collide. */
export function modelToolName(endpointId: string, tool: string, shared: ReadonlySet<string>): string {
  return shared.has(tool) ? mongooseModelToolName(endpointId, tool) : tool;
}

export function assertToolsOwnerBinding(owner: ToolsOwner, expected: Pick<ToolsOwnerOptions, 'store' | 'registry' | 'ownerId'>): void {
  const binding = ownerBindings.get(owner);
  if (!binding || binding.store !== expected.store || binding.registry !== expected.registry || binding.ownerId !== expected.ownerId) throw Error('tools_owner_binding_mismatch');
}
const classes = ['ordinary', 'private', 'sensitive'];
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k) && !optional.includes(k)) || keys.some(k => !Object.hasOwn(value, k))) throw Error('invalid_policy_shape');
}
function text(value: unknown): asserts value is string { if (typeof value !== 'string' || value.length < 1 || value.length > 512) throw Error('invalid_identifier'); }
function positive(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 1) throw Error('invalid_positive_integer'); }
function classSet(value: unknown): asserts value is DataClass[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(c => !classes.includes(c))) throw Error('invalid_classes');
}
export function validatePolicy(input: ConnectionPolicy): ConnectionPolicy {
  const p = detached(input);
  exact(p, ['schemaVersion', 'ownerId', 'connectionId', 'generation', 'enabled', 'connector', 'endpoint', 'toolNames', 'schemaDigest', 'sourcePolicy', 'route', 'bounds'], ['bindingMode']);
  if (p.bindingMode !== undefined && p.bindingMode !== 'connection') throw Error('invalid_policy_binding_mode');
  if (p.schemaVersion !== 1 || typeof p.enabled !== 'boolean') throw Error('invalid_policy_version');
  [p.ownerId, p.connectionId].forEach(text); positive(p.generation);
  exact(p.endpoint, (p.endpoint as { transport?: unknown }).transport === 'stdio' ? ['id', 'transport', 'command', 'args', 'env', 'account', 'resource', 'credentialRef'] : ['id', 'url', 'account', 'resource', 'credentialRef']);
  if ((p.endpoint as { transport?: unknown }).transport === 'stdio') {
    const e = p.endpoint as StdioConnectionEndpoint;
    [e.id, e.command, e.account, e.resource].forEach(text);
    if (e.credentialRef !== null) throw Error('invalid_policy_version');
    if (!isAbsolute(e.command) || !Array.isArray(e.args) || e.args.some(arg => typeof arg !== 'string')) throw Error('invalid_policy_version');
    if (!validateApprovedStdioEnv(e.env)) throw Error('invalid_policy_version');
  } else {
    const e = p.endpoint as HttpConnectionEndpoint;
    [e.id, e.account, e.resource, e.url].forEach(text); validateEndpointUrl(e.url);
    if (e.credentialRef !== null) text(e.credentialRef);
  }
  text(p.connector);
  // Local read grants use the connector envelope, independently of Live reader support.
  const envelope = CONNECTOR_ENVELOPES[p.connector];
  if (!envelope) throw Error('invalid_connector');
  if (!Array.isArray(p.toolNames) || p.toolNames.length < 1 || p.toolNames.length > envelope.length || new Set(p.toolNames).size !== p.toolNames.length || p.toolNames.some(n => typeof n !== 'string' || !envelope.includes(n)) || !/^[a-f0-9]{64}$/.test(p.schemaDigest)) throw Error('invalid_read_tools');
  exact(p.sourcePolicy, ['id', 'revision', 'unknownClass', 'allowedClasses']); text(p.sourcePolicy.id); positive(p.sourcePolicy.revision); classSet(p.sourcePolicy.allowedClasses);
  if ((p.bindingMode === 'connection' && p.sourcePolicy.unknownClass === null) || (p.sourcePolicy.unknownClass !== null && !classes.includes(p.sourcePolicy.unknownClass))) throw Error('invalid_unknown_class');
  exact(p.route, ['identity', 'allowedClasses']); text(p.route.identity); classSet(p.route.allowedClasses);
  exact(p.bounds, ['maxQueryChars', 'maxSearchLimit', 'maxGetIds', 'maxEntityBytes', 'maxResultBytes']); Object.values(p.bounds).forEach(positive);
  return p;
}
function validateAcceptance(input: RunAcceptance): RunAcceptance {
  const a = detached(input);
  exact(a, ['ownerId', 'actorId', 'runId', 'authorityEpoch', 'revision', 'route', 'allowedClasses', 'connectionIds']);
  [a.ownerId, a.actorId, a.runId, a.authorityEpoch].forEach(text); positive(a.revision); classSet(a.allowedClasses);
  exact(a.route, ['identity', 'provider', 'modelId', 'allowedClasses']); [a.route.identity, a.route.modelId].forEach(text); classSet(a.route.allowedClasses);
  if (!isLiveVoiceProvider(a.route.provider) || !Array.isArray(a.connectionIds) || new Set(a.connectionIds).size !== a.connectionIds.length || a.connectionIds.length > 32) throw Error('invalid_run_acceptance');
  a.connectionIds.forEach(text); return a;
}
function callDTO(input: ToolCallRefusal): ToolCallRefusal {
  const c = detached(input);
  exact(c, ['runId', 'actorId', 'authorityEpoch', 'revision', 'executionId', 'toolName', 'argumentsHash'], ['callId', 'accountId', 'resourceId']);
  [c.runId, c.actorId, c.authorityEpoch, c.executionId, c.toolName].forEach(text); positive(c.revision);
  if (!/^[a-f0-9]{64}$/.test(c.argumentsHash)) throw Error('invalid_arguments_hash');
  if (c.callId !== undefined) text(c.callId);
  if (c.accountId !== undefined) text(c.accountId); if (c.resourceId !== undefined) text(c.resourceId);
  return c;
}
function hostMatches(a: RunAcceptance, h: Pick<HostContext, 'runId' | 'actorId' | 'authorityEpoch' | 'revision'>): boolean {
  return a.runId === h.runId && a.actorId === h.actorId && a.authorityEpoch === h.authorityEpoch && a.revision === h.revision;
}

/**
 * W10: the connections a run may use are frozen at acceptance, so a `connectionIds()` that only
 * names the connectors that already finished their handshake drops a slow one for the whole call.
 * The durable policies are the ones this owner has already published, and they are the set a start
 * freezes, whether or not the transport has come up yet.
 */
export interface LiveRunConnections { durableConnectionIds?(tx: Transaction): string[] }
export function createToolsOwner(options: ToolsOwnerOptions): ToolsOwner & LiveRunConnections {
  const { store, registry, port, lookupAuthority, ownerId, reportToolStatus } = options; text(ownerId);
  if (ownedStores.has(store)) throw Error('duplicate_store_tools_owner');
  ownedStores.add(store);
  // Failure latch is not authority: it only prevents fallback journal writes after failed persistence.
  const persistenceFailures = new Set<string>();
  const historyReader = createHistoryReader();
  const retained = new Map<string, { runId: string; executionId: string; resultSha256: string; evidence: HostEvidenceRef }>();
  const bodyPages = new Map<string, ReceivedBodyPage>();
  const bodyConsumers = new Set<string>();
  const bodyLeases = new Map<string, { closed: boolean }>();
  const pruneEvidence = (): void => {
    for (const [id, value] of retained) if (value.evidence.kind === 'remote-body' && value.evidence.expiresAt <= Date.now()) retained.delete(id);
    for (const [cursor, page] of bodyPages) if (!retained.has(page.parent.result.id)) bodyPages.delete(cursor);
  };
  const chatRun = (tx: Transaction, runId: string): SQLRow | undefined => tx.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_runs'")
    ? tx.get('SELECT session_id,state,outcome FROM chat_runs WHERE owner_assistant_id=? AND run_id=?', [ownerId, runId]) : undefined;
  const connection = (tx: Transaction, id: string): BoundConnection => {
    const row = tx.get("SELECT c.*,COALESCE(s.binding_mode,'legacy') AS binding_mode FROM tool_connections c LEFT JOIN tool_connection_semantics s ON s.owner_id=c.owner_id AND s.connection_id=c.connection_id WHERE c.owner_id=? AND c.connection_id=?", [ownerId, id]);
    if (!row || typeof row.policy_json !== 'string' || sha256(row.policy_json) !== row.policy_sha256) throw Error('connection_policy_missing_or_corrupt');
    const policy = validatePolicy(JSON.parse(row.policy_json) as ConnectionPolicy);
    if (canonicalJSON(policy) !== row.policy_json || policy.ownerId !== ownerId || policy.connectionId !== id || policy.endpoint.id !== row.endpoint_id || policy.generation !== row.generation || Number(policy.enabled) !== row.enabled || (policy.bindingMode ?? 'legacy') !== row.binding_mode) throw Error('connection_policy_binding');
    return { connectionId: id, generation: policy.generation, sha256: String(row.policy_sha256), policy };
  };
  const readRun = (tx: Transaction, runId: string): { snapshot: RunSnapshot; hash: string } => {
    const row = tx.get('SELECT * FROM tool_runs WHERE owner_id=? AND run_id=?', [ownerId, runId]);
    if (!row || typeof row.snapshot_json !== 'string' || sha256(row.snapshot_json) !== row.snapshot_sha256) throw Error('run_missing_or_corrupt');
    const snapshot = JSON.parse(row.snapshot_json) as RunSnapshot;
    validateAcceptance(snapshot.acceptance);
    if (snapshot.acceptance.ownerId !== ownerId || snapshot.acceptance.runId !== runId || snapshot.acceptance.authorityEpoch !== store.authorityEpoch) throw Error('run_scope_mismatch');
    return { snapshot, hash: String(row.snapshot_sha256) };
  };
  // A run freezes admission, not a global conjunction of every connector's policy.
  const currentPolicies = (tx: Transaction, snapshot: RunSnapshot, id: string): boolean => {
    if (id === 'gateway:live-voice' || id === HISTORY_IDENTITY.accountId) return options.grantMode === 'owner-trusted-reads';
    const bound = snapshot.connections.find(b => b.connectionId === id);
    if (!bound || !snapshot.acceptance.connectionIds.includes(id)) return false;
    const current = connection(tx, id); const p = current.policy; const c = p.sourcePolicy.unknownClass;
    if (p.bindingMode !== 'connection' || current.sha256 !== bound.sha256 || current.generation !== bound.generation || canonicalJSON(p) !== canonicalJSON(bound.policy) || !p.enabled || c === null) return false;
    return [p.sourcePolicy.allowedClasses, p.route.allowedClasses, snapshot.acceptance.allowedClasses, snapshot.acceptance.route.allowedClasses].every(set => set.includes(c));
  };
  const currentProjection = (snapshot: RunSnapshot, id: string): boolean => {
    if (id === 'gateway:live-voice' || id === HISTORY_IDENTITY.accountId) return options.grantMode === 'owner-trusted-reads';
    const bound = snapshot.connections.find(b => b.connectionId === id); if (!bound) return false;
    const p = bound.policy;
    try {
      const endpoint = registry.endpoint(p.endpoint.id); const grant = registry.currentGrant(p.endpoint.id);
      return !!grant && endpointBinding(endpoint) === endpointBinding(p.endpoint) &&
        grant.generation === p.generation && grant.schemaDigest === p.schemaDigest && grant.account === p.endpoint.account && grant.resource === p.endpoint.resource && canonicalJSON(grant.toolNames) === canonicalJSON(p.toolNames);
    } catch { return false; }
  };
  const intentBytes = (tx: Transaction, call: ToolCallRefusal): string => canonicalJSON({ ...call, routeIdentity: readRun(tx, call.runId).snapshot.acceptance.route.identity });
  const storedCall = (tx: Transaction, row: SQLRow): ToolCallRefusal => {
    const { routeIdentity, ...input } = JSON.parse(String(row.intent_json)) as ToolCallRefusal & { routeIdentity?: string };
    const call = callDTO(input);
    // Pre-migration calls never acquire route approval merely by being read.
    if (routeIdentity !== readRun(tx, call.runId).snapshot.acceptance.route.identity) throw Error('intent_route_mismatch');
    return call;
  };
  const callRow = (tx: Transaction, call: ToolCallRefusal): SQLRow | undefined => tx.get('SELECT * FROM tool_calls WHERE owner_id=? AND run_id=? AND (execution_id=? OR (? IS NOT NULL AND call_id=?))', [ownerId, call.runId, call.executionId, call.callId ?? null, call.callId ?? null]);
  const exactIntent = (tx: Transaction, call: ToolCallRefusal): SQLRow => {
    const row = callRow(tx, call);
    if (!row || row.execution_id !== call.executionId || row.intent_json !== intentBytes(tx, call)) throw Error('intent_mismatch');
    return row;
  };
  const originalCall = (tx: Transaction, runId: string, parent: RemoteResultLineage): ToolCallRefusal => {
    const row = tx.get('SELECT * FROM tool_calls WHERE owner_id=? AND run_id=? AND execution_id=?', [ownerId, runId, parent.executionId]);
    if (!row || row.state !== 'completed' || row.result_id !== parent.result.id || row.result_sha256 !== parent.result.sha256 || typeof row.result_json !== 'string' || sha256(row.result_json) !== parent.result.sha256) throw Error('body_parent_unavailable');
    const call = storedCall(tx, row);
    if (!RECEIVED_BODY_TOOLS.has(call.toolName) || call.toolName !== parent.name || call.callId !== parent.callId || retained.get(parent.result.id)?.evidence.kind !== 'remote-body') throw Error('body_parent_unavailable');
    return call;
  };
  const pageForCall = (call: ToolCallRefusal): ReceivedBodyPage | undefined => [...bodyPages.values()].find(page => page.runId === call.runId && page.argumentsHash === call.argumentsHash);
  const target = (snapshot: RunSnapshot, call: ToolCallRefusal, transaction?: Transaction): { connectionId: string; policy: { sourcePolicy: { allowedClasses: readonly DataClass[] }; route: { allowedClasses: readonly DataClass[] }; bounds: { maxResultBytes: number } } } => {
    if (call.toolName === RECEIVED_BODY.name && call.accountId === RECEIVED_BODY.accountId && call.resourceId === RECEIVED_BODY.resourceId) {
      const page = pageForCall(call); if (!page || !bodyConsumers.has(call.runId)) throw Error('body_cursor_unavailable');
      const resolve = (tx: Transaction) => target(snapshot, originalCall(tx, call.runId, page.parent), tx);
      return transaction ? resolve(transaction) : store.transaction(resolve);
    }
    if (call.toolName === HISTORY_IDENTITY.name && call.accountId === HISTORY_IDENTITY.accountId && call.resourceId === HISTORY_IDENTITY.resourceId) {
      if (options.grantMode !== 'owner-trusted-reads') throw Error('builtin_grant_denied');
      return { connectionId: HISTORY_IDENTITY.accountId, policy: { sourcePolicy: { allowedClasses: snapshot.acceptance.allowedClasses }, route: { allowedClasses: snapshot.acceptance.route.allowedClasses }, bounds: { maxResultBytes: 65536 } } };
    }
    if (call.toolName === REMEMBER_IDENTITY.name && call.accountId === REMEMBER_IDENTITY.accountId && call.resourceId === REMEMBER_IDENTITY.resourceId) {
      if (options.grantMode !== 'owner-trusted-reads') throw Error('builtin_grant_denied');
      return { connectionId: 'gateway:live-voice', policy: { sourcePolicy: { allowedClasses: ['ordinary'] }, route: { allowedClasses: ['ordinary'] }, bounds: { maxResultBytes: 1024 } } };
    }
    if (call.accountId === OPEN_IDENTITY.accountId && call.resourceId === OPEN_IDENTITY.resourceId && OPEN_TOOL_NAMES.has(call.toolName)) {
      // Host-native open tools; the native side re-checks the allowlist before anything opens.
      if (options.grantMode !== 'owner-trusted-reads') throw Error('builtin_grant_denied');
      return { connectionId: 'gateway:live-voice', policy: { sourcePolicy: { allowedClasses: ['ordinary'] }, route: { allowedClasses: ['ordinary'] }, bounds: { maxResultBytes: 1024 } } };
    }
    const matches = snapshot.connections.filter(b => snapshot.acceptance.connectionIds.includes(b.connectionId) && b.policy.toolNames.includes(call.toolName) && b.policy.endpoint.account === call.accountId && b.policy.endpoint.resource === call.resourceId);
    if (matches.length !== 1) throw Error('intent_scope_mismatch'); return matches[0]!;
  };
  const validateCallRun = (tx: Transaction, call: ToolCallRefusal): RunSnapshot => {
    const { snapshot } = readRun(tx, call.runId);
    if (!hostMatches(snapshot.acceptance, call)) throw Error('intent_run_mismatch'); return snapshot;
  };
  const assertLiveIdentity = (tx: Transaction, call: ToolCallRefusal): void => {
    if (call.accountId !== REMEMBER_IDENTITY.accountId || call.resourceId !== REMEMBER_IDENTITY.resourceId) return;
    if (call.toolName !== REMEMBER_IDENTITY.name || !tx.get("SELECT live_session_id FROM live_sessions WHERE live_session_id=? AND owner_assistant_id=? AND lifecycle IN ('opening','active')", [call.runId, ownerId])) throw Error('builtin_live_session_required');
  };
  const persistTerminal = (tx: Transaction, call: ToolCallRefusal, state: 'completed' | 'failed' | 'unknown' | 'refused', value: ModelSnapshot, fresh = false): ToolResultRef => {
    const bytes = canonicalJSON({ ...value, routeIdentity: readRun(tx, call.runId).snapshot.acceptance.route.identity, intentSha256: sha256(intentBytes(tx, call)) }); const ref = { id: randomUUID(), sha256: sha256(bytes) };
    if (fresh) tx.run('INSERT INTO tool_calls(owner_id,run_id,execution_id,call_id,intent_json,state,result_id,result_json,result_sha256) VALUES (?,?,?,?,?,?,?,?,?)', [ownerId, call.runId, call.executionId, call.callId ?? null, intentBytes(tx, call), state, ref.id, bytes, ref.sha256]);
    else if (tx.run("UPDATE tool_calls SET state=?,result_id=?,result_json=?,result_sha256=? WHERE owner_id=? AND run_id=? AND execution_id=? AND state='intent'", [state, ref.id, bytes, ref.sha256, ownerId, call.runId, call.executionId]) !== 1) throw Error('terminal_immutable');
    return ref;
  };
  // Store constructor already holds the exclusive writer lock. Seal this owner's intents once.
  store.transaction(tx => {
    for (const row of tx.all("SELECT * FROM tool_calls WHERE owner_id=? AND state='intent'", [ownerId])) {
      const call = JSON.parse(String(row.intent_json)) as ToolCallRefusal;
      if (call.runId !== row.run_id || call.executionId !== row.execution_id) throw Error('recovery_intent_corrupt');
      persistTerminal(tx, call, 'unknown', { response: { status: 'unknown', reason: 'recovered_intent' }, dataClasses: [] });
    }
  });

  const evidenceCurrent = (tx: Transaction, call: ToolCallRefusal, snapshot: RunSnapshot, evidence: HostEvidenceRef): boolean => {
    if (evidence.kind === 'remote-page') {
      if (call.toolName !== RECEIVED_BODY.name) return false;
      try { originalCall(tx, call.runId, evidence.parent); return authorizedStoredResult(tx, snapshot, evidence.parent) !== undefined; } catch { return false; }
    }
    if (evidence.kind === 'local-history') return call.toolName === HISTORY_IDENTITY.name && historyEvidenceCurrent(tx, ownerId, evidence);
    const bound = snapshot.connections.find(item => item.connectionId === target(snapshot, call, tx).connectionId);
    if (!bound || evidence.expiresAt <= Date.now() || !/^[a-f0-9]{64}$/.test(evidence.entitySha256) || sha256(evidence.body) !== evidence.bodySha256) return false;
    const p = bound.policy, source = evidence.source;
    const binding = 'transport' in p.endpoint ? bindingDigestOf(p.endpoint) : p.endpoint.url;
    return evidence.tool === call.toolName && source.toolName === call.toolName && source.endpointId === p.endpoint.id && sourceBindingOf(source) === binding
      && source.generation === p.generation && source.schemaDigest === p.schemaDigest && source.account === p.endpoint.account && source.resource === p.endpoint.resource;
  };
  const complete = (input: ToolCallIntent, response: JsonObject, dataClasses: readonly DataClass[], transaction?: Transaction, hostEvidence?: HostEvidenceRef, sourceDispatchRefs?: readonly SourceDispatchRef[]): ToolResultRef => {
    const call = callDTO(input);
    if ((hostEvidence?.kind === 'remote-body' || hostEvidence?.kind === 'remote-page') && !bodyConsumers.has(call.runId)) throw Error('evidence_run_closed');
    const cursor = hostEvidence?.kind === 'remote-body' && bodyConsumers.has(call.runId) && RECEIVED_BODY_TOOLS.has(call.toolName) && hostEvidence.body.length > 0 ? randomUUID() : undefined;
    let maxResultBytes = 0;
    try {
      const commit = (tx: Transaction) => {
        const row = exactIntent(tx, call); if (row.state !== 'intent') throw Error('terminal_immutable');
        const snapshot = validateCallRun(tx, call); assertLiveIdentity(tx, call); const bound = target(snapshot, call, tx);
        maxResultBytes = bound.policy.bounds.maxResultBytes;
        if (!currentPolicies(tx, snapshot, bound.connectionId) || !currentProjection(snapshot, bound.connectionId)) throw Error('completion_policy_denied');
        classSet(dataClasses); exact(response, [], Object.keys(response));
        if (dataClasses.some(c => !bound.policy.sourcePolicy.allowedClasses.includes(c) || !bound.policy.route.allowedClasses.includes(c) || !snapshot.acceptance.allowedClasses.includes(c) || !snapshot.acceptance.route.allowedClasses.includes(c))) throw Error('completion_class_denied');
        if (hostEvidence && (!evidenceCurrent(tx, call, snapshot, hostEvidence) || (hostEvidence.kind === 'local-history' && hostEvidence.sources.some(source => !dataClasses.includes(source.dataClass))))) throw Error('evidence_binding_denied');
        if (sourceDispatchRefs?.some(ref => !tx.get("SELECT dispatch_id FROM tool_dispatches WHERE dispatch_id=? AND owner_id=? AND state='completed' AND ((run_id=? AND execution_id=?) OR EXISTS(SELECT 1 FROM tool_dispatch_reuse WHERE owner_id=? AND run_id=? AND execution_id=? AND origin_dispatch_id=? AND state='referenced'))",[ref.id,ownerId,call.runId,call.executionId,ownerId,call.runId,call.executionId,ref.id]))) throw Error('dispatch_reference_denied');
        if (hostEvidence?.kind === 'remote-page' && authorizedStoredResult(tx, snapshot, hostEvidence.parent)?.dataClasses.some(c => !dataClasses.includes(c))) throw Error('evidence_class_denied');
        const value = { response: { ...detached(response), ...(cursor && hostEvidence?.kind === 'remote-body' ? { bodyContinuation: { cursor, tool: call.toolName, projection: 'preview', total: hostEvidence.body.length, unit: 'utf16', upstreamComplete: hostEvidence.upstreamComplete, upstreamOmitted: hostEvidence.upstreamOmitted, stage: 'canonical-preparation' } } : {}) }, dataClasses: [...dataClasses], ...(sourceDispatchRefs ? {sourceDispatchRefs:[...new Set(sourceDispatchRefs.map(ref => ref.id))]} : {}), ...(hostEvidence ? { hostEvidenceRequired: true } : {}) };
        if (Buffer.byteLength(canonicalJSON({ ...value, routeIdentity: snapshot.acceptance.route.identity, intentSha256: sha256(intentBytes(tx, call)) })) > bound.policy.bounds.maxResultBytes) throw Error('model_snapshot_oversize');
        return persistTerminal(tx, call, 'completed', value);
      };
      const result = transaction ? commit(transaction) : store.transaction(commit);
      if (hostEvidence) retained.set(result.id, { runId: call.runId, executionId: call.executionId, resultSha256: result.sha256, evidence: detached(hostEvidence) });
      if (cursor && hostEvidence?.kind === 'remote-body') {
        const parent = { executionId: call.executionId, name: call.toolName, ...(call.callId ? { callId: call.callId } : {}), result };
        const end = receivedBodyEnd(hostEvidence.body, 0, maxResultBytes);
        bodyPages.set(cursor, { runId: call.runId, maxResultBytes, rootCursor: cursor, parent, offset: 0, end, argumentsHash: sha256(JSON.stringify({ cursor })), ...(end < hostEvidence.body.length ? { nextCursor: randomUUID() } : {}) });
      }
      return result;
    } catch (error) { persistenceFailures.add(call.executionId); throw error; }
  };
  const journal: ToolsOwner['journal'] = {
    intent(input, capture) {
      const call = callDTO(input);
      return store.transaction(tx => {
        const existing = callRow(tx, call);
        if (existing) { if (existing.intent_json !== intentBytes(tx, call) || existing.execution_id !== call.executionId) throw Error('intent_collision'); return 'existing'; }
        const snapshot = validateCallRun(tx, call); assertLiveIdentity(tx, call); const bound = target(snapshot, call, tx);
        if (!currentPolicies(tx, snapshot, bound.connectionId) || !currentProjection(snapshot, bound.connectionId)) throw Error('intent_policy_denied');
        let projection = projectDiagnosticInput(call.toolName,capture);
        const declaration = 'connector' in bound.policy && typeof bound.policy.connector === 'string' ? connectorDescriptor(bound.policy.connector)?.declarations(bound.policy as ConnectionPolicy).find(item => item.name === call.toolName) : undefined;
        const sourceAccess = diagnosticContentAccess(tx,call.runId,{ownerId,allowedClasses:snapshot.acceptance.allowedClasses.filter(c => snapshot.acceptance.route.allowedClasses.includes(c))});
        if (sourceAccess.state !== 'allowed' || projection.sha256 !== call.argumentsHash || (declaration && !declaration.validate(capture))) projection = {json:null,sha256:call.argumentsHash,fidelity:'hash_only_unsupported_v1',keyCount:projection.keyCount};
        tx.run("INSERT INTO tool_calls(owner_id,run_id,execution_id,call_id,intent_json,state,input_json,input_sha256,input_fidelity,input_key_count) VALUES (?,?,?,?,?,'intent',?,?,?,?)", [ownerId, call.runId, call.executionId, call.callId ?? null, intentBytes(tx, call),projection.json,projection.sha256,projection.fidelity,projection.keyCount]);
        return 'fresh';
      });
    },
    refuse(input, reason) {
      const call = callDTO(input);
      return store.transaction(tx => {
        if (callRow(tx, call)) throw Error('refusal_collision'); validateCallRun(tx, call);
        return persistTerminal(tx, call, 'refused', { response: { status: 'refused', reason }, dataClasses: [] }, true);
      });
    },
    fail(input, status, reason) {
      const call = callDTO(input);
      if (persistenceFailures.has(call.executionId)) throw Error('result_persistence_failed');
      if (status !== 'failed' && status !== 'unknown') throw Error('invalid_terminal_status');
      return store.transaction(tx => {
        if (exactIntent(tx, call).state !== 'intent') throw Error('terminal_immutable'); validateCallRun(tx, call);
        const code = isToolFailureCode(reason) ? reason : status === 'unknown' ? 'tool_unknown' : 'tool_failed';
        return persistTerminal(tx, call, status, { response: { status, reason: code }, dataClasses: [] });
      });
    },
  };
  const authorizedStoredResult = (tx: Transaction, snapshot: RunSnapshot, binding: RemoteResultLineage): { response: JsonObject; dataClasses: readonly DataClass[] } | undefined => {
    const row = tx.get('SELECT * FROM tool_calls WHERE owner_id=? AND run_id=? AND execution_id=?', [ownerId, snapshot.acceptance.runId, binding.executionId]);
    if (!row || row.state === 'intent' || row.state === 'unknown' || row.result_id !== binding.result.id || row.result_sha256 !== binding.result.sha256 || typeof row.result_json !== 'string' || sha256(row.result_json) !== binding.result.sha256) return undefined;
    const call = storedCall(tx, row);
    const accepted = snapshot.acceptance;
    if (!hostMatches(accepted, call) || call.executionId !== binding.executionId || call.toolName !== binding.name || call.callId !== binding.callId || row.call_id !== (call.callId ?? null)) return undefined;
    if (row.state !== 'refused' && call.toolName === RECEIVED_BODY.name) {
      const page = pageForCall(call); if (!page || !bodyConsumers.has(call.runId)) return undefined;
      try { originalCall(tx, call.runId, page.parent); } catch { return undefined; }
    }
    if (row.state !== 'refused') { const selected = target(snapshot, call, tx); if (!currentPolicies(tx, snapshot, selected.connectionId) || !currentProjection(snapshot, selected.connectionId)) return undefined; }
    const value = JSON.parse(row.result_json) as ModelSnapshot & { intentSha256: string; routeIdentity: string; hostEvidenceRequired?: boolean }; classSet(value.dataClasses);
    const reference = retained.get(binding.result.id);
    if (value.hostEvidenceRequired && (!reference || reference.runId !== call.runId || reference.executionId !== call.executionId || reference.resultSha256 !== binding.result.sha256 || !evidenceCurrent(tx, call, snapshot, reference.evidence))) return undefined;
    if (reference?.evidence.kind === 'remote-page' && authorizedStoredResult(tx, snapshot, reference.evidence.parent)?.dataClasses.some(c => !value.dataClasses.includes(c))) return undefined;
    if (call.toolName === HISTORY_IDENTITY.name && row.state === 'completed' && !value.hostEvidenceRequired) return undefined;
    if (value.intentSha256 !== sha256(intentBytes(tx, call)) || value.routeIdentity !== accepted.route.identity) return undefined;
    if (value.dataClasses.some(c => !accepted.allowedClasses.includes(c) || !accepted.route.allowedClasses.includes(c))) return undefined;
    if (row.state === 'completed') {
      const bound = target(snapshot, call, tx);
      if (value.dataClasses.some(c => !bound.policy.sourcePolicy.allowedClasses.includes(c) || !bound.policy.route.allowedClasses.includes(c)) || Buffer.byteLength(row.result_json) > bound.policy.bounds.maxResultBytes) return undefined;
    }
    return { response: detached(value.response), dataClasses: [...value.dataClasses] };
  };
  const authorizeDelivery: ToolsOwner['authorizeDelivery'] = (host, bindings, baseClasses, liveInput, signal) => {
    pruneEvidence();
    if (signal.aborted) return { state: 'refused', reason: 'cancelled' };
    if (!liveInput) return { state: 'refused', reason: 'authority_denied' };
    const live = detached(liveInput); const { acceptedRunHash, ...liveAcceptance } = live;
    validateAcceptance(liveAcceptance); classSet(baseClasses);
    // All persisted state is reread synchronously AFTER the awaited authoritative lookup.
    return store.transaction(tx => {
      const { snapshot, hash } = readRun(tx, host.runId); const accepted = snapshot.acceptance;
      const denied = { state: 'refused' as const, reason: 'authority_policy_or_result_denied' };
      if (live.ownerId !== ownerId || !hostMatches(accepted, host) || hash !== acceptedRunHash || canonicalJSON(liveAcceptance) !== canonicalJSON(accepted) || baseClasses.some(c => !live.allowedClasses.includes(c) || !live.route.allowedClasses.includes(c))) return denied;
      const results: { binding: ToolResultBinding; response: JsonObject; dataClasses: readonly DataClass[] }[] = [];
      for (const binding of bindings) {
        const result = authorizedStoredResult(tx, snapshot, binding);
        if (!result) return denied;
        results.push({ binding: detached(binding), ...result });
      }
      return { state: 'allowed' as const, results };
    });
  };
  const resultGate: ToolResultGate = {
    async authorize(host, bindings, baseClasses, signal) {
      if (signal.aborted) return { state: 'refused', reason: 'cancelled' };
      return authorizeDelivery(host, bindings, baseClasses, await lookupAuthority(host.runId, signal), signal);
    },
  };
  const apply = (input: ConnectionPolicy, expected: string | null | undefined): ConnectionApplyResult => {
    const p = validatePolicy({ ...input, bindingMode: input.bindingMode ?? 'connection' }); if (p.ownerId !== ownerId) throw Error('connection_owner_mismatch');
    const bytes = canonicalJSON(p); const hash = sha256(bytes);
    const changed = store.transaction(tx => {
      const row = tx.get('SELECT * FROM tool_connections WHERE owner_id=? AND connection_id=?', [ownerId, p.connectionId]);
      let current: BoundConnection | undefined;
      try { current = row ? connection(tx, p.connectionId) : undefined; }
      catch (error) {
        // W9: a stored approval that no longer validates against this release's reviewed connector
        // envelope (a release renamed its read tools) is a catalog change, not corruption. Only the
        // same endpoint's own live approval qualifies, and the compare-and-swap on the exact
        // predecessor bytes below still guards the replacement; anything else keeps throwing.
        const peeked = ((): { enabled?: unknown; connector?: unknown; endpoint?: { id?: unknown; account?: unknown; resource?: unknown } } | null => {
          try { return JSON.parse(String(row?.['policy_json'] ?? '')) as { enabled?: unknown }; } catch { return null; }
        })();
        // #530: the approval identity is the endpoint id plus its current tool manifest, so a release
        // that splits one endpoint into three leaves each new id unapproved until it is written once.
        const qualifies = approvalQualifies(peeked, { connector: p.connector, endpoint: { id: p.endpoint.id, account: p.endpoint.account, resource: p.endpoint.resource } }, options.grantMode === 'owner-trusted-reads');
        if (!row || expected !== String(row.policy_sha256) || !qualifies) throw error;
      }
      if (current && canonicalJSON(current.policy) === bytes) return false;
      const predecessor = current?.sha256 ?? (row ? String(row.policy_sha256) : null);
      if (expected !== undefined && expected !== predecessor) throw Error('connection_predecessor_mismatch');
      if (current && (p.generation <= current.generation || canonicalJSON(p.endpoint) !== canonicalJSON(current.policy.endpoint))) throw Error('connection_identity_or_generation');
      if (row) tx.run('UPDATE tool_connections SET generation=?,enabled=?,policy_json=?,policy_sha256=? WHERE owner_id=? AND connection_id=?', [p.generation, Number(p.enabled), bytes, hash, ownerId, p.connectionId]);
      else tx.run('INSERT INTO tool_connections VALUES (?,?,?,?,?,?,?)', [ownerId, p.connectionId, p.endpoint.id, p.generation, Number(p.enabled), bytes, hash]);
      tx.run("INSERT OR IGNORE INTO tool_connection_semantics VALUES (?,?,'connection')", [ownerId, p.connectionId]);
      return true;
    });
    // Durable commit wins even when projection is unavailable.
    if (changed || !p.enabled) { if (p.enabled) registry.suspend(p.endpoint.id); else registry.revoke(p.endpoint.id); }
    return { state: changed ? 'applied' : 'unchanged', sha256: hash };
  };
  const endpointMatches = (p: ConnectionPolicy): boolean => {
    const endpoint = registry.endpoint(p.endpoint.id);
    return endpointBinding(endpoint) === endpointBinding(p.endpoint);
  };

  const dispatch = createDispatchOwner({store,port,ownerId,
    current(tx,scope) {
      const snapshot = validateCallRun(tx,scope.call);
      return sha256(canonicalJSON(snapshot)) === scope.snapshotSha256 && currentPolicies(tx,snapshot,scope.bound.connectionId) && currentProjection(snapshot,scope.bound.connectionId);
    },
    failure(reason,scope) {
      if (!['context_absent','wire_observed_context_absent','pre_wire_context_absent','dispatch_unknown_context_absent','reuse_context_absent'].includes(reason)) options.log?.({event:'tool_failure',code:'connector_error',tool:scope?.call.toolName ?? 'unattributed',connector:scope?.bound.policy.connector ?? 'unknown',errorClass:'Error',messageHead:'connector_error'});
      hostLogEvent({event:'tool_diagnostic_capture',reason,runId:scope?.call.runId ?? null,executionId:scope?.call.executionId ?? null});
    },
  });
  const owner: ToolsOwner & LiveRunConnections = {
    journal, resultGate, authorizeDelivery, complete, sourcePort: dispatch.port,
    releaseHistoryConversation(conversationId) { historyReader.releaseConversation(conversationId); },
    releaseEvidence(runId, bindings) {
      pruneEvidence();
      if (bindings === undefined) {
        const chat = store.transaction(tx => chatRun(tx, runId));
        const successful = chat?.state === 'terminal' && chat.outcome === 'complete';
        if (chat && !successful) historyReader.releaseConversation(String(chat.session_id));
        historyReader.releaseRun(runId, successful);
        const lease = bodyLeases.get(runId); if (lease) lease.closed = true; bodyLeases.delete(runId); bodyConsumers.delete(runId);
      }
      const releasedIds = bindings ? new Set(bindings.map(binding => binding.result.id)) : undefined;
      for (const [cursor, page] of bodyPages) if (page.runId === runId && (!releasedIds || releasedIds.has(page.parent.result.id))) bodyPages.delete(cursor);
      const selected = bindings ? new Set(bindings.map(binding => binding.result.id)) : undefined;
      for (const [id, reference] of retained) if (reference.runId === runId && (!selected || selected.has(id))) {
        if (reference.evidence.kind === 'local-history' && selected) {
          const row = store.transaction(tx => tx.get('SELECT result_json FROM tool_calls WHERE owner_id=? AND run_id=? AND result_id=?', [ownerId, runId, id]));
          if (typeof row?.result_json === 'string') {
            const response = (JSON.parse(row.result_json) as ModelSnapshot).response;
            const tokens = [response['nextCursor'], response['recordRef'], ...(Array.isArray(response['hits']) ? response['hits'].map(hit => hit && typeof hit === 'object' && !Array.isArray(hit) ? hit['recordRef'] : null) : [])].filter((value): value is string => typeof value === 'string');
            historyReader.releaseReferences(tokens);
          }
        }
        retained.delete(id);
      }
    },
    consumeEvidence(host, binding, authority, signal) {
      const authorized = authorizeDelivery(host, [binding], [], authority, signal);
      if (authorized.state !== 'allowed') return authorized;
      const reference = retained.get(binding.result.id);
      if (!reference) return { state: 'refused', reason: 'evidence_unavailable' };
      return { state: 'allowed', evidence: detached(reference.evidence) };
    },
    applyConnection(input) { apply(input, undefined); },
    applyConnectionIntent(intent) {
      exact(intent, ['expectedPolicySha256', 'policy']);
      if (intent.expectedPolicySha256 !== null && (typeof intent.expectedPolicySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(intent.expectedPolicySha256))) throw Error('invalid_predecessor');
      return apply(intent.policy, intent.expectedPolicySha256);
    },
    async restoreConnection(id, assertCurrentBinding) {
      let selected: BoundConnection;
      try {
        selected = store.transaction(tx => connection(tx, id));
        if (!selected.policy.enabled || selected.policy.bindingMode !== 'connection' || selected.policy.sourcePolicy.unknownClass === null || !endpointMatches(selected.policy)) return { state: 'refused', reason: 'connection-not-enabled' };
        assertCurrentBinding();
      } catch { return { state: 'refused', reason: 'binding-not-current' }; }
      let discovered: Awaited<ReturnType<typeof port.discover>>;
      try { discovered = await port.discover(selected.policy.endpoint.id); } catch { discovered = { state: 'unavailable', reason: 'discovery-unavailable' }; }
      try {
        const current = store.transaction(tx => connection(tx, id));
        if (!current.policy.enabled || current.sha256 !== selected.sha256 || !endpointMatches(current.policy)) return { state: 'refused', reason: 'authority-changed' };
        if (discovered.state !== 'discovered') return { state: 'unavailable', reason: 'discovery-unavailable' };
        if (discovered.endpointId !== current.policy.endpoint.id || discovered.schemaDigest !== current.policy.schemaDigest) return { state: 'refused', reason: 'catalog-changed' };
        assertCurrentBinding();
        // Callback may synchronously mutate policy. Reread and install with no await gap.
        return store.transaction(tx => {
          const latest = connection(tx, id); const p = latest.policy;
          if (!p.enabled || latest.sha256 !== selected.sha256 || !endpointMatches(p)) return { state: 'refused', reason: 'authority-changed' };
          registry.restore({ endpointId: p.endpoint.id, schemaDigest: p.schemaDigest, generation: p.generation, account: p.endpoint.account, resource: p.endpoint.resource, toolNames: p.toolNames, effect: 'read' });
          return { state: 'restored' };
        });
      } catch { return { state: 'refused', reason: 'binding-or-consent-not-current' }; }
    },
    projectConnection(id) {
      const p = store.transaction(tx => connection(tx, id).policy); if (!p.enabled) throw Error('connection_disabled');
      if (p.bindingMode !== 'connection' || p.sourcePolicy.unknownClass === null) throw Error('connection_not_executable');
      const endpoint = registry.endpoint(p.endpoint.id);
      if (endpointBinding(endpoint) !== endpointBinding(p.endpoint)) throw Error('projection_endpoint_mismatch');
      const grant = registry.currentGrant(p.endpoint.id);
      if (grant && grant.generation === p.generation && grant.schemaDigest === p.schemaDigest && canonicalJSON(grant.toolNames) === canonicalJSON(p.toolNames)) return;
      registry.approve({ endpointId: p.endpoint.id, schemaDigest: p.schemaDigest, generation: p.generation, account: p.endpoint.account, resource: p.endpoint.resource, toolNames: p.toolNames, effect: 'read' });
    },
    snapshotRun(tx, input) {
      const acceptance = validateAcceptance(input);
      if (acceptance.ownerId !== ownerId || acceptance.authorityEpoch !== store.authorityEpoch) throw Error('snapshot_authority_mismatch');
      const snapshot: RunSnapshot = { acceptance, connections: acceptance.connectionIds.map(id => connection(tx, id)) };
      const bytes = canonicalJSON(snapshot); const hash = sha256(bytes);
      const existing = tx.get('SELECT snapshot_json FROM tool_runs WHERE owner_id=? AND run_id=?', [ownerId, acceptance.runId]);
      if (existing) { if (existing.snapshot_json !== bytes) throw Error('run_snapshot_collision'); return { sha256: hash }; }
      tx.run('INSERT INTO tool_runs VALUES (?,?,?,?)', [ownerId, acceptance.runId, bytes, hash]); return { sha256: hash };
    },
    durableConnectionIds(tx) {
      return tx.all('SELECT connection_id FROM tool_connections WHERE owner_id=? ORDER BY connection_id', [ownerId])
        .map(row => String(row['connection_id']))
        .filter(id => { try { return connection(tx, id).policy.enabled; } catch { return false; } });
    },
    liveRememberApproved() { return options.grantMode === 'owner-trusted-reads'; },
    liveDefinitions(runId, rememberNote) {
      // The Live model is declared only the one research tool plus remember; the connector reads
      // stay in the registry so the research fan-out and the session cache keep working, but the Live
      // session never declares them to the provider. A research tool is answered by a host-side loop
      // in the Live session, so its own execute is never reached.
      const ownerTools = owner.definitions(runId);
      const definitions: ToolDefinition[] = [researchDeclaration(researchSourcesFromToolNames(ownerTools.map(tool => tool.name)))].map(declaration => ({
        name: declaration.name, description: declaration.description, guidance: declaration.guidance, parameters: declaration.parameters,
        effect: 'read', accountId: 'gateway:live-voice', resourceId: 'intent', validate: declaration.validate,
        async execute() { return { status: 'failed' as const, code: 'handler_outcome' as const }; },
      }));
      definitions.push(...ownerTools.filter(tool => tool.name !== REMEMBER_IDENTITY.name));
      definitions.push({ ...REMEMBER_IDENTITY, description: 'Remember a note explicitly requested in the owner’s finalized words.', effect: 'write', parameters: REMEMBER_PARAMETERS, validate: validateRemember,
        async execute(args, context) {
          if (context.runId !== runId || !validateRemember(args) || context.signal.aborted) return { status: 'failed' };
          const gate = await resultGate.authorize({ ...context, grants: [] }, [], ['ordinary'], context.signal);
          if (gate.state !== 'allowed' || context.signal.aborted) return { status: 'failed' };
          const result = store.transaction(tx => {
            const row = tx.get('SELECT * FROM tool_calls WHERE owner_id=? AND run_id=? AND execution_id=?', [ownerId, context.runId, context.executionId]);
            if (!row || row.state !== 'intent') throw Error('intent_missing_or_terminal');
            const call = storedCall(tx, row);
            const expected = { runId: context.runId, actorId: context.actorId, authorityEpoch: context.authorityEpoch, revision: context.revision, executionId: context.executionId, toolName: REMEMBER_IDENTITY.name, argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'), accountId: REMEMBER_IDENTITY.accountId, resourceId: REMEMBER_IDENTITY.resourceId, ...(call.callId !== undefined ? { callId: call.callId } : {}) };
            if (canonicalJSON(call) !== canonicalJSON(expected)) throw Error('executor_intent_mismatch');
            const snapshot = validateCallRun(tx, call);
            assertLiveIdentity(tx, call); target(snapshot, call, tx);
            if (!currentPolicies(tx, snapshot, 'gateway:live-voice') || !currentProjection(snapshot, 'gateway:live-voice')) throw Error('executor_policy_denied');
            const response = rememberNote(tx, runId, args);
            return complete(call as ToolCallIntent, response, ['ordinary'], tx);
          });
          return { status: 'completed', result };
        },
      });
      // Host-native open actions: the frame goes down the local Live socket and the ack is the result.
      for (const openTool of OPEN_TOOLS) definitions.push({
        name: openTool.name, description: openTool.description, effect: 'read', accountId: OPEN_IDENTITY.accountId, resourceId: OPEN_IDENTITY.resourceId,
        parameters: openParameters(openTool), validate: args => validateOpen(args, openTool),
        async execute(args, context) {
          if (context.runId !== runId || !validateOpen(args, openTool) || context.signal.aborted) return { status: 'failed' as const };
          const gate = await resultGate.authorize({ ...context, grants: [] }, [], ['ordinary'], context.signal);
          if (gate.state !== 'allowed' || context.signal.aborted) return { status: 'failed' as const };
          const resolved = openTarget(openTool.name, args);
          const refused = 'target' in resolved ? undefined : resolved.code;
          const dispatched = 'target' in resolved ? resolved.target : undefined;
          const code = dispatched === undefined ? refused! : await nativeActions.dispatch(runId, dispatched.action, dispatched.target);
          if (dispatched) nativeActionReceipt(dispatched.action, code, dispatched.detail);
          else nativeActionReceipt('open_url', code, openTool.name === 'open_home' ? 'home' : 'none');
          // Open2: the opened ack names what opened, and only an ack of `opened` becomes a turn receipt.
          if (code === 'opened' && dispatched) noteOpened(context.runId, { kind: dispatched.kind, title: dispatched.title });
          if (context.signal.aborted) return { status: 'failed' as const };
          const result = store.transaction(tx => {
            const row = tx.get('SELECT * FROM tool_calls WHERE owner_id=? AND run_id=? AND execution_id=?', [ownerId, context.runId, context.executionId]);
            if (!row || row.state !== 'intent') throw Error('intent_missing_or_terminal');
            const call = storedCall(tx, row);
            const expected = { runId: context.runId, actorId: context.actorId, authorityEpoch: context.authorityEpoch, revision: context.revision, executionId: context.executionId, toolName: openTool.name, argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'), accountId: OPEN_IDENTITY.accountId, resourceId: OPEN_IDENTITY.resourceId, ...(call.callId !== undefined ? { callId: call.callId } : {}) };
            if (canonicalJSON(call) !== canonicalJSON(expected)) throw Error('executor_intent_mismatch');
            const snapshot = validateCallRun(tx, call);
            assertLiveIdentity(tx, call); target(snapshot, call, tx);
            if (!currentPolicies(tx, snapshot, 'gateway:live-voice') || !currentProjection(snapshot, 'gateway:live-voice')) throw Error('executor_policy_denied');
            const opened = code === 'opened' && dispatched ? { code: 'opened' as const, kind: dispatched.kind, title: dispatched.title } : undefined;
            return complete(call as ToolCallIntent, refused !== undefined ? { code, guidance: OPEN_GUIDANCE[refused] } : opened ?? { code }, ['ordinary'], tx);
          });
          return { status: 'completed' as const, result };
        },
      });
      return definitions;
    },
    definitions(runId, tx?: Transaction) {
      let lease = bodyLeases.get(runId);
      if (!lease) { lease = { closed: false }; bodyLeases.set(runId, lease); }
      const evidenceLease = lease;
      const snapshot = tx ? readRun(tx, runId).snapshot : store.transaction(current => readRun(current, runId).snapshot);
      const definitions: ToolDefinition[] = [];
      if (options.grantMode === 'owner-trusted-reads') definitions.push({ ...HISTORY_IDENTITY, effect: 'read', parameters: HISTORY_PARAMETERS,
        description: 'Search retained local conversations and notes, or read an exact returned record. Use query/date bounds for search, recordRef alone for detail, or cursor alone to continue. Coverage gaps are explicit.',
        validate: validateHistory,
        async execute(args, context) {
          if (!validateHistory(args) || context.signal.aborted) return { status: 'failed' };
          const gate = await resultGate.authorize({ ...context, grants: [] }, [], [], context.signal);
          if (gate.state !== 'allowed' || context.signal.aborted) return { status: 'failed' };
          const result = store.transaction(tx => {
            const row = tx.get('SELECT * FROM tool_calls WHERE owner_id=? AND run_id=? AND execution_id=?', [ownerId, context.runId, context.executionId]);
            if (!row || row.state !== 'intent') throw Error('intent_missing_or_terminal');
            const call = storedCall(tx, row);
            const expected = { runId: context.runId, actorId: context.actorId, authorityEpoch: context.authorityEpoch, revision: context.revision, executionId: context.executionId,
              toolName: HISTORY_IDENTITY.name, accountId: HISTORY_IDENTITY.accountId, resourceId: HISTORY_IDENTITY.resourceId, argumentsHash: sha256(JSON.stringify(args)), ...(call.callId ? { callId: call.callId } : {}) };
            exactIntent(tx, expected);
            const accepted = validateCallRun(tx, call).acceptance;
            const conversation = chatRun(tx, call.runId);
            const read = historyReader.read(tx, { ownerId, runId: call.runId, ...(conversation ? { conversationId: String(conversation.session_id) } : {}), authorityEpoch: accepted.authorityEpoch, revision: accepted.revision,
              routeIdentity: accepted.route.identity, allowedClasses: accepted.allowedClasses.filter(value => accepted.route.allowedClasses.includes(value)) }, args);
            const response = redactSecretsWithCount(read.response).value;
            return complete(call as ToolCallIntent, response, read.dataClasses, tx, { kind: 'local-history', ...read.evidence });
          });
          return { status: 'completed', result };
        },
      });
      // A name two connections both grant is model-facing under its endpoint id: the shared gateway pair
      // never collides, while a genuine duplicate inside one endpoint still throws below.
      const sharedNames = sharedGrantedNames(snapshot.connections.map(bound => bound.policy));
      for (const bound of snapshot.connections) {
        const p = bound.policy;
        const descriptor = connectorDescriptor(p.connector);
        if (!descriptor) throw new ConnectorCompositionError('unknown_connector', p.connectionId, p.connector);
        const reader = descriptor.createReader({ port: dispatch.port, registry, endpoint: p.endpoint, schemaDigest: p.schemaDigest, generation: p.generation, policy: p });
        const declarations = descriptor.declarations(p);
        for (const name of p.toolNames) {
          const modelName = modelToolName(p.endpoint.id, name, sharedNames);
          if (definitions.some(d => d.name === modelName)) throw new ConnectorCompositionError('ambiguous_model_tool_name', p.connectionId, p.connector);
          const declaration = declarations.find(candidate => candidate.name === name);
          // A connector capability granted for internal use (Mattermost channel-name resolution)
          // is absent from the model-facing table; it stays dispatchable through the connector.
          if (!declaration) {
            if (descriptor.envelope.includes(name)) continue;
            throw new ConnectorCompositionError('unknown_connector_tool', p.connectionId, p.connector);
          }
          definitions.push({ name: modelName, description: declaration.description, effect: 'read', accountId: p.endpoint.account, resourceId: p.endpoint.resource, endpointId: p.endpoint.id, validate: declaration.validate,
            ...(declaration.guidance === undefined ? {} : { guidance: declaration.guidance }),
            parameters: declaration.parameters,
            async execute(args, context) {
              if (context.signal.aborted) { return { status: 'unknown' }; }
              // Independent dispatch guard, checked at call time and not at declaration time: a
              // connector whose current generation is not published and ready never reaches its
              // handler, even when a stale run snapshot still names one of its tools.
              const grant = registry.currentGrant(p.endpoint.id);
              if (!grant || grant.generation !== p.generation || !grant.toolNames.includes(name)) { return { status: 'failed' }; }
              if (!declaration.validate(args)) { return { status: 'failed' }; }
              // Normalize at the boundary; the intent hash below stays over the model's original args.
              const prepared = declaration.normalize === undefined ? undefined : declaration.normalize(args);
              if (declaration.normalize !== undefined && prepared === undefined) { return { status: 'failed' }; }
              const callArgs = prepared === undefined ? args : prepared.args;
              const gate = await resultGate.authorize({ ...context, grants: [] }, [], [], context.signal);
              if (context.signal.aborted) return { status: 'unknown' };
              if (gate.state !== 'allowed') { return { status: 'failed' }; }
              const call = store.transaction(tx => {
                const row = tx.get('SELECT * FROM tool_calls WHERE owner_id=? AND run_id=? AND execution_id=?', [ownerId, context.runId, context.executionId]);
                if (!row || row.state !== 'intent') throw Error('intent_missing_or_terminal');
                const committed = storedCall(tx, row);
                const expected = { runId: context.runId, actorId: context.actorId, authorityEpoch: context.authorityEpoch, revision: context.revision, executionId: context.executionId, accountId: context.accountId, resourceId: context.resourceId, toolName: name, argumentsHash: sha256(JSON.stringify(args)), ...(committed.callId === undefined ? {} : { callId: committed.callId }) };
                exactIntent(tx, expected); const accepted = validateCallRun(tx, expected);
                if (!currentPolicies(tx, accepted, bound.connectionId) || !currentProjection(accepted, bound.connectionId)) return null;
                if (target(accepted, expected, tx).connectionId !== bound.connectionId) throw Error('executor_policy_denied');
                return expected;
              });
              if (!call) return { status: 'failed' };
              let evidence: Awaited<ReturnType<typeof reader.call>>;
              try { evidence = await dispatch.run({call,bound,snapshotSha256:sha256(canonicalJSON(snapshot)),allowedClasses:snapshot.acceptance.allowedClasses.filter(c => snapshot.acceptance.route.allowedClasses.includes(c))},() => reader.call(name, callArgs, context.signal)); } catch (error) {
                const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && isToolFailureCode(error.code) ? error.code : 'handler_outcome';
                options.log?.({ event: 'tool_failure', code, tool: name, connector: p.connector, errorClass: error instanceof SyntaxError ? 'SyntaxError' : error instanceof Error ? 'Error' : 'UnknownThrow', messageHead: code });
                return { status: code === 'connector_error' || code === 'handler_outcome' ? 'failed' : 'unknown', code };
              }
              // A completed read carries real data even when the turn deadline fired while it finished:
              // never discard it silently (F9 partial calendar reads); a refused or unknown result stays unknown.
              if (context.signal.aborted && evidence.state !== 'completed') return { status: 'unknown' };
              if (evidence.state === 'unknown') {
                const code = dispatchedFailureCode(evidence.reason);
                options.log?.({ event: 'tool_failure', code, tool: name, connector: p.connector, errorClass: 'Error', messageHead: code });
                return { status: 'unknown', code };
              }
              if (evidence.state !== 'completed') {
                const status = evidence.state === 'tool-error' || evidence.state === 'protocol-error' ? descriptor.status?.(evidence) : undefined;
                if (!status) {
                  // Keep the failure cause truthful: a refused connector read names its reason; a child
                  // tool/protocol error is an unusable result. Either way surface a real code.
                  const failureCode = evidence.state === 'refused' ? dispatchedFailureCode(evidence.reason) : 'invalid_result';
                  return { status: 'failed', code: failureCode };
                }
                // A classified failure is visible: the endpoint flips to configured and the call
                // returns the plain reason as its projection, never an empty success.
                reportToolStatus?.(p.endpoint.id, status);
                return { status: 'completed', result: complete(call, { tool: name, text: status.reason, partial: false, originalCharacters: status.reason.length, omittedCharacters: 0 }, []) };
              }
              reportToolStatus?.(p.endpoint.id, null);
              const sourceRefs = evidence[SOURCE_DISPATCH] ? [evidence[SOURCE_DISPATCH]!] : evidence[SOURCE_CHILD_DISPATCHES];
              let value: ModelSnapshot;
              try { value = descriptor.project(evidence, dispatch.port, p); } catch (error) {
                const code = error instanceof SyntaxError || (error instanceof Error && (error.message === 'unsupported_mcp_result' || error.message === 'unsupported_mcp_content')) ? 'invalid_result'
                  : error instanceof Error ? 'connector_error' : 'handler_outcome';
                // Only safe class/code metadata, never remote payloads or arbitrary exception text.
                options.log?.({ event: 'tool_failure', code, tool: name, connector: p.connector, errorClass: error instanceof SyntaxError ? 'SyntaxError' : error instanceof Error ? 'Error' : 'UnknownThrow', messageHead: code });
                return { status: 'failed', code };
              }
              // One boundary for every connector: a projected tool result is redacted before it is
              // persisted to tool_calls, put into evidence or source cards, or sent to the model.
              const redacted = redactSecretsWithCount(value.response);
              // K1's redaction point is the one place a completed call's result text is final, so the
              // journal copies it from here: already redacted, capped by the journal itself.
              if (redacted.count > 0) {
                // The owner log accepts one closed failure shape; the host log validates this receipt's
                // own closed shape (event, tool, count) and drops anything else, so no value can ride along.
                const receipt = options.log as unknown as ((event: Record<string, unknown>) => void) | undefined;
                receipt?.({ event: 'tool_redaction', tool: name, count: redacted.count });
                value = { ...value, response: redacted.value };
              }
              if (prepared?.notice !== undefined && typeof value.response['text'] === 'string') {
                value = { ...value, response: { ...value.response, text: `${value.response['text']} ${prepared.notice}` } };
              }
              if (evidenceLease.closed) return { status: 'failed', code: 'cancelled' };
              const hostEvidence = value[HOST_EVIDENCE];
              if (hostEvidence?.kind === 'remote-body') {
                const body = redactSecretsWithCount({ text: hostEvidence.body }).value.text as string;
                return { status: 'completed', result: complete(call, value.response, value.dataClasses, undefined, { ...hostEvidence, body, bodySha256: sha256(body) },sourceRefs) };
              }
              return { status: 'completed', result: complete(call, value.response, value.dataClasses, undefined, hostEvidence,sourceRefs) };
            },
          });
        }
      }
      if (definitions.some(tool => RECEIVED_BODY_TOOLS.has(tool.name))) {
        bodyConsumers.add(runId);
        definitions.push({ ...RECEIVED_BODY, effect: 'read', parameters: RECEIVED_BODY_PARAMETERS,
          description: 'Continue a received tool body locally using only bodyContinuation.cursor or nextCursor from this run. This makes no source request. Initial source text is a preview; full received-body coordinates start at zero. Coverage distinguishes local remaining bytes from unconfirmed source completeness. A repeated prepared cursor returns a receipt, not duplicate text.',
          validate: args => {
            pruneEvidence();
            if (!receivedBodyArguments(args) || evidenceLease.closed) return false;
            const page = bodyPages.get(args.cursor), original = page && retained.get(page.parent.result.id);
            return page?.runId === runId && original?.evidence.kind === 'remote-body' && original.evidence.expiresAt > Date.now();
          },
          async execute(args, context) {
            if (!receivedBodyArguments(args) || context.runId !== runId || context.signal.aborted) return { status: 'failed' };
            const page = bodyPages.get(args.cursor);
            if (!page || page.runId !== runId) return { status: 'failed' };
            const parentBinding = { ...page.parent, contentIndex: 0, partIndex: 0 };
            const gated = await resultGate.authorize({ ...context, grants: [] }, [parentBinding], [], context.signal);
            if (gated.state !== 'allowed' || context.signal.aborted || evidenceLease.closed || bodyPages.get(args.cursor) !== page) return { status: 'failed' };
            const reference = retained.get(page.parent.result.id);
            if (reference?.evidence.kind !== 'remote-body') return { status: 'failed' };
            const evidence = reference.evidence;
            const call = store.transaction(tx => {
              const row = tx.get('SELECT * FROM tool_calls WHERE owner_id=? AND run_id=? AND execution_id=?', [ownerId, runId, context.executionId]);
              if (!row || row.state !== 'intent') throw Error('intent_missing_or_terminal');
              const committed = storedCall(tx, row);
              const expected = { runId, actorId: context.actorId, authorityEpoch: context.authorityEpoch, revision: context.revision, executionId: context.executionId, toolName: RECEIVED_BODY.name, accountId: RECEIVED_BODY.accountId, resourceId: RECEIVED_BODY.resourceId, argumentsHash: sha256(JSON.stringify(args)), ...(committed.callId ? { callId: committed.callId } : {}) };
              exactIntent(tx, expected); return expected;
            });
            const coverage = { rootCursor: page.rootCursor, offset: page.offset, end: page.end, total: evidence.body.length, unit: 'utf16', upstreamComplete: evidence.upstreamComplete, upstreamOmitted: evidence.upstreamOmitted, stage: 'canonical-preparation' };
            const response: JsonObject = { status: 'completed', cursor: args.cursor, bodyCoverage: coverage, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), canContinue: Boolean(page.nextCursor),
              ...(page.completed ? { alreadyPrepared: true, bodySlices: [] } : { bodySlices: [{ source: evidence.tool === 'gmail_read_message' ? 'mail' : evidence.tool === 'get_insight' ? 'knowledge' : 'mongoose', tool: evidence.tool, text: evidence.body.slice(page.offset, page.end), offset: page.offset, end: page.end, total: evidence.body.length, unit: 'utf16', upstreamComplete: evidence.upstreamComplete, upstreamOmitted: evidence.upstreamOmitted }] }) };
            const provenance = store.transaction(tx => {
              const { snapshot, hash } = readRun(tx, runId);
              if (!authorizedStoredResult(tx, snapshot, page.parent)) throw Error('body_parent_unavailable');
              const parentCall = originalCall(tx, runId, page.parent);
              const bound = snapshot.connections.find(item => item.connectionId === target(snapshot, parentCall, tx).connectionId);
              if (!bound) throw Error('body_parent_unavailable');
              const row = exactIntent(tx, parentCall);
              const value = JSON.parse(String(row.result_json)) as { sourceDispatchRefs?: unknown };
              const ids = value.sourceDispatchRefs;
              if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length)) throw Error('dispatch_reference_denied');
              return { bound, hash, snapshot, refs: (ids as string[] | undefined)?.map(id => ({ id })) };
            });
            dispatch.run({ call, bound: provenance.bound, snapshotSha256: provenance.hash, allowedClasses: provenance.snapshot.acceptance.allowedClasses.filter(c => provenance.snapshot.acceptance.route.allowedClasses.includes(c)) }, () => provenance.refs?.forEach(ref => dispatch.reuse(ref)));
            const result = complete(call, response, gated.results[0]!.dataClasses, undefined, { kind: 'remote-page', parent: page.parent }, provenance.refs);
            if (!page.completed) {
              page.completed = result;
              if (page.nextCursor) {
                const cursor = page.nextCursor;
                const end = receivedBodyEnd(evidence.body, page.end, page.maxResultBytes);
                bodyPages.set(cursor, { runId, maxResultBytes: page.maxResultBytes, rootCursor: page.rootCursor, parent: page.parent, offset: page.end, end, argumentsHash: sha256(JSON.stringify({ cursor })), ...(end < evidence.body.length ? { nextCursor: randomUUID() } : {}) });
              }
            }
            return { status: 'completed', result };
          },
        });
      }
      return definitions;
      },
  };
  ownerBindings.set(owner, { store, registry, ownerId });
  transactionDefinitions.set(owner, owner.definitions);
  return owner;
}

/** Read a frozen run through the caller's transaction, without opening a nested transaction. */
export function definitionsInTransaction(owner: ToolsOwner, runId: string, tx: Transaction): ToolDefinition[] {
  const read = transactionDefinitions.get(owner);
  if (!read) throw Error('unbound_tools_owner');
  return read(runId, tx);
}
