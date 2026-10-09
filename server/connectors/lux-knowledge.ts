import type { CompletedResult, McpPort, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';

/** The only remote tools this connector may ever call, in fixed order. No caller override. */
export const LUX_KNOWLEDGE_TOOLS = ['search_knowledge', 'get_insight'] as const;
export type LuxKnowledgeTool = (typeof LUX_KNOWLEDGE_TOOLS)[number];

export interface LuxKnowledgeConfig {
  endpointId: string;
  account: string;
  resource: string;
  /** Reviewed discovery digest the trusted owner approved for this endpoint. */
  schemaDigest: string;
  /** Approved read-grant generation; must match the current registry grant. */
  generation: number;
  /** Request budget: largest `limit` a search caller may select. */
  maxSearchLimit: number;
  /** Batch budget: largest number of IDs a get caller may select. */
  maxGetIds: number;
  /** Bound on query length in characters. */
  maxQueryChars: number;
}

export interface LuxKnowledgeSearchInput { query: string; limit: number }
export interface LuxKnowledgeGetInput { ids: number[] }

export interface LuxKnowledgeSource {
  endpointId: string;
  url: string;
  account: string;
  resource: string;
  schemaDigest: string;
  generation: number;
}

/** Opaque local evidence. Classification is constant `unknown`; markdown can never change it. */
export interface LuxKnowledgeEvidence {
  classification: 'unknown';
  capability: 'local-only';
  tool: LuxKnowledgeTool;
  source: LuxKnowledgeSource;
  observedAt: number;
  coverage: CompletedResult['coverage'];
  projection: CompletedResult['projection'];
  response: StoredPayload;
}

export interface LuxKnowledgeRefused { state: 'refused'; reason: string }
export interface LuxKnowledgeUnknown { state: 'unknown'; reason: string }

export type LuxKnowledgeResult =
  | (LuxKnowledgeEvidence & {
      state: 'completed' | 'tool-error' | 'protocol-error';
      /** get() only: caller-requested IDs, NOT verified returned entities. */
      requestedIds?: readonly number[];
    })
  | LuxKnowledgeRefused
  | LuxKnowledgeUnknown;

export interface LuxKnowledgeReader {
  search(input: LuxKnowledgeSearchInput): Promise<LuxKnowledgeResult>;
  get(input: LuxKnowledgeGetInput): Promise<LuxKnowledgeResult>;
}

export interface LuxKnowledgeOptions {
  port: McpPort;
  registry: McpRegistry;
  config: LuxKnowledgeConfig;
}

export function createLuxKnowledgeReader(options: LuxKnowledgeOptions): LuxKnowledgeReader {
  void options;
  return {
    async search(): Promise<LuxKnowledgeResult> { return { state: 'refused', reason: 'not-implemented' }; },
    async get(): Promise<LuxKnowledgeResult> { return { state: 'refused', reason: 'not-implemented' }; },
  };
}
