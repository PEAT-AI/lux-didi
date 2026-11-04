import { commitAlarmEffect } from '../runtime/store.js';
import { authorizedTaskEffect } from '../tasks/authority.js';
import { connectorFailures } from '../tasks/results.js';
import { SOURCE_DISPATCH, SOURCE_CHILD_DISPATCHES } from '../adapters/mcp/port.js';
import { nativeTaskReadTool, nativeTaskReadGranted, isConnectorTaskRead } from '../tasks/connectors.js';
import { TASK_ACCOUNT, TASK_RESOURCE, TASK_TOOL_NAMES } from '../tasks/tools.js';
import type { TaskExecutionContext, ExistingExecutors } from '../tasks/connectors.js';
import { documentResult as taskDocumentResult, failed as taskFailed } from '../tasks/results.js';
import { diagnosticContentAccess } from '../trace/content.js';
import { hostLogEvent } from './host-events.js';
import { createDispatchOwner, projectDiagnosticInput } from './dispatch.js';
import { RECEIVED_BODY, RECEIVED_BODY_TOOLS, receivedBodyEnd, type ReceivedBodyPage, type RemoteResultLineage } from './received-body.js';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { SQLRow, Transaction } from '../contracts/storage.js';
import type { DataClass, HostContext, JsonObject, ToolCallIntent, ToolCallRefusal, ToolResultBinding, ToolResultGate, ToolResultRef } from '../adapters/model/types.js';
import { isToolFailureCode, MCP_FAILURE_STAGES } from '../adapters/model/types.js';
import { validateEndpointUrl, validateApprovedStdioEnv } from '../adapters/mcp/registry.js';
import { type SourceDispatchRef, endpointBinding, bindingDigestOf, sourceBindingOf } from '../adapters/mcp/port.js';
import { isLiveVoiceProvider } from '../adapters/live-voice/types.js';
import { ConnectorCompositionError, composedGrantedNames, connectorDescriptor, CONNECTOR_COMPOSED_TOOLS, CONNECTOR_ENVELOPES } from '../connectors/index.js';
import { canonicalJSON, detached, sha256 } from './canonical.js';
import { createHistoryReader, historyEvidenceCurrent } from '../domain/history-reader.js';
import { HISTORY_IDENTITY,} from './history.js';
import { type HostEvidenceRef } from './types.js';
import type { BoundConnection, ConnectionApplyResult, ConnectionPolicy, HttpConnectionEndpoint, ModelSnapshot, RunAcceptance, RunSnapshot, StdioConnectionEndpoint, ToolsOwner, ToolsOwnerOptions } from './types.js';
import { REMEMBER_IDENTITY,} from './remember.js';
import { STAGE_NOTE_IDENTITY,} from './lux-note.js';
import { VAULT_WRITE_IDENTITY,} from './vault-write.js';
import { refusalCauseOf } from './refusal-cause.js';
import { TRELLO_READ_IDENTITY, TRELLO_WRITE_IDENTITY,} from './trello.js';
import { ALARM_NAMES, ALARM_IDENTITY, listPendingAlarms, insertAlarmSeries, linkAlarmOccurrence, alarmSeriesOfOccurrence, materialiseSeriesOccurrence, seriesNextFireAt, type SeriesRule, pendingOccurrenceOf, parseCancelScope, parseAlarmTime, alarmReadBack, readTimeSpec,} from './alarm.js';
import { COMPOSE_IDENTITY, COMPOSE_NAMES,} from './compose.js';
import { OPEN_IDENTITY, OPEN_TOOL_NAMES, openWebFailure, OPEN_WEB_NAME,} from './open.js';

import { PEOPLE_LOOKUP_DECLARATION, peopleLookupResult } from '../people/index.js';
export { toolsMigrations } from './schema.js';
export type * from './types.js';

const ownedStores = new WeakSet<object>();
const ownerBindings = new WeakMap<object, Pick<ToolsOwnerOptions, 'store' | 'registry' | 'ownerId'>>();
/** Factory identity check: no second owner, port or registry may substitute for canonical authority. */
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
/** C-DEPTH11: the pre-rename Google read names a durable policy may still hold, old name to current name. */
const LEGACY_GOOGLE_READ_NAMES: Readonly<Record<string, string>> = {
  gcal_calendars: 'calendar_list_calendars',
  gcal_list: 'calendar_list_events',
  gmail_list: 'gmail_search_messages',
  gmail_read: 'gmail_read_message',
};

export function validatePolicy(input: ConnectionPolicy): ConnectionPolicy {
  const p = detached(input);
  // C-DEPTH11 (W16-R1 F1): a stored policy may still carry the pre-rename Google read names (the app keeps
  // gcal_ for old rows, web/src/markdown.ts:272). They are resolved to the current names here, so an upgraded
  // owner keeps reading instead of the whole connection being refused as invalid_read_tools.
  if (Array.isArray(p.toolNames)) p.toolNames = [...new Set(p.toolNames.map(name => typeof name === 'string' ? LEGACY_GOOGLE_READ_NAMES[name] ?? name : name))];
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
  // #604: a connector composite is a grantable name of its own, but only beside every child read it
  // stands on, so the policy can never widen the envelope one composed name at a time.
  const composed = CONNECTOR_COMPOSED_TOOLS[p.connector] ?? [];
  // W1030: a write family's own names are grantable, but never as reads: they ride beside the family's
  // read-only consent probe and are never model-facing tool declarations (see liveDefinitions below).
  const declaration = connectorDescriptor(p.connector);
  const writes = declaration?.writeEnvelope ?? [];
  const grantable = [...envelope, ...composed.map(tool => tool.name), ...writes];
  if (!Array.isArray(p.toolNames) || p.toolNames.length < 1 || p.toolNames.length > grantable.length || new Set(p.toolNames).size !== p.toolNames.length || p.toolNames.some(n => typeof n !== 'string' || !grantable.includes(n)) || !/^[a-f0-9]{64}$/.test(p.schemaDigest)) throw Error('invalid_read_tools');
  if (composed.some(tool => p.toolNames.includes(tool.name) && !tool.requires.every(child => p.toolNames.includes(child)))) throw Error('invalid_read_tools');
  // The same closure for a write family: a write name is grantable only beside the read-only probe.
  if (writes.some(name => p.toolNames.includes(name)) && (declaration?.writeProbe === undefined || !p.toolNames.includes(declaration.writeProbe))) throw Error('invalid_read_tools');
  exact(p.sourcePolicy, ['id', 'revision', 'unknownClass', 'allowedClasses']); text(p.sourcePolicy.id); positive(p.sourcePolicy.revision); classSet(p.sourcePolicy.allowedClasses);
  if ((p.bindingMode === 'connection' && p.sourcePolicy.unknownClass === null) || (p.sourcePolicy.unknownClass !== null && !classes.includes(p.sourcePolicy.unknownClass))) throw Error('invalid_unknown_class');
  exact(p.route, ['identity', 'allowedClasses']); text(p.route.identity); classSet(p.route.allowedClasses);
  exact(p.bounds, ['maxQueryChars', 'maxSearchLimit', 'maxGetIds', 'maxEntityBytes', 'maxResultBytes']); Object.values(p.bounds).forEach(positive);
  return p;
}
/**
 * #630: the host publishes only the names the endpoint itself lists (host/mcp.ts restore), so a
 * composite the policy grants is satisfied by the children it stands on, never by its own name.
 * Any other difference between the grant and the policy still refuses.
 */
function projectionCovers(p: ConnectionPolicy, granted: readonly string[]): boolean {
  if (granted.some(name => !p.toolNames.includes(name))) return false;
  const covered = new Set([...granted, ...composedGrantedNames(p.connector, granted)]);
  return p.toolNames.every(name => covered.has(name));
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
/**
 * LOGS.md L-08: one classified connector failure, closed. Ids and the connector's own code only, so
 * host.log can tell a failed read from an empty one; never an argument, a payload, a query or a line
 * of helper text. Its own event name, because `tool_failure` is a transport failure and
 * `connector_failure` a connect-time stage.
 */
export interface ClassifiedFailureEvent {
  event: 'tool_classified_failure';
  endpointId: string;
  connector: string;
  tool: string;
  code: string;
}

const EVENT_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** The closed failure event for one classified result, or undefined when a value is not an id or a code. */
export function classifiedFailureEvent(input: { endpointId: string; connector: string; tool: string; code: string }): ClassifiedFailureEvent | undefined {
  if (!EVENT_TOKEN.test(input.code)) return undefined;
  if (input.endpointId === '' || input.endpointId.length > 64 || input.connector === '' || input.connector.length > 32 || input.tool === '' || input.tool.length > 64) return undefined;
  return { event: 'tool_classified_failure', endpointId: input.endpointId, connector: input.connector, tool: input.tool, code: input.code };
}

export function createToolsOwner(options: ToolsOwnerOptions): ToolsOwner & LiveRunConnections {
  const { store, registry, port, lookupAuthority, ownerId } = options; text(ownerId);
  if (ownedStores.has(store)) throw Error('duplicate_store_tools_owner');
  ownedStores.add(store);
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
    if (id === TASK_ACCOUNT) return true;
    if (id === 'gateway:live-voice' || id === HISTORY_IDENTITY.accountId) return options.grantMode === 'owner-trusted-reads';
    const bound = snapshot.connections.find(b => b.connectionId === id);
    if (!bound || !snapshot.acceptance.connectionIds.includes(id)) return false;
    const current = connection(tx, id); const p = current.policy; const c = p.sourcePolicy.unknownClass;
    if (p.bindingMode !== 'connection' || current.sha256 !== bound.sha256 || current.generation !== bound.generation || canonicalJSON(p) !== canonicalJSON(bound.policy) || !p.enabled || c === null) return false;
    return [p.sourcePolicy.allowedClasses, p.route.allowedClasses, snapshot.acceptance.allowedClasses, snapshot.acceptance.route.allowedClasses].every(set => set.includes(c));
  };
  const currentProjection = (snapshot: RunSnapshot, id: string): boolean => {
    if (id === TASK_ACCOUNT) return true;
    if (id === 'gateway:live-voice' || id === HISTORY_IDENTITY.accountId) return options.grantMode === 'owner-trusted-reads';
    const bound = snapshot.connections.find(b => b.connectionId === id); if (!bound) return false;
    const p = bound.policy;
    try {
      const endpoint = registry.endpoint(p.endpoint.id); const grant = registry.currentGrant(p.endpoint.id);
      return !!grant && endpointBinding(endpoint) === endpointBinding(p.endpoint) &&
        grant.generation === p.generation && grant.schemaDigest === p.schemaDigest && grant.account === p.endpoint.account && grant.resource === p.endpoint.resource && projectionCovers(p, grant.toolNames);
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
    if (TASK_TOOL_NAMES.has(call.toolName) && call.accountId === TASK_ACCOUNT && call.resourceId === TASK_RESOURCE) {
      // Native source admission and completion bind the selected source in runTask/evidenceCurrent, not every unrelated connector.
      return { connectionId: TASK_ACCOUNT, policy: { sourcePolicy: { allowedClasses: snapshot.acceptance.allowedClasses }, route: { allowedClasses: snapshot.acceptance.route.allowedClasses }, bounds: { maxResultBytes: 65536 } } };
    }
    if (call.toolName === RECEIVED_BODY.name && call.accountId === RECEIVED_BODY.accountId && call.resourceId === RECEIVED_BODY.resourceId) {
      const page = pageForCall(call); if (!page || !bodyConsumers.has(call.runId)) throw Error('body_cursor_unavailable');
      const resolve = (tx: Transaction) => target(snapshot, originalCall(tx, call.runId, page.parent), tx);
      return transaction ? resolve(transaction) : store.transaction(resolve);
    }
    if (call.toolName === PEOPLE_LOOKUP_DECLARATION.name && call.accountId === 'gateway:live-voice' && call.resourceId === 'intent') {
      if (options.grantMode !== 'owner-trusted-reads') throw Error('builtin_grant_denied');
      return { connectionId: 'gateway:live-voice', policy: { sourcePolicy: { allowedClasses: ['ordinary'] }, route: { allowedClasses: ['ordinary'] }, bounds: { maxResultBytes: 65536 } } };
    }
    if (call.toolName === HISTORY_IDENTITY.name && call.accountId === HISTORY_IDENTITY.accountId && call.resourceId === HISTORY_IDENTITY.resourceId) {
      if (options.grantMode !== 'owner-trusted-reads') throw Error('builtin_grant_denied');
      return { connectionId: HISTORY_IDENTITY.accountId, policy: { sourcePolicy: { allowedClasses: snapshot.acceptance.allowedClasses }, route: { allowedClasses: snapshot.acceptance.route.allowedClasses }, bounds: { maxResultBytes: 65536 } } };
    }
    if (COMPOSE_NAMES.some(name => name === call.toolName) && call.accountId === COMPOSE_IDENTITY.accountId && call.resourceId === COMPOSE_IDENTITY.resourceId) {
      // W1030: the write tools are gateway tools pinned to his own compose surface, never a chosen account.
      if (options.grantMode !== 'owner-trusted-reads') throw Error('builtin_grant_denied');
      return { connectionId: 'gateway:live-voice', policy: { sourcePolicy: { allowedClasses: ['ordinary'] }, route: { allowedClasses: ['ordinary'] }, bounds: { maxResultBytes: 65536 } } };
    }
    if (call.toolName === VAULT_WRITE_IDENTITY.name && call.accountId === VAULT_WRITE_IDENTITY.accountId && call.resourceId === VAULT_WRITE_IDENTITY.resourceId) {
      if (options.grantMode !== 'owner-trusted-reads') throw Error('builtin_grant_denied');
      return { connectionId: 'gateway:live-voice', policy: { sourcePolicy: { allowedClasses: ['ordinary'] }, route: { allowedClasses: ['ordinary'] }, bounds: { maxResultBytes: 1024 } } };
    }
    if (call.toolName === STAGE_NOTE_IDENTITY.name && call.accountId === STAGE_NOTE_IDENTITY.accountId && call.resourceId === STAGE_NOTE_IDENTITY.resourceId) {
      if (options.grantMode !== 'owner-trusted-reads') throw Error('builtin_grant_denied');
      // The stage result carries the frozen title, body and read-back line for the owner to hear, so the
      // ceiling is the note's own limits, not the vault tool's small receipt. W5: 1024 refused every
      // realistic note with model_snapshot_oversize after the row was already written and rolled back.
      return { connectionId: 'gateway:live-voice', policy: { sourcePolicy: { allowedClasses: ['ordinary'] }, route: { allowedClasses: ['ordinary'] }, bounds: { maxResultBytes: 65_536 } } };
    }
    if (call.toolName === REMEMBER_IDENTITY.name && call.accountId === REMEMBER_IDENTITY.accountId && call.resourceId === REMEMBER_IDENTITY.resourceId) {
      if (options.grantMode !== 'owner-trusted-reads') throw Error('builtin_grant_denied');
      return { connectionId: 'gateway:live-voice', policy: { sourcePolicy: { allowedClasses: ['ordinary'] }, route: { allowedClasses: ['ordinary'] }, bounds: { maxResultBytes: 1024 } } };
    }
    if ((call.toolName === TRELLO_READ_IDENTITY.name || call.toolName === TRELLO_WRITE_IDENTITY.name) && call.accountId === TRELLO_READ_IDENTITY.accountId && call.resourceId === TRELLO_READ_IDENTITY.resourceId) {
      // W7: the owner's own Trello board, a gateway tool pinned to one board on Didi's side.
      if (options.grantMode !== 'owner-trusted-reads' || !options.trello) throw Error('builtin_grant_denied');
      return { connectionId: 'gateway:live-voice', policy: { sourcePolicy: { allowedClasses: ['ordinary'] }, route: { allowedClasses: ['ordinary'] }, bounds: { maxResultBytes: 65536 } } };
    }
    if (call.accountId === ALARM_IDENTITY.accountId && call.resourceId === ALARM_IDENTITY.resourceId && ALARM_NAMES.some(name => name === call.toolName)) {
      if (options.grantMode !== 'owner-trusted-reads') throw Error('builtin_grant_denied');
      return { connectionId: 'gateway:live-voice', policy: { sourcePolicy: { allowedClasses: ['ordinary'] }, route: { allowedClasses: ['ordinary'] }, bounds: { maxResultBytes: 4096 } } };
    }
    if (call.accountId === OPEN_IDENTITY.accountId && call.resourceId === OPEN_IDENTITY.resourceId && OPEN_TOOL_NAMES.has(call.toolName)) {
      // Host-native open tools; the native side re-checks the allowlist before anything opens.
      if (options.grantMode !== 'owner-trusted-reads') throw Error('builtin_grant_denied');
      return { connectionId: 'gateway:live-voice', policy: { sourcePolicy: { allowedClasses: ['ordinary'] }, route: { allowedClasses: ['ordinary'] }, bounds: { maxResultBytes: 1024 } } };
    }
    // TR-R15: a composed read is in the run's scope exactly when every base read it composes is granted by the
    // connection's own policy, the same derivation the door and the host use. Nothing is stored: the composite is
    // never added to the policy, so an unapproved name still finds no connection and still refuses.
    const inScope = (b: { policy: { connector: string; toolNames: readonly string[] } }): boolean =>
      b.policy.toolNames.includes(call.toolName) || composedGrantedNames(b.policy.connector, b.policy.toolNames).includes(call.toolName);
    const matches = snapshot.connections.filter(b => snapshot.acceptance.connectionIds.includes(b.connectionId) && inScope(b) && b.policy.endpoint.account === call.accountId && b.policy.endpoint.resource === call.resourceId);
    if (matches.length !== 1) throw Error('intent_scope_mismatch'); return matches[0]!;
    return matches[0]!;
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
    const taskRead = call.accountId === TASK_ACCOUNT && call.resourceId === TASK_RESOURCE && TASK_TOOL_NAMES.has(call.toolName);
    const bound = taskRead
      ? snapshot.connections.find(item => item.policy.endpoint.id === evidence.source.endpointId && item.policy.endpoint.account === evidence.source.account && item.policy.endpoint.resource === evidence.source.resource)
      : snapshot.connections.find(item => item.connectionId === target(snapshot, call, tx).connectionId);
    if (taskRead && bound && (!currentPolicies(tx, snapshot, bound.connectionId) || !currentProjection(snapshot, bound.connectionId))) return false;
    if (!bound || evidence.expiresAt <= Date.now() || !/^[a-f0-9]{64}$/.test(evidence.entitySha256) || sha256(evidence.body) !== evidence.bodySha256) return false;
    const p = bound.policy, source = evidence.source;
    const binding = 'transport' in p.endpoint ? bindingDigestOf(p.endpoint) : p.endpoint.url;
    const nativeTool = taskRead ? nativeTaskReadTool(call.toolName, p.connector) : call.toolName;
    return evidence.tool === nativeTool && source.toolName === nativeTool && source.endpointId === p.endpoint.id && sourceBindingOf(source) === binding
      && source.generation === p.generation && source.schemaDigest === p.schemaDigest && source.account === p.endpoint.account && source.resource === p.endpoint.resource;
  };
  const complete = (input: ToolCallIntent, response: JsonObject, dataClasses: readonly DataClass[], transaction?: Transaction, hostEvidence?: HostEvidenceRef, sourceDispatchRefs?: readonly SourceDispatchRef[]): ToolResultRef => {
    const call = callDTO(input);
    if ((hostEvidence?.kind === 'remote-body' || hostEvidence?.kind === 'remote-page') && !bodyConsumers.has(call.runId)) throw Error('evidence_run_closed');
    const cursor = hostEvidence?.kind === 'remote-body' && bodyConsumers.has(call.runId) && RECEIVED_BODY_TOOLS.has(call.toolName) && hostEvidence.body.length > 0 ? randomUUID() : undefined;
    let maxResultBytes = 0;
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
        if (sourceAccess.state !== 'allowed' || projection.sha256 !== call.argumentsHash || (declaration && !declaration.validate(capture))) projection = {json:null,sha256:call.argumentsHash,fidelity:'hash_only_unsupported_v1',keyCount:projection.keyCount,keys:projection.keys};
        tx.run("INSERT INTO tool_calls(owner_id,run_id,execution_id,call_id,intent_json,state,input_json,input_sha256,input_fidelity,input_key_count) VALUES (?,?,?,?,?,'intent',?,?,?,?)", [ownerId, call.runId, call.executionId, call.callId ?? null, intentBytes(tx, call),projection.json,projection.sha256,projection.fidelity,projection.keyCount]);
        return 'fresh';
      });
    },
    refuse(input, reason) {
      const call = callDTO(input);
      return store.transaction(tx => {
        if (callRow(tx, call)) throw Error('refusal_collision'); validateCallRun(tx, call);
        return persistTerminal(tx, call, 'refused', { response: call.toolName === OPEN_WEB_NAME ? { status: 'refused', reason, ...openWebFailure(reason) } : { status: 'refused', reason, ...refusalCauseOf(reason) }, dataClasses: [] }, true);
      });
    },
    fail(input, status, reason, hostRepair) {
      const call = callDTO(input);
      if (status !== 'failed' && status !== 'unknown') throw Error('invalid_terminal_status');
      return store.transaction(tx => {
        if (exactIntent(tx, call).state !== 'intent') throw Error('terminal_immutable'); validateCallRun(tx, call);
        const code = isToolFailureCode(reason) ? reason : status === 'unknown' ? 'tool_unknown' : 'tool_failed';
        return persistTerminal(tx, call, status, { response: hostRepair ? { status, reason: code, cause: hostRepair, next: hostRepair, text: hostRepair, repair: hostRepair } : call.toolName === OPEN_WEB_NAME ? { status, reason: code, ...openWebFailure(code) } : { status, reason: code, ...refusalCauseOf(code) }, dataClasses: [] });
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
        const peeked = ((): { enabled?: unknown; endpoint?: { id?: unknown; account?: unknown; resource?: unknown } } | null => {
          try { return JSON.parse(String(row?.['policy_json'] ?? '')) as { enabled?: unknown }; } catch { return null; }
        })();
        const sameEndpoint = peeked !== null && peeked.enabled !== false
          && peeked.endpoint?.id === p.endpoint.id
          && peeked.endpoint?.account === p.endpoint.account
          && peeked.endpoint?.resource === p.endpoint.resource;
        if (!row || expected !== String(row.policy_sha256) || !sameEndpoint) throw error;
      }
      if (current && canonicalJSON(current.policy) === bytes) return false;
      const predecessor = current?.sha256 ?? (row ? String(row.policy_sha256) : null);
      if (expected !== undefined && expected !== predecessor) throw Error('connection_predecessor_mismatch');
      // W2-R1: a new generation may move the endpoint's own command, args or env (a rebuilt child), but
      // never its id, account or resource: that is the foreign endpoint this guard exists for.
      const sameIdentity = current !== undefined && current.policy.endpoint.id === p.endpoint.id
        && current.policy.endpoint.account === p.endpoint.account && current.policy.endpoint.resource === p.endpoint.resource;
      if (current && (p.generation <= current.generation || (canonicalJSON(p.endpoint) !== canonicalJSON(current.policy.endpoint) && !sameIdentity))) throw Error('connection_identity_or_generation');
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
    taskIntent(context, name, args) {
      return store.transaction(tx => {
        const row = tx.get('SELECT * FROM tool_calls WHERE owner_id=? AND run_id=? AND execution_id=?', [ownerId, context.runId, context.executionId]);
        if (!row || row.state !== 'intent') throw Error('intent_missing_or_terminal');
        const call = storedCall(tx, row), { signal: _signal, ...execution } = context;
        const expected = { ...execution, toolName: name, argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'), ...(call.callId !== undefined ? { callId: call.callId } : {}) };
        if (!TASK_TOOL_NAMES.has(name) || context.accountId !== TASK_ACCOUNT || context.resourceId !== TASK_RESOURCE || canonicalJSON(call) !== canonicalJSON(expected)) throw Error('executor_intent_mismatch');
        const snapshot = validateCallRun(tx, call); target(snapshot, call, tx);
        return call as ToolCallIntent;
      });
    },
    taskVisible(runId, name) {
      if (!isConnectorTaskRead(name)) return true;
      return store.transaction(tx => {
        const { snapshot } = readRun(tx, runId);
        return snapshot.connections.some(bound => {
          const p = bound.policy, c = p.sourcePolicy.unknownClass;
          return snapshot.acceptance.connectionIds.includes(bound.connectionId)
            && (nativeTaskReadTool(name, p.connector) !== undefined || name === 'query_company' && p.connector === 'mongoose')
            && p.enabled && p.bindingMode === 'connection' && c !== null
            && [p.sourcePolicy.allowedClasses, p.route.allowedClasses, snapshot.acceptance.allowedClasses, snapshot.acceptance.route.allowedClasses].every(classes => classes.includes(c));
        });
      });
    },
    runTask(call, args, body) {
      const scope = store.transaction(tx => {
        const snapshot = validateCallRun(tx, call);
        const bound = snapshot.connections.find(item => {
          const native = nativeTaskReadTool(call.toolName, item.policy.connector, args);
          return native !== undefined && snapshot.acceptance.connectionIds.includes(item.connectionId) && nativeTaskReadGranted(item.policy, native);
        });
        if (!bound) return undefined;
        if (!currentPolicies(tx, snapshot, bound.connectionId)) throw Error('task_source_policy_denied');
        if (!currentProjection(snapshot, bound.connectionId)) throw Error('task_source_projection_changed');
        return { call, bound, snapshotSha256: sha256(canonicalJSON(snapshot)), allowedClasses: snapshot.acceptance.allowedClasses };
      });
      if (scope) { bodyConsumers.add(call.runId); return dispatch.run(scope, body); }
      return body();
    },
    closeTaskCall(sessionId) { options.trello?.end(sessionId); },
    taskExecutors(sessionId) {
      const project = (name: string, value: JsonObject) => value.ok === false
        ? taskFailed(String(value.guidance ?? value.code ?? 'The operation was refused.')) : taskDocumentResult(JSON.stringify(value), name);
      const alarm = (action: 'create' | 'update' | 'cancel', args: Record<string, unknown>, context: TaskExecutionContext) => {
        if (!options.alarms || !context.identity) return taskFailed('The local alarm scheduler or task identity is unavailable. Nothing changed.');
        const now = options.alarms.now();
        const effect = authorizedTaskEffect.getStore();
        if (!effect) return taskFailed('Alarm authority context is unavailable. Nothing changed.');
        let rule = args.recurrence as SeriesRule | null | undefined;
        let at = args.at === null || args.at === undefined ? undefined : Date.parse(String(args.at));
        if (args.at !== null && args.at !== undefined && (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(String(args.at)) || !Number.isFinite(at) || at! <= now)) return taskFailed('Use a future ISO timestamp with an explicit time-zone offset. Nothing changed.');
        if (at !== undefined) {
          const zone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
          const proposed = alarmReadBack(at, zone);
          const time = readTimeSpec({ mode: 'wall', date: proposed.date, local_time: proposed.localTime, timezone: zone });
          const interpreted = parseAlarmTime(effect.ownerWords, now, zone, time.state === 'read' ? time.spec : undefined);
          if (interpreted.status === 'ready') { at = interpreted.fireAtUtc; rule = interpreted.series ?? rule; }
        }
        if (rule) { try { if (rule.kind === 'weekly' && !rule.weekdays.length) throw Error('empty_weekdays'); at = seriesNextFireAt(rule, now); } catch { return taskFailed('Invalid recurrence. Nothing changed.'); } }
        if (at !== undefined) at = Math.max(at, now + 60_000);
        const label = typeof args.text === 'string' ? args.text.trim() : undefined;
        if ((action === 'create' && (at === undefined || !label)) || (label !== undefined && (!label || label.length > 200))) return taskFailed('Give a nonempty reminder label of at most 200 characters and a future timestamp. Nothing changed.');
        if (action === 'update' && at === undefined && label === undefined && !rule) return taskFailed('Supply the new reminder text or timestamp. Nothing changed.');
        let id = action === 'create' ? `alarm_${createHash('sha256').update(`${context.identity.task_id}:${JSON.stringify(args)}`).digest('hex')}` : String(args.id);
        const result = commitAlarmEffect(store, effect.identity, tx => {
          if (action === 'create') {
            if (rule) insertAlarmSeries(tx, { id, rule, label: label!, createdJournalId: context.identity!.task_id });
            tx.run("INSERT INTO alarms(id,fire_at_utc,tz,label,state,created_journal_id) VALUES(?,?,?,?,'pending',?)", [id, at!, options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, label!, context.identity!.task_id]);
            if (rule) linkAlarmOccurrence(tx, id, id);
          } else {
            id = pendingOccurrenceOf(tx, id) ?? id;
            const row = tx.get("SELECT * FROM alarms WHERE id=? AND state IN ('pending','ringing')", [id]);
            if (!row) return taskFailed('That alarm is not active. Read the current local alarms and choose its exact id.');
            if (action === 'cancel') {
              tx.run("UPDATE alarms SET state='cancelled',ring_started_at_utc=NULL,ring_deadline_utc=NULL WHERE id=?", [id]);
              const series = alarmSeriesOfOccurrence(tx, id);
              if (series && (args.scope ?? parseCancelScope(effect.ownerWords)) === 'series') tx.run("UPDATE alarm_series SET state='cancelled' WHERE id=?", [series.id]);
              else if (series) materialiseSeriesOccurrence(tx, id, now);
            }
            else {
              const series = alarmSeriesOfOccurrence(tx, id);
              if (rule) {
                if (series) tx.run('UPDATE alarm_series SET rule_kind=?,weekdays=?,local_time=?,tz=?,label=? WHERE id=?', [rule.kind, rule.kind === 'weekly' ? rule.weekdays.join(',') : '', `${String(rule.hour).padStart(2, '0')}:${String(rule.minute).padStart(2, '0')}`, rule.tz, label ?? String(row.label), series.id]);
                else { insertAlarmSeries(tx, { id, rule, label: label ?? String(row.label), createdJournalId: context.identity!.task_id }); linkAlarmOccurrence(tx, id, id); }
              } else if (series && label) tx.run('UPDATE alarm_series SET label=? WHERE id=?', [label, series.id]);
              tx.run("UPDATE alarms SET label=?,fire_at_utc=?,tz=?,state='pending',ring_started_at_utc=NULL,ring_deadline_utc=NULL WHERE id=?", [label ?? String(row.label), at ?? Number(row.fire_at_utc), rule?.tz ?? String(row.tz), id]);
            }
          }
          return { ...taskDocumentResult(JSON.stringify({ id, state: action === 'cancel' ? 'cancelled' : 'pending', ...(at === undefined ? {} : { at: new Date(at).toISOString(), localTime: alarmReadBack(at, options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone).spoken }) }), id), references: [{ id }] };
        });
        if (result.status === 'ok') {
          try { options.alarms.recheck(); } catch {
            // The durable scheduler rows survive notification failure and restart. Retry once.
            try { options.alarms.recheck(); } catch { /* Scheduler recovery reads committed rows. */ }
          }
        }
        return result;
      };
      const executors: ExistingExecutors = {
        people_lookup: async args => project('people_lookup', peopleLookupResult(args)),
        alarm_create: async (args, _signal, context) => alarm('create', args, context),
        alarm_update: async (args, _signal, context) => alarm('update', args, context),
        alarm_cancel: async (args, _signal, context) => alarm('cancel', args, context),
        alarm_list: async () => taskDocumentResult(JSON.stringify(store.transaction(tx => listPendingAlarms(tx))), 'local-alarms'),
        trello_read: async (args, signal) => options.trello ? project('trello_read', await options.trello.read(sessionId, args, signal)) : taskFailed('The board connector is not configured.'),
        trello_write: async (args, signal) => options.trello ? project('trello_write', await options.trello.writeTask(sessionId, args, signal)) : taskFailed('The board connector is not configured.'),
      };
      return executors;
    },
    taskBindings(connectionIds) {
      const policies = store.transaction(tx => connectionIds.map(id => connection(tx, id).policy).filter(policy => policy.enabled));
      return policies.map(policy => {
        const descriptor = connectorDescriptor(policy.connector);
        if (!descriptor) throw new ConnectorCompositionError('unknown_connector', policy.connectionId, policy.connector);
        const nativeReader = descriptor.createReader({ port: dispatch.port, registry, endpoint: policy.endpoint, schemaDigest: policy.schemaDigest, generation: policy.generation, policy });
        const reader = { ...nativeReader, call: async (...args: Parameters<typeof nativeReader.call>) => {
          const evidence = await nativeReader.call(...args);
          if ('reason' in evidence && isToolFailureCode(evidence.reason) && (MCP_FAILURE_STAGES as readonly string[]).includes(evidence.reason)) options.log?.({ event: 'tool_failure', code: evidence.reason, tool: args[0], connector: policy.connector, errorClass: 'Error', messageHead: evidence.reason });
          if (descriptor.status) {
            const status = descriptor.status(evidence, policy.endpoint);
            options.reportToolStatus?.(policy.connectionId, status ?? null);
            if (status) connectorFailures.set(evidence, status.reason);
            if (status?.log) options.log?.(status.log);
          }
          return evidence;
        } };
        return { connector: policy.connector, reader, policy, project: (evidence: import('../connectors/index.js').ConnectorEvidence) => {
          const origins = [evidence[SOURCE_DISPATCH], ...(evidence[SOURCE_CHILD_DISPATCHES] ?? [])].flatMap(ref => ref ? [ref] : []);
          return { ...descriptor.project(evidence, dispatch.port, policy), sourceDispatchRefs: origins.map(ref => ref.id),
            recordRedaction: (tool: string, count: number) => { const event = { event: 'tool_redaction' as const, tool, count }; if (options.log) options.log(event); else hostLogEvent(event); },
            recordReuse: () => { for (const origin of origins) dispatch.port.recordReuse?.(origin); } };
        } };
      });
    },
    observeAlarmOwner: (_session, _journalId, words, _at) => {
      if (/[\p{L}\p{N}]/u.test(words)) queueMicrotask(() => options.alarms?.ownerSpeech?.());
    },
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
      // W2B-R1: the configuration file is the single source of truth for connections, so a row whose id is
      // no longer an enabled entry there is retired: it contributes no id, grant or tool definition to a run.
      const configured = options.configuredConnectionIds?.();
      return tx.all('SELECT connection_id FROM tool_connections WHERE owner_id=? ORDER BY connection_id', [ownerId])
        .map(row => String(row['connection_id']))
        .filter(id => { try { return connection(tx, id).policy.enabled; } catch { return false; } })
        .filter(id => configured === undefined || configured.includes(id));
    },
  };
  ownerBindings.set(owner, { store, registry, ownerId });
  return owner;
}
