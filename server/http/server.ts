import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Store } from '../runtime/store.js';
import type { DomainPort } from '../contracts/domain.js';
import { ServiceError } from '../contracts/errors.js';
import { object, resolveRoute } from './routes.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type'] !== 'application/json' && req.headers['content-type'] !== 'application/json; charset=utf-8') throw new ServiceError('BAD_REQUEST', 'JSON Content-Type required');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += (chunk as Buffer).length; if (size > 65536) { req.resume(); throw new ServiceError('PAYLOAD_TOO_LARGE', 'Request body exceeds limit', 413); } chunks.push(chunk as Buffer); }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { if (error instanceof ServiceError) throw error; throw new ServiceError('BAD_REQUEST', 'Malformed JSON'); }
}
interface Principal { clientId: string; mode: 'bearer' | 'browser'; tokenHash?: string; csrfToken?: string }
export interface ServiceOptions { store: Store; domain?: DomainPort; port?: number }
export interface RunningService { server: Server; origin: string; close(): Promise<void> }
export async function listenService(options: ServiceOptions): Promise<RunningService> {
  const { store, domain } = options;
  let origin = '';
  const pairing = new Map<string, number>();
  const send = (res: ServerResponse, status: number, payload: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(JSON.stringify(payload));
  };
  const principal = (req: IncomingMessage): Principal => {
    const authorization = req.headers.authorization;
    const cookie = req.headers.cookie;
    if (authorization) {
      if (cookie || !authorization.startsWith('Bearer ') || !equal(authorization.slice(7), store.adminCredential)) throw new ServiceError('UNAUTHORIZED', 'Authentication required', 401);
      return { clientId: 'local-admin', mode: 'bearer' };
    }
    const cookies = (cookie ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith('didi_session='));
    if (cookies.length !== 1 || !/^didi_session=[A-Za-z0-9_-]{43}$/.test(cookies[0]!)) throw new ServiceError('UNAUTHORIZED', 'Authentication required', 401);
    const tokenHash = hash(cookies[0]!.slice('didi_session='.length));
    const row = store.transaction(tx => tx.get('SELECT * FROM runtime_sessions WHERE token_hash=? AND expires_at>?', [tokenHash, Date.now()]));
    if (!row) throw new ServiceError('UNAUTHORIZED', 'Authentication required', 401);
    return { clientId: String(row.client_id), mode: 'browser', tokenHash, csrfToken: String(row.csrf_token) };
  };
  const csrf = (req: IncomingMessage, actor: Principal) => {
    if (actor.mode === 'browser' && (req.headers.origin !== origin || !equal(String(req.headers['x-didi-csrf'] ?? ''), actor.csrfToken!))) throw new ServiceError('FORBIDDEN', 'Origin and CSRF token required', 403);
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID();
    const success = (data: unknown) => ({ data, requestId, authorityEpoch: store.authorityEpoch });
    try {
      const protectedHeaders = new Set(['host', 'origin', 'authorization', 'cookie', 'idempotency-key', 'x-didi-authority-epoch', 'x-didi-csrf']);
      const seen = new Set<string>();
      for (let i = 0; i < req.rawHeaders.length; i += 2) { const name = req.rawHeaders[i]!.toLowerCase(); if (protectedHeaders.has(name) && seen.has(name)) throw new ServiceError('BAD_REQUEST', 'Duplicate security header'); seen.add(name); }
      if (req.headers.host !== new URL(origin).host || (req.headers.origin !== undefined && req.headers.origin !== origin)) throw new ServiceError('FORBIDDEN', 'Host or Origin is not allowed', 403);
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new ServiceError('BAD_REQUEST', 'Invalid request target');
      const url = new URL(req.url, origin);
      if (url.hash || url.username || url.password) throw new ServiceError('BAD_REQUEST', 'Invalid request target');
      const method = req.method ?? '';
      let route = resolveRoute(method, url);
      if (route.kind === 'health') { send(res, 200, { status: 'ok', version: '0.1.0', serviceMode: 'loopback' }); return; }
      if (route.kind === 'pair') {
        if (req.headers.origin !== origin) throw new ServiceError('FORBIDDEN', 'Exact Origin required', 403);
        const body = await readBody(req); resolveRoute(method, url, body);
        const codeHash = hash(String(body.pairingCode)); const expiry = pairing.get(codeHash); pairing.delete(codeHash);
        if (!expiry || expiry <= Date.now()) throw new ServiceError('UNAUTHORIZED', 'Pairing code invalid or expired', 401);
        const token = secret(), csrfToken = secret();
        store.transaction(tx => { tx.run('DELETE FROM runtime_sessions WHERE expires_at<=?', [Date.now()]); tx.run('INSERT INTO runtime_sessions VALUES (?,?,?,?)', [hash(token), randomUUID(), csrfToken, Date.now() + 12 * 60 * 60 * 1000]); });
        res.setHeader('Set-Cookie', `didi_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        send(res, 200, success({ csrfToken })); return;
      }
      const actor = principal(req);
      if (route.mutation) csrf(req, actor);
      if (route.kind === 'status') {
        send(res, 200, success({ assistantId: store.assistantId, authorityEpoch: store.authorityEpoch, serviceMode: 'loopback', capabilities: { memory: !!domain, commitments: !!domain, notifications: false, model: false }, model: { configured: false }, sources: [], capabilityReasons: { ...(!domain ? { memory: 'DOMAIN_NOT_CONFIGURED', commitments: 'DOMAIN_NOT_CONFIGURED' } : {}), notifications: 'NOTIFICATION_NOT_CONFIGURED', model: 'MODEL_NOT_CONFIGURED' } })); return;
      }
      if (route.kind === 'session') { send(res, 200, success({ clientId: actor.clientId, csrfToken: actor.csrfToken ?? null })); return; }
      if (route.mutation) { const body = await readBody(req); route = resolveRoute(method, url, body); }
      if (route.kind === 'pairing') {
        if (actor.mode !== 'bearer') throw new ServiceError('FORBIDDEN', 'Local operator credential required', 403);
        for (const [key, expiry] of pairing) if (expiry <= Date.now()) pairing.delete(key);
        if (pairing.size >= 16) throw new ServiceError('CONFLICT', 'Outstanding pairing limit reached', 409);
        const pairingCode = secret(), expires = Date.now() + 300_000; pairing.set(hash(pairingCode), expires);
        send(res, 200, success({ pairingCode, expiresAt: new Date(expires).toISOString() })); return;
      }
      if (route.kind === 'logout') {
        if (actor.mode !== 'browser') throw new ServiceError('BAD_REQUEST', 'Browser session required');
        store.transaction(tx => tx.run('DELETE FROM runtime_sessions WHERE token_hash=?', [actor.tokenHash!]));
        res.setHeader('Set-Cookie', 'didi_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); send(res, 200, success({ revoked: true })); return;
      }
      if (route.kind === 'chat') throw new ServiceError('MODEL_NOT_CONFIGURED', 'Model capability is unavailable', 503);
      if (route.kind !== 'domain') throw new ServiceError('NOT_FOUND', 'Route not found', 404);
      if (!domain) throw new ServiceError('DOMAIN_NOT_CONFIGURED', 'Domain capability is unavailable', 503);
      const domainRoute = route;
      const context = { assistantId: store.assistantId, clientId: actor.clientId, authorityEpoch: store.authorityEpoch, now: new Date().toISOString() };
      if (!route.mutation) { send(res, 200, success(store.transaction(tx => domain.execute(tx, domainRoute.operation, domainRoute.input, context)))); return; }
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) throw new ServiceError('BAD_REQUEST', 'Idempotency-Key required');
      if (req.headers['x-didi-authority-epoch'] !== store.authorityEpoch) throw new ServiceError('STALE_AUTHORITY', 'Authority epoch does not match', 409);
      const fingerprint = hash(canonical({ method, path: url.pathname, input: route.input }));
      const response = store.transaction(tx => {
        const prior = tx.get('SELECT * FROM runtime_requests WHERE assistant_id=? AND client_id=? AND request_key=?', [store.assistantId, actor.clientId, key]);
        if (prior) { if (prior.fingerprint !== fingerprint) throw new ServiceError('CONFLICT', 'Idempotency key reused with different request', 409); return JSON.parse(String(prior.response)) as unknown; }
        const data = domain.execute(tx, domainRoute.operation, domainRoute.input, context);
        if (data && typeof (data as unknown as { then?: unknown }).then === 'function') throw new Error('Domain operation must be synchronous');
        const result = success(data);
        tx.run('INSERT INTO runtime_requests VALUES (?,?,?,?,?)', [store.assistantId, actor.clientId, key, fingerprint, JSON.stringify(result)]); return result;
      });
      send(res, 200, response);
    } catch (error) {
      const typed = error instanceof ServiceError ? error : new ServiceError('INTERNAL_ERROR', 'Internal service error', 500);
      if (!res.headersSent && !res.destroyed) send(res, typed.status, { error: { code: typed.code, message: typed.message, ...(typed.details ? { details: typed.details } : {}) }, requestId });
    }
  };
  const server = createServer({ maxHeaderSize: 16_384, requestTimeout: 10_000, headersTimeout: 10_000 }, (req, res) => { void handler(req, res); });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 8765, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing service address');
  origin = `http://127.0.0.1:${address.port}`;
  return { server, origin, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
