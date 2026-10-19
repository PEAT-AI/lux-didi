import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { MONGOOSE_RECORD_SCHEMA, writeMongooseOAuth, type MongooseOAuthRecord } from './mongoose-auth.js';

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

export type MongooseLoginCode = 'metadata-unavailable' | 'registration-refused' | 'port-in-use' | 'state-mismatch' | 'authorization-refused' | 'token-refused' | 'browser-unavailable' | 'timeout';

export class MongooseLoginError extends Error {
  constructor(readonly code: MongooseLoginCode) { super(code); }
}

export interface MongooseLoginOptions {
  /** Absolute private configuration directory that receives the record. */
  configDir: string;
  /** Credential reference from the endpoint policy (`mongoose-mcp`). */
  reference: string;
  /** The endpoint's MCP URL; its origin is the OAuth resource and the fallback issuer. */
  resourceUrl: string;
  account: string;
  redirectPort?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Opens the owner's default browser; a test supplies its own. */
  openBrowser?: (url: string) => void;
  /** Present the sign-in URL without opening a browser; takes precedence over openBrowser. */
  showAuthorizationUrl?: (url: string) => void;
  now?: () => number;
}

interface Metadata { authorization_server?: unknown; issuer?: unknown; authorization_endpoint?: unknown; token_endpoint?: unknown; registration_endpoint?: unknown }

function originOf(url: string): string {
  const parsed = new URL(url);
  return parsed.origin;
}

function base64url(bytes: Buffer): string { return bytes.toString('base64url'); }

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

async function getJson(post: typeof fetch, url: string, wait: <T>(promise: Promise<T>) => Promise<T>): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await post(url, { method: 'GET', headers: { accept: 'application/json' } });
    if (!response.ok) return undefined;
    const body = await wait(response.json()) as unknown;
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** The authorization server document, from the protected-resource metadata when it is present. */
async function discover(post: typeof fetch, origin: string, wait: <T>(promise: Promise<T>) => Promise<T>): Promise<Metadata> {
  const resource = await getJson(post, `${origin}/.well-known/oauth-protected-resource`, wait);
  const listed = resource?.['authorization_servers'];
  const issuer = Array.isArray(listed) && token(listed[0]) ? listed[0] : origin;
  const server = await getJson(post, `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`, wait);
  if (!server) throw new MongooseLoginError('metadata-unavailable');
  return server;
}

interface CallbackResult { code?: string; error?: string }

export async function runMongooseLogin(options: MongooseLoginOptions): Promise<MongooseOAuthRecord> {
  const transport = options.fetch ?? fetch;
  const controller = new AbortController();
  let expire: () => void = () => {};
  const expired = new Promise<never>((_resolve, reject) => { expire = () => reject(new MongooseLoginError('timeout')); });
  const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, expired]);
  const timer = setTimeout(() => { controller.abort(); expire(); }, options.timeoutMs ?? MONGOOSE_LOGIN_TIMEOUT_MS);
  const post: typeof fetch = (input, init) => wait(transport(input, { ...init, signal: controller.signal }));
  let server: Server | undefined;
  try {
    const now = options.now ?? Date.now;
    const requestedPort = options.redirectPort ?? MONGOOSE_LOGIN_PORT;
    const origin = originOf(options.resourceUrl);
    const metadata = await discover(post, origin, wait);
    if (!token(metadata['authorization_endpoint']) || !token(metadata['token_endpoint']) || !token(metadata['registration_endpoint'])) throw new MongooseLoginError('metadata-unavailable');

    const state = base64url(randomBytes(16));
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());

    // Bind the listener before anything opens a browser, so a taken port is one line and no orphan tab.
    let settle: (result: CallbackResult) => void = () => { /* replaced by the wait below */ };
    const callback = new Promise<CallbackResult>(resolve => { settle = resolve; });
    const listener = createServer((request, response) => {
      let url: URL;
      try { url = new URL(request.url ?? '/', 'http://127.0.0.1'); } catch { response.writeHead(400).end(); return; }
      if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
      const gotState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(gotState === state && (code || error) ? 'Lux Didi received the Mongoose sign-in. You can close this tab.\n' : 'Lux Didi refused this sign-in. You can close this tab.\n');
      if (gotState !== state) { settle({ error: 'state' }); return; }
      settle(code ? { code } : { error: error ?? 'authorization' });
    });
    server = listener;
    await wait(new Promise<void>((resolve, reject) => {
      listener.once('error', () => reject(new MongooseLoginError('port-in-use')));
      listener.listen(requestedPort, '127.0.0.1', () => resolve());
    }));
    // The bound port, never the requested one: the redirect URI must be the one really listening.
    const bound = listener.address();
    if (!bound || typeof bound === 'string') throw new MongooseLoginError('port-in-use');
    const port = bound.port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const registration = await post(String(metadata['registration_endpoint']), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
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
    if (!token(clientId)) throw new MongooseLoginError('registration-refused');

    const authorize = new URL(String(metadata['authorization_endpoint']));
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('scope', MONGOOSE_LOGIN_SCOPE);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    const open = options.showAuthorizationUrl ?? options.openBrowser;
    if (!open) throw new MongooseLoginError('browser-unavailable');
    try { open(authorize.toString()); } catch { throw new MongooseLoginError('browser-unavailable'); }

    const result = await wait(callback);
    if (result.error === 'state') throw new MongooseLoginError('state-mismatch');
    if (!result.code) throw new MongooseLoginError('authorization-refused');

    const exchange = await post(String(metadata['token_endpoint']), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: result.code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
    }).catch(() => undefined);
    const granted = exchange?.ok ? await wait(exchange.json()).catch(() => undefined) as Record<string, unknown> | undefined : undefined;
    const accessToken = granted?.['access_token'];
    const refreshToken = granted?.['refresh_token'];
    const expiresIn = granted?.['expires_in'];
    if (!token(accessToken) || !token(refreshToken) || !Number.isSafeInteger(expiresIn) || (expiresIn as number) < 1) throw new MongooseLoginError('token-refused');

    const record: MongooseOAuthRecord = {
      schemaVersion: MONGOOSE_RECORD_SCHEMA,
      base: origin,
      clientId,
      redirectPort: port,
      account: options.account,
      accessToken,
      refreshToken,
      expiresAt: now() + (expiresIn as number) * 1000,
      consentStartedAt: now(),
    };
    writeMongooseOAuth(options.configDir, options.reference, record);
    return record;
  } catch (error) {
    if (controller.signal.aborted) throw new MongooseLoginError('timeout');
    throw error;
  } finally {
    clearTimeout(timer); controller.abort();
    const listener = server;
    if (listener) await new Promise<void>(resolve => { listener.close(() => resolve()); listener.closeAllConnections(); });
  }
}
