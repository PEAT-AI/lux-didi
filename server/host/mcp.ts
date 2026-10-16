import { CONNECTOR_DESCRIPTORS, ConnectorCompositionError } from '../connectors/index.js';
import type { Store } from '../runtime/store.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { assertToolsOwnerBinding, createToolsOwner, validatePolicy } from '../tools/index.js';
import type { ConnectionPolicy, ConnectionRestoreResult, LiveAuthority, ToolsOwner, ToolsOwnerOptions } from '../tools/types.js';
import { loadMcpConfiguration, loadMcpEndpoints, type McpEndpointEntry } from '../config/mcp.js';
import { fields, parseJson, readPrivate } from '../config/files.js';
import { join } from 'node:path';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { mongooseFailureStage } from '../connectors/mongoose.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { bindingDigestOf, isStdioEndpoint, type CallRequest, type McpPort, type ResultScope } from '../adapters/mcp/port.js';
import { canonicalJSON, sha256 } from '../tools/canonical.js';
import { CONNECTOR_ENVELOPES } from '../connectors/index.js';
import { identityAction, proveIdentity, type IdentityProof } from '../connectors/identity.js';

export interface McpConnectionBundle {
  state: 'applied' | 'unchanged' | 'refused' | 'pending';
  reason?: string;
  sha256?: string;
  restore(): Promise<ConnectionRestoreResult>;
}
const credentialReference = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const credentialLimit = 8 * 1024;
/** Same byte rules as the Gemini key file: non-empty printable ASCII, bounded. */
function tokenValid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && /^[\x21-\x7e]+$/.test(value);
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
export interface McpEndpointReport { id: string; state: McpEndpointState; tools: number; lastHandshakeAt: string | null; error?: string; reasonCode?: 'identity_mismatch'; identity?: IdentityProof; configurationError?: 'unknown-class-missing' | 'unknown-class-invalid' | 'owner-approval-required' | 'ambiguous-legacy-policy'; exception?: { class: string; code: string } }
export interface McpRuntimeComposition {
  registry: McpRegistry;
  port: McpPort;
  owner: ToolsOwner;
  connectionIds(): string[];
  status(): { endpoints: (McpEndpointReport & { connector: string })[] };
  /** Idempotent first connector round. The supervised host writes the ready frame before this. */
  start(): Promise<void>;
  refresh(): Promise<void>;
  close(): Promise<void>;
}
/** The local read envelope is the Didi connector's own classification, never the remote readOnlyHint. */
const connectorEnvelopes: Readonly<Record<string, readonly string[]>> = CONNECTOR_ENVELOPES;
/**
 * A registry that also admits exactly one bounded identity probe per endpoint before any read
 * grant exists: the connector, its tool and its generation, never a model-facing tool. The
 * callable grant is published only after a successful proof (see settle below).
 */
class ProbeRegistry extends McpRegistry {
  private readonly probes = new Map<string, { tool: string; generation: number; schemaDigest: string; account: string; resource: string }>();
  grantProbe(id: string, probe: { tool: string; generation: number; schemaDigest: string; account: string; resource: string }): void { this.probes.set(id, probe); }
  clearProbe(id: string): void { this.probes.delete(id); }
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
/** Compose the inert MCP runtime once at startup: config, owner and registry only, no remote work. */
export async function composeMcpRuntime(options: {
  log?: ToolsOwnerOptions['log'];
  connectorLog?: (connector: string, stage: string) => void;
  identityLog?: (connector: string, proven: boolean, match: boolean | null) => void;
  store: Store; ownerId: string; configDir: string;
  lookupAuthority(runId: string, signal: AbortSignal): Promise<LiveAuthority | null>;
  now?: () => number;
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
  const callTimeoutMsByEndpoint = new Map(selection.state === 'configured'
    ? selection.catalog.endpoints.map(entry => [entry.id, 30000] as const) : []);
  const port = createMcpAdapter({ registry, store: new MemoryResultStore(), callTimeoutMsByEndpoint, resolveCredential: async reference => readMcpCredential(configDir, reference) });
  const reports = new Map<string, McpEndpointReport>();
  const connectors = new Map<string, string>();
  const ready = new Set<string>();
  const generations = new Map<string, number>();
  let closed = false;
  const reportToolStatus = (connectionId: string, status: { state: 'configured'; reason: string } | null): void => {
    const previous = reports.get(connectionId);
    if (!previous) return;
    reports.set(connectionId, status === null
      ? { id: previous.id, state: 'connected', tools: previous.tools, lastHandshakeAt: previous.lastHandshakeAt }
      : { id: previous.id, state: 'configured', tools: previous.tools, lastHandshakeAt: previous.lastHandshakeAt, error: status.reason });
  };
  const owner = createToolsOwner({ grantMode: selection.state === 'missing' ? 'explicit' : selection.catalog.grantMode, store, ownerId, registry, port, lookupAuthority: options.lookupAuthority, reportToolStatus, ...(options.log ? { log: options.log } : {}) });
  if (selection.state === 'missing') {
    const empty: McpRuntimeComposition = { registry, port, owner, connectionIds: () => [], status: () => ({ endpoints: [] }), start: async () => {}, refresh: async () => {}, close: () => port.close() };
    return empty;
  }
  const { grantMode, endpoints } = selection.catalog;
  // Reject local capability mismatches before any transport starts, including disabled entries.
  for (const entry of endpoints) {
    if (!Object.hasOwn(CONNECTOR_DESCRIPTORS, entry.connector)) throw new ConnectorCompositionError('unknown_connector', entry.id, entry.connector);
    if (entry.enabled) {
      if (entry.transport === 'stdio') {
        registry.register({ id: entry.id, transport: 'stdio', command: entry.command, args: [...entry.args], env: { ...entry.env }, account: entry.account, resource: entry.resource });
      } else {
        registry.register({ id: entry.id, url: entry.url, account: entry.account, resource: entry.resource, ...(entry.credentialRef ? { credentialRef: entry.credentialRef } : {}) });
      }
      registry.enable(entry.id);
      if (entry.allowEgress) registry.allowEgress(entry.id);
    }
    reports.set(entry.id, { id: entry.id, state: 'connecting', tools: 0, lastHandshakeAt: null });
    connectors.set(entry.id, entry.connector);
  }
  const active = endpoints.filter(entry => entry.enabled && entry.allowEgress);

  const settle = async (entry: McpEndpointEntry, token: number): Promise<void> => {
    const previous = reports.get(entry.id);
    ready.delete(entry.id);
    const stale = (): boolean => closed || generations.get(entry.id) !== token;
    if (entry.configurationError || entry.unknownClass === null) {
      const code = entry.configurationError ?? 'unknown-class-missing';
      reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: code, configurationError: code }); return;
    }
    // A missing or malformed credential is a visible, typed status; discovery never runs with a blank bearer.
    if (entry.credentialRef) {
      try { readMcpCredential(configDir, entry.credentialRef); }
      catch { options.connectorLog?.(entry.connector, 'credential'); reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: 'credential-missing' }); return; }
    }
    try {
      const discovery = await port.discover(entry.id);
      if (stale()) return;
      if (discovery.state !== 'discovered') { options.connectorLog?.(entry.connector, mongooseFailureStage(discovery.reason, discovery.exception?.code)); reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: discovery.reason, ...(discovery.exception ? { exception: discovery.exception } : {}) }); return; }
      const envelope = connectorEnvelopes[entry.connector] ?? [];
      const names = grantMode === 'owner-trusted-reads'
        ? discovery.tools.map(tool => tool.name).filter(name => envelope.includes(name)).sort()
        : [];
      // Healthy discovery without an approved envelope is status-only, not an empty owner policy.
      if (!names.length) {
        reports.set(entry.id, { id: entry.id, state: 'connected', tools: 0, lastHandshakeAt: new Date(discovery.observedAt).toISOString() });
        return;
      }
      // Reconcile through the owner projection; the durable row is authoritative over local config.
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
        const stored = validatePolicy(JSON.parse(bytes) as ConnectionPolicy);
        if (stored.ownerId !== ownerId || stored.connectionId !== entry.id || stored.generation !== Number(row.generation)) throw Error('connection_policy_binding');
        const legacy = stored.bindingMode === undefined;
        if (legacy && stored.route.identity !== stored.endpoint.id) {
          reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: 'ambiguous-legacy-policy', configurationError: 'ambiguous-legacy-policy' }); return;
        }
        const rank = { ordinary: 0, private: 1, sensitive: 2 };
        const oldClass = stored.sourcePolicy.unknownClass;
        const widened = names.some(name => !stored.toolNames.includes(name));
        if (canonicalJSON(stored.endpoint) !== canonicalJSON(policy.endpoint) || widened || (oldClass !== null && rank[entry.unknownClass] < rank[oldClass])) {
          reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: 'owner-approval-required', configurationError: 'owner-approval-required' }); return;
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
        if (canonicalJSON(policy) !== bytes) { policy.generation += 1; owner.applyConnectionIntent({ expectedPolicySha256: String(row.policy_sha256), policy }); }
      } else owner.applyConnectionIntent({ expectedPolicySha256: null, policy });
      // Identity proof before any read grant. A failed proof never falls back to publication.
      const descriptor = CONNECTOR_DESCRIPTORS[entry.connector];
      const identitySource = descriptor?.identity?.(policy) ?? null;
      let identity: IdentityProof | undefined;
      if (identitySource && descriptor && expectedIdentities.length) {
        registry.grantProbe(entry.id, { tool: identitySource.tool, generation: policy.generation, schemaDigest: policy.schemaDigest, account: policy.endpoint.account, resource: policy.endpoint.resource });
        try {
          const reader = descriptor.createReader({ port, registry, endpoint: policy.endpoint, schemaDigest: policy.schemaDigest, generation: policy.generation, policy });
          identity = await proveIdentity({ source: identitySource, expected: expectedIdentities, call: (tool, args) => reader.call(tool, args) });
        } finally { registry.clearProbe(entry.id); }
        if (stale()) return;
        options.identityLog?.(entry.connector, identity.proven, identity.match);
        if (identityAction(identity) === 'refuse') {
          reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: 'identity-mismatch', reasonCode: 'identity_mismatch', identity });
          return;
        }
        if (!identity.proven) {
          reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: 'identity-unproven', identity });
          return;
        }
      } else if (identitySource && expectedIdentities.length === 0) {
        // No owner identity configured: the explicit no-comparison policy, never a failed proof.
        options.identityLog?.(entry.connector, true, null);
      }
      if (stale()) return;
      const restored = await owner.restoreConnection(entry.id, () => {
        const current = loadMcpEndpoints({ configDir });
        if (current.state !== 'configured' || current.catalog.grantMode !== grantMode
          || canonicalJSON(current.catalog.endpoints.find(endpoint => endpoint.id === entry.id) ?? null) !== canonicalJSON(entry)) {
          throw Error('endpoint-binding-mismatch');
        }
      });
      if (stale()) return;
      if (restored.state !== 'restored') { reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: restored.reason }); return; }
      ready.add(entry.id);
      reports.set(entry.id, { id: entry.id, state: 'connected', tools: names.length, lastHandshakeAt: new Date(now()).toISOString(), ...(identity ? { identity } : {}) });
    } catch (error) {
      if (stale()) return;
      const localCodes = ['invalid_policy_shape', 'invalid_policy_version', 'invalid_policy_text', 'invalid_positive_integer', 'invalid_read_tools', 'invalid_unknown_class', 'invalid_data_classes', 'connection_owner_mismatch', 'connection_predecessor_mismatch', 'connection_identity_or_generation', 'connection_policy_missing_or_corrupt', 'projection_endpoint_mismatch', 'invalid-local-read-grant'];
      const exception = {
        class: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.constructor.name) ? error.constructor.name : 'Unknown',
        code: error instanceof Error && error.constructor === Error && localCodes.includes(error.message) ? error.message : 'unknown',
      };
      reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: 'discovery-unavailable', exception });
    }
  };

  let startPromise: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    if (closed) return;
    await Promise.all(active.map(entry => {
      const token = (generations.get(entry.id) ?? 0) + 1;
      generations.set(entry.id, token);
      return settle(entry, token).catch(() => { /* the per-connector report already carries the failure */ });
    }));
  };
  const composition: McpRuntimeComposition = {
    registry, port, owner,
    // Live calls this inside its acceptance transaction: do not open a nested store transaction.
    // Only a connector whose current generation is published and ready is callable.
    connectionIds: () => active.filter(entry => ready.has(entry.id) && reports.get(entry.id)?.state === 'connected' && !!registry.currentGrant(entry.id)).map(entry => entry.id),
    status: () => ({ endpoints: [...reports.values()].map(report => ({ ...report, connector: connectors.get(report.id) ?? report.id })) }),
    start: () => (startPromise ??= run()),
    refresh: async () => { startPromise = undefined; await run(); },
    close: () => { closed = true; for (const entry of active) generations.set(entry.id, (generations.get(entry.id) ?? 0) + 1); return port.close(); },
  };
  if (options.deferConnectors !== true) await composition.start();
  return composition;
}
