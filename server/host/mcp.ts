import { CONNECTOR_DESCRIPTORS, ConnectorCompositionError } from '../connectors/index.js';
import type { Store } from '../runtime/store.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { assertToolsOwnerBinding, createToolsOwner, validatePolicy } from '../tools/index.js';
import type { ConnectionPolicy, ConnectionRestoreResult, LiveAuthority, ToolsOwner, ToolsOwnerOptions } from '../tools/types.js';
import { loadMcpConfiguration, loadMcpEndpoints, type McpEndpointEntry } from '../config/mcp.js';
import { fields, parseJson, readPrivate } from '../config/files.js';
import { join } from 'node:path';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { McpPort } from '../adapters/mcp/port.js';
import { canonicalJSON, sha256 } from '../tools/canonical.js';
import { CONNECTOR_ENVELOPES } from '../connectors/index.js';

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

export type McpEndpointState = 'missing' | 'configured' | 'connected' | 'error';
export interface McpEndpointReport { id: string; state: McpEndpointState; tools: number; lastHandshakeAt: string | null; error?: string; configurationError?: 'unknown-class-missing' | 'unknown-class-invalid' | 'owner-approval-required' | 'ambiguous-legacy-policy'; exception?: { class: string; code: string } }
export interface McpRuntimeComposition {
  registry: McpRegistry;
  port: McpPort;
  owner: ToolsOwner;
  connectionIds(): string[];
  status(): { endpoints: (McpEndpointReport & { connector: string })[] };
  refresh(): Promise<void>;
  close(): Promise<void>;
}
/** The local read envelope is the Didi connector's own classification, never the remote readOnlyHint. */
const connectorEnvelopes: Readonly<Record<string, readonly string[]>> = CONNECTOR_ENVELOPES;
/** Compose the MCP runtime once at startup: one registry, adapter and owner. Never blocks on a remote. */
export async function composeMcpRuntime(options: {
  log?: ToolsOwnerOptions['log'];
  store: Store; ownerId: string; configDir: string;
  lookupAuthority(runId: string, signal: AbortSignal): Promise<LiveAuthority | null>;
  now?: () => number;
}): Promise<McpRuntimeComposition> {
  const { store, ownerId, configDir } = options; const now = options.now ?? Date.now;
  const registry = new McpRegistry();
  const selection = loadMcpEndpoints({ configDir });
  // One rule: every configured read connector gets the longer call deadline, so a real hybrid
  // archive search cannot hit the five-second default. Connect and discovery stay on budgets.timeoutMs.
  const callTimeoutMsByEndpoint = new Map(selection.state === 'configured'
    ? selection.catalog.endpoints.map(entry => [entry.id, 30000] as const) : []);
  const port = createMcpAdapter({ registry, store: new MemoryResultStore(), callTimeoutMsByEndpoint, resolveCredential: async reference => readMcpCredential(configDir, reference) });
  const reports = new Map<string, McpEndpointReport>();
  const connectors = new Map<string, string>();
  const reportToolStatus = (connectionId: string, status: { state: 'configured'; reason: string } | null): void => {
    const previous = reports.get(connectionId);
    if (!previous) return;
    reports.set(connectionId, status === null
      ? { id: previous.id, state: 'connected', tools: previous.tools, lastHandshakeAt: previous.lastHandshakeAt }
      : { id: previous.id, state: 'configured', tools: previous.tools, lastHandshakeAt: previous.lastHandshakeAt, error: status.reason });
  };
  const owner = createToolsOwner({ grantMode: selection.state === 'missing' ? 'explicit' : selection.catalog.grantMode, store, ownerId, registry, port, lookupAuthority: options.lookupAuthority, reportToolStatus, ...(options.log ? { log: options.log } : {}) });
  if (selection.state === 'missing') {
    return { registry, port, owner, connectionIds: () => [], status: () => ({ endpoints: [] }), refresh: async () => {}, close: () => port.close() };
  }
  const { grantMode, endpoints } = selection.catalog;
  // Reject local capability mismatches before any transport starts, including disabled entries.
  for (const entry of endpoints) {
    if (!Object.hasOwn(CONNECTOR_DESCRIPTORS, entry.connector)) throw new ConnectorCompositionError('unknown_connector', entry.id, entry.connector);
  }
  const usable = new Set<string>();
  const active = endpoints.filter(entry => entry.enabled && entry.allowEgress);
  for (const entry of endpoints) {
    if (entry.enabled) {
      if (entry.transport === 'stdio') {
        registry.register({ id: entry.id, transport: 'stdio', command: entry.command, args: [...entry.args], env: { ...entry.env }, account: entry.account, resource: entry.resource });
      } else {
        registry.register({ id: entry.id, url: entry.url, account: entry.account, resource: entry.resource, ...(entry.credentialRef ? { credentialRef: entry.credentialRef } : {}) });
      }
      registry.enable(entry.id);
      if (entry.allowEgress) registry.allowEgress(entry.id);
    }
    reports.set(entry.id, { id: entry.id, state: 'configured', tools: 0, lastHandshakeAt: null });
    connectors.set(entry.id, entry.connector);
  }
  const connect = async (entry: McpEndpointEntry): Promise<void> => {
    const previous = reports.get(entry.id);
    usable.delete(entry.id);
    if (entry.configurationError || entry.unknownClass === null) {
      const code = entry.configurationError ?? 'unknown-class-missing';
      reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: code, configurationError: code }); return;
    }
    // A missing or malformed credential is a visible, typed status; discovery never runs with a blank bearer.
    if (entry.credentialRef) {
      try { readMcpCredential(configDir, entry.credentialRef); }
      catch { reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: `credential ${entry.credentialRef} missing or invalid` }); return; }
    }
    try {
      const discovery = await port.discover(entry.id);
      if (discovery.state !== 'discovered') { reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: discovery.reason, ...(discovery.exception ? { exception: discovery.exception } : {}) }); return; }
      const envelope = connectorEnvelopes[entry.connector] ?? [];
      const names = grantMode === 'owner-trusted-reads'
        ? discovery.tools.map(tool => tool.name).filter(name => envelope.includes(name)).sort()
        : [];
      // Healthy discovery without an approved envelope is status-only, not an empty owner policy.
      if (!names.length) {
        reports.set(entry.id, { id: entry.id, state: 'connected', tools: 0, lastHandshakeAt: new Date(discovery.observedAt).toISOString() });
        return;
      }
      // Reconcile through the owner's CAS intent API, never fabricate a registry-only grant.
      // The owner validates the existing row (including its hash) before accepting the intent.
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
      const restored = await owner.restoreConnection(entry.id, () => {
        const current = loadMcpEndpoints({ configDir });
        if (current.state !== 'configured' || current.catalog.grantMode !== grantMode
          || canonicalJSON(current.catalog.endpoints.find(endpoint => endpoint.id === entry.id) ?? null) !== canonicalJSON(entry)) {
          throw Error('endpoint-binding-mismatch');
        }
      });
      if (restored.state !== 'restored') { reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: restored.reason }); return; }
      usable.add(entry.id);
      const granted = names.length;
      reports.set(entry.id, { id: entry.id, state: 'connected', tools: granted, lastHandshakeAt: new Date(now()).toISOString() });
    } catch (error) {
      const localCodes = ['invalid_policy_shape', 'invalid_policy_version', 'invalid_policy_text', 'invalid_positive_integer', 'invalid_read_tools', 'invalid_unknown_class', 'invalid_data_classes', 'connection_owner_mismatch', 'connection_predecessor_mismatch', 'connection_identity_or_generation', 'connection_policy_missing_or_corrupt', 'projection_endpoint_mismatch', 'invalid-local-read-grant'];
      const exception = {
        class: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.constructor.name) ? error.constructor.name : 'Unknown',
        code: error instanceof Error && error.constructor === Error && localCodes.includes(error.message) ? error.message : 'unknown',
      };
      reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: 'discovery-unavailable', exception });
    }
  };
  await Promise.all(active.map(connect));
  return {
    registry, port, owner,
    // Live calls this inside its acceptance transaction: do not open a nested store transaction.
    // Only the canonical owner projects grants after validating connection semantics/class.
    connectionIds: () => active.filter(entry => usable.has(entry.id) && reports.get(entry.id)?.state === 'connected' && !!registry.currentGrant(entry.id)).map(entry => entry.id),
    status: () => ({ endpoints: [...reports.values()].map(report => ({ ...report, connector: connectors.get(report.id) ?? report.id })) }),
    refresh: async () => { await Promise.all(active.map(connect)); },
    close: () => port.close(),
  };
}
