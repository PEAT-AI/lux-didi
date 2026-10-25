import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A synthetic Mongoose on the loopback that enforces the OAuth rules of the deployed server
 * (backend/src/mongoose/routers/oauth.py and mcp_endpoints.py at 4376ae40), written from that source and
 * never from Didi's own helpers. Its discovery documents are the committed live capture with only the
 * origin swapped, so the shape under test is the shape Mongoose really publishes.
 */
export const FAKE_ORIGIN = 'https://mongoose.test';
const LIVE_ORIGIN = 'https://mongoose.dev.peat-cloud.com';
/** mcp_endpoints.ENDPOINTS, in registry order; admin is a resource here even though Didi never connects it. */
const ENDPOINT_PATHS = ['/mcp/knowledge', '/mcp/data', '/mcp/crm', '/mcp/admin'] as const;
const KNOWLEDGE = '/mcp/knowledge';

type Json = Record<string, unknown>;

function liveDocuments(origin: string): Map<string, Json> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'fixtures/mongoose-discovery.json'), join(here, '../../test/fixtures/mongoose-discovery.json'), join(here, '../../../server/test/fixtures/mongoose-discovery.json')];
  let raw: string | undefined;
  for (const path of candidates) { try { raw = readFileSync(path, 'utf8'); break; } catch { /* next location */ } }
  if (raw === undefined) throw new Error('mongoose-discovery.json fixture not found');
  const documents = (JSON.parse(raw) as { documents: Record<string, Json> }).documents;
  return new Map(Object.entries(documents).map(([path, body]) => [path, JSON.parse(JSON.stringify(body).split(LIVE_ORIGIN).join(origin)) as Json]));
}

/** Python urlsplit plus _normalise_resource: lowercase scheme and host, path without its trailing slash. */
function normaliseResource(raw: string): { normalised: string; query: string[] } {
  const parts = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(raw.trim());
  if (!parts || parts[1]!.toLowerCase() !== 'https') throw new Error('resource must be an absolute https URI');
  const netloc = (parts[2] ?? '').toLowerCase();
  if (!netloc || netloc.includes('@')) throw new Error('resource must carry a plain host');
  if (parts[5]) throw new Error('resource must not carry a fragment');
  const path = parts[3]!.replace(/\/+$/, '') || '/';
  if (!ENDPOINT_PATHS.some(endpoint => endpoint === path)) throw new Error('resource path is not an MCP endpoint');
  return { normalised: `https://${netloc}${path}`, query: (parts[4] ?? '').split('&').filter(piece => piece.length > 0) };
}

/** mcp_endpoints.canonical_resource: no query, and one of the deployment's canonical resources. */
export function canonicalResource(raw: string, allowed: readonly string[]): string {
  const { normalised, query } = normaliseResource(raw);
  if (query.length) throw new Error('resource must not carry a query parameter');
  if (!allowed.map(value => normaliseResource(value).normalised).includes(normalised)) throw new Error("resource is not this deployment's MCP endpoint");
  return normalised;
}

interface Client { clientId: string; redirectUris: string[] }
interface Code { clientId: string; redirectUri: string; challenge: string; resource: string; used: boolean }
interface Family { clientId: string; resource: string; current: string; revoked: boolean }
export interface TokenCall { form: Record<string, string>; status: number; error?: string }

export interface ContractFake {
  origin: string;
  /** The deployment's protected-resource and authorization-server documents, editable per test. */
  documents: Map<string, Json>;
  /** Paths answered with a redirect off the origin instead of their document. */
  redirectOffOrigin: Set<string>;
  /** Hold every discovery GET until release() is called. */
  holdDiscovery(): () => void;
  /** A fetch that reaches this fake for its origin and refuses every other origin, recording it. */
  fetch: typeof fetch;
  offOrigin: string[];
  registrations: Json[];
  authorizations: URLSearchParams[];
  tokenCalls: TokenCall[];
  /** The owner's browser: open the authorize URL, consent, follow the redirect to the loopback callback. */
  browse(authorizeUrl: string, options?: { state?: string; times?: number }): Promise<string[]>;
  /** One read on an MCP endpoint with a bearer, answered only when the token is bound to that endpoint. */
  read(path: string, accessToken: string): Promise<number>;
  close(): Promise<void>;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');
const loopback = (uri: string): boolean => /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/callback$/.test(uri);

export async function startContractFake(): Promise<ContractFake> {
  const origin = FAKE_ORIGIN;
  const allowed = ENDPOINT_PATHS.map(path => `${origin}${path}`);
  const documents = liveDocuments(origin);
  const redirectOffOrigin = new Set<string>();
  const clients = new Map<string, Client>();
  const codes = new Map<string, Code>();
  const families = new Map<string, Family>();
  const tokens = new Map<string, string>();
  const registrations: Json[] = [];
  const authorizations: URLSearchParams[] = [];
  const tokenCalls: TokenCall[] = [];
  const offOrigin: string[] = [];
  let held: Promise<void> | undefined;
  const mint = (prefix: string): string => `${prefix}-${randomBytes(12).toString('hex')}`;

  const tokenError = (response: ServerResponse, call: TokenCall, error: string, status = 400): void => {
    call.status = status; call.error = error; send(response, status, { error, error_description: 'synthetic' });
  };
  /** oauth._resource_mismatch: an omitted resource inherits the binding, a supplied one must canonicalise to it. */
  const mismatch = (requested: string | undefined, bound: string): boolean => {
    if (requested === undefined) return false;
    try { return canonicalResource(requested, allowed) !== bound.replace(/\/+$/, ''); } catch { return true; }
  };
  const issue = (family: Family): Json => {
    const access = mint('fake-access');
    tokens.set(access, family.resource);
    const refresh = mint('fake-refresh');
    family.current = refresh;
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: 'mcp' };
  };

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    if (request.method === 'GET' && url.pathname.startsWith('/.well-known/')) {
      if (held) await held;
      if (redirectOffOrigin.has(url.pathname)) { response.writeHead(302, { location: `https://elsewhere.test${url.pathname}` }).end(); return; }
      const document = documents.get(url.pathname);
      if (!document) { response.writeHead(404).end(); return; }
      send(response, 200, document); return;
    }
    if (request.method === 'POST' && url.pathname === '/oauth/register') {
      const value = JSON.parse(await body(request)) as Json;
      registrations.push(value);
      const uris = value['redirect_uris'];
      if (!Array.isArray(uris) || !uris.length || !uris.every(uri => typeof uri === 'string' && loopback(uri))) return send(response, 400, { error: 'invalid_redirect_uri' });
      if (!['none', 'client_secret_post', undefined].includes(value['token_endpoint_auth_method'] as string | undefined)) return send(response, 400, { error: 'invalid_client_metadata' });
      const clientId = mint('mcp');
      clients.set(clientId, { clientId, redirectUris: uris as string[] });
      return send(response, 201, { client_id: clientId, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    }
    if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
      const q = url.searchParams;
      authorizations.push(q);
      const requested = q.getAll('resource');
      if (requested.length > 1) { response.writeHead(400).end('invalid_target'); return; }
      let resource: string;
      // oauth._bind_resource: omitted binds the knowledge endpoint, anything else must canonicalise.
      try { resource = requested.length ? canonicalResource(requested[0]!, allowed) : `${origin}${KNOWLEDGE}`; }
      catch { response.writeHead(400).end('invalid_target'); return; }
      const client = clients.get(q.get('client_id') ?? '');
      const redirectUri = q.get('redirect_uri') ?? '';
      if (!client || !client.redirectUris.includes(redirectUri)) { response.writeHead(400).end('redirect_uri does not match'); return; }
      const back = new URL(redirectUri);
      const state = q.get('state');
      if (state !== null) back.searchParams.set('state', state);
      if (q.get('response_type') !== 'code') { back.searchParams.set('error', 'unsupported_response_type'); response.writeHead(302, { location: back.toString() }).end(); return; }
      if (!q.get('code_challenge') || q.get('code_challenge_method') !== 'S256') { back.searchParams.set('error', 'invalid_request'); response.writeHead(302, { location: back.toString() }).end(); return; }
      // The owner consents (the Google leg is out of scope here): a single-use code bound to the resource.
      const code = mint('fake-code');
      codes.set(code, { clientId: client.clientId, redirectUri, challenge: q.get('code_challenge')!, resource, used: false });
      back.searchParams.set('code', code);
      response.writeHead(302, { location: back.toString() }).end(); return;
    }
    if (request.method === 'POST' && url.pathname === '/oauth/token') {
      const raw = await body(request);
      const form = Object.fromEntries(new URLSearchParams(raw));
      const call: TokenCall = { form, status: 200 };
      tokenCalls.push(call);
      if (!String(request.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return tokenError(response, call, 'invalid_request');
      const resource = form['resource'];
      if (form['grant_type'] === 'authorization_code') {
        const record = codes.get(form['code'] ?? '');
        if (!form['code'] || !form['redirect_uri'] || !form['code_verifier'] || !form['client_id']) return tokenError(response, call, 'invalid_request');
        if (!clients.has(form['client_id'])) return tokenError(response, call, 'invalid_client', 401);
        if (!record || record.used) return tokenError(response, call, 'invalid_grant');
        record.used = true;
        if (record.clientId !== form['client_id'] || record.redirectUri !== form['redirect_uri']) return tokenError(response, call, 'invalid_grant');
        if (s256(form['code_verifier']) !== record.challenge) return tokenError(response, call, 'invalid_grant');
        if (mismatch(resource, record.resource)) return tokenError(response, call, 'invalid_target');
        const family: Family = { clientId: record.clientId, resource: record.resource, current: '', revoked: false };
        const granted = issue(family);
        families.set(String(granted['refresh_token']), family);
        return send(response, 200, granted);
      }
      if (form['grant_type'] === 'refresh_token') {
        const presented = form['refresh_token'] ?? '';
        const family = families.get(presented);
        if (!family) return tokenError(response, call, 'invalid_grant');
        if (form['client_id'] !== undefined && form['client_id'] !== family.clientId) return tokenError(response, call, 'invalid_grant');
        if (family.revoked || family.current !== presented) { family.revoked = true; return tokenError(response, call, 'invalid_grant'); }
        if (mismatch(resource, family.resource)) return tokenError(response, call, 'invalid_target');
        families.delete(presented);
        const granted = issue(family);
        families.set(String(granted['refresh_token']), family);
        return send(response, 200, granted);
      }
      return tokenError(response, call, 'unsupported_grant_type');
    }
    if (url.pathname.startsWith('/mcp/')) {
      const bearer = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ''))?.[1];
      const bound = bearer ? tokens.get(bearer) : undefined;
      if (bound !== `${origin}${url.pathname.replace(/\/+$/, '')}`) {
        response.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${url.pathname}"` }).end(); return;
      }
      send(response, 200, { ok: true }); return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const local = `http://127.0.0.1:${address.port}`;

  const routed: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (target.origin !== origin) { offOrigin.push(target.origin); throw new TypeError('fetch failed: off the fake origin'); }
    return fetch(`${local}${target.pathname}${target.search}`, init);
  };

  return {
    origin, documents, redirectOffOrigin, fetch: routed, offOrigin, registrations, authorizations, tokenCalls,
    holdDiscovery() { let release: () => void = () => {}; held = new Promise<void>(resolve => { release = () => { held = undefined; resolve(); }; }); return release; },
    async browse(authorizeUrl, options = {}) {
      const consent = await routed(authorizeUrl, { redirect: 'manual' });
      await consent.text();
      const location = consent.headers.get('location');
      if (consent.status !== 302 || !location) return [`authorize-refused-${consent.status}`];
      const callback = new URL(location);
      if (options.state !== undefined) callback.searchParams.set('state', options.state);
      // Several deliveries of one redirect at once: a replay must reach the listener while it still listens.
      return Promise.all(Array.from({ length: options.times ?? 1 }, async () => (await fetch(callback)).text()));
    },
    async read(path, accessToken) {
      const response = await routed(`${origin}${path}`, { headers: { authorization: `Bearer ${accessToken}` } });
      await response.text();
      return response.status;
    },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
