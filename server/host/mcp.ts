import { CONNECTOR_DESCRIPTORS, ConnectorCompositionError } from '../connectors/index.js';
import type { Store } from '../runtime/store.js';
import { McpRegistry, canonicalToolDigest } from '../adapters/mcp/registry.js';
import { assertToolsOwnerBinding, createToolsOwner, validatePolicy } from '../tools/index.js';
import type { ConnectionPolicy, ConnectionRestoreResult, LiveAuthority, ToolsOwner, ToolsOwnerOptions } from '../tools/types.js';
import { loadMcpConfiguration, loadMcpEndpoints, type McpEndpointEntry } from '../config/mcp.js';
import { fields, parseJson, readPrivate } from '../config/files.js';
import { join } from 'node:path';
import { createMcpAdapter, type McpTransportState } from '../adapters/mcp/adapter.js';
import { mongooseCredentialAtStart, mongooseFailureStage, mongooseReadOnly } from '../connectors/mongoose.js';
import { MongooseCredentialError, mongooseAccessToken, mongooseCredentialPresent, readMongooseOAuth } from './mongoose-auth.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { bindingDigestOf, isStdioEndpoint, type CallRequest, type McpPort, type ReadGrant, type ResultScope, type ToolDefinition } from '../adapters/mcp/port.js';
import { canonicalJSON, sha256 } from '../tools/canonical.js';
import { CONNECTOR_ENVELOPES } from '../connectors/index.js';
import { identityAction, identityProofMemo, proveIdentity, refusalCode, IDENTITY_TIMEOUT_MS, type IdentityErrorCode, type IdentityProof } from '../connectors/identity.js';

export interface McpConnectionBundle {
  state: 'applied' | 'unchanged' | 'refused' | 'pending';
  reason?: string;
  sha256?: string;
  restore(): Promise<ConnectionRestoreResult>;
}
const credentialReference = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const credentialLimit = 8 * 1024;
/** The deliberate per-endpoint read deadline; a hybrid archive search may exceed the five-second discovery default. */
const ENDPOINT_CALL_DEADLINE_MS = 30000;
/** Same byte rules as the Gemini key file: non-empty printable ASCII, bounded. */
function tokenValid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && /^[\x21-\x7e]+$/.test(value);
}
/** Whether a pasted schemaVersion 1 credential exists, answered without opening the connector. */
function pastedCredentialPresent(configDir: string, reference: string): boolean {
  try { readMcpCredential(configDir, reference); return true; } catch { return false; }
}
/**
 * Reads an operator-supplied MCP bearer token from `<configDir>/<reference>.json`: owner-only
 * 0600, no symlink, strict `{ schemaVersion: 1, token }`. The token is never logged and the
 * typed error carries only the reference.
 */
export function readMcpCredential(configDir: string, reference: string): string {
  if (typeof reference !== 'string' || !credentialReference.test(reference)) throw new Error('credential-invalid');
  try {
    const raw = parseJson(readPrivate(join(configDir, `${reference}.json`), credentialLimit));
    const record = fields(raw, ['schemaVersion', 'token'], 'invalid_secret');
    if (record['schemaVersion'] !== 1 || !tokenValid(record['token'])) throw new Error('invalid_secret');
    return record['token'];
  } catch { throw new Error(`credential ${reference} missing or invalid`); }
}
/** Startup library seam only: receives the existing migrated Store and its canonical owner/registry. */
export function composeMcpConnection(options: { store: Store; owner: ToolsOwner; registry: McpRegistry; configDir: string }): McpConnectionBundle {
  const { store, owner, registry } = options; const ownerId = store.assistantId;
  assertToolsOwnerBinding(owner, { store, ownerId, registry });
  const refused = (reason: string, state: 'refused' | 'pending' = 'refused'): McpConnectionBundle => ({ state, reason, restore: async () => ({ state: 'refused', reason }) });
  try {
    const selected = loadMcpConfiguration({ configDir: options.configDir, ownerId, dataDir: store.directory });
    const p = selected.intent.policy;
    if (!registry.matchesEndpoint(selected.endpoint)) return refused('endpoint-binding-mismatch');
    if (selected.locallyDisabled) { registry.disable(p.endpoint.id); registry.denyEgress(p.endpoint.id); return refused('local-disable-durable-revocation-pending', 'pending'); }
    if (p.enabled) selected.assertCurrentBinding();
    const applied = owner.applyConnectionIntent({ expectedPolicySha256: selected.intent.expectedPolicySha256, policy: p });
    if (!p.enabled) { registry.disable(p.endpoint.id); registry.denyEgress(p.endpoint.id); return { ...applied, restore: async () => ({ state: 'refused', reason: 'connection-disabled' }) }; }
    // Separate, explicit protected selection authorizes both operations; neither grants tools.
    registry.enable(p.endpoint.id); registry.allowEgress(p.endpoint.id);
    return { ...applied, restore: () => owner.restoreConnection(p.connectionId, selected.assertCurrentBinding) };
  } catch { return refused('configuration-or-intent-refused'); }
}

export type McpEndpointState = 'missing' | 'configured' | 'connecting' | 'connected' | 'error';
export interface McpEndpointReport { id: string; state: McpEndpointState; tools: number; lastHandshakeAt: string | null; error?: string; reasonCode?: 'identity_mismatch' | 'not_signed_in' | IdentityErrorCode; identity?: IdentityProof; configurationError?: 'unknown-class-missing' | 'unknown-class-invalid' | 'owner-approval-required' | 'ambiguous-legacy-policy'; exception?: { class: string; code: string } }
export interface McpRuntimeComposition {
  registry: McpRegistry;
  port: McpPort;
  owner: ToolsOwner;
  connectionIds(): string[];
  status(): { endpoints: (McpEndpointReport & { connector: string })[] };
  /** Idempotent first connector round. The supervised host writes the ready frame before this. */
  start(): Promise<void>;
  refresh(): Promise<void>;
  recover(): Promise<void>;
  close(): Promise<void>;
}
/** The local read candidate list per connector; the Mongoose classifier narrows it at discovery. */
const connectorEnvelopes: Readonly<Record<string, readonly string[]>> = CONNECTOR_ENVELOPES;
/** Connectors that classify one discovered tool themselves, instead of trusting a static name list. */
const readClassifiers: Readonly<Record<string, (tool: ToolDefinition) => boolean>> = { mongoose: mongooseReadOnly };
/**
 * A registry that also admits exactly one bounded identity probe per endpoint before any read
 * grant exists: the connector, its tool and its generation, never a model-facing tool. The
 * callable grant is published only after a successful proof (see settle below).
 */
class ProbeRegistry extends McpRegistry {
  private readonly probes = new Map<string, { tool: string; generation: number; schemaDigest: string; account: string; resource: string; tools: readonly ToolDefinition[] }>();
  grantProbe(id: string, probe: { tool: string; generation: number; schemaDigest: string; account: string; resource: string; tools: readonly ToolDefinition[] }): void { this.probes.set(id, probe); }
  clearProbe(id: string): void { this.probes.delete(id); }
  /** The private candidate grant: exactly the identity tool, never a model-facing tool. */
  override currentGrant(id: string): ReadGrant | undefined {
    const standing = super.currentGrant(id);
    if (standing) return standing;
    const probe = this.probes.get(id);
    return probe ? { endpointId: id, schemaDigest: probe.schemaDigest, generation: probe.generation, account: probe.account, resource: probe.resource, toolNames: [probe.tool], effect: 'read' } : undefined;
  }
  override visibleTools(id: string): readonly ToolDefinition[] {
    const standing = super.visibleTools(id);
    if (standing.length) return standing;
    const probe = this.probes.get(id);
    return probe ? probe.tools.filter(tool => tool.name === probe.tool) : [];
  }
  override authorize(request: CallRequest): ResultScope {
    try { return super.authorize(request); } catch (error) {
      const probe = this.probes.get(request.endpointId);
      if (!probe || probe.tool !== request.toolName || probe.generation !== request.generation || probe.account !== request.account || probe.resource !== request.resource) throw error;
      const config = this.endpoint(request.endpointId);
      if (isStdioEndpoint(config)) return { endpointId: config.id, transport: 'stdio', bindingDigest: bindingDigestOf(config), schemaDigest: probe.schemaDigest, toolName: request.toolName, generation: probe.generation, account: probe.account, resource: probe.resource };
      return { endpointId: config.id, url: config.url, schemaDigest: probe.schemaDigest, toolName: request.toolName, generation: probe.generation, account: probe.account, resource: probe.resource };
    }
  }
}
/** A registration-class rejection reduced to one closed token, never the thrown message. */
function registrationCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(message) ? message : 'registration-rejected';
}

/** The closed connect-time stages a connector_failure line may carry. */
export type ConnectStage = 'credential' | 'config' | 'spawn' | 'handshake' | 'first_call';

/** Bounded connect-time detail on a connector_failure line: closed tokens only, never free text. */
export interface ConnectorFailureDetail {
  reason?: string;
  exceptionCode?: string;
  endpointId?: string;
  /** Which connect pass this is: the first one, or the one bounded re-discovery. */
  attempt?: 'first-connect' | 'refresh';
}

/** Compose the inert MCP runtime once at startup: config, owner and registry only, no remote work. */
export async function composeMcpRuntime(options: {
  log?: ToolsOwnerOptions['log'];
  connectorLog?: (connector: string, stage: string, detail?: ConnectorFailureDetail) => void;
  identityLog?: (connector: string, proven: boolean, match: boolean | null) => void;
  store: Store; ownerId: string; configDir: string;
  lookupAuthority(runId: string, signal: AbortSignal): Promise<LiveAuthority | null>;
  now?: () => number;
  /** Test seam: override the endpoint read deadline; production uses {@link ENDPOINT_CALL_DEADLINE_MS}. */
  callDeadlineMs?: number;
  /** Hold connector initialization until `start()`; the supervised host writes the ready frame first. */
  deferConnectors?: boolean;
}): Promise<McpRuntimeComposition> {
  const { store, ownerId, configDir } = options; const now = options.now ?? Date.now;
  const registry = new ProbeRegistry();
  const selection = loadMcpEndpoints({ configDir });
  const expectedIdentities = selection.state === 'configured'
    ? [selection.catalog.ownerIdentity, selection.catalog.ownerChatUsername].filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  // One rule: every configured read connector gets the longer call deadline, so a real hybrid
  // archive search cannot hit the five-second default. Connect and discovery stay on budgets.timeoutMs.
  const callDeadlineMs = options.callDeadlineMs ?? ENDPOINT_CALL_DEADLINE_MS;
  const callTimeoutMsByEndpoint = new Map(selection.state === 'configured'
    ? selection.catalog.endpoints.map(entry => [entry.id, callDeadlineMs] as const) : []);
  // One credential seam for both shapes: a schemaVersion 1 pasted bearer, or the schemaVersion 2
  // OAuth record this host owns and refreshes lazily. A v2 record is never read as a bearer token.
  const credentialOwners = new Map(selection.state === 'configured'
    ? selection.catalog.endpoints.filter(entry => entry.credentialRef).map(entry => [entry.credentialRef!, entry] as const) : []);
  const resolveCredential = async (reference: string): Promise<string> => {
    if (!readMongooseOAuth(configDir, reference)) return readMcpCredential(configDir, reference);
    const owner = credentialOwners.get(reference);
    try {
      return await mongooseAccessToken(configDir, reference, {
        now,
        // #502: a refused refresh is spoken once, by the endpoint's own typed connector_failure line
        // (credential-refresh-failed), never twice through this notice as well. A consent notice has no
        // such line, so it still speaks here.
        notify: reason => { if (owner && reason === 'consent-expiring') options.connectorLog?.(owner.connector, 'credential', { reason, endpointId: owner.id }); },
      });
    } catch (error) {
      // #502: a typed credential refusal keeps its closed code, so the endpoint report and the one
      // connector_failure line name the real cause (a refused refresh is a sign-in again, never an
      // unknown transport failure). Only an untyped failure gets the generic owner text below.
      if (error instanceof MongooseCredentialError) throw error;
      // One owner line: the browser surfaces this exact text as the credential status and renders the
      // "reconnect Mongoose" next step. The closed refresh code stayed in the connector log above.
      throw Error(`credential ${reference} missing or invalid`);
    }
  };
  const port = createMcpAdapter({ registry, store: new MemoryResultStore(), callTimeoutMsByEndpoint, resolveCredential, onTransportState: event => transportState(event) });
  const reports = new Map<string, McpEndpointReport>();
  const connectors = new Map<string, string>();
  const ready = new Set<string>();
  const generations = new Map<string, number>();
  // The per-tool digest of each endpoint's readable names as of its last approved round.
  const approvedSchemas = new Map<string, Map<string, string>>();
  let closed = false;
  // W9: exactly one closed connector_failure line per endpoint that did not connect at host start,
  // whatever the reason. Stage and reason are closed tokens, so no message, url or credential value
  // can ride out, and a retried or repeated pass never doubles the line.
  const failuresReported = new Set<string>();
  const reportFailure = (entry: McpEndpointEntry, stage: ConnectStage, attempt: 'first-connect' | 'refresh',
    reason: string, exceptionCode?: string): void => {
    if (attempt !== 'first-connect' || failuresReported.has(entry.id)) return;
    failuresReported.add(entry.id);
    options.connectorLog?.(entry.connector, stage, { reason, endpointId: entry.id, attempt, ...(exceptionCode ? { exceptionCode } : {}) });
  };
  const reportToolStatus = (connectionId: string, status: { state: 'configured'; reason: string } | null): void => {
    const previous = reports.get(connectionId);
    if (!previous) return;
    reports.set(connectionId, status === null
      ? { id: previous.id, state: 'connected', tools: previous.tools, lastHandshakeAt: previous.lastHandshakeAt }
      : { id: previous.id, state: 'configured', tools: previous.tools, lastHandshakeAt: previous.lastHandshakeAt, error: status.reason });
  };
  const owner = createToolsOwner({ grantMode: selection.state === 'missing' ? 'explicit' : selection.catalog.grantMode, store, ownerId, registry, port, lookupAuthority: options.lookupAuthority, reportToolStatus, ...(options.log ? { log: options.log } : {}) });
  const sourcePort = owner.sourcePort;
  if (selection.state === 'missing') {
    const empty: McpRuntimeComposition = { registry, port: sourcePort, owner, connectionIds: () => [], status: () => ({ endpoints: [] }), start: async () => {}, refresh: async () => {}, recover: async () => {}, close: () => port.close() };
    return empty;
  }
  const { grantMode, endpoints } = selection.catalog;
  const trusted = grantMode === 'owner-trusted-reads';
  // Reject local capability mismatches before any transport starts, including disabled entries.
  const rejected = new Set<string>();
  for (const entry of endpoints) {
    if (!Object.hasOwn(CONNECTOR_DESCRIPTORS, entry.connector)) throw new ConnectorCompositionError('unknown_connector', entry.id, entry.connector);
    if (entry.enabled) {
      try {
        if (entry.transport === 'stdio') {
          registry.register({ id: entry.id, transport: 'stdio', command: entry.command, args: [...entry.args], env: { ...entry.env }, account: entry.account, resource: entry.resource });
        } else {
          registry.register({ id: entry.id, url: entry.url, account: entry.account, resource: entry.resource, ...(entry.credentialRef ? { credentialRef: entry.credentialRef } : {}) });
        }
        registry.enable(entry.id);
        if (entry.allowEgress) registry.allowEgress(entry.id);
      } catch (error) {
        // W9-B2: a registration-class rejection (a moved helper, an unapproved env) never admits the
        // endpoint, so nothing can settle it. It is still reported and still says why, and the rest of
        // the composition continues: one bad endpoint must never take every source down with it.
        const code = registrationCode(error);
        rejected.add(entry.id);
        reportFailure(entry, 'config', 'first-connect', code);
        reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: null, error: code, exception: { class: 'Registration', code } });
        connectors.set(entry.id, entry.connector);
        continue;
      }
    }
    reports.set(entry.id, { id: entry.id, state: 'connecting', tools: 0, lastHandshakeAt: null });
    connectors.set(entry.id, entry.connector);
  }
  const active = endpoints.filter(entry => entry.enabled && entry.allowEgress && !rejected.has(entry.id));

  const eligible = new Map<string, { session: number; revision: number }>();
  // Endpoints parked at `not_signed_in`: a login writes the credential, and the next recover()
  // connects them, so the owner never restarts the host to finish a sign-in (R9).
  const needsSignIn = new Set<string>();
  const bursts = new Map<string, { session: number; token: number | undefined }>();
  const flights = new Map<string, Promise<void>>();
  const recoverEndpoint = (id: string): Promise<void> => {
    const running = flights.get(id); if (running) return running;
    const candidate = eligible.get(id);
    const entry = active.find(endpoint => endpoint.id === id);
    if (closed || !candidate || !entry || registry.revision(id) !== candidate.revision) return Promise.resolve();
    const token = generations.get(id);
    let firstCheck = true;
    const assertBinding = (): void => {
      if (closed || generations.get(id) !== token || eligible.get(id) !== candidate
          || registry.revision(id) !== candidate.revision + (firstCheck ? 0 : 1)) throw Error('recovery-invalidated');
      const current = loadMcpEndpoints({ configDir });
      if (current.state !== 'configured' || selection.state !== 'configured' || canonicalJSON(current.catalog) !== canonicalJSON(selection.catalog)) throw Error('endpoint-selection-changed');
      firstCheck = false;
    };
    const previous = reports.get(id)!;
    reports.set(id, { ...previous, state: 'connecting', tools: 0, error: 'transport_unavailable' });
    const flight = (async (): Promise<void> => {
      const restored = await owner.restoreConnection(id, assertBinding);
      if (closed || generations.get(id) !== token || eligible.get(id) !== candidate) return;
      if (restored.state === 'restored') {
        try { assertBinding(); } catch {
          registry.suspend(id); eligible.delete(id); ready.delete(id);
          reports.set(id, { ...previous, state: 'error', tools: 0, error: 'recovery-invalidated' });
          return;
        }
        const grant = registry.currentGrant(id);
        if (!grant) { eligible.delete(id); reports.set(id, { ...previous, state: 'error', tools: 0, error: 'recovery-invalidated' }); return; }
        eligible.delete(id); ready.add(id);
        const { error: _error, exception: _exception, ...report } = previous;
        reports.set(id, { ...report, state: 'connected', tools: grant.toolNames.length, lastHandshakeAt: new Date(now()).toISOString() });
      } else {
        ready.delete(id);
        const reason = restored.state === 'refused' ? restored.reason : 'transport_unavailable';
        reports.set(id, { ...previous, state: 'error', tools: 0, error: reason,
          ...(reason === 'catalog-changed' ? { configurationError: 'owner-approval-required' as const } : {}) });
        if (restored.state === 'unavailable') candidate.revision = registry.revision(id);
        else eligible.delete(id);
      }
    })().finally(() => { if (flights.get(id) === flight) flights.delete(id); });
    flights.set(id, flight);
    return flight;
  };
  const transportState = (event: McpTransportState): void => {
    if (closed || !reports.has(event.endpointId)) return;
    const id = event.endpointId;
    if (event.state === 'unavailable') {
      eligible.delete(id); ready.delete(id);
      bursts.set(id, { session: event.session, token: generations.get(id) });
      const previous = reports.get(id)!;
      reports.set(id, { ...previous, state: 'error', tools: 0, error: event.reason,
        exception: { class: 'Transport', code: event.reason } });
    } else if (event.recoverable && registry.revision(id) === event.revision
        && bursts.get(id)?.session === event.session && bursts.get(id)?.token === generations.get(id)) {
      eligible.set(id, { session: event.session, revision: event.revision });
      void recoverEndpoint(id);
    }
  };

  // One proof per endpoint per connect round: an in-flight probe is shared, a settled one is not, so a
  // refresh verifies the account again instead of inheriting the boot-time proof.
  const settle = async (entry: McpEndpointEntry, token: number, attempt: 'first-connect' | 'refresh', identityOnce: ReturnType<typeof identityProofMemo>): Promise<{ retryable: boolean }> => {
    const previous = reports.get(entry.id);
    ready.delete(entry.id);
    const stale = (): boolean => closed || generations.get(entry.id) !== token;
    if (entry.configurationError || entry.unknownClass === null) {
      const code = entry.configurationError ?? 'unknown-class-missing';
      reportFailure(entry, 'config', attempt, code);
      reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: code, configurationError: code }); return { retryable: false };
    }
    // A missing or malformed credential is a visible, typed status; discovery never runs with a blank bearer.
    // A schemaVersion 2 OAuth record counts as present on its refresh token alone: no refresh happens here.
    if (entry.credentialRef) {
      const stored = mongooseCredentialPresent(configDir, entry.credentialRef) || pastedCredentialPresent(configDir, entry.credentialRef);
      // H19: a mongoose endpoint with no stored credential is not signed in yet. Nothing is opened and
      // no failing probe is logged at every launch: one typed status, and the next connect after a
      // login (the app refreshes the connector then) probes it for real.
      if (mongooseCredentialAtStart(entry.connector, stored) === 'not_signed_in') {
        needsSignIn.add(entry.id);
        reportFailure(entry, 'credential', attempt, 'not_signed_in');
        reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: 'not_signed_in', reasonCode: 'not_signed_in' });
        return { retryable: false };
      }
      needsSignIn.delete(entry.id);
      try { if (!stored) readMcpCredential(configDir, entry.credentialRef); }
      catch { reportFailure(entry, 'credential', attempt, 'credential-unavailable'); reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: `credential ${entry.credentialRef} missing or invalid` }); return { retryable: false }; }
    }
    try {
      const discovery = await port.discover(entry.id);
      if (stale()) return { retryable: false };
      if (discovery.state !== 'discovered') {
        const stage = mongooseFailureStage(discovery.reason, discovery.exception?.code);
        reportFailure(entry, stage, attempt, discovery.reason, discovery.exception?.code);
        reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: discovery.reason, ...(discovery.exception ? { exception: discovery.exception } : {}) });
        // Outcome 4: only a first_call discovery failure is worth one bounded re-discovery; a
        // credential or configuration error is stable and a later refresh still reconnects it.
        return { retryable: stage === 'first_call' };
      }
      const envelope = connectorEnvelopes[entry.connector] ?? [];
      const accepts = readClassifiers[entry.connector] ?? (() => true);
      const names = grantMode === 'owner-trusted-reads'
        ? discovery.tools.filter(tool => envelope.includes(tool.name) && accepts(tool)).map(tool => tool.name).sort()
        : [];
      // Healthy discovery without an approved envelope is status-only, not an empty owner policy.
      if (!names.length) {
        reports.set(entry.id, { id: entry.id, state: 'connected', tools: 0, lastHandshakeAt: new Date(discovery.observedAt).toISOString() });
        return { retryable: false };
      }
      // Reconcile through the owner projection; the durable row is authoritative over local config.
      const schemas = new Map(discovery.tools.map(tool => [tool.name, canonicalToolDigest([tool])] as const));
      const row = store.transaction(tx => tx.get('SELECT policy_json,policy_sha256,generation FROM tool_connections WHERE owner_id=? AND connection_id=?', [ownerId, entry.id]));
      const policy: ConnectionPolicy = {
        schemaVersion: 1, bindingMode: 'connection', ownerId, connectionId: entry.id, generation: row ? Number(row.generation) : 1,
        enabled: true, connector: entry.connector,
        endpoint: entry.transport === 'stdio'
          ? { id: entry.id, transport: 'stdio', command: entry.command, args: [...entry.args], env: { ...entry.env }, account: entry.account, resource: entry.resource, credentialRef: null }
          : { id: entry.id, url: entry.url, account: entry.account, resource: entry.resource, credentialRef: entry.credentialRef },
        toolNames: names, schemaDigest: discovery.schemaDigest,
        sourcePolicy: { id: entry.id, revision: 1, unknownClass: entry.unknownClass, allowedClasses: [entry.unknownClass] },
        route: { identity: entry.id, allowedClasses: [entry.unknownClass] },
        bounds: { maxQueryChars: 16384, maxSearchLimit: 100, maxGetIds: 100, maxEntityBytes: 1048576, maxResultBytes: 1048576 },
      };
      if (row) {
        const bytes = String(row.policy_json);
        if (sha256(bytes) !== row.policy_sha256) throw Error('connection_policy_binding');
        // W9: the durable row approves a connector envelope, and a release may rename that envelope's
        // read tools (ab755604 renamed every Google read). A row that no longer validates is a catalog
        // change, never a fatal settle. Under owner-trusted-reads the owner already granted the
        // reviewed envelope, so the row is reconciled from this discovery; a stored revocation still
        // wins, and explicit mode keeps its owner-approval refusal.
        let stored: ConnectionPolicy | null = null;
        let sameEndpoint = false;
        let enabledInRow = false;
        try {
          const parsed = JSON.parse(bytes) as { enabled?: unknown; endpoint?: { id?: unknown; account?: unknown; resource?: unknown } };
          sameEndpoint = parsed.endpoint?.id === policy.endpoint.id
            && parsed.endpoint?.account === policy.endpoint.account
            && parsed.endpoint?.resource === policy.endpoint.resource;
          enabledInRow = parsed.enabled !== false;
          stored = validatePolicy(parsed as unknown as ConnectionPolicy);
        } catch { stored = null; }
        // Only the same endpoint's own approval may be reconciled, and never a revoked one: a tampered,
        // foreign or revoked row keeps the owner-approval refusal.
        if (!stored && (!trusted || !sameEndpoint || !enabledInRow)) {
          reportFailure(entry, 'handshake', attempt, 'owner-approval-required');
          reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: 'owner-approval-required', configurationError: 'owner-approval-required' }); return { retryable: false };
        }
        if (stored) {
        if (stored.ownerId !== ownerId || stored.connectionId !== entry.id || stored.generation !== Number(row.generation)) throw Error('connection_policy_binding');
        const legacy = stored.bindingMode === undefined;
        if (legacy && stored.route.identity !== stored.endpoint.id) {
          reportFailure(entry, 'handshake', attempt, 'ambiguous-legacy-policy');
          reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: 'ambiguous-legacy-policy', configurationError: 'ambiguous-legacy-policy' }); return { retryable: false };
        }
        const rank = { ordinary: 0, private: 1, sensitive: 2 };
        const oldClass = stored.sourcePolicy.unknownClass;
        const widened = names.some(name => !stored.toolNames.includes(name));
        const previousSchemas = approvedSchemas.get(entry.id);
        const readableChanged = previousSchemas !== undefined && names.some(name => previousSchemas.get(name) !== schemas.get(name));
        // Only an explicit approval mode needs a fresh owner approval for any catalog change: under
        // owner-trusted-reads the reviewed envelope is the approval, so only a change to the contract of
        // a name that envelope already makes readable needs the owner again.
        if (canonicalJSON(stored.endpoint) !== canonicalJSON(policy.endpoint) || widened || (oldClass !== null && rank[entry.unknownClass] < rank[oldClass]) || (trusted ? readableChanged : stored.schemaDigest !== policy.schemaDigest)) {
          reportFailure(entry, 'handshake', attempt, 'owner-approval-required');
          reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: 'owner-approval-required', configurationError: 'owner-approval-required' }); return { retryable: false };
        }
        // Persisted approval fields are authoritative. A restart cannot re-enable a revocation.
        policy.enabled = stored.enabled; policy.bounds = stored.bounds;
        policy.sourcePolicy = { ...stored.sourcePolicy, unknownClass: entry.unknownClass };
        policy.route = stored.route;
        if (oldClass !== entry.unknownClass) {
          // Null legacy classifications were never executable approvals. Explicit local config
          // supplies the initial bounded class; later changes may only tighten without approval.
          const replaceClass = (set: typeof stored.sourcePolicy.allowedClasses) => oldClass === null ? [entry.unknownClass!] : [...new Set(set.map(c => c === oldClass ? entry.unknownClass! : c))];
          policy.sourcePolicy.allowedClasses = replaceClass(stored.sourcePolicy.allowedClasses);
          policy.sourcePolicy.revision += 1;
          policy.route = { ...stored.route, allowedClasses: replaceClass(stored.route.allowedClasses) };
        }
        }
        if (!stored || canonicalJSON(policy) !== bytes) { policy.generation += 1; owner.applyConnectionIntent({ expectedPolicySha256: String(row.policy_sha256), policy }); }
      } else owner.applyConnectionIntent({ expectedPolicySha256: null, policy });
      approvedSchemas.set(entry.id, schemas);
      // Identity proof before any read grant. A failed proof never falls back to publication.
      const descriptor = CONNECTOR_DESCRIPTORS[entry.connector];
      const identitySource = descriptor?.identity?.(policy) ?? null;
      let identity: IdentityProof | undefined;
      // A strict source probes even when no owner identity is configured: Google's helper pins its own
      // account, so the no-comparison policy must not publish an unverified read (lux-didi #495).
      if (identitySource && descriptor && (expectedIdentities.length > 0 || identitySource.strict === true)) {
        registry.grantProbe(entry.id, { tool: identitySource.tool, generation: policy.generation, schemaDigest: policy.schemaDigest, account: policy.endpoint.account, resource: policy.endpoint.resource, tools: discovery.tools });
        try {
          const reader = descriptor.createReader({ port: sourcePort, registry, endpoint: policy.endpoint, schemaDigest: policy.schemaDigest, generation: policy.generation, policy });
          // The proof is one read call, so it is bounded by the endpoint's own call deadline (30 s for a
          // configured read connector), never a shorter fixed bound. A healthy connector whose first
          // identity call is slow under host load is proven rather than wrongly marked unproven and
          // fail-closed; a connector that never answers still times out at the call deadline and stays
          // uncallable.
          // H19 with D2's strict per-endpoint source: a proof belongs to one endpoint of one account.
          // Sharing it across a mailbox and a calendar of one account made the second endpoint inherit
          // a proof of the other family's tool, so a strict source refused it (or raced the first
          // endpoint's proof). One proof per endpoint per round lives in settle's caller.
          const proofKey = `${entry.id}\u0000${policy.endpoint.account ?? ''}`;
          identity = await identityOnce(proofKey, async () => {
            const proof = await proveIdentity({ source: identitySource, expected: expectedIdentities, timeoutMs: callTimeoutMsByEndpoint.get(entry.id) ?? IDENTITY_TIMEOUT_MS, call: (tool, args) => reader.call(tool, args) });
            // The receipt belongs to the read that happened, so a reused proof writes no second line.
            options.identityLog?.(entry.connector, proof.proven, proof.match);
            return proof;
          });
        } finally { registry.clearProbe(entry.id); }
        if (stale()) return { retryable: false };
        if (identityAction(identity, identitySource.strict === true) === 'refuse') {
          // A strict source refuses an unproven identity too. The reason code is a closed helper code,
          // so the reply names the source without ever carrying the account or a token path.
          const code = refusalCode(identity);
          reportFailure(entry, 'handshake', attempt, code);
          reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: code === 'identity_mismatch' ? 'identity-mismatch' : 'identity-unproven', reasonCode: code, identity });
          return { retryable: false };
        }
        if (!identity.proven) {
          reportFailure(entry, 'handshake', attempt, 'identity_unverified');
          reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: 'identity-unproven', identity });
          return { retryable: false };
        }
      } else if (identitySource && expectedIdentities.length === 0) {
        // No owner identity configured and a non-strict source: the explicit no-comparison policy.
        options.identityLog?.(entry.connector, true, null);
      }
      if (stale()) return { retryable: false };
      // Publish synchronously: re-read the durable policy, re-check liveness, then swap the
      // callable grant, all inside one synchronous transaction with no await between the check
      // and the registry swap. A superseded generation can never commit a grant.
      const published = store.transaction(tx => {
        const row = tx.get('SELECT policy_json,policy_sha256 FROM tool_connections WHERE owner_id=? AND connection_id=?', [ownerId, entry.id]);
        if (!row) return false;
        const bytes = String(row.policy_json);
        if (sha256(bytes) !== row.policy_sha256) return false;
        const stored = validatePolicy(JSON.parse(bytes) as ConnectionPolicy);
        if (!stored.enabled || stored.generation !== policy.generation || stored.schemaDigest !== policy.schemaDigest || canonicalJSON(stored.toolNames) !== canonicalJSON(policy.toolNames)) return false;
        if (stale()) return false;
        // Re-establish the already-discovered candidate tools with no remote call, then swap.
        registry.observed(entry.id, discovery.tools, registry.revision(entry.id));
        registry.restore({ endpointId: stored.endpoint.id, schemaDigest: stored.schemaDigest, generation: stored.generation, account: stored.endpoint.account, resource: stored.endpoint.resource, toolNames: stored.toolNames, effect: 'read' });
        return true;
      });
      if (!published) {
        reportFailure(entry, 'handshake', attempt, stale() ? 'generation-superseded' : 'connection-policy-changed');
        reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: stale() ? 'generation-superseded' : 'connection-policy-changed' }); return { retryable: false };
      }
      ready.add(entry.id);
      reports.set(entry.id, { id: entry.id, state: 'connected', tools: names.length, lastHandshakeAt: new Date(now()).toISOString(), ...(identity ? { identity } : {}) });
      return { retryable: false };
    } catch (error) {
      if (stale()) return { retryable: false };
      const localCodes = ['invalid_policy_shape', 'invalid_policy_version', 'invalid_policy_text', 'invalid_positive_integer', 'invalid_read_tools', 'invalid_unknown_class', 'invalid_data_classes', 'connection_owner_mismatch', 'connection_predecessor_mismatch', 'connection_identity_or_generation', 'connection_policy_missing_or_corrupt', 'projection_endpoint_mismatch', 'invalid-local-read-grant'];
      const exception = {
        class: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.constructor.name) ? error.constructor.name : 'Unknown',
        code: error instanceof Error && error.constructor === Error && localCodes.includes(error.message) ? error.message : 'unknown',
      };
      reportFailure(entry, mongooseFailureStage(exception.code ?? 'unavailable'), attempt, exception.code ?? 'unavailable');
      reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: 'discovery-unavailable', exception });
      return { retryable: false };
    }
  };

  let startPromise: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    if (closed) return;
    const identityOnce = identityProofMemo();
    await Promise.all(active.map(async entry => {
      eligible.delete(entry.id); bursts.delete(entry.id);
      const token = (generations.get(entry.id) ?? 0) + 1;
      generations.set(entry.id, token);
      // Any generation bump revokes the superseded grant before a replacement can publish, so an
      // already-admitted session snapshot cannot dispatch through the old generation.
      registry.suspend(entry.id);
      // The startup path makes one connect pass only. A first_call failure is reported and left for
      // a background retry; it must never double the five-second startup bound.
      await settle(entry, token, 'first-connect', identityOnce).catch(() => { /* the per-connector report already carries the failure */ });
    }));
  };
  const composition: McpRuntimeComposition = {
    registry, port: sourcePort, owner,
    // Live calls this inside its acceptance transaction: do not open a nested store transaction.
    // Only a connector whose current generation is published and ready is callable.
    connectionIds: () => active.filter(entry => ready.has(entry.id) && reports.get(entry.id)?.state === 'connected' && !!registry.currentGrant(entry.id)).map(entry => entry.id),
    status: () => ({ endpoints: [...reports.values()].map(report => ({ ...report,
      ...(report.state === 'connected' && report.tools > 0 && !registry.currentGrant(report.id) ? { state: 'error' as const, tools: 0, error: 'connector-unavailable' } : {}),
      connector: connectors.get(report.id) ?? report.id })) }),
    start: () => (startPromise ??= run()),
    refresh: async () => { startPromise = undefined; await run(); },
    recover: async () => {
      // A sign-in that landed since the last settle reconnects here: the parked endpoint is settled
      // again with a new generation, exactly as a first connect would (R9).
      const identityOnce = identityProofMemo();
      await Promise.all([...needsSignIn].map(async id => {
        const entry = active.find(candidate => candidate.id === id);
        if (closed || entry === undefined || entry.credentialRef == null) return;
        const stored = mongooseCredentialPresent(configDir, entry.credentialRef) || pastedCredentialPresent(configDir, entry.credentialRef);
        if (!stored) return;
        needsSignIn.delete(id);
        const token = (generations.get(id) ?? 0) + 1;
        generations.set(id, token);
        registry.suspend(id);
        await settle(entry, token, 'refresh', identityOnce).catch(() => { /* the per-connector report already carries the failure */ });
      }));
      await Promise.all([...eligible.keys()].map(recoverEndpoint));
    },
    close: () => { closed = true; for (const entry of active) { generations.set(entry.id, (generations.get(entry.id) ?? 0) + 1); registry.suspend(entry.id); } eligible.clear(); bursts.clear(); const closing = port.close(); return Promise.all([closing, ...flights.values()]).then(() => {}); },
  };
  if (options.deferConnectors !== true) await composition.start();
  return composition;
}
