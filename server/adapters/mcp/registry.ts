import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { bindingDigestOf, endpointBinding, isStdioEndpoint } from './port.js';
import type { CallRequest, EndpointConfig, HttpEndpointConfig, ReadGrant, ResultScope, StdioEndpointConfig, ToolDefinition } from './port.js';

export function canonicalToolDigest(tools: readonly ToolDefinition[]): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical([...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))).digest('hex');
}
export function validateEndpointUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.hash || url.href !== raw) throw new Error('invalid-endpoint-url');
  const literalLoopback = url.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && literalLoopback)) throw new Error('http-requires-literal-loopback');
  return url;
}
interface Entry {
  config: EndpointConfig;
  enabled: boolean;
  egress: boolean;
  tools?: readonly ToolDefinition[];
  digest?: string;
  grant?: ReadGrant;
  consent?: ReadGrant;
  revokedGeneration: number;
  lastGeneration: number;
  revision: number;
}
/** Entirely local authority. Remote annotations are never consulted. */
export class McpRegistry {
  private readonly entries = new Map<string, Entry>();
  register(config: EndpointConfig): void {
    if (isStdioEndpoint(config)) this.registerStdio(config);
    else this.registerHttp(config);
  }
  private registerHttp(config: HttpEndpointConfig): void {
    const allowed = new Set(['id', 'url', 'account', 'resource', 'credentialRef']);
    if (Object.keys(config).some(key => !allowed.has(key)) || [config.id, config.url, config.account, config.resource].some(value => typeof value !== 'string' || !value) || (config.credentialRef !== undefined && (typeof config.credentialRef !== 'string' || !config.credentialRef))) throw new Error('invalid-endpoint-config');
    validateEndpointUrl(config.url);
    this.set(config);
  }
  /** Explicit local executable binding: absolute installed command, ordered args, minimal explicit env. */
  private registerStdio(config: StdioEndpointConfig): void {
    const allowed = new Set(['id', 'transport', 'command', 'args', 'env', 'account', 'resource']);
    if (Object.keys(config).some(key => !allowed.has(key)) || [config.id, config.command, config.account, config.resource].some(value => typeof value !== 'string' || !value) || config.transport !== 'stdio' || !isAbsolute(config.command) || !Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string')) throw new Error('invalid-endpoint-config');
    const env = config.env;
    // The SDK merges its default inherited set into any supplied env; require the routing-affecting HOME and PATH explicitly so the effective child routing environment is approval-bound.
    if (env === undefined || typeof env !== 'object' || env === null || Array.isArray(env) || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) || typeof env['HOME'] !== 'string' || !env['HOME'] || typeof env['PATH'] !== 'string' || !env['PATH']) throw new Error('invalid-endpoint-config');
    try { accessSync(config.command, constants.X_OK); } catch { throw new Error('invalid-endpoint-config'); }
    this.set(config);
  }
  private set(config: EndpointConfig): void {
    if (this.entries.has(config.id)) throw new Error('duplicate-endpoint-id');
    this.entries.set(config.id, { config: structuredClone(config), enabled: false, egress: false, lastGeneration: 0, revokedGeneration: 0, revision: 0 });
  }
  private entry(id: string): Entry {
    const entry = this.entries.get(id); if (!entry) throw new Error('unknown-endpoint'); return entry;
  }
  enable(id: string): void { this.entry(id).enabled = true; }
  allowEgress(id: string): void { this.entry(id).egress = true; }
  disable(id: string): void { this.entry(id).enabled = false; this.suspend(id); }
  denyEgress(id: string): void { this.entry(id).egress = false; this.suspend(id); }
  endpoint(id: string): EndpointConfig {
    const entry = this.entry(id);
    if (!entry.enabled || !entry.egress) throw new Error('source-egress-not-approved');
    return structuredClone(entry.config);
  }
  /** Identity-only check for startup composition; does not enable egress or expose credentials. */
  matchesEndpoint(config: EndpointConfig): boolean {
    const entry = this.entries.get(config.id);
    return !!entry && endpointBinding(entry.config) === endpointBinding(config);
  }
  revision(id: string): number { return this.entry(id).revision; }
  suspend(id: string): void {
    const entry = this.entry(id); delete entry.grant; delete entry.digest; delete entry.tools; entry.revision++;
  }
  revoke(id: string): void { const entry = this.entry(id); delete entry.grant; entry.revokedGeneration = Math.max(entry.revokedGeneration, entry.lastGeneration); entry.revision++; }
  observed(id: string, tools: readonly ToolDefinition[], revision: number): string {
    const entry = this.entry(id); this.endpoint(id);
    if (entry.revision !== revision) throw new Error('discovery-invalidated');
    const digest = canonicalToolDigest(tools);
    // Every refresh is unapproved, even a same-digest reconnect after unknown dispatch.
    delete entry.grant; entry.tools = structuredClone(tools); entry.digest = digest;
    return digest;
  }
  approve(grant: ReadGrant): void {
    const entry = this.entry(grant.endpointId); this.endpoint(grant.endpointId);
    if (!entry.digest || grant.schemaDigest !== entry.digest || grant.effect !== 'read' || grant.account !== entry.config.account || grant.resource !== entry.config.resource || !Number.isSafeInteger(grant.generation) || grant.generation <= entry.lastGeneration || !Array.isArray(grant.toolNames) || new Set(grant.toolNames).size !== grant.toolNames.length || grant.toolNames.some(name => !entry.tools?.some(tool => tool.name === name))) throw new Error('invalid-local-read-grant');
    entry.grant = structuredClone(grant); entry.consent = structuredClone(grant); entry.lastGeneration = grant.generation;
  }
  /** Trusted owner projection of durable consent; never a new operator approval. */
  restore(grant: ReadGrant): void {
    const entry = this.entry(grant.endpointId); this.endpoint(grant.endpointId);
    if (!entry.digest || grant.schemaDigest !== entry.digest || grant.effect !== 'read' || grant.account !== entry.config.account || grant.resource !== entry.config.resource || !Number.isSafeInteger(grant.generation) || grant.generation < 1 || grant.generation <= entry.revokedGeneration || grant.generation < entry.lastGeneration || !Array.isArray(grant.toolNames) || new Set(grant.toolNames).size !== grant.toolNames.length || grant.toolNames.some(name => !entry.tools?.some(tool => tool.name === name))) throw new Error('invalid-standing-read-grant');
    if (grant.generation === entry.lastGeneration && (!entry.consent || entry.consent.schemaDigest !== grant.schemaDigest || JSON.stringify(entry.consent.toolNames) !== JSON.stringify(grant.toolNames))) throw new Error('standing-consent-mismatch');
    entry.grant = structuredClone(grant); entry.consent = structuredClone(grant); entry.lastGeneration = grant.generation;
  }
  currentGrant(id: string): ReadGrant | undefined { const grant = this.entry(id).grant; return grant ? structuredClone(grant) : undefined; }
  visibleTools(id: string): readonly ToolDefinition[] {
    const entry = this.entries.get(id);
    if (!entry?.enabled || !entry.egress || !entry.grant || !entry.tools) return [];
    return structuredClone(entry.tools.filter(tool => entry.grant?.toolNames.includes(tool.name)));
  }
  authorize(request: CallRequest): ResultScope {
    const entry = this.entry(request.endpointId); const config = this.endpoint(request.endpointId); const grant = entry.grant;
    if (!grant || !entry.digest || grant.schemaDigest !== entry.digest || grant.effect !== 'read' || !grant.toolNames.includes(request.toolName) || request.generation !== grant.generation || request.account !== grant.account || request.resource !== grant.resource) throw new Error('local-read-grant-refused');
    return { endpointId: config.id, url: isStdioEndpoint(config) ? '' : config.url, bindingDigest: bindingDigestOf(config), schemaDigest: grant.schemaDigest, toolName: request.toolName, generation: grant.generation, account: grant.account, resource: grant.resource };
  }
  authorizesScope(scope: ResultScope): boolean {
    try {
      const current = this.authorize({ ...scope, arguments: {} });
      return current.url === scope.url && current.bindingDigest === scope.bindingDigest && current.schemaDigest === scope.schemaDigest;
    } catch { return false; }
  }
}
