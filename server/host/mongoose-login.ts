import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { MONGOOSE_RECORD_SCHEMA, discoverMongooseResource, mongooseBinding, onOrigin, writeMongooseOAuth, type MongooseBinding, type MongooseDiscoveryReason, type MongooseOAuthRecord } from './mongoose-auth.js';
import type { MongooseEndpoint } from '../connectors/mongoose.js';

/**
 * The owner's one-time Mongoose sign-in: discovery, one dynamic client registration, PKCE S256, a
 * loopback callback, one code exchange and one atomic record write. It never runs on a host boot,
 * never prints a token and never opens a browser before its listener is bound.
 *
 * Every failure is one closed code; the caller prints one owner line.
 */
export const MONGOOSE_LOGIN_CLIENT_NAME = 'lux-didi';
export const MONGOOSE_LOGIN_SCOPE = 'mcp';
export const MONGOOSE_LOGIN_PORT = 8768;
export const MONGOOSE_LOGIN_TIMEOUT_MS = 300_000;

export type MongooseLoginCode = 'metadata-unavailable' | 'registration-refused' | 'port-in-use' | 'state-mismatch' | 'authorization-refused' | 'token-refused' | 'browser-unavailable' | 'timeout' | 'endpoint-not-allowed';

export class MongooseLoginError extends Error {
  constructor(readonly code: MongooseLoginCode) { super(code); }
}

/** The RFC 6749 error codes a refused token request may name; anything else is not repeated. */
export const MONGOOSE_OAUTH_ERRORS = ['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'invalid_target', 'access_denied'] as const;
export type MongooseOAuthError = (typeof MONGOOSE_OAUTH_ERRORS)[number];

/** One hop of a sign-in and how it ended, content-free: never a URL, code, state, verifier or token. */
export type MongooseSignInHop =
  | { hop: 'discovery'; outcome: 'ok' | MongooseDiscoveryReason | 'config_invalid' | 'metadata_unreachable' | 'metadata_invalid' | 'issuer_mismatch' | 'endpoint_off_origin' }
  | { hop: 'registration'; outcome: 'ok' | 'port_in_use' | 'refused' | 'timeout' }
  | { hop: 'browser_handoff'; outcome: 'ok' | 'unavailable' | 'timeout' }
  | { hop: 'callback'; outcome: 'ok' | 'state_mismatch' | 'authorization_refused' | 'timeout' }
  | { hop: 'token'; outcome: 'ok' | 'unreachable' | 'timeout' } | { hop: 'token'; outcome: 'refused'; oauthError?: MongooseOAuthError }
  | { hop: 'stored'; outcome: 'ok' | 'failed' };
type HopName = MongooseSignInHop['hop'];

export interface MongooseLoginOptions {
  /** Absolute private configuration directory that receives the record. */
  configDir: string;
  /** Credential reference from the endpoint policy (`mongoose-knowledge`, `mongoose-data`, `mongoose-crm`). */
  reference: string;
  /** The endpoint's configured MCP URL; its origin plus the endpoint path is the one resource identity. */
  resourceUrl: string;
  /** Which of the three endpoints this sign-in binds; it decides the resource and the record. */
  endpoint: MongooseEndpoint;
  account: string;
  redirectPort?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Hands the authorize URL to the owner's default browser; a test supplies its own. */
  openBrowser?: (url: string) => void | Promise<void>;
  /** Present the sign-in URL without opening a browser; takes precedence over openBrowser. */
  showAuthorizationUrl?: (url: string) => void;
  /** One content-free line per hop, for the host log and the Settings row. */
  onHop?: (hop: MongooseSignInHop) => void;
  now?: () => number;
}

interface ServerEndpoints { authorization: string; token: string; registration: string }

function base64url(bytes: Buffer): string { return bytes.toString('base64url'); }

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

/**
 * Everything one pending login is bound to, created once: a callback is accepted only for this state,
 * only once, and its code is exchanged only with this verifier, redirect URI and resource.
 */
interface PendingLogin { binding: MongooseBinding; redirectUri: string; state: string; verifier: string; used: boolean }

export async function runMongooseLogin(options: MongooseLoginOptions): Promise<MongooseOAuthRecord> {
  const transport = options.fetch ?? fetch;
  const controller = new AbortController();
  let expire: () => void = () => {};
  const expired = new Promise<never>((_resolve, reject) => { expire = () => reject(new MongooseLoginError('timeout')); });
  const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, expired]);
  const timer = setTimeout(() => { controller.abort(); expire(); }, options.timeoutMs ?? MONGOOSE_LOGIN_TIMEOUT_MS);
  const post: typeof fetch = (input, init) => wait(transport(input, { ...init, signal: controller.signal }));
  let stage: HopName = 'discovery';
  let reported = false;
  const hop = (event: MongooseSignInHop): void => {
    if (event.outcome !== 'ok') reported = true;
    try { options.onHop?.(event); } catch { /* a diagnostic sink never changes the sign-in */ }
  };
  /** One failing hop, named for the stage that failed; a deadline that already passed is a timeout. */
  const fail = (event: MongooseSignInHop, code: MongooseLoginCode): never => {
    hop(controller.signal.aborted ? { hop: event.hop, outcome: 'timeout' } as MongooseSignInHop : event);
    throw new MongooseLoginError(controller.signal.aborted ? 'timeout' : code);
  };
  let server: Server | undefined;
  try {
    const now = options.now ?? Date.now;
    const requestedPort = options.redirectPort ?? MONGOOSE_LOGIN_PORT;
    const binding = mongooseBinding(options.resourceUrl, options.endpoint);
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
      const accepted = pending !== undefined && !pending.used && gotState === pending.state && (code !== null || error !== null);
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(accepted ? 'Lux Didi received the Mongoose sign-in. You can close this tab.\n' : 'Lux Didi refused this sign-in. You can close this tab.\n');
      if (pending?.used) return;
      if (pending) pending.used = true;
      if (!accepted) { settle({ error: 'state' }); return; }
      settle(code ? { code } : { error: 'authorization' });
    });
    server = listener;
    await wait(new Promise<void>((resolve, reject) => {
      listener.once('error', () => reject(new MongooseLoginError('port-in-use')));
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
        client_name: MONGOOSE_LOGIN_CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: MONGOOSE_LOGIN_SCOPE,
      }),
    }).catch(() => undefined);
    const client = registration?.ok ? await wait(registration.json()).catch(() => undefined) as Record<string, unknown> | undefined : undefined;
    const clientId = client?.['client_id'];
    if (!token(clientId)) return fail({ hop: 'registration', outcome: 'refused' }, 'registration-refused');
    hop({ hop: 'registration', outcome: 'ok' });
    pending = { binding, redirectUri, state, verifier, used: false };

    const authorize = new URL(endpoints.authorization);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('scope', MONGOOSE_LOGIN_SCOPE);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('resource', binding.resource);
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
      const oauthError = MONGOOSE_OAUTH_ERRORS.find(code => code === error);
      return fail({ hop: 'token', outcome: 'refused', ...(oauthError ? { oauthError } : {}) }, 'token-refused');
    }
    const accessToken = granted?.['access_token'];
    const refreshToken = granted?.['refresh_token'];
    const expiresIn = granted?.['expires_in'];
    if (!token(accessToken) || !token(refreshToken) || !Number.isSafeInteger(expiresIn) || (expiresIn as number) < 1) return fail({ hop: 'token', outcome: 'refused' }, 'token-refused');
    hop({ hop: 'token', outcome: 'ok' });
    stage = 'stored';

    const record: MongooseOAuthRecord = {
      schemaVersion: MONGOOSE_RECORD_SCHEMA,
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
    };
    try { writeMongooseOAuth(options.configDir, options.reference, record); }
    catch (error) { hop({ hop: 'stored', outcome: 'failed' }); throw error; }
    hop({ hop: 'stored', outcome: 'ok' });
    return record;
  } catch (error) {
    if (controller.signal.aborted) {
      if (!reported) hop({ hop: stage, outcome: 'timeout' } as MongooseSignInHop);
      throw new MongooseLoginError('timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer); controller.abort();
    const listener = server;
    if (listener) await new Promise<void>(resolve => { listener.close(() => resolve()); listener.closeAllConnections(); });
  }
}

/**
 * The authorization server, through this endpoint's own protected-resource document: the document
 * must name exactly this resource and the configured origin, the server metadata must name that origin
 * as its issuer, and every endpoint it lists must sit on that origin.
 */
async function discover(post: typeof fetch, binding: MongooseBinding, wait: <T>(promise: Promise<T>) => Promise<T>,
  fail: (event: MongooseSignInHop, code: MongooseLoginCode) => never): Promise<ServerEndpoints> {
  const resource = await wait(discoverMongooseResource(post, binding));
  if (!resource.ok) return fail({ hop: 'discovery', outcome: resource.reason }, 'metadata-unavailable');
  let metadata: unknown;
  try {
    const response = await post(`${binding.issuer}/.well-known/oauth-authorization-server`, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual' });
    if (!response.ok) return fail({ hop: 'discovery', outcome: response.status >= 300 && response.status < 400 ? 'redirected' : 'http_status' }, 'metadata-unavailable');
    metadata = await wait(response.json());
  } catch (error) {
    if (error instanceof MongooseLoginError) throw error;
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
  if (!onOrigin(authorization, binding.issuer) || !onOrigin(tokenEndpoint, binding.issuer) || !onOrigin(registration, binding.issuer)) {
    return fail({ hop: 'discovery', outcome: 'endpoint_off_origin' }, 'metadata-unavailable');
  }
  return { authorization, token: tokenEndpoint, registration };
}
