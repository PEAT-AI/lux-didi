import { createHash } from 'node:crypto';

/** Didi-owned public seam. No SDK types, model declarations, or persistence policy. */
export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}
export interface HttpEndpointConfig {
  id: string;
  url: string;
  account: string;
  resource: string;
  credentialRef?: string;
}
/** An explicit operator-approved local executable binding. Never a shell string. */
export interface StdioEndpointConfig {
  id: string;
  transport: 'stdio';
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  account: string;
  resource: string;
}
export type EndpointConfig = HttpEndpointConfig | StdioEndpointConfig;
export function isStdioEndpoint(config: EndpointConfig): config is StdioEndpointConfig {
  return (config as { transport?: unknown }).transport === 'stdio';
}
export interface EndpointBindingInput {
  id: string;
  account: string;
  resource: string;
  credentialRef?: string | null;
  transport?: string;
  url?: string;
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}
/**
 * Canonical full binding identity, shared by the registry, the owner policy and
 * protected configuration. A missing URL is never evidence that two process
 * bindings match, so the stdio arm is compared on command, ordered args and env.
 */
export function endpointBinding(config: EndpointBindingInput): string {
  if (config.transport === 'stdio') {
    const env = Object.entries(config.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify(['stdio', config.id, config.command ?? '', [...(config.args ?? [])], env, config.account, config.resource]);
  }
  return JSON.stringify(['streamable-http', config.id, config.url ?? '', config.account, config.resource, config.credentialRef ?? null]);
}
/** Owner-safe binding identity for public projections and diagnostics: a digest, never the raw locator. */
export function bindingDigestOf(config: EndpointBindingInput): string {
  return createHash('sha256').update(endpointBinding(config)).digest('hex');
}
export interface ReadGrant {
  endpointId: string;
  schemaDigest: string;
  toolNames: readonly string[];
  effect: 'read';
  account: string;
  resource: string;
  generation: number;
}
export interface CallRequest {
  endpointId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  generation: number;
  account: string;
  resource: string;
}
export interface ResultScope {
  endpointId: string;
  url: string;
  schemaDigest: string;
  toolName: string;
  generation: number;
  account: string;
  resource: string;
}
export type StoredPayload =
  | { state: 'available'; handle: string; sha256: string; byteLength: number; expiresAt: number; encoding: 'http-response-entity' }
  | { state: 'unavailable'; reason: 'capacity' | 'oversize' | 'store-unavailable' };
export interface SliceRequest {
  handle: string;
  endpointId: string;
  generation: number;
  account: string;
  resource: string;
  offset: number;
  length: number;
}
export type SliceResult =
  | { state: 'available'; bytes: Uint8Array; byteLength: number; sha256: string; expiresAt: number }
  | { state: 'refused' | 'expired' | 'unavailable'; reason: string };
export interface ResultStorePort {
  put(scope: ResultScope, bytes: Uint8Array): StoredPayload;
  read(request: SliceRequest, authorize: (scope: ResultScope) => boolean): SliceResult;
}
export type DiscoveryResult =
  | { state: 'discovered'; endpointId: string; schemaDigest: string; tools: readonly ToolDefinition[]; observedAt: number }
  | { state: 'unavailable'; reason: string };
export interface CompletedResult {
  state: 'completed' | 'tool-error' | 'protocol-error';
  protocolErrorCode?: number;
  source: { endpointId: string; url: string; account: string; resource: string; toolName: string; schemaDigest: string; generation: number };
  coverage: { completeCorpus: false; basis: 'single-tool-result'; remoteSideEffects: 'unverified' };
  freshness: { receivedAt: number; sourceVersion: 'unknown' };
  projection: { text: string; omitted: boolean; originalCharacters: number; omittedCharacters: number };
  payload: StoredPayload;
}
export type CallResult = CompletedResult | { state: 'refused' | 'unknown'; reason: string };
export interface McpPort {
  discover(endpointId: string): Promise<DiscoveryResult>;
  visibleTools(endpointId: string): readonly ToolDefinition[];
  call(request: CallRequest, signal?: AbortSignal): Promise<CallResult>;
  readSlice(request: SliceRequest): SliceResult;
  /** Bounded observer for a protocol notification, primarily for hosts/tests. */
  whenSuspended(endpointId: string): Promise<void>;
  close(): Promise<void>;
}
export interface McpBudgets {
  timeoutMs: number;
  maxResponseBytes: number;
  maxPages: number;
  maxTools: number;
  projectionChars: number;
}
