import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { SOURCE_DISPATCH, type SourceDispatchEvidence, type CompletedResult, type McpPort } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';
import { LUX_FORBIDDEN_TOOLS, LUX_PARAMS, luxWriteAdmitted } from './lux-names.js';
import { luxResultPayload } from './lux-receipt.js';
export { LUX_TOOLS } from './lux-names.js';

/** The owner's first-party endpoint follows its discovered schema without another approval round. */
export function isTrustedRediscovery(connector: string): boolean { return connector === 'lux-knowledge'; }

/** M21 owns this one hook; M23 composes safe mutations with read admission here. */
export function luxToolAdmitted(tool: { name: string; description?: string; annotations?: unknown }): boolean {
  if ((LUX_FORBIDDEN_TOOLS as readonly string[]).includes(tool.name)) return false;
  if (!tool.annotations || typeof tool.annotations !== 'object' || Array.isArray(tool.annotations)) return false;
  const hints = tool.annotations as Record<string, unknown>;
  return hints.destructiveHint !== true && (hints.readOnlyHint === true || luxWriteAdmitted(tool));
}

export interface LuxKnowledgeConfig {
  endpointId: string; account: string; resource: string; generation: number;
  maxSearchLimit: number; maxGetIds: number; maxQueryChars: number;
}
export interface LuxKnowledgeOptions { port: McpPort; registry: McpRegistry; config: LuxKnowledgeConfig }
export interface LuxKnowledgeEvidence extends SourceDispatchEvidence {
  decodedResult: unknown; classification: 'unknown'; capability: 'local-only'; tool: string;
  source: CompletedResult['source']; observedAt: number;
  coverage: CompletedResult['coverage']; projection: CompletedResult['projection']; response: CompletedResult['payload'];
}
export type LuxKnowledgeResult = (LuxKnowledgeEvidence & { state: CompletedResult['state'] }) | { state: 'refused' | 'unknown'; reason: string };
export interface LuxKnowledgeReader {
  call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<LuxKnowledgeResult>;
}

/** Reject non-JSON objects before inspecting or copying untrusted arguments. */
function wireData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return false;
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) return false;
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string' || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !wireData(descriptor.value, seen)) return false;
  }
  seen.delete(value);
  return true;
}

/** The discovered schema is the wire contract. No parameter aliases, silent drops or read allowlist. */
export function createLuxKnowledgeReader({ port, registry, config }: LuxKnowledgeOptions): LuxKnowledgeReader {
  const settings = { ...config };
  if (!settings.endpointId || !settings.account || !settings.resource || [settings.generation, settings.maxSearchLimit, settings.maxGetIds, settings.maxQueryChars].some(value => !Number.isSafeInteger(value) || value < 1)) throw Error('invalid-connector-config');
  const validator = new AjvJsonSchemaValidator();
  return {
    async call(tool, args, signal) {
      if (signal?.aborted) return { state: 'refused', reason: 'cancelled-before-dispatch' };
      const grant = registry.currentGrant(settings.endpointId);
      if (!grant || grant.generation !== settings.generation || grant.account !== settings.account || grant.resource !== settings.resource) return { state: 'refused', reason: 'grant-scope-mismatch' };
      const declaration = registry.visibleTools(settings.endpointId).find(item => item.name === tool);
      if (!declaration || !luxToolAdmitted(declaration)) return { state: 'refused', reason: 'tool_missing_or_forbidden' };
      if (luxWriteAdmitted(declaration) && grant.effect !== 'read-write') return { state: 'refused', reason: 'write-grant-required' };
      if (!args || Array.isArray(args) || !wireData(args)) return { state: 'refused', reason: 'invalid_arguments' };
      const properties = declaration.inputSchema.properties as Record<string, unknown> | undefined;
      if (Object.keys(args).some(key => !properties || !Object.hasOwn(properties, key))) return { state: 'refused', reason: 'unknown_wire_parameter' };
      const wire: Record<string, unknown> = { ...args, ...(properties && Object.hasOwn(properties, LUX_PARAMS.includeSensitive) ? { [LUX_PARAMS.includeSensitive]: true } : {}) };
      if (!validator.getValidator(declaration.inputSchema)(wire).valid) return { state: 'refused', reason: 'invalid_arguments' };
      const limit = wire[LUX_PARAMS.limit], query = wire[LUX_PARAMS.query], ids = wire[LUX_PARAMS.insightIds];
      if ((typeof limit === 'number' && limit > settings.maxSearchLimit) || (typeof query === 'string' && query.length > settings.maxQueryChars) || (Array.isArray(ids) && ids.length > settings.maxGetIds)) return { state: 'refused', reason: 'request_bound_exceeded' };
      const result = await port.call({ endpointId: settings.endpointId, toolName: tool, arguments: wire, generation: settings.generation, account: settings.account, resource: settings.resource }, signal);
      if ('reason' in result) return result;
      if (signal?.aborted) return { state: 'unknown', reason: 'cancelled-after-dispatch' };
      return { state: result.state, classification: 'unknown', capability: 'local-only', tool,
        ...(Array.isArray(ids) ? { requestedIds: [...ids] as number[] } : {}),
        decodedResult: structuredClone(result.decodedResult), source: { ...result.source }, observedAt: result.freshness.receivedAt,
        coverage: structuredClone(result.coverage), projection: structuredClone(result.projection), response: structuredClone(result.payload),
        ...(result[SOURCE_DISPATCH] ? { [SOURCE_DISPATCH]: result[SOURCE_DISPATCH] } : {}) };
    },
  };
}

/** MCP envelope decoding only: the complete search header remains opaque text to the host. */
export function renderLuxText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const payload = luxResultPayload(value as Record<string, unknown>);
    if (payload !== undefined) return typeof payload === 'string' ? payload : JSON.stringify(payload);
  }
  return JSON.stringify(value);
}
