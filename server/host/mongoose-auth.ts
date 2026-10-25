import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fields, parseJson, readPrivate } from '../config/files.js';
import { MONGOOSE_ENDPOINTS, MONGOOSE_ENDPOINT_PATHS, mongooseEndpointName, type MongooseEndpoint } from '../connectors/mongoose.js';
import { validateEndpointUrl } from '../adapters/mcp/registry.js';

/**
 * Host-owned OAuth state for the Mongoose connector. One record per endpoint, one writer (this host),
 * one file in the private provider-config directory. A schemaVersion 1 file keeps the pasted-bearer
 * path; a schemaVersion 3 record carries the OAuth tokens bound to one RFC 8707 resource URL and is
 * refreshed lazily, never on boot.
 *
 * The persisted record is the only place a token exists on disk. The typed errors below carry a
 * closed code and never a token, a URL query or a response body.
 */
export const MONGOOSE_RECORD_SCHEMA = 3;
/** One protected-resource probe is bounded, so a hung discovery never holds a bootstrap. */
export const MONGOOSE_DISCOVERY_TIMEOUT_MS = 5_000;
/** Exactly the keys the login writes and the runtime accepts, so doc and reader cannot drift. */
export const MONGOOSE_OAUTH_KEYS = ['schemaVersion', 'endpoint', 'resource', 'issuer', 'tokenEndpoint', 'clientId', 'redirectPort', 'account', 'accessToken', 'refreshToken', 'expiresAt', 'consentStartedAt'] as const;
export const MONGOOSE_RECORD_LIMIT = 8 * 1024;
/** Refresh this long before the advertised expiry so a request never races the deadline. */
export const MONGOOSE_REFRESH_MARGIN_MS = 120_000;
/** The server caps one consent family at 90 absolute days; a refresh never extends it. */
export const MONGOOSE_CONSENT_CAP_MS = 90 * 24 * 60 * 60 * 1000;
/** One owner line when the consent family is close to its cap and re-consent is near. */
export const MONGOOSE_CONSENT_WARN_MS = 5 * 24 * 60 * 60 * 1000;

export interface MongooseOAuthRecord {
  schemaVersion: typeof MONGOOSE_RECORD_SCHEMA;
  /** Which of the three endpoints this record signs in to; one record per endpoint. */
  endpoint: MongooseEndpoint;
  /** The canonical resource URL the grant is bound to: the configured origin plus the endpoint path. */
  resource: string;
  /** The authorization server that issued the grant: the configured origin. */
  issuer: string;
  /** Where the grant refreshes, on the issuer's origin. */
  tokenEndpoint: string;
  clientId: string;
  redirectPort: number;
  account: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token stops being accepted. */
  expiresAt: number;
  /** Epoch milliseconds of the first consent in this family; the 90 day cap is measured from here. */
  consentStartedAt: number;
}

/**
 * A refresh that never reached the server is its own code: a network blip is not a refusal, so the
 * host retries it instead of asking the owner to sign in again.
 */
export type MongooseCredentialCode = 'credential-missing' | 'credential-refresh-failed' | 'credential-refresh-unavailable' | 'credential-refresh-busy' | 'credential-consent-expired' | 'credential-unavailable';

export class MongooseCredentialError extends Error {
  constructor(readonly code: MongooseCredentialCode) { super(code); }
}

/** One endpoint's resource identity, computed once from trusted configuration, never from a discovery document. */
export interface MongooseBinding { endpoint: MongooseEndpoint; resource: string; issuer: string }

/** The one transport rule of the catalogue (validateEndpointUrl): https, or http on a literal loopback address. */
function trustedOrigin(url: URL): boolean {
  if (url.username || url.password || url.search || url.hash || url.href.includes('#') || url.href.includes('?')) return false;
  try { validateEndpointUrl(url.origin + '/'); } catch { return false; }
  return true;
}

/**
 * The binding a configured endpoint URL implies: its origin plus that endpoint's own path. A URL with
 * userinfo, a query, a fragment, another path or a transport the catalogue refuses has no binding.
 */
export function mongooseBinding(configuredUrl: string, endpoint: MongooseEndpoint): MongooseBinding | undefined {
  let url: URL;
  try { url = new URL(configuredUrl); } catch { return undefined; }
  if (!trustedOrigin(url) || url.pathname.replace(/\/$/, '') !== MONGOOSE_ENDPOINT_PATHS[endpoint]) return undefined;
  return { endpoint, resource: `${url.origin}${MONGOOSE_ENDPOINT_PATHS[endpoint]}`, issuer: url.origin };
}

/** The binding of one catalogue entry, by its resource label or its path; undefined for anything else. */
export function mongooseEntryBinding(entry: { resource: string; url?: string | undefined }): MongooseBinding | undefined {
  if (typeof entry.url !== 'string') return undefined;
  const endpoint = mongooseEndpointName(entry.resource) ?? mongooseEndpointName(entry.url);
  return endpoint === undefined ? undefined : mongooseBinding(entry.url, endpoint);
}

/** An https (or literal loopback) URL on exactly this origin, with no userinfo or fragment. */
export function onOrigin(value: unknown, origin: string): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.origin === origin && !url.username && !url.password && !url.hash && !value.includes('#') && trustedOrigin(new URL(url.origin));
}

function secret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Strict read of one schemaVersion 3 record; undefined for a missing, v1, v2 or malformed file. */
export function readMongooseOAuth(configDir: string, reference: string): MongooseOAuthRecord | undefined {
  let raw: unknown;
  try { raw = parseJson(readPrivate(join(configDir, `${reference}.json`), MONGOOSE_RECORD_LIMIT)); }
  catch { return undefined; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if ((raw as Record<string, unknown>)['schemaVersion'] !== MONGOOSE_RECORD_SCHEMA) return undefined;
  let record: Record<string, unknown>;
  try { record = fields(raw, MONGOOSE_OAUTH_KEYS, 'invalid_secret'); }
  catch { return undefined; }
  const { endpoint, resource, issuer, tokenEndpoint, clientId, redirectPort, account, accessToken, refreshToken, expiresAt, consentStartedAt } = record;
  if (typeof endpoint !== 'string' || !(MONGOOSE_ENDPOINTS as readonly string[]).includes(endpoint)) return undefined;
  if (typeof resource !== 'string' || typeof issuer !== 'string') return undefined;
  const binding = mongooseBinding(resource, endpoint as MongooseEndpoint);
  if (!binding || binding.resource !== resource || binding.issuer !== issuer || !onOrigin(tokenEndpoint, issuer)) return undefined;
  if (!secret(clientId) || !secret(account) || !secret(accessToken) || !secret(refreshToken)) return undefined;
  if (!Number.isSafeInteger(redirectPort) || (redirectPort as number) < 1 || (redirectPort as number) > 65535) return undefined;
  if (!timestamp(expiresAt) || !timestamp(consentStartedAt)) return undefined;
  return { schemaVersion: MONGOOSE_RECORD_SCHEMA, endpoint: endpoint as MongooseEndpoint, resource, issuer, tokenEndpoint: tokenEndpoint as string, clientId, redirectPort: redirectPort as number, account, accessToken, refreshToken, expiresAt: expiresAt as number, consentStartedAt: consentStartedAt as number };
}

/** Atomic replace: a private temp file in the same directory, then one rename. */
export function writeMongooseOAuth(configDir: string, reference: string, record: MongooseOAuthRecord): void {
  const target = join(configDir, `${reference}.json`);
  const temp = join(configDir, `.${reference}.json.${process.pid}.tmp`);
  const data = Buffer.from(JSON.stringify(record), 'utf8');
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    writeSync(fd, data, 0, data.length, 0);
    if (lstatSync(temp).isSymbolicLink()) throw new MongooseCredentialError('credential-refresh-failed');
    if (fstatSync(fd).size !== data.length) throw new MongooseCredentialError('credential-refresh-failed');
    closeSync(fd); fd = undefined;
    renameSync(temp, target);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    try { unlinkSync(temp); } catch { /* nothing to remove */ }
    throw error instanceof MongooseCredentialError ? error : new MongooseCredentialError('credential-refresh-failed');
  }
}

/** Why one endpoint's discovery was refused, a closed set the host log may name. */
export type MongooseDiscoveryReason = 'unreachable' | 'redirected' | 'http_status' | 'not_json' | 'resource_mismatch' | 'server_untrusted' | 'timeout';

/**
 * RFC 9728 discovery of one endpoint's protected-resource document, fetched only from the configured
 * origin with no redirect followed. Its `resource` must equal the expected URL exactly and its first
 * authorization server must be the configured origin, so a sibling endpoint's document is refused.
 */
export async function discoverMongooseResource(
  post: typeof fetch, binding: MongooseBinding, timeoutMs = MONGOOSE_DISCOVERY_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; reason: MongooseDiscoveryReason }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let document: Response;
    try {
      document = await post(`${binding.issuer}/.well-known/oauth-protected-resource${MONGOOSE_ENDPOINT_PATHS[binding.endpoint]}`,
        { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: controller.signal });
    } catch { return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'unreachable' }; }
    if (document.type === 'opaqueredirect' || (document.status >= 300 && document.status < 400)) return { ok: false, reason: 'redirected' };
    if (!document.ok) return { ok: false, reason: 'http_status' };
    let body: unknown;
    try { body = await document.json(); } catch { return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'not_json' }; }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'not_json' };
    if ((body as Record<string, unknown>)['resource'] !== binding.resource) return { ok: false, reason: 'resource_mismatch' };
    const servers = (body as Record<string, unknown>)['authorization_servers'];
    if (!Array.isArray(servers) || servers[0] !== binding.issuer) return { ok: false, reason: 'server_untrusted' };
    return { ok: true };
  } finally { clearTimeout(timer); }
}

/**
 * One 401 that advertises its protected-resource document is the token being refused for this endpoint:
 * a closed credential reason for this endpoint only, never a retry against another endpoint. Any other
 * status is not that verdict.
 */
export function mongooseCredentialRefusal(status: number, resourceMetadata: string | undefined): 'credential-unavailable' | undefined {
  return status === 401 && resourceMetadata !== undefined && resourceMetadata.length > 0 ? 'credential-unavailable' : undefined;
}

/** The startup presence check: a usable record exists, without refreshing and without any network. */
export function mongooseCredentialPresent(configDir: string, reference: string): boolean {  const record = readMongooseOAuth(configDir, reference);
  return record !== undefined && secret(record.refreshToken);
}

/**
 * One refresh at a time per record, in this process; a cross-process holder is a typed
 * `credential-refresh-busy` instead of a second token request. A rotating refresh token used twice
 * revokes the whole family, so the exclusive create is the guard, never a best-effort attempt.
 */
const inflight = new Map<string, Promise<string>>();

export interface MongooseAuthOptions {
  now?: () => number;
  fetch?: typeof fetch;
  /** One closed-token notice for the owner, never a message and never a token. */
  notify?: (reason: 'consent-expiring' | 'refresh-failed') => void;
}

/**
 * The access token for one endpoint. The record must be bound to exactly the binding the current
 * configuration implies; any other record, or no binding, is a sign-in and never a refresh.
 */
export async function mongooseAccessToken(configDir: string, reference: string, binding: MongooseBinding | undefined, options: MongooseAuthOptions = {}): Promise<string> {
  if (!binding) throw new MongooseCredentialError('credential-missing');
  const key = `${configDir}\u0000${reference}`;
  const running = inflight.get(key);
  if (running) return running;
  const started = resolveMongooseToken(configDir, reference, binding, options).finally(() => { inflight.delete(key); });
  inflight.set(key, started);
  return started;
}

const warned = new Set<string>();

const bound = (record: MongooseOAuthRecord, binding: MongooseBinding): boolean =>
  record.endpoint === binding.endpoint && record.resource === binding.resource && record.issuer === binding.issuer;

async function resolveMongooseToken(configDir: string, reference: string, binding: MongooseBinding, options: MongooseAuthOptions): Promise<string> {
  const now = options.now ?? Date.now;
  const record = readMongooseOAuth(configDir, reference);
  if (!record || !bound(record, binding)) throw new MongooseCredentialError('credential-missing');
  if (now() < record.expiresAt - MONGOOSE_REFRESH_MARGIN_MS) return record.accessToken;
  if (now() >= record.consentStartedAt + MONGOOSE_CONSENT_CAP_MS) throw new MongooseCredentialError('credential-consent-expired');
  const key = `${configDir}\u0000${reference}`;
  const release = acquireLock(configDir, reference, now);
  try {
    // Re-read under the lock: another writer may have rotated the family while we waited.
    const current = readMongooseOAuth(configDir, reference) ?? record;
    if (!bound(current, binding)) throw new MongooseCredentialError('credential-missing');
    if (now() < current.expiresAt - MONGOOSE_REFRESH_MARGIN_MS) return current.accessToken;
    let next: MongooseOAuthRecord;
    try { next = await refreshMongooseOAuth(current, options); }
    catch (error) { options.notify?.('refresh-failed'); throw error; }
    writeMongooseOAuth(configDir, reference, next);
    if (!warned.has(key) && now() >= next.consentStartedAt + MONGOOSE_CONSENT_CAP_MS - MONGOOSE_CONSENT_WARN_MS) {
      warned.add(key);
      options.notify?.('consent-expiring');
    }
    return next.accessToken;
  } finally { release(); }
}

function lockPath(configDir: string, reference: string): string { return join(configDir, `.${reference}.json.lock`); }

/** A refresh that died holding the lock is reclaimed after this long, so a crash cannot wedge the connector. */
export const MONGOOSE_LOCK_STALE_MS = 60_000;

/** Exclusive create, no waiting: one holder refreshes, every other caller gets a typed refusal. */
function acquireLock(configDir: string, reference: string, now: () => number): () => void {
  const path = lockPath(configDir, reference);
  const create = (): void => {
    let fd: number | undefined;
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(fd); fd = undefined; }
    catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
      throw error;
    }
  };
  try { create(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new MongooseCredentialError('credential-refresh-failed');
    let stale = false;
    try { stale = now() - statSync(path).mtimeMs > MONGOOSE_LOCK_STALE_MS; } catch { stale = false; }
    if (!stale) throw new MongooseCredentialError('credential-refresh-busy');
    try { unlinkSync(path); create(); }
    catch { throw new MongooseCredentialError('credential-refresh-busy'); }
  }
  return () => { try { unlinkSync(path); } catch { /* another writer already removed it */ } };
}

interface TokenResponse { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }

async function refreshMongooseOAuth(record: MongooseOAuthRecord, options: MongooseAuthOptions): Promise<MongooseOAuthRecord> {
  const now = options.now ?? Date.now;
  const post = options.fetch ?? fetch;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: record.refreshToken, client_id: record.clientId, resource: record.resource });
  let response: Response;
  try {
    response = await post(record.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, redirect: 'error' });
  } catch { throw new MongooseCredentialError('credential-refresh-unavailable'); }
  if (!response.ok) throw new MongooseCredentialError('credential-refresh-failed');
  let payload: TokenResponse;
  try { payload = await response.json() as TokenResponse; } catch { throw new MongooseCredentialError('credential-refresh-failed'); }
  const accessToken = payload.access_token;
  const refreshToken = payload.refresh_token;
  const expiresIn = payload.expires_in;
  if (!secret(accessToken) || !secret(refreshToken)) throw new MongooseCredentialError('credential-refresh-failed');
  if (!Number.isSafeInteger(expiresIn) || (expiresIn as number) < 1) throw new MongooseCredentialError('credential-refresh-failed');
  return { ...record, accessToken, refreshToken, expiresAt: now() + (expiresIn as number) * 1000 };
}
