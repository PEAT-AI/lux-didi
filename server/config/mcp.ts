import { closeSync, constants, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { EndpointConfig } from '../adapters/mcp/port.js';
import { validatePolicy } from '../tools/index.js';
import type { ConnectionEndpoint, ConnectionIntent, ConnectionPolicy, HttpConnectionEndpoint, StdioConnectionEndpoint } from '../tools/types.js';
const stdioEndpoint = (e: ConnectionEndpoint): e is StdioConnectionEndpoint => (e as { transport?: unknown }).transport === 'stdio';
import { canonicalJSON, sha256 } from '../tools/canonical.js';
import { ConfigError, fail, fields, parseJson, readPrivate, safeError, validateRoot } from './files.js';

export interface McpProfile extends ConnectionIntent {
  schemaVersion: 1; transport: 'streamable-http' | 'stdio'; dataDir: string;
}
interface Credential {
  schemaVersion: 1; ownerId: string; connectionId: string; endpointId: string; url: string;
  account: string; resource: string; generation: number; credentialRef: string | null; token: string; enabled: boolean;
}
interface Target { configDir: string; ownerId: string; dataDir: string }
export interface McpConfiguration {
  intent: McpProfile;
  endpoint: EndpointConfig;
  locallyDisabled: boolean;
  resolveCredential(reference: string): Promise<string>;
  assertCredentialCurrent(reference: string): void;
  assertCurrentBinding(): void;
}
const profileFile = 'profile.json'; const credentialFile = 'credential.json';
const profileLimit = 32768; const secretLimit = 16384;
const refPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function absolute(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || !isAbsolute(value) || normalize(value) !== value) fail('invalid_arguments');
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail('invalid_profile');
}
function root(path: string): void { absolute(path); if (!validateRoot(path)) fail('file_missing'); }
function privateJson(path: string, limit: number): unknown { absolute(path); return parseJson(readPrivate(path, limit)); }
function profile(raw: unknown): McpProfile {
  const p = fields(raw, ['schemaVersion', 'transport', 'dataDir', 'expectedPolicySha256', 'policy'], 'invalid_profile');
  if (p['schemaVersion'] !== 1 || (p['transport'] !== 'streamable-http' && p['transport'] !== 'stdio')) fail('invalid_profile');
  absolute(p['dataDir']);
  if (p['expectedPolicySha256'] !== null && (typeof p['expectedPolicySha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(p['expectedPolicySha256']))) fail('invalid_profile');
  let policy: ConnectionPolicy;
  try { policy = validatePolicy(p['policy'] as ConnectionPolicy); } catch { return fail('invalid_profile'); }
  identifier(policy.ownerId); identifier(policy.connectionId); identifier(policy.endpoint.id);
  if (stdioEndpoint(policy.endpoint)) {
    if (policy.endpoint.credentialRef !== null || policy.endpoint.transport !== p['transport']) fail('invalid_reference');
  } else {
    if (policy.endpoint.credentialRef === null || !refPattern.test(policy.endpoint.credentialRef) || p['transport'] !== 'streamable-http') fail('invalid_reference');
  }
  if ([policy.endpoint.account, policy.endpoint.resource].some(value => /[\x00-\x1f\x7f]/.test(value))) fail('invalid_profile');
  if (policy.bounds.maxQueryChars > 16384 || policy.bounds.maxSearchLimit > 100 || policy.bounds.maxGetIds > 100 || policy.bounds.maxEntityBytes > 1048576 || policy.bounds.maxResultBytes > 1048576) fail('invalid_profile');
  return { schemaVersion: 1, transport: p['transport'] as 'streamable-http' | 'stdio', dataDir: p['dataDir'], expectedPolicySha256: p['expectedPolicySha256'] as string | null, policy };
}
function credential(raw: unknown): Credential {
  const c = fields(raw, ['schemaVersion', 'ownerId', 'connectionId', 'endpointId', 'url', 'account', 'resource', 'generation', 'credentialRef', 'token', 'enabled'], 'invalid_secret');
  if (c['schemaVersion'] !== 1 || typeof c['enabled'] !== 'boolean' || !Number.isSafeInteger(c['generation']) || Number(c['generation']) < 1) fail('invalid_secret');
  for (const key of ['ownerId', 'connectionId', 'endpointId', 'account', 'resource']) if (typeof c[key] !== 'string' || !(c[key] as string).length || (c[key] as string).length > 512 || /[\x00-\x1f\x7f]/.test(c[key] as string)) fail('invalid_secret');
  if (typeof c['url'] !== 'string' || (c['url'] as string).length > 4096 || /[\x00-\x1f\x7f]/.test(c['url'] as string)) fail('invalid_secret');
  if (c['credentialRef'] !== null && (typeof c['credentialRef'] !== 'string' || !refPattern.test(c['credentialRef'] as string))) fail('invalid_reference');
  if (typeof c['token'] !== 'string' || !/^[A-Za-z0-9._~+/=-]{0,8192}$/.test(c['token'])) fail('invalid_secret');
  return c as unknown as Credential;
}
function metadata(c: Credential): Omit<Credential, 'token'> { const { token: _token, ...binding } = c; return binding; }
function binding(p: McpProfile, c: Credential): void {
  const policy = p.policy; const e = policy.endpoint;
  if (c.ownerId !== policy.ownerId || c.connectionId !== policy.connectionId || c.endpointId !== e.id || c.account !== e.account || c.resource !== e.resource || c.generation !== policy.generation || (c.enabled && !policy.enabled)) fail('invalid_secret');
  if (stdioEndpoint(e)) { if (c.credentialRef !== null) fail('invalid_secret'); }
  else if (c.url !== (e as HttpConnectionEndpoint).url || c.credentialRef !== (e as HttpConnectionEndpoint).credentialRef) fail('invalid_secret');
}
function readSelection(target: Target): { intent: McpProfile; secret: Credential } {
  identifier(target.ownerId); absolute(target.dataDir); root(target.configDir);
  const intent = profile(privateJson(join(target.configDir, profileFile), profileLimit));
  const secret = credential(privateJson(join(target.configDir, credentialFile), secretLimit));
  if (intent.policy.ownerId !== target.ownerId || intent.dataDir !== target.dataDir) fail('invalid_profile');
  binding(intent, secret);
  return { intent, secret };
}
function loaded(target: Target, allowDisabled: boolean): McpConfiguration {
  const selected = readSelection(target); const selectionHash = sha256(canonicalJSON(selected.intent));
  const selectedBinding = canonicalJSON(metadata(selected.secret));
  const current = (reference: string | null): Credential => {
    if (reference !== selected.secret.credentialRef) fail('invalid_reference');
    const now = readSelection(target);
    if (sha256(canonicalJSON(now.intent)) !== selectionHash || canonicalJSON(metadata(now.secret)) !== selectedBinding || (!allowDisabled && (!now.secret.enabled || !now.intent.policy.enabled))) fail('invalid_secret');
    return now.secret;
  };
  const endpoint = selected.intent.policy.endpoint;
  return {
    intent: structuredClone(selected.intent), endpoint: stdioEndpoint(endpoint)
      ? { id: endpoint.id, transport: 'stdio' as const, command: endpoint.command, args: [...endpoint.args], ...(endpoint.env ? { env: { ...endpoint.env } } : {}), account: endpoint.account, resource: endpoint.resource }
      : { id: endpoint.id, url: (endpoint as HttpConnectionEndpoint).url, account: endpoint.account, resource: endpoint.resource, ...(selected.secret.credentialRef ? { credentialRef: selected.secret.credentialRef } : {}) },
    locallyDisabled: selected.intent.policy.enabled && !selected.secret.enabled,
    resolveCredential: async reference => current(reference).token,
    assertCredentialCurrent: reference => { current(reference); },
    assertCurrentBinding: () => { current(selected.secret.credentialRef); },
  };
}
/** No Store access. Locator checks are synchronous and compare only binding/selection, never token bytes. */
export function loadMcpConfiguration(target: Target): McpConfiguration { return loaded(target, false); }

function replacePrivate(configDir: string, name: string, value: unknown, limit: number): void {
  root(configDir); const destination = join(configDir, name); readPrivate(destination, limit);
  const temporary = join(configDir, `.pending-${randomUUID()}`); let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, canonicalJSON(value)); closeSync(fd); fd = undefined;
    renameSync(temporary, destination);
  } catch (e) { throw safeError(e); }
  finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
}
export function initMcpConfiguration(options: { configDir: string; ownerId: string; profileInput: string; credentialInput: string }): { state: 'pending' } {
  absolute(options.configDir); identifier(options.ownerId);
  const intent = profile(privateJson(options.profileInput, profileLimit)); const secret = credential(privateJson(options.credentialInput, secretLimit));
  binding(intent, secret);
  if (intent.policy.ownerId !== options.ownerId || intent.policy.enabled || secret.enabled || intent.expectedPolicySha256 !== null) fail('invalid_profile');
  try { mkdirSync(options.configDir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('destination_exists'); throw safeError(e); }
  try {
    root(options.configDir);
    writeFileSync(join(options.configDir, credentialFile), canonicalJSON(secret), { mode: 0o600, flag: 'wx' });
    writeFileSync(join(options.configDir, profileFile), canonicalJSON(intent), { mode: 0o600, flag: 'wx' });
  } catch { rmSync(options.configDir, { recursive: true, force: true }); fail('initialization_failed'); }
  return { state: 'pending' };
}
/** Operator supplies the complete reviewed intent/predecessor; no generation is invented here. */
export function approveMcpConfiguration(options: Target & { policyInput: string }): { state: 'pending' } {
  const selected = readSelection(options); const next = profile(privateJson(options.policyInput, profileLimit));
  if (next.dataDir !== options.dataDir || next.policy.ownerId !== options.ownerId || next.policy.connectionId !== selected.intent.policy.connectionId || canonicalJSON(next.policy.endpoint) !== canonicalJSON(selected.intent.policy.endpoint)) fail('invalid_profile');
  const secret = { ...selected.secret, generation: next.policy.generation, enabled: next.policy.enabled }; binding(next, secret);
  // Between replacements mismatched generations/selections fail closed. CLI never touches durable authority.
  replacePrivate(options.configDir, credentialFile, secret, secretLimit);
  replacePrivate(options.configDir, profileFile, next, profileLimit);
  return { state: 'pending' };
}
/** Local locator disable is immediate; durable revocation still needs a reviewed higher-generation intent. */
export function disableMcpConfiguration(options: Target): { state: 'pending' } {
  const selected = readSelection(options);
  replacePrivate(options.configDir, credentialFile, { ...selected.secret, enabled: false }, secretLimit);
  return { state: 'pending' };
}
export interface CatalogOptions { configDir: string; ownerId: string; allowEgress: boolean; limit: number; cursor?: string }
export async function catalogMcpConfiguration(options: CatalogOptions): Promise<{ state: 'catalog'; schemaDigest: string; toolNames: string[]; total: number; cursor: string | null; coverage: 'complete-tool-catalog-not-source-corpus' }> {
  if (!options.allowEgress || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 64) fail('invalid_arguments');
  root(options.configDir); const p = profile(privateJson(join(options.configDir, profileFile), profileLimit));
  const selected = loaded({ configDir: options.configDir, ownerId: options.ownerId, dataDir: p.dataDir }, true);
  const registry = new McpRegistry(); registry.register(selected.endpoint); registry.enable(selected.endpoint.id); registry.allowEgress(selected.endpoint.id);
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore(), resolveCredential: selected.resolveCredential, assertCredentialCurrent: selected.assertCredentialCurrent });
  try {
    const discovery = await adapter.discover(selected.endpoint.id); if (discovery.state !== 'discovered') fail('invalid_source');
    const names = discovery.tools.map(tool => tool.name);
    if (names.some(name => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))) fail('invalid_source');
    let offset = 0; const selection = sha256(canonicalJSON(selected.intent));
    if (options.cursor !== undefined) {
      if (typeof options.cursor !== 'string' || options.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) fail('invalid_arguments');
      const cursor = fields(parseJson(Buffer.from(options.cursor, 'base64url').toString('utf8')), ['digest', 'selection', 'offset'], 'invalid_arguments');
      if (cursor['digest'] !== discovery.schemaDigest || cursor['selection'] !== selection || !Number.isSafeInteger(cursor['offset']) || Number(cursor['offset']) < 1 || Number(cursor['offset']) >= names.length) fail('invalid_arguments');
      offset = Number(cursor['offset']);
    }
    const next = offset + options.limit;
    return { state: 'catalog', schemaDigest: discovery.schemaDigest, toolNames: names.slice(offset, next).map(name => name === 'search_knowledge' || name === 'get_insight' ? name : '<unapproved-tool>'), total: names.length,
      cursor: next < names.length ? Buffer.from(canonicalJSON({ digest: discovery.schemaDigest, selection, offset: next })).toString('base64url') : null,
      coverage: 'complete-tool-catalog-not-source-corpus' };
  } finally { await adapter.close(); }
}
export function mcpErrorCode(error: unknown): string { return error instanceof ConfigError ? error.code : 'io_error'; }
