import type { StorePort, Transaction } from '../contracts/storage.js';
import type { McpPort } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';
import type { DataClass, JsonObject, ToolCallIntent, ToolCallJournal, ToolDefinition, ToolResultGate, ToolResultRef } from '../adapters/model/types.js';

export interface ConnectionPolicy {
  schemaVersion: 1; ownerId: string; connectionId: string; generation: number; enabled: boolean;
  endpoint: { id: string; url: string; account: string; resource: string; credentialRef: string | null };
  toolNames: readonly ('search_knowledge' | 'get_insight')[]; schemaDigest: string;
  sourcePolicy: { id: string; revision: number; unknownClass: DataClass | null; allowedClasses: readonly DataClass[] };
  route: { identity: string; allowedClasses: readonly DataClass[] };
  bounds: { maxQueryChars: number; maxSearchLimit: number; maxGetIds: number; maxEntityBytes: number; maxResultBytes: number };
}
export interface RunAcceptance {
  ownerId: string; actorId: string; runId: string; authorityEpoch: string; revision: number;
  route: { identity: string; provider: 'gemini'; modelId: string; allowedClasses: readonly DataClass[] };
  allowedClasses: readonly DataClass[]; connectionIds: readonly string[];
}
export interface LiveAuthority extends RunAcceptance { acceptedRunHash: string }
export interface BoundConnection { connectionId: string; generation: number; sha256: string; policy: ConnectionPolicy }
/** Read-only owner projection of a durable configured connection; never a secret or a live catalog. */
export interface OwnerConnection {
  connectionId: string; endpointId: string; generation: number; enabled: boolean;
  schemaDigest: string; toolNames: readonly string[];
}
export interface RunSnapshot { acceptance: RunAcceptance; connections: BoundConnection[] }
/**
 * Read-only projection of an immutable completed-call receipt for an accepted run:
 * the existing result reference, its call/intent association, and the validated
 * bound-connection provenance. No result text, secrets, paths, provider entity ids
 * or new authority; provider record identity stays unknown.
 */
export interface OwnerReceipt {
  executionId: string; callId?: string; name: string;
  result: { id: string; sha256: string };
  connection: { connectionId: string; generation: number; sha256: string };
}
/** Separate trusted metadata boundary, not parsed from reader markdown or arbitrary MCP fields. */
export interface TrustedRestrictions { localOnly: boolean; nonDisclosure: boolean; dataClasses: readonly DataClass[] }
export interface ModelSnapshot { response: JsonObject; dataClasses: readonly DataClass[] }
export interface ToolsOwnerOptions {
  store: StorePort; ownerId: string; registry: McpRegistry; port: McpPort;
  lookupAuthority(runId: string, signal: AbortSignal): Promise<LiveAuthority | null>;
}
export interface ConnectionIntent { expectedPolicySha256: string | null; policy: ConnectionPolicy }
export interface ConnectionApplyResult { state: 'applied' | 'unchanged'; sha256: string }
export type ConnectionRestoreResult = { state: 'restored' } | { state: 'refused' | 'unavailable'; reason: string };
export interface ToolsOwner {
  journal: ToolCallJournal; resultGate: ToolResultGate;
  applyConnection(policy: ConnectionPolicy): void;
  applyConnectionIntent(intent: ConnectionIntent): ConnectionApplyResult;
  restoreConnection(connectionId: string, assertCurrentBinding: () => void): Promise<ConnectionRestoreResult>;
  projectConnection(connectionId: string): void;
  snapshotRun(tx: Transaction, acceptance: RunAcceptance): { sha256: string };
  /** Immutable completed-call receipts for an accepted run; read inside the caller's transaction. */
  receipts(tx: Transaction, runId: string): OwnerReceipt[];
  /** Immutable accepted-run snapshot (acceptance + hash) read by the Host through the owner, never raw SQL. */
  acceptedRun(runId: string): { acceptance: RunAcceptance; sha256: string } | null;
  /** Durable configured connections; read-only owner status projection, never downstream raw SQL. */
  connections(): OwnerConnection[];
  definitions(runId: string): ToolDefinition[];
  complete(call: ToolCallIntent, response: JsonObject, dataClasses: readonly DataClass[]): ToolResultRef;
}
