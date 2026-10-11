import type { Store } from '../runtime/store.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { assertToolsOwnerBinding, createToolsOwner } from '../tools/index.js';
import type { ConnectionRestoreResult, LiveAuthority, ToolsOwner } from '../tools/types.js';
import { loadMcpConfiguration, loadMcpEndpoints, type McpEndpointEntry } from '../config/mcp.js';
import { fields, parseJson, readPrivate } from '../config/files.js';
import { join } from 'node:path';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { McpPort } from '../adapters/mcp/port.js';
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
const connectorEnvelopes: Readonly<Record<string, readonly string[]>> = CONNECTOR_ENVELOPES;
/** Compose the MCP runtime once at startup: one registry, adapter and owner. Never blocks on a remote. */
export async function composeMcpRuntime(options: {
  store: Store; ownerId: string; configDir: string;
  lookupAuthority(runId: string, signal: AbortSignal): Promise<LiveAuthority | null>;
  now?: () => number;
}): Promise<McpRuntimeComposition> {
  const { store, ownerId, configDir } = options; const now = options.now ?? Date.now;
  const registry = new McpRegistry();
  const port = createMcpAdapter({ registry, store: new MemoryResultStore(), resolveCredential: async reference => readMcpCredential(configDir, reference) });
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
      if (entry.transport === 'stdio') {
        registry.register({ id: entry.id, transport: 'stdio', command: entry.command, args: [...entry.args], env: { ...entry.env }, account: entry.account, resource: entry.resource });
      } else {
        registry.register({ id: entry.id, url: entry.url, account: entry.account, resource: entry.resource, ...(entry.credentialRef ? { credentialRef: entry.credentialRef } : {}) });
      }
      registry.enable(entry.id);
      if (entry.allowEgress) registry.allowEgress(entry.id);
    }
    reports.set(entry.id, { id: entry.id, state: 'configured', tools: 0, lastHandshakeAt: null });
  }
  const connect = async (entry: McpEndpointEntry): Promise<void> => {
    const previous = reports.get(entry.id);
    // A missing or malformed credential is a visible, typed status; discovery never runs with a blank bearer.
    if (entry.credentialRef) {
      try { readMcpCredential(configDir, entry.credentialRef); }
      catch { reports.set(entry.id, { id: entry.id, state: 'error', tools: 0, lastHandshakeAt: previous?.lastHandshakeAt ?? null, error: `credential ${entry.credentialRef} missing or invalid` }); return; }
    }
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
