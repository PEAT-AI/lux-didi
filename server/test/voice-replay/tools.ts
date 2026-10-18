import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpAdapter } from '../../adapters/mcp/adapter.js';
import { McpRegistry, canonicalToolDigest } from '../../adapters/mcp/registry.js';
import { MemoryResultStore } from '../../adapters/mcp/store.js';
import { createToolsOwner, toolsMigrations } from '../../tools/index.js';
import type { LiveAuthority } from '../../tools/types.js';
import type { LiveToolsComposition } from '../../live/types.js';
import type { Store } from '../../runtime/store.js';
import type { ReplayClock } from './driver.js';

/**
 * Scriptable fake tools: a real MCP server over an in-process transport, so the host executes its real tool
 * path, with a per-call script that sets latency, failure and a late callback. Latency is virtual: the call
 * resolves when the replay clock reaches it, so a late callback is one that lands after the host settled.
 */
export interface ToolScript {
  /** Virtual milliseconds before the tool answers. */
  readonly latencyMs?: number;
  /** The tool returns an MCP error result instead of content. */
  readonly fail?: boolean;
  /** The tool result text, when the call succeeds. */
  readonly text?: string;
}

/** The migrations a store needs before a scripted tool composition can be applied. */
export { toolsMigrations };

export interface ReplayTools {
  readonly composition: LiveToolsComposition;
  readonly calls: { name: string; args: unknown; at: number }[];
  /** Why the tool journal refused a call, if it did. An empty list means every scripted tool really ran. */
  readonly journalErrors: readonly string[];
  /** The queue of scripts; an exhausted queue answers immediately with the default synthetic result. */
  script(entry: ToolScript): void;
  /** Called by the driver once the live owner exists: the host's own authority lookup. */
  setAuthority(lookup: (runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>): void;
  close(): Promise<void>;
}

const SCHEMAS = [
  { name: 'search_knowledge', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query', 'limit'], additionalProperties: false } },
  { name: 'get_insight', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, include_links: { type: 'boolean' } }, required: ['ids', 'include_links'], additionalProperties: false } },
];

export async function replayTools(t: TestContext, store: Store, clock: ReplayClock, routeIdentity: string): Promise<ReplayTools> {
  const calls: { name: string; args: unknown; at: number }[] = [];
  const queue: ToolScript[] = [];
  let authority: ((runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>) | undefined;
  const registry = new McpRegistry();
  const endpoint = { id: 'lux', url: 'https://fixture.invalid/mcp', account: 'account', resource: 'resource' };
  registry.register(endpoint); registry.enable(endpoint.id); registry.allowEgress(endpoint.id);
  const sdk = new Server({ name: 'voice-replay-tools', version: '1' }, { capabilities: { tools: { listChanged: false } } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  sdk.setRequestHandler('tools/list', () => ({ tools: structuredClone(SCHEMAS) }) as never);
  sdk.setRequestHandler('tools/call', async request => {
    const at = clock.now();
    calls.push({ name: request.params.name, args: request.params.arguments, at });
    const script = queue.shift() ?? {};
    if (script.latencyMs) await new Promise<void>(resolve => { clock.setTimer(script.latencyMs!, resolve); });
    if (script.fail) return { content: [{ type: 'text', text: 'synthetic tool failure' }], isError: true };
    return { content: [{ type: 'text', text: script.text ?? '#1: Synthetic insight\n[Evidence](https://example.test/evidence)' }] };
  });
  await sdk.connect(transport);
  // The MCP adapter reaches the endpoint over `fetch`; the scripted server answers in process, no network.
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) =>
    transport.handleRequest(new Request(input, init)));
  const port = createMcpAdapter({
    registry, store: new MemoryResultStore({ maxBytes: 10_000, maxSliceBytes: 512 }),
    resolveCredential: async () => 'synthetic-token',
    budgets: { maxResponseBytes: 12_000, projectionChars: 10, timeoutMs: 1_000 },
  });
  const toolOwner = createToolsOwner({
    store, ownerId: store.assistantId, registry, port,
    lookupAuthority: async (runId, signal) => (authority ? authority(runId, signal) : null),
  });
  // The tool journal refuses a call for a policy reason; a replay records that reason instead of blaming the
  // fake tool, so a scenario that expects a real result never passes on a refused call.
  const journalErrors: string[] = [];
  const intent = toolOwner.journal.intent.bind(toolOwner.journal);
  toolOwner.journal.intent = (input) => {
    try { return intent(input); } catch (error) { journalErrors.push(error instanceof Error ? error.message : String(error)); throw error; }
  };
  toolOwner.applyConnection({
    schemaVersion: 1, ownerId: store.assistantId, connectionId: 'lux', generation: 1, enabled: true, connector: 'lux-knowledge',
    endpoint: { ...endpoint, credentialRef: null }, toolNames: ['search_knowledge', 'get_insight'], schemaDigest: canonicalToolDigest(SCHEMAS),
    sourcePolicy: { id: 'voice-replay', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
    route: { identity: routeIdentity, allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 80, maxSearchLimit: 3, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 },
  });
  if ((await port.discover(endpoint.id)).state !== 'discovered') throw new Error('replay tools failed to discover the synthetic endpoint');
  // Approve the connection's read grant: a projection without a current grant refuses every call, and a
  // scenario would then be asserting against a dead tool.
  toolOwner.projectConnection('lux');
  return {
    composition: { owner: toolOwner, connectionIds: () => ['lux'] },
    calls,
    journalErrors,
    script: entry => { queue.push(entry); },
    setAuthority: lookup => { authority = lookup; },
    async close() { await port.close(); await transport.close(); await sdk.close(); },
  };
}
