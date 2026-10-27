import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fields, parseJson, readPrivate } from '../config/files.js';
import { validateEndpointUrl } from '../adapters/mcp/registry.js';

/**
 * The host's one OAuth client for a remote MCP resource the owner signs in to (Mongoose endpoints, the
 * Trello board). One binding is computed from trusted configuration and carried through the whole
 * transaction: the resource URL, the issuer the resource must name, and the issuer's origin, on which
 * every authorization server endpoint must sit. Discovery never widens it.
 *
 * Every failure is one closed code; no URL query, response body, code, state, verifier or token leaves.
 */
export const OAUTH_RECORD_SCHEMA = 3;
/** One protected-resource probe is bounded, so a hung discovery never holds a bootstrap. */
export const OAUTH_DISCOVERY_TIMEOUT_MS = 5_000;
/** Exactly the keys the login writes and the runtime accepts, so doc and reader cannot drift. */
export const OAUTH_RECORD_KEYS = ['schemaVersion', 'endpoint', 'resource', 'issuer', 'tokenEndpoint', 'clientId', 'redirectPort', 'account', 'accessToken', 'refreshToken', 'expiresAt', 'consentStartedAt', 'identity'] as const;
export const OAUTH_RECORD_LIMIT = 8 * 1024;
/** Refresh this long before the advertised expiry so a request never races the deadline. */
export const OAUTH_REFRESH_MARGIN_MS = 120_000;
/** A refresh that died holding the lock is reclaimed after this long, so a crash cannot wedge the connector. */
export const OAUTH_LOCK_STALE_MS = 60_000;
export const OAUTH_LOGIN_TIMEOUT_MS = 300_000;

/** One resource identity: which record it is, the resource URL, and the issuer the grant must come from. */
export interface OAuthBinding { endpoint: string; resource: string; issuer: string }

export interface OAuthRecord {
  schemaVersion: typeof OAUTH_RECORD_SCHEMA;
  endpoint: string;
  resource: string;
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  redirectPort: number;
  account: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token stops being accepted. */
  expiresAt: number;
  /** Epoch milliseconds of the first consent in this family. */
  consentStartedAt: number;
  /**
   * The owner email the issuer minted into the token and the token check accepted, so Settings can say
   * who a connector is signed in as without a connect. It never reaches host.log.
   */
  identity?: string;
}

export type OAuthCredentialCode = 'credential-missing' | 'credential-refresh-failed' | 'credential-refresh-unavailable' | 'credential-refresh-busy' | 'credential-consent-expired' | 'credential-unavailable'
  // The minted token's own claims name another account, or cannot be decoded at all. A new sign-in is
  // the only repair, so the endpoint parks on it (identity_mismatch / identity_unverified).
  | 'credential-identity-mismatch' | 'credential-identity-unverified';
export class OAuthCredentialError extends Error {
  constructor(readonly code: OAuthCredentialCode) { super(code); }
}

export type OAuthLoginCode = 'metadata-unavailable' | 'registration-refused' | 'port-in-use' | 'state-mismatch' | 'authorization-refused' | 'token-refused' | 'browser-unavailable' | 'timeout' | 'endpoint-not-allowed'
  | 'account-mismatch' | 'identity-mismatch' | 'identity-unverified';
export class OAuthLoginError extends Error {
  constructor(readonly code: OAuthLoginCode) { super(code); }
}

/** The RFC 6749 error codes a refused token request may name; anything else is not repeated. */
export const OAUTH_ERRORS = ['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'invalid_target', 'access_denied'] as const;
export type OAuthError = (typeof OAUTH_ERRORS)[number];

/** Why one resource's discovery was refused, a closed set the host log may name. */
export type OAuthDiscoveryReason = 'unreachable' | 'redirected' | 'http_status' | 'not_json' | 'resource_mismatch' | 'server_untrusted' | 'timeout';

/** One hop of a sign-in and how it ended, content-free: never a URL, code, state, verifier or token. */
export type OAuthSignInHop =
  | { hop: 'discovery'; outcome: 'ok' | OAuthDiscoveryReason | 'config_invalid' | 'metadata_unreachable' | 'metadata_invalid' | 'issuer_mismatch' | 'endpoint_off_origin' }
  | { hop: 'registration'; outcome: 'ok' | 'port_in_use' | 'refused' | 'timeout' }
  | { hop: 'browser_handoff'; outcome: 'ok' | 'unavailable' | 'timeout' }
  | { hop: 'callback'; outcome: 'ok' | 'state_mismatch' | 'authorization_refused' | 'account_mismatch' | 'timeout' }
  | { hop: 'token'; outcome: 'ok' | 'unreachable' | 'timeout' }
  | { hop: 'token'; outcome: 'refused'; oauthError?: OAuthError }
  | { hop: 'token'; outcome: 'identity_mismatch' | 'identity_unverified' }
  | { hop: 'stored'; outcome: 'ok' | 'failed' };
type HopName = OAuthSignInHop['hop'];

/** The one transport rule of the catalogue (validateEndpointUrl): https, or http on a literal loopback address. */
export function trustedOrigin(url: URL): boolean {
  if (url.username || url.password || url.search || url.hash || url.href.includes('#') || url.href.includes('?')) return false;
  try { validateEndpointUrl(url.origin + '/'); } catch { return false; }
  return true;
}

/** A strict identity URL: a trusted origin, no userinfo, query or fragment, no trailing slash, nothing normalised. */
export function strictIdentityUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (!trustedOrigin(url)) return false;
  return !value.endsWith('/') && value === `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
}

/** A binding from trusted configuration, or nothing when either identity is not strict. */
export function oauthBinding(endpoint: string, resource: string, issuer: string): OAuthBinding | undefined {
  return strictIdentityUrl(resource) && strictIdentityUrl(issuer) ? { endpoint, resource, issuer } : undefined;
}

/** The issuer's origin: every authorization server endpoint must sit on it. */
export function issuerOrigin(issuer: string): string { return new URL(issuer).origin; }

/** An https (or literal loopback) URL on exactly this origin, with no userinfo or fragment. */
export function onOrigin(value: unknown, origin: string): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.origin === origin && !url.username && !url.password && !url.hash && !value.includes('#') && trustedOrigin(new URL(url.origin));
}

/** RFC 9728 path insertion: the resource's own protected-resource document on the resource's origin. */
export function protectedResourceDocumentUrl(resource: string): string {
  const url = new URL(resource);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname === '/' ? '' : url.pathname}`;
}

/** RFC 8414 path insertion: the issuer's metadata document on the issuer's origin. */
export function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  return `${url.origin}/.well-known/oauth-authorization-server${url.pathname === '/' ? '' : url.pathname}`;
}

function secret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}
function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * Strict read of one schemaVersion 3 record; undefined for a missing, older or malformed file, or one
 * whose endpoint, resource and issuer are not exactly a binding the caller accepts.
 */
export function readOAuthRecord(configDir: string, reference: string, accept: (endpoint: string, resource: string) => OAuthBinding | undefined): OAuthRecord | undefined {
  let raw: unknown;
  try { raw = parseJson(readPrivate(join(configDir, `${reference}.json`), OAUTH_RECORD_LIMIT)); }
  catch { return undefined; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if ((raw as Record<string, unknown>)['schemaVersion'] !== OAUTH_RECORD_SCHEMA) return undefined;
  // A record written before the claim was kept carries no such key; it stays valid and its claim is
  // proven again at the next connect.
  if ((raw as Record<string, unknown>)['identity'] === undefined) (raw as Record<string, unknown>)['identity'] = '';
  let record: Record<string, unknown>;
  try { record = fields(raw, OAUTH_RECORD_KEYS, 'invalid_secret'); }
  catch { return undefined; }
  const { endpoint, resource, issuer, tokenEndpoint, clientId, redirectPort, account, accessToken, refreshToken, expiresAt, consentStartedAt, identity } = record;
  if (typeof endpoint !== 'string' || typeof resource !== 'string' || typeof issuer !== 'string') return undefined;
  const binding = accept(endpoint, resource);
  if (!binding || binding.endpoint !== endpoint || binding.resource !== resource || binding.issuer !== issuer || !onOrigin(tokenEndpoint, issuerOrigin(issuer))) return undefined;
  if (!secret(clientId) || !secret(account) || !secret(accessToken) || !secret(refreshToken)) return undefined;
  if (!Number.isSafeInteger(redirectPort) || (redirectPort as number) < 1 || (redirectPort as number) > 65535) return undefined;
  if (!timestamp(expiresAt) || !timestamp(consentStartedAt)) return undefined;
  // The claim is the owner's address or nothing: a malformed one is a malformed record.
  if (typeof identity !== 'string' || identity.length > 254) return undefined;
  return { schemaVersion: OAUTH_RECORD_SCHEMA, endpoint, resource, issuer, tokenEndpoint: tokenEndpoint as string, clientId, redirectPort: redirectPort as number, account, accessToken, refreshToken, expiresAt: expiresAt as number, consentStartedAt: consentStartedAt as number, identity };
}

/** Atomic replace: a private temp file in the same directory, then one rename. */
export function writeOAuthRecord(configDir: string, reference: string, record: OAuthRecord): void {
  const target = join(configDir, `${reference}.json`);
  const temp = join(configDir, `.${reference}.json.${process.pid}.tmp`);
  // Exactly the closed key set every time: the claim is written empty when no token check proved one.
  const data = Buffer.from(JSON.stringify({ ...record, identity: record.identity ?? '' }), 'utf8');
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    writeSync(fd, data, 0, data.length, 0);
    if (lstatSync(temp).isSymbolicLink()) throw new OAuthCredentialError('credential-refresh-failed');
    if (fstatSync(fd).size !== data.length) throw new OAuthCredentialError('credential-refresh-failed');
    closeSync(fd); fd = undefined;
    renameSync(temp, target);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    try { unlinkSync(temp); } catch { /* nothing to remove */ }
    throw error instanceof OAuthCredentialError ? error : new OAuthCredentialError('credential-refresh-failed');
  }
}

/**
 * RFC 9728 discovery of one resource's protected-resource document, fetched only from the resource's own
 * origin with no redirect followed. Its `resource` must equal the expected URL exactly and its first
 * authorization server must be the configured issuer, so a sibling resource's document is refused.
 */
export async function discoverProtectedResource(
  post: typeof fetch, binding: OAuthBinding, timeoutMs = OAUTH_DISCOVERY_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; reason: OAuthDiscoveryReason }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let document: Response;
    try {
      document = await post(protectedResourceDocumentUrl(binding.resource),
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

/** What one provider's sign-in needs beyond the binding: its scope, client name, callback words and port. */
export interface OAuthProvider {
  /** The space-separated scope sent at registration and on the authorize request. */
  scope: string;
  clientName: string;
  /** The provider name on the callback page the owner's browser shows. */
  label: string;
  defaultPort: number;
}

export interface OAuthLoginOptions {
  provider: OAuthProvider;
  /**
   * The one owner email this sign-in must land on. It is sent as `expected_email` (the authorization
   * server's own refusal) and `login_hint` (Google's account prefill), and every caught token is checked
   * against it before anything is stored.
   */
  expectedEmail?: string;
  /** Prove a minted access token names the owner account; a refusal stores nothing. */
  verifyToken?: (accessToken: string, refreshed: boolean) => { ok: true; identity?: string } | { ok: false; code: 'identity_mismatch' | 'identity_unverified' };
  /** The one identity this sign-in binds, from trusted configuration; undefined refuses at discovery. */
  binding: OAuthBinding | undefined;
  configDir: string;
  reference: string;
  account: string;
  redirectPort?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => void | Promise<void>;
  showAuthorizationUrl?: (url: string) => void;
  onHop?: (hop: OAuthSignInHop) => void;
  now?: () => number;
}

interface ServerEndpoints { authorization: string; token: string; registration: string }

function base64url(bytes: Buffer): string { return bytes.toString('base64url'); }

/**
 * Everything one pending login is bound to, created once: a callback is accepted only for this state,
 * only once, and its code is exchanged only with this verifier, redirect URI and resource.
 */
interface PendingLogin { binding: OAuthBinding; redirectUri: string; state: string; verifier: string; used: boolean }

/**
 * The owner's one-time sign-in: discovery, one dynamic client registration, PKCE S256, a loopback
 * callback, one code exchange and one atomic record write. It never runs on a host boot, never prints a
 * token and never opens a browser before its listener is bound.
 */
export async function runOAuthLogin(options: OAuthLoginOptions): Promise<OAuthRecord> {
  const transport = options.fetch ?? fetch;
  const controller = new AbortController();
  let expire: () => void = () => {};
  const expired = new Promise<never>((_resolve, reject) => { expire = () => reject(new OAuthLoginError('timeout')); });
  const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, expired]);
  const timer = setTimeout(() => { controller.abort(); expire(); }, options.timeoutMs ?? OAUTH_LOGIN_TIMEOUT_MS);
  const post: typeof fetch = (input, init) => wait(transport(input, { ...init, signal: controller.signal }));
  let stage: HopName = 'discovery';
  let reported = false;
  const hop = (event: OAuthSignInHop): void => {
    if (event.outcome !== 'ok') reported = true;
    try { options.onHop?.(event); } catch { /* a diagnostic sink never changes the sign-in */ }
  };
  /** One failing hop, named for the stage that failed; a deadline that already passed is a timeout. */
  const fail = (event: OAuthSignInHop, code: OAuthLoginCode): never => {
    hop(controller.signal.aborted ? { hop: event.hop, outcome: 'timeout' } as OAuthSignInHop : event);
    throw new OAuthLoginError(controller.signal.aborted ? 'timeout' : code);
  };
  const { provider } = options;
  let server: Server | undefined;
  try {
    const now = options.now ?? Date.now;
    const requestedPort = options.redirectPort ?? provider.defaultPort;
    const binding = options.binding;
    if (!binding) return fail({ hop: 'discovery', outcome: 'config_invalid' }, 'metadata-unavailable');
    const endpoints = await discover(post, binding, wait, fail);
    hop({ hop: 'discovery', outcome: 'ok' });
    stage = 'registration';

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));

    // Bind the listener before anything opens a browser, so a taken port is one line and no orphan tab.
    let pending: PendingLogin | undefined;
    let settle: (result: { code?: string; error?: string }) => void = () => { /* replaced by the wait below */ };
    const callback = new Promise<{ code?: string; error?: string }>(resolve => { settle = resolve; });
    const listener = createServer((request, response) => {
      let url: URL;
      try { url = new URL(request.url ?? '/', 'http://127.0.0.1'); } catch { response.writeHead(400).end(); return; }
      if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
      const gotState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      // Mongoose refuses a different Google account after its own check: access_denied plus its own word.
      const accountMismatch = error === 'access_denied' && url.searchParams.get('mongoose_error') === 'account_mismatch';
      const accepted = pending !== undefined && !pending.used && gotState === pending.state && (code !== null || error !== null);
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(accepted ? `Lux Didi received the ${provider.label} sign-in. You can close this tab.\n` : 'Lux Didi refused this sign-in. You can close this tab.\n');
      if (pending?.used) return;
      if (pending) pending.used = true;
      if (!accepted) { settle({ error: 'state' }); return; }
      settle(code ? { code } : accountMismatch ? { error: 'account_mismatch' } : { error: 'authorization' });
    });
    server = listener;
    await wait(new Promise<void>((resolve, reject) => {
      listener.once('error', () => reject(new OAuthLoginError('port-in-use')));
      listener.listen(requestedPort, '127.0.0.1', () => resolve());
    })).catch(() => fail({ hop: 'registration', outcome: 'port_in_use' }, 'port-in-use'));
    // The bound port, never the requested one: the redirect URI must be the one really listening.
    const bound = listener.address();
    if (!bound || typeof bound === 'string') return fail({ hop: 'registration', outcome: 'port_in_use' }, 'port-in-use');
    const redirectUri = `http://127.0.0.1:${bound.port}/callback`;

    const registration = await post(endpoints.registration, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      redirect: 'error',
      body: JSON.stringify({
        client_name: provider.clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: provider.scope,
      }),
    }).catch(() => undefined);
    const client = registration?.ok ? await wait(registration.json()).catch(() => undefined) as Record<string, unknown> | undefined : undefined;
    const clientId = client?.['client_id'];
    if (!secret(clientId)) return fail({ hop: 'registration', outcome: 'refused' }, 'registration-refused');
    hop({ hop: 'registration', outcome: 'ok' });
    pending = { binding, redirectUri, state, verifier, used: false };

    const authorize = new URL(endpoints.authorization);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('scope', provider.scope);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('resource', binding.resource);
    if (options.expectedEmail !== undefined) {
      authorize.searchParams.set('login_hint', options.expectedEmail);
      authorize.searchParams.set('expected_email', options.expectedEmail);
    }
    if (options.showAuthorizationUrl) {
      stage = 'callback';
      options.showAuthorizationUrl(authorize.toString());
    } else {
      stage = 'browser_handoff';
      if (!options.openBrowser) return fail({ hop: 'browser_handoff', outcome: 'unavailable' }, 'browser-unavailable');
      try { await wait(Promise.resolve(options.openBrowser(authorize.toString()))); }
      catch { return fail({ hop: 'browser_handoff', outcome: 'unavailable' }, 'browser-unavailable'); }
      // Handed to the operating system; whether a page showed is the callback's to prove.
      hop({ hop: 'browser_handoff', outcome: 'ok' });
      stage = 'callback';
    }

    const result = await wait(callback);
    if (result.error === 'state') return fail({ hop: 'callback', outcome: 'state_mismatch' }, 'state-mismatch');
    if (result.error === 'account_mismatch') return fail({ hop: 'callback', outcome: 'account_mismatch' }, 'account-mismatch');
    if (!result.code) return fail({ hop: 'callback', outcome: 'authorization_refused' }, 'authorization-refused');
    hop({ hop: 'callback', outcome: 'ok' });
    stage = 'token';

    const exchange = await post(endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      redirect: 'error',
      body: new URLSearchParams({ grant_type: 'authorization_code', code: result.code, redirect_uri: pending.redirectUri, client_id: clientId, code_verifier: pending.verifier, resource: pending.binding.resource }),
    }).catch(() => undefined);
    if (!exchange) return fail({ hop: 'token', outcome: 'unreachable' }, 'token-refused');
    const granted = await wait(exchange.json()).catch(() => undefined) as Record<string, unknown> | undefined;
    if (!exchange.ok) {
      const error = granted?.['error'];
      const oauthError = OAUTH_ERRORS.find(code => code === error);
      return fail({ hop: 'token', outcome: 'refused', ...(oauthError ? { oauthError } : {}) }, 'token-refused');
    }
    const accessToken = granted?.['access_token'];
    const refreshToken = granted?.['refresh_token'];
    const expiresIn = granted?.['expires_in'];
    if (!secret(accessToken) || !secret(refreshToken) || !Number.isSafeInteger(expiresIn) || (expiresIn as number) < 1) return fail({ hop: 'token', outcome: 'refused' }, 'token-refused');
    const proof = options.verifyToken?.(accessToken);
    if (proof && !proof.ok) return fail({ hop: 'token', outcome: proof.code }, proof.code === 'identity_mismatch' ? 'identity-mismatch' : 'identity-unverified');
    hop({ hop: 'token', outcome: 'ok' });
    stage = 'stored';

    const record: OAuthRecord = {
      schemaVersion: OAUTH_RECORD_SCHEMA,
      endpoint: binding.endpoint,
      resource: binding.resource,
      issuer: binding.issuer,
      tokenEndpoint: endpoints.token,
      clientId,
      redirectPort: bound.port,
      account: options.account,
      accessToken,
      refreshToken,
      expiresAt: now() + (expiresIn as number) * 1000,
      consentStartedAt: now(),
      ...(proof !== undefined && proof.ok && proof.identity ? { identity: proof.identity } : {}),
    };
    try { writeOAuthRecord(options.configDir, options.reference, record); }
    catch (error) { hop({ hop: 'stored', outcome: 'failed' }); throw error; }
    hop({ hop: 'stored', outcome: 'ok' });
    return record;
  } catch (error) {
    if (controller.signal.aborted) {
      if (!reported) hop({ hop: stage, outcome: 'timeout' } as OAuthSignInHop);
      throw new OAuthLoginError('timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer); controller.abort();
    const listener = server;
    if (listener) await new Promise<void>(resolve => { listener.close(() => resolve()); listener.closeAllConnections(); });
  }
}

/**
 * The authorization server, through this resource's own protected-resource document: the document must
 * name exactly this resource and the configured issuer, the issuer's metadata must name that issuer,
 * and every endpoint it lists must sit on the issuer's origin.
 */
async function discover(post: typeof fetch, binding: OAuthBinding, wait: <T>(promise: Promise<T>) => Promise<T>,
  fail: (event: OAuthSignInHop, code: OAuthLoginCode) => never): Promise<ServerEndpoints> {
  const resource = await wait(discoverProtectedResource(post, binding));
  if (!resource.ok) return fail({ hop: 'discovery', outcome: resource.reason }, 'metadata-unavailable');
  let metadata: unknown;
  try {
    const response = await post(authorizationServerMetadataUrl(binding.issuer), { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual' });
    if (!response.ok) return fail({ hop: 'discovery', outcome: response.status >= 300 && response.status < 400 ? 'redirected' : 'http_status' }, 'metadata-unavailable');
    metadata = await wait(response.json());
  } catch (error) {
    if (error instanceof OAuthLoginError) throw error;
    return fail({ hop: 'discovery', outcome: 'metadata_unreachable' }, 'metadata-unavailable');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return fail({ hop: 'discovery', outcome: 'metadata_invalid' }, 'metadata-unavailable');
  const document = metadata as Record<string, unknown>;
  if (document['issuer'] !== binding.issuer) return fail({ hop: 'discovery', outcome: 'issuer_mismatch' }, 'metadata-unavailable');
  const methods = document['code_challenge_methods_supported'];
  if (!Array.isArray(methods) || !methods.includes('S256')) return fail({ hop: 'discovery', outcome: 'metadata_invalid' }, 'metadata-unavailable');
  const authorization = document['authorization_endpoint'];
  const tokenEndpoint = document['token_endpoint'];
  const registration = document['registration_endpoint'];
  const origin = issuerOrigin(binding.issuer);
  if (!onOrigin(authorization, origin) || !onOrigin(tokenEndpoint, origin) || !onOrigin(registration, origin)) {
    return fail({ hop: 'discovery', outcome: 'endpoint_off_origin' }, 'metadata-unavailable');
  }
  return { authorization, token: tokenEndpoint, registration };
}

export interface OAuthTokenOptions {
  now?: () => number;
  fetch?: typeof fetch;
  /** One closed-token notice for the owner, never a message and never a token. */
  notify?: (reason: 'consent-expiring' | 'refresh-failed') => void;
}

/** The provider rules a token read follows: how a record is accepted and the consent family's cap, if any. */
export interface OAuthTokenPolicy {
  accept: (endpoint: string, resource: string) => OAuthBinding | undefined;
  /**
   * Prove a token before it is used: a cached one and a freshly refreshed one alike. A refusal is an
   * OAuthCredentialError for a token that names another account, so a bad refresh is never written; an
   * accepted proof may carry the owner claim it proved, which the record keeps for Settings.
   */
  verifyToken?: (accessToken: string, refreshed: boolean) => { ok: true; identity?: string } | { ok: false; code: string } | void;
  consentCapMs?: number;
  consentWarnMs?: number;
}

/**
 * One refresh at a time per record, in this process; a cross-process holder is a typed
 * `credential-refresh-busy` instead of a second token request. A rotating refresh token used twice
 * revokes the whole family, so the exclusive create is the guard, never a best-effort attempt.
 */
const inflight = new Map<string, Promise<string>>();
const warned = new Set<string>();

/**
 * The access token for one record. The record must be bound to exactly the binding the current
 * configuration implies; any other record, or no binding, is a sign-in and never a refresh.
 */
export async function oauthAccessToken(configDir: string, reference: string, binding: OAuthBinding | undefined, policy: OAuthTokenPolicy, options: OAuthTokenOptions = {}): Promise<string> {
  if (!binding) throw new OAuthCredentialError('credential-missing');
  const key = `${configDir}\u0000${reference}`;
  const running = inflight.get(key);
  if (running) return running;
  const started = resolveToken(configDir, reference, binding, policy, options).finally(() => { inflight.delete(key); });
  inflight.set(key, started);
  return started;
}

const bound = (record: OAuthRecord, binding: OAuthBinding): boolean =>
  record.endpoint === binding.endpoint && record.resource === binding.resource && record.issuer === binding.issuer;

/** Prove one token with the policy's own check: a refusal keeps its closed credential code. */
function verify(policy: OAuthTokenPolicy, accessToken: string, refreshed = false): { ok: true; identity?: string } | undefined {
  const proof = policy.verifyToken?.(accessToken, refreshed);
  if (proof !== undefined && !proof.ok) {
    throw new OAuthCredentialError(proof.code === 'identity_mismatch' ? 'credential-identity-mismatch' : 'credential-identity-unverified');
  }
  return proof as { ok: true; identity?: string } | undefined;
}

async function resolveToken(configDir: string, reference: string, binding: OAuthBinding, policy: OAuthTokenPolicy, options: OAuthTokenOptions): Promise<string> {
  const now = options.now ?? Date.now;
  const record = readOAuthRecord(configDir, reference, policy.accept);
  if (!record || !bound(record, binding)) throw new OAuthCredentialError('credential-missing');
  if (now() < record.expiresAt - OAUTH_REFRESH_MARGIN_MS) {
    verify(policy, record.accessToken);
    return record.accessToken;
  }
  if (policy.consentCapMs !== undefined && now() >= record.consentStartedAt + policy.consentCapMs) throw new OAuthCredentialError('credential-consent-expired');
  const key = `${configDir}\u0000${reference}`;
  const release = acquireLock(configDir, reference, now);
  try {
    // Re-read under the lock: another writer may have rotated the family while we waited.
    const current = readOAuthRecord(configDir, reference, policy.accept) ?? record;
    if (!bound(current, binding)) throw new OAuthCredentialError('credential-missing');
    if (now() < current.expiresAt - OAUTH_REFRESH_MARGIN_MS) {
      verify(policy, current.accessToken);
      return current.accessToken;
    }
    let next: OAuthRecord;
    try { next = await refreshOAuthRecord(current, options); }
    catch (error) { options.notify?.('refresh-failed'); throw error; }
    // A refreshed token that names another account is discarded: nothing is written, and the endpoint
    // parks on a new sign-in instead of reading with the wrong account.
    const proven = verify(policy, next.accessToken, true);
    // The refreshed record keeps the claim this connect proved, so Settings can name the account.
    writeOAuthRecord(configDir, reference, proven !== undefined && proven.identity ? { ...next, identity: proven.identity } : next);
    if (policy.consentCapMs !== undefined && policy.consentWarnMs !== undefined && !warned.has(key) && now() >= next.consentStartedAt + policy.consentCapMs - policy.consentWarnMs) {
      warned.add(key);
      options.notify?.('consent-expiring');
    }
    return next.accessToken;
  } finally { release(); }
}

function lockPath(configDir: string, reference: string): string { return join(configDir, `.${reference}.json.lock`); }

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
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new OAuthCredentialError('credential-refresh-failed');
    let stale = false;
    try { stale = now() - statSync(path).mtimeMs > OAUTH_LOCK_STALE_MS; } catch { stale = false; }
    if (!stale) throw new OAuthCredentialError('credential-refresh-busy');
    try { unlinkSync(path); create(); }
    catch { throw new OAuthCredentialError('credential-refresh-busy'); }
  }
  return () => { try { unlinkSync(path); } catch { /* another writer already removed it */ } };
}

interface TokenResponse { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }

async function refreshOAuthRecord(record: OAuthRecord, options: OAuthTokenOptions): Promise<OAuthRecord> {
  const now = options.now ?? Date.now;
  const post = options.fetch ?? fetch;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: record.refreshToken, client_id: record.clientId, resource: record.resource });
  let response: Response;
  try {
    response = await post(record.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, redirect: 'error' });
  } catch { throw new OAuthCredentialError('credential-refresh-unavailable'); }
  if (!response.ok) throw new OAuthCredentialError('credential-refresh-failed');
  let payload: TokenResponse;
  try { payload = await response.json() as TokenResponse; } catch { throw new OAuthCredentialError('credential-refresh-failed'); }
  const accessToken = payload.access_token;
  const refreshToken = payload.refresh_token;
  const expiresIn = payload.expires_in;
  if (!secret(accessToken) || !secret(refreshToken)) throw new OAuthCredentialError('credential-refresh-failed');
  if (!Number.isSafeInteger(expiresIn) || (expiresIn as number) < 1) throw new OAuthCredentialError('credential-refresh-failed');
  return { ...record, accessToken, refreshToken, expiresAt: now() + (expiresIn as number) * 1000 };
}
