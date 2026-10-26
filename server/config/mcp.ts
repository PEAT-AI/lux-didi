import type { DataClass } from '../adapters/model/types.js';
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
import { validateApprovedStdioEnv, validateEndpointUrl } from '../adapters/mcp/registry.js';
import { ConfigError, fail, fields, parseJson, readPrivate, safeError, validateRoot } from './files.js';

export interface McpProfile extends ConnectionIntent {
  schemaVersion: 1; transport: 'streamable-http' | 'stdio'; dataDir: string;
}
interface HttpCredential {
  schemaVersion: 1; ownerId: string; connectionId: string; endpointId: string; url: string;
  account: string; resource: string; generation: number; credentialRef: string; token: string; enabled: boolean;
}
/** Protected locator arm for an explicit local executable; no HTTP-shaped fields. */
interface StdioCredential {
  schemaVersion: 1; ownerId: string; connectionId: string; endpointId: string; transport: 'stdio'; command: string; args: readonly string[];
  env: Readonly<Record<string, string>>; account: string; resource: string; generation: number; enabled: boolean;
}
type Credential = HttpCredential | StdioCredential;
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
function isStdioCredential(c: Credential): c is StdioCredential { return (c as { transport?: unknown }).transport === 'stdio'; }
function credential(raw: unknown): Credential {
  const stdio = raw !== null && typeof raw === 'object' && !Array.isArray(raw) && (raw as { transport?: unknown }).transport === 'stdio';
  return stdio ? stdioCredential(raw) : httpCredential(raw);
}
function httpCredential(raw: unknown): HttpCredential {
  const c = fields(raw, ['schemaVersion', 'ownerId', 'connectionId', 'endpointId', 'url', 'account', 'resource', 'generation', 'credentialRef', 'token', 'enabled'], 'invalid_secret');
  if (c['schemaVersion'] !== 1 || typeof c['enabled'] !== 'boolean' || !Number.isSafeInteger(c['generation']) || Number(c['generation']) < 1) fail('invalid_secret');
  for (const key of ['ownerId', 'connectionId', 'endpointId', 'account', 'resource']) if (typeof c[key] !== 'string' || !(c[key] as string).length || (c[key] as string).length > 512 || /[\x00-\x1f\x7f]/.test(c[key] as string)) fail('invalid_secret');
  if (typeof c['url'] !== 'string' || (c['url'] as string).length > 4096 || /[\x00-\x1f\x7f]/.test(c['url'] as string)) fail('invalid_secret');
  if (typeof c['credentialRef'] !== 'string' || !refPattern.test(c['credentialRef'] as string)) fail('invalid_reference');
  if (typeof c['token'] !== 'string' || !/^[A-Za-z0-9._~+/=-]{1,8192}$/.test(c['token'])) fail('invalid_secret');
  return c as unknown as HttpCredential;
}
/** Protected stdio locator arm: absolute command, ordered args, minimal env; no url/token/credentialRef. */
function stdioCredential(raw: unknown): StdioCredential {
  const c = fields(raw, ['schemaVersion', 'ownerId', 'connectionId', 'endpointId', 'transport', 'command', 'args', 'env', 'account', 'resource', 'generation', 'enabled'], 'invalid_secret');
  if (c['schemaVersion'] !== 1 || c['transport'] !== 'stdio' || typeof c['enabled'] !== 'boolean' || !Number.isSafeInteger(c['generation']) || Number(c['generation']) < 1) fail('invalid_secret');
  for (const key of ['ownerId', 'connectionId', 'endpointId', 'command', 'account', 'resource']) if (typeof c[key] !== 'string' || !(c[key] as string).length || (c[key] as string).length > 4096 || /[\x00-\x1f\x7f]/.test(c[key] as string)) fail('invalid_secret');
  if (!isAbsolute(c['command'] as string) || !Array.isArray(c['args']) || (c['args'] as unknown[]).some(arg => typeof arg !== 'string')) fail('invalid_secret');
  const env = c['env'];
  if (!validateApprovedStdioEnv(env)) fail('invalid_secret');
  return c as unknown as StdioCredential;
}
function metadata(c: Credential): unknown {
  if (isStdioCredential(c)) return structuredClone(c);
  const { token: _token, ...binding } = c; return binding;
}
function binding(p: McpProfile, c: Credential): void {
  const policy = p.policy; const e = policy.endpoint;
  if (c.ownerId !== policy.ownerId || c.connectionId !== policy.connectionId || c.endpointId !== e.id || c.account !== e.account || c.resource !== e.resource || c.generation !== policy.generation || (c.enabled && !policy.enabled)) fail('invalid_secret');
  if (stdioEndpoint(e)) {
    if (!isStdioCredential(c) || c.command !== e.command || JSON.stringify([...c.args]) !== JSON.stringify([...e.args]) || canonicalJSON(c.env) !== canonicalJSON(e.env ?? {})) fail('invalid_secret');
  } else if (isStdioCredential(c) || c.url !== (e as HttpConnectionEndpoint).url || c.credentialRef !== (e as HttpConnectionEndpoint).credentialRef) fail('invalid_secret');
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
  const selectedCredentialRef = isStdioCredential(selected.secret) ? null : selected.secret.credentialRef;
  const current = (reference: string | null): Credential => {
    if (reference !== selectedCredentialRef) fail('invalid_reference');
    const now = readSelection(target);
    if (sha256(canonicalJSON(now.intent)) !== selectionHash || canonicalJSON(metadata(now.secret)) !== selectedBinding || (!allowDisabled && (!now.secret.enabled || !now.intent.policy.enabled))) fail('invalid_secret');
    return now.secret;
  };
  const endpoint = selected.intent.policy.endpoint;
  return {
    intent: structuredClone(selected.intent), endpoint: stdioEndpoint(endpoint)
      ? { id: endpoint.id, transport: 'stdio' as const, command: endpoint.command, args: [...endpoint.args], ...(endpoint.env ? { env: { ...endpoint.env } } : {}), account: endpoint.account, resource: endpoint.resource }
      : { id: endpoint.id, url: (endpoint as HttpConnectionEndpoint).url, account: endpoint.account, resource: endpoint.resource, ...(selectedCredentialRef ? { credentialRef: selectedCredentialRef } : {}) },
    locallyDisabled: selected.intent.policy.enabled && !selected.secret.enabled,
    resolveCredential: async reference => { const c = current(reference); if (isStdioCredential(c)) fail('invalid_reference'); return c.token; },
    assertCredentialCurrent: reference => { current(reference); },
    assertCurrentBinding: () => { current(selectedCredentialRef); },
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

const endpointFile = 'mcp.json';
const endpointLimit = 32768;
/** An optional operator-asserted owner email; absence is the deliberate public default. */
function optionalIdentity(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail('invalid_profile');
  return value;
}
/** An optional operator-asserted chat username, compared exactly against a chat connector's own username. */
function optionalUsername(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) fail('invalid_profile');
  return value;
}
/** Installed <dataDir>/provider-config/mcp.json: a small, owner-only, secret-free endpoint catalog. */export interface HttpMcpEndpointEntry {
  id: string; transport: 'streamable-http'; url: string; connector: string;
  unknownClass: DataClass | null; configurationError?: 'unknown-class-missing' | 'unknown-class-invalid' | 'identity_mismatch';
  account: string; resource: string; credentialRef: string | null; enabled: boolean; allowEgress: boolean;
}
/** The stdio arm names an absolute local executable, ordered args and the approved env; no url/credentialRef. */
export interface StdioMcpEndpointEntry {
  unknownClass: DataClass | null; configurationError?: 'unknown-class-missing' | 'unknown-class-invalid' | 'identity_mismatch';
  id: string; transport: 'stdio'; command: string; args: readonly string[]; env: Readonly<Record<string, string>>;
  connector: string; account: string; resource: string; credentialRef: null; enabled: boolean; allowEgress: boolean;
}
export type McpEndpointEntry = HttpMcpEndpointEntry | StdioMcpEndpointEntry;
export interface McpEndpointCatalog { grantMode: 'explicit' | 'owner-trusted-reads'; endpoints: readonly McpEndpointEntry[]; ownerIdentity: string | null; ownerChatUsername: string | null }
export type McpEndpointSelection = { state: 'missing' } | { state: 'configured'; catalog: McpEndpointCatalog };
function endpointUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) fail('invalid_profile');
  try { validateEndpointUrl(value); } catch { fail('invalid_profile'); }
  return value;
}
function entryAccount(e: Record<string, unknown>): void {
  for (const key of ['account', 'resource'] as const) if (typeof e[key] !== 'string' || !(e[key] as string).length || (e[key] as string).length > 512 || /[\x00-\x1f\x7f]/.test(e[key] as string)) fail('invalid_profile');
}
function stdioEndpointEntry(raw: unknown): Omit<StdioMcpEndpointEntry, 'unknownClass' | 'configurationError'> {
  const e = fields(raw, ['id', 'transport', 'command', 'args', 'env', 'connector', 'account', 'resource', 'credentialRef', 'enabled', 'allowEgress'], 'invalid_profile');
  identifier(e['id']); identifier(e['connector']);
  const command = e['command'];
  if (typeof command !== 'string' || !command.length || command.length > 4096 || command.includes('\0') || !isAbsolute(command) || normalize(command) !== command) fail('invalid_profile');
  const args = e['args'];
  if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) fail('invalid_profile');
  if (!validateApprovedStdioEnv(e['env'])) fail('invalid_profile');
  entryAccount(e);
  if (e['credentialRef'] !== null) fail('invalid_reference');
  if (typeof e['enabled'] !== 'boolean' || typeof e['allowEgress'] !== 'boolean') fail('invalid_profile');
  return { id: e['id'] as string, transport: 'stdio', command, args: [...(args as string[])], env: { ...(e['env'] as Record<string, string>) }, connector: e['connector'] as string, account: e['account'] as string, resource: e['resource'] as string, credentialRef: null, enabled: e['enabled'] as boolean, allowEgress: e['allowEgress'] as boolean };
}
function endpointEntry(raw: unknown): McpEndpointEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_profile');
  const { unknownClass, ...binding } = raw as Record<string, unknown>;
  const classification: Pick<HttpMcpEndpointEntry, 'unknownClass' | 'configurationError'> = ['ordinary', 'private', 'sensitive'].includes(String(unknownClass)) && typeof unknownClass === 'string'
    ? { unknownClass: unknownClass as DataClass }
    : { unknownClass: null, configurationError: unknownClass === undefined ? 'unknown-class-missing' : 'unknown-class-invalid' };
  if (binding['transport'] === 'stdio') return { ...stdioEndpointEntry(binding), ...classification };
  const e = fields(binding, ['id', 'transport', 'url', 'connector', 'account', 'resource', 'credentialRef', 'enabled', 'allowEgress'], 'invalid_profile');
  identifier(e['id']); identifier(e['connector']);
  if (e['transport'] !== 'streamable-http') fail('invalid_profile');
  const url = endpointUrl(e['url']);
  entryAccount(e);
  const credentialRef = e['credentialRef'];
  if (credentialRef !== null && (typeof credentialRef !== 'string' || !refPattern.test(credentialRef))) fail('invalid_reference');
  if (typeof e['enabled'] !== 'boolean' || typeof e['allowEgress'] !== 'boolean') fail('invalid_profile');
  if (e['connector'] === mongooseConnector) mongooseEndpointEntry(url, e['resource'], credentialRef);
  return { ...classification, id: e['id'] as string, transport: 'streamable-http', url, connector: e['connector'] as string, account: e['account'] as string, resource: e['resource'] as string, credentialRef: credentialRef as string | null, enabled: e['enabled'], allowEgress: e['allowEgress'] };
}
const mongooseConnector = 'mongoose';
const mongoosePaths = ['/mcp/knowledge', '/mcp/data', '/mcp/crm'] as const;
const mongooseAudiences = ['mongoose:knowledge', 'mongoose:data', 'mongoose:crm'] as const;
const mongooseReferences = ['mongoose-knowledge', 'mongoose-data', 'mongoose-crm'] as const;

/** One host log record for a legacy catalogue the loader replaced; the boot path owns the sink. */
export type McpCatalogueEvents = (event: { event: string; endpoints: number }) => void;

/**
 * Release 9 stored one Mongoose endpoint at `/mcp` under the retired single `mongoose` audience.
 * The owner's installation is replaced rather than migrated field by field: the three release-1023b
 * endpoints take its place the first time the catalogue is read, each with its own reference and
 * with no stored token, so every one of them reports not signed in until the owner signs in.
 * Every other shape is left to the strict validation below, which refuses it.
 */
function replaceInstalledMongoose(rawEndpoints: readonly unknown[], events: McpCatalogueEvents | undefined): readonly unknown[] {
  const mongoose = rawEndpoints.filter(item => item !== null && typeof item === 'object' && (item as Record<string, unknown>)['connector'] === mongooseConnector);
  if (mongoose.length !== 1) return rawEndpoints;
  const legacy = mongoose[0] as Record<string, unknown>;
  const url = legacy['url'];
  if (legacy['resource'] !== mongooseConnector || typeof url !== 'string') return rawEndpoints;
  let origin: string;
  try {
    const parsed = new URL(url);
    if (parsed.pathname.replace(/\/$/, '') !== '/mcp' || parsed.search !== '') return rawEndpoints;
    origin = parsed.origin;
  } catch { return rawEndpoints; }
  const unknownClass = legacy['unknownClass'];
  const replacements = mongooseReferences.map((reference, index) => ({
    id: reference, transport: 'streamable-http', url: `${origin}${mongoosePaths[index]}`, connector: mongooseConnector,
    account: legacy['account'], resource: mongooseAudiences[index], credentialRef: reference,
    enabled: legacy['enabled'], allowEgress: legacy['allowEgress'],
    ...(unknownClass !== undefined ? { unknownClass } : {}),
  }));
  events?.({ event: 'mongoose_catalogue_replaced', endpoints: replacements.length });
  return rawEndpoints.flatMap(item => (item === legacy ? replacements : [item]));
}

/**
 * One Mongoose endpoint: exactly one of the three release-1023b paths, its own audience and its own
 * credential reference. `/mcp`, `/mcp/`, a toolset query, a retired name and admin are all refused,
 * because a token bound to one audience is refused on another and admin is never connected.
 */
function mongooseEndpointEntry(url: string, resource: unknown, credentialRef: string | null): void {
  if (typeof resource !== 'string' || !(mongooseAudiences as readonly string[]).includes(resource)) fail('invalid_source');
  if (credentialRef === null) fail('invalid_source');
  let path: string;
  try { path = new URL(url).pathname.replace(/\/$/, ''); } catch { return fail('invalid_source'); }
  if (!(mongoosePaths as readonly string[]).includes(path)) fail('invalid_source');
  if (path.replace('/mcp/', 'mongoose:') !== resource) fail('invalid_source');
}

/**
 * D1-R4: every Google child must pin the helper to the owner account. The helper compares the refreshed
 * id_token's verified email with `LUX_GOOGLE_MCP_ACCOUNT` and refuses every read otherwise
 * (lux-cli tools/google-mcp/google_mcp/creds.py, assert_identity), so a child pinned elsewhere, or not
 * pinned at all, can only act as another account or not prove one. Such a child is refused with
 * `identity_mismatch` at catalog load, before any spawn; the comparison is exact and case-insensitive.
 */
function googleAccountPins(endpoints: readonly McpEndpointEntry[], ownerIdentity: string | null): readonly McpEndpointEntry[] {
  if (ownerIdentity === null) return endpoints;
  const owner = ownerIdentity.trim().toLowerCase();
  return endpoints.map(endpoint => {
    if (endpoint.connector !== 'google' || endpoint.transport !== 'stdio') return endpoint;
    const pinned = endpoint.env['LUX_GOOGLE_MCP_ACCOUNT'];
    if (typeof pinned === 'string' && pinned.trim().toLowerCase() === owner) return endpoint;
    return { ...endpoint, configurationError: 'identity_mismatch' as const };
  });
}

/** The catalog carries all three Mongoose endpoints, once each, with three distinct resources and refs. */
function mongooseEndpointSet(endpoints: readonly McpEndpointEntry[]): void {
  const mongoose = endpoints.filter(endpoint => endpoint.connector === mongooseConnector);
  if (!mongoose.length) return;
  if (mongoose.length !== mongoosePaths.length) fail('invalid_source');
  if (new Set(mongoose.map(endpoint => endpoint.resource)).size !== mongoosePaths.length) fail('invalid_source');
  if (new Set(mongoose.map(endpoint => endpoint.credentialRef)).size !== mongoosePaths.length) fail('invalid_source');
  if (new Set(mongoose.map(endpoint => endpoint.id)).size !== mongoosePaths.length) fail('invalid_source');
}

/** Missing mcp.json is a defined state, never an error: startup continues with no approved source. */
export function loadMcpEndpoints(options: { configDir: string; events?: McpCatalogueEvents }): McpEndpointSelection {
  const { configDir, events } = options;
  if (typeof configDir !== 'string' || !isAbsolute(configDir) || normalize(configDir) !== configDir) fail('invalid_arguments');
  if (!validateRoot(configDir)) return { state: 'missing' };
  let raw: string;
  try { raw = readPrivate(join(configDir, endpointFile), endpointLimit); }
  catch (error) { if (error instanceof ConfigError && error.code === 'file_missing') return { state: 'missing' }; throw error; }
  const parsed = parseJson(raw);
  const present = (key: string): boolean => parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, key);
  const optionalGrantMode = present('grantMode');
  const file = fields(parsed, ['schemaVersion', ...(optionalGrantMode ? ['grantMode'] : []), ...(present('ownerIdentity') ? ['ownerIdentity'] : []), ...(present('ownerChatUsername') ? ['ownerChatUsername'] : []), 'endpoints'], 'invalid_profile');
  if (file['schemaVersion'] !== 1) fail('invalid_profile');
  const ownerIdentity = optionalIdentity(file['ownerIdentity']);
  const ownerChatUsername = optionalUsername(file['ownerChatUsername']);
  const grantMode = file['grantMode'] ?? 'explicit';
  if (grantMode !== 'explicit' && grantMode !== 'owner-trusted-reads') fail('invalid_profile');
  const rawEndpoints = file['endpoints'];
  if (!Array.isArray(rawEndpoints) || rawEndpoints.length > 64) fail('invalid_profile');
  const seen = new Set<string>(); const endpoints: McpEndpointEntry[] = [];
  for (const item of replaceInstalledMongoose(rawEndpoints, events)) { const entry = endpointEntry(item); if (seen.has(entry.id)) fail('invalid_profile'); seen.add(entry.id); endpoints.push(entry); }
  mongooseEndpointSet(endpoints);
  return { state: 'configured', catalog: { grantMode, endpoints: googleAccountPins(endpoints, ownerIdentity), ownerIdentity, ownerChatUsername } };
}
