import type { Store } from '../runtime/store.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { assertToolsOwnerBinding, createToolsOwner } from '../tools/index.js';
import type { ConnectionRestoreResult, LiveAuthority, ToolsOwner } from '../tools/types.js';
import { loadMcpConfiguration, loadMcpEndpoints, type McpEndpointEntry } from '../config/mcp.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { McpPort } from '../adapters/mcp/port.js';
import { LUX_KNOWLEDGE_TOOLS } from '../connectors/lux-knowledge.js';

export interface McpConnectionBundle {
  state: 'applied' | 'unchanged' | 'refused' | 'pending';
  reason?: string;
  sha256?: string;
  restore(): Promise<ConnectionRestoreResult>;
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
export interface McpEndpointReport { id: string; state: McpEndpointState; tools: number; lastHandshakeAt: string | null; error?: string }
export interface McpRuntimeComposition {
  registry: McpRegistry;
  port: McpPort;
  owner: ToolsOwner;
  connectionIds(): string[];
  status(): { endpoints: McpEndpointReport[] };
  refresh(): Promise<void>;
  close(): Promise<void>;
}
/** The local read envelope is the Didi connector's own classification, never the remote readOnlyHint. */
const connectorEnvelopes: Readonly<Record<string, readonly string[]>> = { 'lux-knowledge': LUX_KNOWLEDGE_TOOLS };
/** Compose the MCP runtime once at startup: one registry, adapter and owner. Never blocks on a remote. */
export async function composeMcpRuntime(options: {
  store: Store; ownerId: string; configDir: string;
  lookupAuthority(runId: string, signal: AbortSignal): Promise<LiveAuthority | null>;
  now?: () => number;
}): Promise<McpRuntimeComposition> {
  const { store, ownerId, configDir } = options; const now = options.now ?? Date.now;
  const registry = new McpRegistry();
  const port = createMcpAdapter({ registry, store: new MemoryResultStore() });
  const owner = createToolsOwner({ store, ownerId, registry, port, lookupAuthority: options.lookupAuthority });
  const selection = loadMcpEndpoints({ configDir });
  if (selection.state === 'missing') {
    return { registry, port, owner, connectionIds: () => [], status: () => ({ endpoints: [] }), refresh: async () => {}, close: () => port.close() };
  }
  const { grantMode, endpoints } = selection.catalog;
  const reports = new Map<string, McpEndpointReport>();
  const generations = new Map<string, number>();
  const digests = new Map<string, string>();
  const active = endpoints.filter(entry => entry.enabled && entry.allowEgress);
  for (const entry of endpoints) {
    if (entry.enabled) {
      registry.register({ id: entry.id, url: entry.url, account: entry.account, resource: entry.resource, ...(entry.credentialRef ? { credentialRef: entry.credentialRef } : {}) });
      registry.enable(entry.id);
      if (entry.allowEgress) registry.allowEgress(entry.id);
    }
    reports.set(entry.id, { id: entry.id, state: 'configured', tools: 0, lastHandshakeAt: null });
  }
  const connect = async (entry: McpEndpointEntry): Promise<void> => {
    const previous = reports.get(entry.id);
    try {
      const discovery = await port.discover(entry.id);
      if (discovery.state !== 'discovered') { reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: discovery.reason }); return; }
      let granted = 0;
      if (grantMode === 'owner-trusted-reads') {
        const envelope = connectorEnvelopes[entry.connector] ?? [];
        const names = discovery.tools.map(tool => tool.name).filter(name => envelope.includes(name));
        if (names.length) {
          const generation = (generations.get(entry.id) ?? 0) + 1;
          registry.approve({ endpointId: entry.id, schemaDigest: discovery.schemaDigest, toolNames: names, effect: 'read', account: entry.account, resource: entry.resource, generation });
          generations.set(entry.id, generation);
          if (digests.has(entry.id) && digests.get(entry.id) !== discovery.schemaDigest) console.error(`[mcp] envelope re-approved after digest change: ${entry.id}`);
          digests.set(entry.id, discovery.schemaDigest);
        }
        granted = names.length;
      }
      reports.set(entry.id, { id: entry.id, state: 'connected', tools: granted, lastHandshakeAt: new Date(now()).toISOString() });
    } catch { reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: 'discovery-unavailable' }); }
  };
  await Promise.all(active.map(connect));
  return {
    registry, port, owner,
    connectionIds: () => active.map(entry => entry.id),
    status: () => ({ endpoints: [...reports.values()].map(report => ({ ...report })) }),
    refresh: async () => { await Promise.all(active.map(connect)); },
    close: () => port.close(),
  };
}
