import type { RememberNotePort } from './remember.js';
import type { LiveVoiceProvider } from '../adapters/live-voice/types.js';
import type { StorePort, Transaction } from '../contracts/storage.js';
import type { McpPort } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';
import type { DataClass, HostContext, JsonObject, ToolResultBinding, ToolCallIntent, ToolCallJournal, ToolDefinition, ToolFailureCode, ToolResultGate, ToolResultRef } from '../adapters/model/types.js';

export interface HttpConnectionEndpoint { id: string; url: string; account: string; resource: string; credentialRef: string | null }
/** Explicit operator-approved local executable binding; credentialRef is strictly null. */
export interface StdioConnectionEndpoint { id: string; transport: 'stdio'; command: string; args: readonly string[]; env?: Readonly<Record<string, string>>; account: string; resource: string; credentialRef: null }
export type ConnectionEndpoint = HttpConnectionEndpoint | StdioConnectionEndpoint;
export interface ConnectionPolicy {
  /** Missing only on legacy inputs. Explicit owner approval adopts connection semantics. */
  bindingMode?: 'connection';
  schemaVersion: 1; ownerId: string; connectionId: string; generation: number; enabled: boolean;
  /** The Didi connector that owns this connection's read envelope, tool table and projector. */
  connector: string;
  endpoint: ConnectionEndpoint;
  toolNames: readonly string[]; schemaDigest: string;
  sourcePolicy: { id: string; revision: number; unknownClass: DataClass | null; allowedClasses: readonly DataClass[] };
  route: { identity: string; allowedClasses: readonly DataClass[] };
  bounds: { maxQueryChars: number; maxSearchLimit: number; maxGetIds: number; maxEntityBytes: number; maxResultBytes: number };
}
export interface RunAcceptance {
  ownerId: string; actorId: string; runId: string; authorityEpoch: string; revision: number;
  route: { identity: string; provider: LiveVoiceProvider; modelId: string; allowedClasses: readonly DataClass[] };
  allowedClasses: readonly DataClass[]; connectionIds: readonly string[];
}
export interface LiveAuthority extends RunAcceptance { acceptedRunHash: string }
export interface BoundConnection { connectionId: string; generation: number; sha256: string; policy: ConnectionPolicy }
export interface RunSnapshot { acceptance: RunAcceptance; connections: BoundConnection[] }
/** Separate trusted metadata boundary, not parsed from reader markdown or arbitrary MCP fields. */
export interface TrustedRestrictions { localOnly: boolean; nonDisclosure: boolean; dataClasses: readonly DataClass[] }
export interface ModelSnapshot { response: JsonObject; dataClasses: readonly DataClass[] }
export interface ToolFailureEvent {
  event: 'tool_failure'; code: ToolFailureCode;
  tool: string; connector: string; errorClass: 'Error' | 'SyntaxError' | 'UnknownThrow'; messageHead: string;
}
export interface ToolsOwnerOptions {
  log?: (event: ToolFailureEvent) => void;
  grantMode?: 'explicit' | 'owner-trusted-reads';
  store: StorePort; ownerId: string; registry: McpRegistry; port: McpPort;
  lookupAuthority(runId: string, signal: AbortSignal): Promise<LiveAuthority | null>;
  /** Reports a connector-classified connection status after a call; null clears it (R4). */
  reportToolStatus?(connectionId: string, status: { state: 'configured'; reason: string } | null): void;
}
export interface ConnectionIntent { expectedPolicySha256: string | null; policy: ConnectionPolicy }
export interface ConnectionApplyResult { state: 'applied' | 'unchanged'; sha256: string }
export type ConnectionRestoreResult = { state: 'restored' } | { state: 'refused' | 'unavailable'; reason: string };
export interface ToolsOwner {
  journal: ToolCallJournal; resultGate: ToolResultGate;
  /** Trusted synchronous publication boundary; uses the same canonical checks as resultGate. */
  authorizeDelivery(host: HostContext, bindings: readonly ToolResultBinding[], baseClasses: readonly DataClass[], authority: LiveAuthority | null, signal: AbortSignal): Awaited<ReturnType<ToolResultGate['authorize']>>;
  applyConnection(policy: ConnectionPolicy): void;
  applyConnectionIntent(intent: ConnectionIntent): ConnectionApplyResult;
  restoreConnection(connectionId: string, assertCurrentBinding: () => void): Promise<ConnectionRestoreResult>;
  projectConnection(connectionId: string): void;
  snapshotRun(tx: Transaction, acceptance: RunAcceptance): { sha256: string };
  definitions(runId: string): ToolDefinition[];
  liveDefinitions(runId: string, rememberNote: RememberNotePort): ToolDefinition[];
  liveRememberApproved(): boolean;
  complete(call: ToolCallIntent, response: JsonObject, dataClasses: readonly DataClass[]): ToolResultRef;
}
