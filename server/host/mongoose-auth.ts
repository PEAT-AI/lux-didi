import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fields, parseJson, readPrivate } from '../config/files.js';
import { MONGOOSE_ENDPOINTS, MONGOOSE_ENDPOINT_AUDIENCES, type MongooseEndpoint } from '../connectors/mongoose.js';

/**
 * Host-owned OAuth state for the Mongoose connector. One record, one writer (this host), one file in
 * the private provider-config directory. A schemaVersion 1 record keeps the pasted-bearer path; a
 * schemaVersion 2 record carries the OAuth tokens and is refreshed lazily, never on boot.
 *
 * The persisted record is the only place a token exists on disk. The typed errors below carry a
 * closed code and never a token, a URL query or a response body.
 */
export const MONGOOSE_RECORD_SCHEMA = 2;
/** One protected-resource probe is bounded, so a hung discovery never holds a bootstrap. */
export const MONGOOSE_DISCOVERY_TIMEOUT_MS = 5_000;
/** Exactly the keys the login writes and the runtime accepts, so doc and reader cannot drift. */
export const MONGOOSE_OAUTH_KEYS = ['schemaVersion', 'base', 'clientId', 'redirectPort', 'account', 'endpoint', 'audience', 'accessToken', 'refreshToken', 'expiresAt', 'consentStartedAt'] as const;
export const MONGOOSE_RECORD_LIMIT = 8 * 1024;
/** Refresh this long before the advertised expiry so a request never races the deadline. */
export const MONGOOSE_REFRESH_MARGIN_MS = 120_000;
/** The server caps one consent family at 90 absolute days; a refresh never extends it. */
export const MONGOOSE_CONSENT_CAP_MS = 90 * 24 * 60 * 60 * 1000;
/** One owner line when the consent family is close to its cap and re-consent is near. */
export const MONGOOSE_CONSENT_WARN_MS = 5 * 24 * 60 * 60 * 1000;

export interface MongooseOAuthRecord {
  schemaVersion: typeof MONGOOSE_RECORD_SCHEMA;
  /** Origin of the Mongoose server, no trailing slash: `https://host`. */
  base: string;
  clientId: string;
  redirectPort: number;
  account: string;
  /** Which of the three endpoints this record signs in to; one record per endpoint. */
  endpoint: MongooseEndpoint;
  /** The OAuth resource this token is bound to, and the only endpoint it may be presented at. */
  audience: string;
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

function secret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Strict read of one schemaVersion 2 record; undefined for a missing, v1 or malformed file. */
export function readMongooseOAuth(configDir: string, reference: string): MongooseOAuthRecord | undefined {
  let raw: unknown;
  try { raw = parseJson(readPrivate(join(configDir, `${reference}.json`), MONGOOSE_RECORD_LIMIT)); }
  catch { return undefined; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if ((raw as Record<string, unknown>)['schemaVersion'] !== MONGOOSE_RECORD_SCHEMA) return undefined;
  let record: Record<string, unknown>;
  try { record = fields(raw, MONGOOSE_OAUTH_KEYS, 'invalid_secret'); }
  catch { return undefined; }
  const { base, clientId, redirectPort, account, endpoint, audience, accessToken, refreshToken, expiresAt, consentStartedAt } = record;
  if (typeof base !== 'string' || !/^https?:\/\/[^\s/?#]+$/.test(base)) return undefined;
  if (typeof endpoint !== 'string' || !(MONGOOSE_ENDPOINTS as readonly string[]).includes(endpoint)) return undefined;
  if (typeof audience !== 'string' || audience !== MONGOOSE_ENDPOINT_AUDIENCES[endpoint as MongooseEndpoint]) return undefined;
  if (!secret(clientId) || !secret(account) || !secret(accessToken) || !secret(refreshToken)) return undefined;
  if (!Number.isSafeInteger(redirectPort) || (redirectPort as number) < 1 || (redirectPort as number) > 65535) return undefined;
  if (!timestamp(expiresAt) || !timestamp(consentStartedAt)) return undefined;
  return { schemaVersion: MONGOOSE_RECORD_SCHEMA, base, clientId, redirectPort: redirectPort as number, account, endpoint: endpoint as MongooseEndpoint, audience, accessToken, refreshToken, expiresAt: expiresAt as number, consentStartedAt: consentStartedAt as number };
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

/**
 * RFC 9728 discovery of one endpoint's protected-resource document: the audience the token must be
 * bound to and the authorization server that issues it. A document that names another audience is
 * undefined, so a data token can never be handed to the knowledge endpoint.
 */
export async function discoverMongooseResource(
  post: typeof fetch, resourceUrl: string, audience: string, timeoutMs = MONGOOSE_DISCOVERY_TIMEOUT_MS,
): Promise<{ audience: string; authorizationServer: string } | undefined> {
  let target: URL;
  try { target = new URL(resourceUrl); } catch { return undefined; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const document = await post(`${target.origin}/.well-known/oauth-protected-resource${target.pathname.replace(/\/$/, '')}`,
      { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
    if (!document.ok) return undefined;
    const body: unknown = await document.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const declared = (body as Record<string, unknown>)['resource'];
    if (declared !== audience) return undefined;
    const servers = (body as Record<string, unknown>)['authorization_servers'];
    const issuer = Array.isArray(servers) && secret(servers[0]) ? servers[0] : target.origin;
    return { audience, authorizationServer: issuer };
  } catch { return undefined; } finally { clearTimeout(timer); }
}

/**
 * One 401 that advertises its protected-resource document is the token being refused for this audience:
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

export async function mongooseAccessToken(configDir: string, reference: string, options: MongooseAuthOptions = {}): Promise<string> {
  const key = `${configDir}\u0000${reference}`;
  const running = inflight.get(key);
  if (running) return running;
  const started = resolveMongooseToken(configDir, reference, options).finally(() => { inflight.delete(key); });
  inflight.set(key, started);
  return started;
}

const warned = new Set<string>();

async function resolveMongooseToken(configDir: string, reference: string, options: MongooseAuthOptions): Promise<string> {
  const now = options.now ?? Date.now;
  const record = readMongooseOAuth(configDir, reference);
  if (!record) throw new MongooseCredentialError('credential-missing');
  if (now() < record.expiresAt - MONGOOSE_REFRESH_MARGIN_MS) return record.accessToken;
  if (now() >= record.consentStartedAt + MONGOOSE_CONSENT_CAP_MS) throw new MongooseCredentialError('credential-consent-expired');
  const key = `${configDir}\u0000${reference}`;
  const release = acquireLock(configDir, reference, now);
  try {
    // Re-read under the lock: another writer may have rotated the family while we waited.
    const current = readMongooseOAuth(configDir, reference) ?? record;
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
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: record.refreshToken, client_id: record.clientId, resource: record.audience });
  let response: Response;
  try {
    response = await post(`${record.base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
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
