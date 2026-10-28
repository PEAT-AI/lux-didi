import { HostLog } from '../host/log.js';
import { AlarmSessionCoordinator, type AlarmScheduler, type AlarmShellBridge, type AlarmRecheck } from '../host/alarm-scheduler.js';
import type { LivePendingService } from '../live/types.js';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Store, scrubDeletedMemoryResponses } from '../runtime/store.js';
import type { DomainPort, EntryTombstone } from '../contracts/domain.js';
import { ChatError, redactDeletedMemoryContext, type ChatPort } from '../chat/index.js';
import { redactDeletedMemorySnapshots } from '../live/index.js';
import type { ConnectedStatus } from '../host/connected.js';
import { ServiceError } from '../contracts/errors.js';
import { ConfigError } from '../config/index.js';
import { currentLiveAccent, currentLivePlaybackRate } from '../config/live.js';
import { LiveConfigError } from '../live/types.js';
import { OPENAI_DELEGATION_MODEL } from '../adapters/live-voice/openai.js';
import { clientDiagnostic, object, resolveRoute } from './routes.js';
import { projectIdentity } from '../connectors/identity.js';
import { ConversationSelection, NO_SELECTION } from './conversationSelection.js';
import { createStaticHandler } from './static.js';
import type { DataClass } from '../adapters/live-voice/index.js';
import { authorityContext, operatorPrincipal } from './auth.js';
import { createLiveUpgrader, liveServiceError, type LiveService } from './live-upgrade.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
/** Mongoose and Trello are the connectors the owner signs in to, so the sign-in reason is scoped to them. */
function signInConnector(row: Record<string, unknown>): boolean {
  return row.connector === 'mongoose' || row.connector === 'trello';
}

const SIGN_IN_PHASES = ['running', 'waiting', 'finishing', 'signed_in', 'failed'];
const SIGN_IN_FAILURES = ['discovery_unreachable', 'discovery_refused', 'registration_refused', 'port_in_use', 'browser_unavailable', 'callback_failed', 'callback_timeout', 'token_refused', 'store_failed', 'did_not_finish'];
/** One Mongoose row's sign-in attempt as closed tokens and an opaque id, or nothing. */
function signInAttempt(value: { attemptId: string; phase: string; reason?: string } | undefined): Record<string, string> | undefined {
  if (!value || !/^[0-9a-f]{16}$/.test(value.attemptId) || !SIGN_IN_PHASES.includes(value.phase)) return undefined;
  if (value.phase === 'failed') return SIGN_IN_FAILURES.includes(String(value.reason)) ? { attemptId: value.attemptId, phase: value.phase, reason: String(value.reason) } : undefined;
  return { attemptId: value.attemptId, phase: value.phase };
}

/**
 * The one closed reason code a connection row carries to the browser. A transport that never answered is
 * unreachable whatever layer timed it out, including an identity probe that ran out of time; a
 * cancellation whose origin is not known is not reported as a dead endpoint, because it is not one.
 */
export function connectionReasonCode(input: { state: string; error: string; reasonCode?: string | undefined; configurationError?: string | undefined; signIn: boolean }): string | null {
  const { state, error, configurationError, signIn } = input;
  if (state === 'connected' || state === 'connecting' || (state === 'configured' && !error)) return null;
  if (configurationError) return 'configuration_error';
  if (/^credential .* missing or invalid$/.test(error)) return 'credential_missing';
  if (/^not_signed_in$/.test(error)) return signIn ? 'needs_sign_in' : 'not_signed_in';
  // W7-R2: the Trello board has no configured name, which is the owner's private file, not a fault.
  if (/^not_configured$/.test(error)) return 'not_configured';
  if (/^credential_mismatch$/.test(error)) return 'identity_mismatch';
  if (/^credential-refresh-unavailable$/.test(error)) return 'unreachable';
  if (/^credential-(missing|refresh-failed|consent-expired)$/.test(error)) return signIn ? 'needs_sign_in' : 'unknown';
  // An identity probe that ran out of time says nothing about whose account it is, so it is unreachable.
  if (input.reasonCode === 'identity_timeout' || /timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|unreachable/.test(error)) return 'unreachable';
  if (/discovery/.test(error)) return 'discovery_failed';
  if (/handshake/.test(error)) return 'handshake_failed';
  return /identity/.test(error) ? 'identity_mismatch' : 'unknown';
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function readBody(req: IncomingMessage, limit = 65536): Promise<Record<string, unknown>> {
  if (req.headers['content-type'] !== 'application/json' && req.headers['content-type'] !== 'application/json; charset=utf-8') throw new ServiceError('BAD_REQUEST', 'JSON Content-Type required');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += (chunk as Buffer).length; if (size > limit) { req.resume(); throw new ServiceError(limit === 512 ? 'BAD_REQUEST' : 'PAYLOAD_TOO_LARGE', 'Request body exceeds limit', limit === 512 ? 400 : 413); } chunks.push(chunk as Buffer); }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { if (error instanceof ServiceError) throw error; throw new ServiceError('BAD_REQUEST', 'Malformed JSON'); }
}
interface Principal { clientId: string; mode: 'bearer' | 'browser'; tokenHash?: string; csrfToken?: string }
export interface ServiceOptions { alarms?: { scheduler: AlarmScheduler; shell: AlarmShellBridge }; ownerProfileStatus?: { status: 'default' | 'configured'; displayName: string }; store: Store; domain?: DomainPort; port?: number; now?: () => number; webRoot?: string; chat?: ChatPort; modelStatus?: ConnectedStatus; live?: LiveService; toolsStatus?: () => { endpoints: unknown[] }; mongooseSignIn?: (endpoint?: string) => Promise<{ status: 'started'; attemptId: string } | { status: 'failed'; reason: string }>; mongooseSignInAttempt?: (endpointId: string, connected: boolean) => { attemptId: string; phase: string; reason?: string } | undefined; trelloRow?: () => Record<string, unknown> }
export interface EntryDeletionResponse extends EntryTombstone { liveSessionRetainsUntilRebuild: boolean }
export interface RunningService { server: Server; origin: string; close(): Promise<void> }
export async function listenService(options: ServiceOptions): Promise<RunningService> {
  const { store, domain, chat, live } = options;
  const modelStatus = options.modelStatus ?? { status: 'unconfigured' };
  const streamClosers = new Map<string, Set<() => void>>();
  const alarmStreams = new Set<() => void>();
  let streamCount = 0;
  const serveStatic = options.webRoot === undefined ? undefined : await createStaticHandler(options.webRoot);
  const now = options.now ?? Date.now;
  let origin = '';
  const pairing = new Map<string, number>();
  const selection = new ConversationSelection();
  const diagnosticLog = new HostLog(store.directory);
  const alarmSessions = options.alarms && live ? new AlarmSessionCoordinator({ store,
    hasLiveSession: () => !['idle', 'ended', 'error'].includes(live.current().state),
    open: (setup, key) => {
      if (!live.createAlarm) throw Error('alarm_speech_unavailable');
      return live.createAlarm(setup, key, { clientId: 'local-admin', auditId: randomUUID(), authorityEpoch: store.authorityEpoch }).liveSessionId;
    },
    degraded: (id, reason) => {
      const alarm = options.alarms!.scheduler.list().find(row => row.id === id);
      if (alarm) diagnosticLog.event({ event: 'alarm_degraded', alarmId: id, scheduledMs: alarm.fireAtUtc, actualMs: now(), reason });
    },
  }) : undefined;
  const diagnosticTimes = new Map<string, number[]>();
  const liveClients = () => new Set(store.transaction(tx => tx.all('SELECT DISTINCT client_id FROM runtime_sessions WHERE expires_at>?', [now()])).map(row => String(row.client_id)));
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
    const row = store.transaction(tx => tx.get('SELECT * FROM runtime_sessions WHERE token_hash=? AND expires_at>?', [tokenHash, now()]));
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
      if (serveStatic && await serveStatic(req, res)) return;
      const method = req.method ?? '';
      if (url.pathname.startsWith('/v1/alarms/') && options.alarms) {
        const actor = principal(req);
        if (actor.mode !== 'bearer') throw new ServiceError('FORBIDDEN', 'Native shell only', 403);
        const { scheduler, shell } = options.alarms;
        if (method === 'GET' && url.pathname === '/v1/alarms/events') {
          for (const close of [...alarmStreams]) close();
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
          res.flushHeaders();
          const unbind = shell.bind(frame => !res.destroyed && res.write(`data: ${JSON.stringify(frame)}\n\n`));
          const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': alarm heartbeat\n\n'); }, 30000);
          heartbeat.unref();
          const close = () => { clearInterval(heartbeat); unbind(); alarmStreams.delete(close); res.end(); };
          alarmStreams.add(close);
          req.on('close', close);
          shell.state(scheduler.list());
          scheduler.recheck('reconnect');
          return;
        }
        if (method === 'POST' && req.headers['x-didi-authority-epoch'] === store.authorityEpoch) {
          const body = await readBody(req);
          if (url.pathname === '/v1/alarms/session' && typeof body.id === 'string' && typeof body.ownerDisplayName === 'string' && body.ownerDisplayName.length > 0 && body.ownerDisplayName.length <= 120) {
            const attempt = alarmSessions?.attempt(body.id, body.ownerDisplayName);
            if (attempt?.status === 'created' && attempt.liveSessionId && live) { send(res, 201, success(live.snapshot(attempt.liveSessionId))); return; }
            send(res, 409, { error: { code: 'ALARM_SPEECH_UNAVAILABLE', message: 'Local ringing continues.' }, requestId }); return;
          }
          if (url.pathname === '/v1/alarms/ring-started' && typeof body.id === 'string') {
            const alarm = scheduler.list().find(row => row.id === body.id && row.state === 'ringing');
            if (alarm) diagnosticLog.event({ event: 'alarm_ring_started', alarmId: alarm.id, scheduledMs: alarm.fireAtUtc, actualMs: now(), reason: 'local_ring' });
            send(res, 200, success({ status: 'ok' })); return;
          }
          if (url.pathname === '/v1/alarms/shell' && typeof body.assertion === 'boolean' && typeof body.notifications === 'boolean') {
            shell.report({ assertion: body.assertion, notifications: body.notifications });
            send(res, 200, success(shell.health())); return;
          }
          const reasons: AlarmRecheck[] = ['wake', 'clock_changed', 'timezone_changed'];
          if (url.pathname === '/v1/alarms/recheck' && reasons.some(reason => reason === body.reason)) {
            scheduler.recheck(body.reason as AlarmRecheck); send(res, 200, success({ status: 'ok' })); return;
          }
          if (url.pathname === '/v1/alarms/acknowledged' && typeof body.id === 'string') {
            send(res, 200, success({ acknowledged: scheduler.acknowledge(body.id) })); return;
          }
        }
        throw new ServiceError('BAD_REQUEST', 'Invalid alarm shell request');
      }
      let route = resolveRoute(method, url);
      if (route.kind === 'health') { send(res, 200, { status: 'ok', version: '0.1.0', serviceMode: 'loopback' }); return; }
      if (route.kind === 'pair') {
        if (req.headers.origin !== origin) throw new ServiceError('FORBIDDEN', 'Exact Origin required', 403);
        const body = await readBody(req); resolveRoute(method, url, body);
        const codeHash = hash(String(body.pairingCode)); const expiry = pairing.get(codeHash); pairing.delete(codeHash);
        if (!expiry || expiry <= now()) throw new ServiceError('UNAUTHORIZED', 'Pairing code invalid or expired', 401);
        const token = secret(), csrfToken = secret();
        store.transaction(tx => { tx.run('DELETE FROM runtime_sessions WHERE expires_at<=?', [now()]); tx.run('INSERT INTO runtime_sessions VALUES (?,?,?,?)', [hash(token), randomUUID(), csrfToken, now() + 12 * 60 * 60 * 1000]); });
        res.setHeader('Set-Cookie', `didi_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        send(res, 200, success({ csrfToken })); return;
      }
      // Live is operator-bearer only and must run before the generic cookie/Bearer principal so a
      // browser cookie/CSRF or any Origin gets 403 before the owner or credentials are touched.
      if (route.kind === 'clientDiagnostics') {
        const operator = operatorPrincipal(req, store, origin);
        const diagnostic = clientDiagnostic(await readBody(req, 512));
        const received = now();
        const times = (diagnosticTimes.get(operator.clientId) ?? []).filter(time => time > received - 60000);
        if (times.length >= 30) throw new ServiceError('rate_limited', 'Client diagnostic rate limit exceeded', 429);
        diagnosticLog.event({ event: 'client_diagnostic', source: 'native', diagnostic, receivedAt: new Date(received).toISOString() });
        times.push(received); diagnosticTimes.set(operator.clientId, times);
        res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return;
      }
      // The live settings write is the one live route a browser reaches; it is handled below, after the
      // generic mutation resolve, so it gets the cookie, CSRF token and authority epoch every write has.
      if (route.kind === 'live' && route.action !== 'settings') {
        if (!live) throw new ServiceError('MODEL_NOT_CONFIGURED', 'Live route is not locally configured', 503);
        const principal = operatorPrincipal(req, store, origin);
        const context = authorityContext(req, store, principal);
        const jobs = live as typeof live & Partial<LivePendingService>;
        if (route.action === 'pendingJobs') { send(res, 200, success(jobs.pendingJobs?.() ?? [])); return; }
        if (route.action === 'status') { send(res, 200, success(live.status())); return; }
        if (route.action === 'prewarm') {
          // 338: the owner's wake instruction. A wake belongs to no session, so it is answered before the
          // enabled gate exactly as `status` is; the caller never gets an error for a cold calendar. The
          // body names no field, which the route's second pass is what refuses.
          const resolved = resolveRoute(method, url, await readBody(req));
          if (resolved.kind !== 'live' || resolved.action !== 'prewarm') throw new ServiceError('BAD_REQUEST', 'Invalid Live request');
          const receipt = await live.prewarm();
          send(res, 200, success(receipt));
          return;
        }
        if (!live.enabled) throw new ServiceError('MODEL_NOT_CONFIGURED', 'Live is not locally configured', 503);
        if (route.action === 'create') {
          const body = await readBody(req);
          const resolved = resolveRoute(method, url, body);
          if (resolved.kind !== 'live') throw new ServiceError('BAD_REQUEST', 'Invalid Live request');
          const key = req.headers['idempotency-key'];
          if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) throw new ServiceError('BAD_REQUEST', 'Idempotency-Key required');
          // R3-R5, 1015: the start uses the digest the host's background owner already read; with no
          // fresh cache it waits at most 1,500 ms for a read in flight, never a whole read. It cannot
          // fail the start: an absent, failed or stale read leaves the slot out.
          await live.prepareCalendar();
          if (res.destroyed) return;
          send(res, 200, success(jobs.createWithPending ? jobs.createWithPending(String(resolved.input['inputClass']) as DataClass, key, context, resolved.input['pickupJobId'] as string | undefined) : live.create(String(resolved.input['inputClass']) as DataClass, key, context))); return;
        }
        if (route.action === 'snapshot') { send(res, 200, success(live.snapshot(route.id!))); return; }
        if (route.action === 'journal') { send(res, 200, success(live.journal(route.id!, route.input['cursor'] as number | undefined, route.input['limit'] as number | undefined))); return; }
        if (route.action === 'revoke') { live.revoke(route.id!); send(res, 200, success({ liveSessionId: route.id!, revoked: true })); return; }
        if (route.action === 'text') { live.text(String(route.input['text'])); send(res, 200, success({ sent: true })); return; }
        throw new ServiceError('METHOD_NOT_ALLOWED', 'Audio requires a WebSocket upgrade', 405);
      }
      const actor = principal(req);
      if (route.kind === 'liveSummary') {
        // Browser-safe sibling of the operator-only status route: a closed whitelist for the page,
        // never key references, prompts, endpoints or credentials. Cookie and operator both read it.
        const status = live?.status();
        const active = status && status.status === 'configured' ? status : undefined;
        const personaName = options.ownerProfileStatus?.displayName ?? null;
        res.setHeader('Cache-Control', 'no-store');
        send(res, 200, success({
          provider: active?.provider ?? null,
          modelId: active?.model ?? null,
          voice: active?.voice ?? null,
          // The accent selection the next session start composes with, so the page can show what runs.
          accent: active ? currentLiveAccent() : null,
          // P3: the pitch-preserving pace the next session start plays at, shown read-only on the page.
          playbackRate: active ? currentLivePlaybackRate() : null,
          // Names only: the delegation backend the OpenAI Live adapter pins, and nothing else about it.
          ...(active?.provider === 'openai' ? { delegationModel: OPENAI_DELEGATION_MODEL } : {}),
          personaName: active ? personaName : null,
          limits: active?.limits ?? null,
          profileEnabled: active !== undefined,
        })); return;
      }
      if (route.kind === 'liveCurrent' || route.kind === 'liveConnections') {
        if (actor.mode !== 'browser' || req.headers.authorization !== undefined || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) throw new ServiceError('FORBIDDEN', 'Page session required', 403);
        res.setHeader('Cache-Control', 'no-store');
        if (route.kind === 'liveConnections') {
          // The Trello board row rides beside the catalogue rows; it carries its own latest sign-in attempt.
          const endpoints = [...(options.toolsStatus?.().endpoints ?? []), ...(options.trelloRow ? [options.trelloRow()] : [])].map(value => {
            const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
            const state = ['missing', 'configured', 'connecting', 'connected', 'error'].includes(String(row.state)) ? String(row.state) : 'error';
            // Classify privately; return only closed reason tokens, never the original diagnostic.
            const error = typeof row.error === 'string' ? row.error : '';
            const configurationError = ['unknown-class-missing', 'unknown-class-invalid', 'owner-approval-required', 'ambiguous-legacy-policy'].includes(String(row.configurationError)) ? String(row.configurationError) : undefined;
            // Only Mongoose has an owner sign-in, so only its rows can carry the sign-in reason.
            const reasonCode = connectionReasonCode({ state, error, reasonCode: typeof row.reasonCode === 'string' ? row.reasonCode : undefined, configurationError, signIn: signInConnector(row) });
            const identity = projectIdentity(row.identity);
            // The latest sign-in attempt of a Mongoose row: the click answered at once, the row tells the rest.
            // A connected row settles its finished attempt, so a later failure never carries an old outcome.
            const signIn = signInConnector(row) && typeof row.id === 'string' ? signInAttempt(options.mongooseSignInAttempt?.(row.id, state === 'connected')) : undefined;
            return {
              id: typeof row.id === 'string' && /^[\w.-]{1,128}$/.test(row.id) ? row.id : 'unknown', state,
              tools: typeof row.tools === 'number' && Number.isSafeInteger(row.tools) && row.tools >= 0 ? row.tools : 0,
              lastHandshakeAt: typeof row.lastHandshakeAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(row.lastHandshakeAt) && Number.isFinite(Date.parse(row.lastHandshakeAt)) ? row.lastHandshakeAt : null,
              reasonCode,
              // True only while a bounded recovery attempt is really scheduled for this endpoint.
              retrying: row.retrying === true,
              ...(identity ? { identity } : {}),
              ...(configurationError ? { configurationError } : {}),
              ...(signIn ? { signIn } : {}),
              // C-OPEN 6: the one closed wiring notice a row may carry; nothing else of the report passes.
              ...(row.warning === 'google_mcp_path_unsafe' ? { warning: 'google_mcp_path_unsafe' } : {}),
              // W2-R1: the added read names a remaining refusal names in the approve command text, closed
              // tokens only, so no provider text or schema ever rides along.
              ...(Array.isArray(row.addedToolNames) ? { addedToolNames: row.addedToolNames.filter((name): name is string => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)).slice(0, 64) } : {}),
            };
          });
          send(res, 200, success(endpoints)); return;
        }
        if (route.kind === 'liveCurrent') {
          send(res, 200, success(live ? live.current(route.cursor) : { state: 'idle', since: null, entries: [], cursor: route.cursor })); return;
        }
      }
      if (route.mutation) csrf(req, actor);
      if (route.kind === 'status') {
        send(res, 200, success({ ownerProfile: options.ownerProfileStatus ?? { status: 'default', displayName: 'Lux Didi' }, assistantId: store.assistantId, authorityEpoch: store.authorityEpoch, serviceMode: 'loopback', capabilities: { memory: !!domain, commitments: !!domain, notifications: false, model: modelStatus.status === 'configured' }, model: { configured: modelStatus.status === 'configured', ...modelStatus }, sources: [], capabilityReasons: { ...(!domain ? { memory: 'DOMAIN_NOT_CONFIGURED', commitments: 'DOMAIN_NOT_CONFIGURED' } : {}), notifications: 'NOTIFICATION_NOT_CONFIGURED', ...(modelStatus.status === 'configured' ? {} : { model: 'MODEL_NOT_CONFIGURED' }) } })); return;
      }
      if (route.kind === 'toolsStatus') {
        if (actor.mode !== 'bearer') throw new ServiceError('FORBIDDEN', 'Local operator credential required', 403);
        send(res, 200, success(options.toolsStatus?.() ?? { endpoints: [] })); return;
      }
      if (route.kind === 'mongooseSignIn') {
        // One explicit owner click starts the login and is answered at once with its attempt id or a closed
        // refusal, never a URL, a token, a record or a provider message. Nothing opens a browser at app start.
        // The click names the one endpoint it signs in; the host validates the name against its catalogue.
        const body = await readBody(req);
        const endpoint = typeof body.endpoint === 'string' ? body.endpoint : undefined;
        const started = options.mongooseSignIn ? await options.mongooseSignIn(endpoint) : { status: 'failed' as const, reason: 'not-configured' };
        send(res, 200, success(started)); return;
      }
      if (route.kind === 'session') { send(res, 200, success({ clientId: actor.clientId, csrfToken: actor.csrfToken ?? null })); return; }
      if (route.kind === 'connected' && ['enroll', 'accept'].includes(route.action) && (!chat || modelStatus.status !== 'configured')) throw new ServiceError('MODEL_NOT_CONFIGURED', 'Model route is not locally configured', 503);
      if (route.mutation) { const body = await readBody(req); route = resolveRoute(method, url, body); }
      if (route.kind === 'live' && route.action === 'settings') {
        // Browser-safe sibling of the bearer-only live session routes, like liveSummary and
        // liveConnections: the Settings page answers the owner's Save with the same cookie, CSRF token
        // and authority epoch as any other mutation, and the body was read and validated by the
        // mutation resolve just above. The choice is written to live.json and touches no session.
        if (!live) throw new ServiceError('MODEL_NOT_CONFIGURED', 'Live route is not locally configured', 503);
        if (!live.saveSelection) throw new ServiceError('MODEL_NOT_CONFIGURED', 'Live settings are not writable here', 503);
        let saved;
        try {
          saved = live.saveSelection({ provider: route.input['provider'],
            ...(route.input['voice'] !== undefined ? { voice: route.input['voice'] } : {}),
            ...(route.input['accent'] !== undefined ? { accent: route.input['accent'] } : {}) });
        } catch (error) { throw new ServiceError('BAD_REQUEST', error instanceof ConfigError || error instanceof LiveConfigError ? error.code : 'invalid_selection', 400); }
        send(res, 200, success(saved));
        return;
      }
      if (route.kind === 'pairing') {
        if (actor.mode !== 'bearer') throw new ServiceError('FORBIDDEN', 'Local operator credential required', 403);
        for (const [key, expiry] of pairing) if (expiry <= now()) pairing.delete(key);
        if (pairing.size >= 16) throw new ServiceError('CONFLICT', 'Outstanding pairing limit reached', 409);
        const pairingCode = secret(), expires = now() + 300_000; pairing.set(hash(pairingCode), expires);
        send(res, 200, success({ pairingCode, expiresAt: new Date(expires).toISOString() })); return;
      }
      if (route.kind === 'logout') {
        if (actor.mode !== 'browser') throw new ServiceError('BAD_REQUEST', 'Browser session required');
        store.transaction(tx => tx.run('DELETE FROM runtime_sessions WHERE token_hash=?', [actor.tokenHash!]));
        selection.clear(actor.clientId);
        for (const close of [...(streamClosers.get(actor.clientId) ?? [])]) close();
        res.setHeader('Set-Cookie', 'didi_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); send(res, 200, success({ revoked: true })); return;
      }
      if (route.kind === 'selection') {
        if (actor.mode !== 'browser') throw new ServiceError('FORBIDDEN', 'Browser session required', 403);
        if (route.mutation && req.headers['x-didi-authority-epoch'] !== store.authorityEpoch) throw new ServiceError('STALE_AUTHORITY', 'Authority epoch does not match', 409);
        selection.prune(liveClients());
        if (route.clear) { selection.clear(actor.clientId); send(res, 200, success({ ...NO_SELECTION })); return; }
        if (!route.mutation) { send(res, 200, success(selection.get(actor.clientId) ?? { ...NO_SELECTION })); return; }
        if (!chat) throw new ServiceError('MODEL_NOT_CONFIGURED', 'Model route is not locally configured', 503);
        const sessionId = String(route.input.sessionId), title = String(route.input.title);
        const context = { assistantId: store.assistantId, clientId: actor.clientId, authorityEpoch: store.authorityEpoch, now: new Date(now()).toISOString() };
        let state: string;
        try { state = chat.conversation(sessionId, context).state; }
        catch { throw new ServiceError('NOT_FOUND', 'Conversation is not available for this client', 404); }
        if (state !== 'active') throw new ServiceError('NOT_FOUND', 'Conversation is not available for this client', 404);
        selection.set(actor.clientId, { sessionId, title });
        send(res, 200, success({ sessionId, title })); return;
      }
      if (route.kind === 'connected') {
        const context = { assistantId: store.assistantId, clientId: actor.clientId, authorityEpoch: store.authorityEpoch, now: new Date(now()).toISOString() };
        if (route.action === 'status') { send(res, 200, success({ ...modelStatus, consent: chat?.standingConsent(context) ?? null })); return; }
        if (!chat || (['enroll', 'accept'].includes(route.action) && modelStatus.status !== 'configured')) throw new ServiceError('MODEL_NOT_CONFIGURED', 'Model route is not locally configured', 503);
        if (route.mutation && req.headers['x-didi-authority-epoch'] !== store.authorityEpoch) throw new ServiceError('STALE_AUTHORITY', 'Authority epoch does not match', 409);
        const key = req.headers['idempotency-key'];
        if (['enroll', 'accept'].includes(route.action) && (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key))) throw new ServiceError('BAD_REQUEST', 'Idempotency-Key required');
        const input = route.input;
        if (route.action === 'enroll') { send(res, 200, success(chat.enroll({ title: String(input.title), timeZone: String(input.timeZone), idempotencyKey: String(key), consent: input.consent === true, remember: input.remember === true }, context))); return; }
        if (route.action === 'conversation') { send(res, 200, success(chat.conversation(route.id!, context))); return; }
        if (route.action === 'revoke') { send(res, 200, success(chat.revoke(route.id!, context))); return; }
        if (route.action === 'accept') { send(res, 200, success(chat.accept({ sessionId: String(input.sessionId), text: String(input.text), idempotencyKey: String(key), ...(input.retryOf === undefined ? {} : { retryOf: String(input.retryOf) }), ...(input.selectedMemoryEntryIds === undefined ? {} : { selectedMemoryEntryIds: input.selectedMemoryEntryIds as string[] }) }, context))); return; }
        if (route.action === 'run') { send(res, 200, success(chat.get(route.id!, context))); return; }
        if (route.action === 'cancel') { send(res, 200, success(chat.cancel(route.id!, context))); return; }
        const closers = streamClosers.get(actor.clientId) ?? new Set<() => void>();
        if (streamCount >= 64 || closers.size >= 4) throw new ServiceError('CONFLICT', 'Subscriber limit reached', 429);
        const source: AsyncIterable<unknown> = route.action === 'events' ? chat.subscribe(route.id!, context) : chat.subscribeConversation(route.id!, context);
        const iterator = source[Symbol.asyncIterator]();
        let closed = false, timer: ReturnType<typeof setInterval> | undefined;
        const close = () => {
          if (closed) return; closed = true;
          if (timer) clearInterval(timer);
          closers.delete(close); if (!closers.size) streamClosers.delete(actor.clientId); streamCount--;
          res.off('close', close); void iterator.return?.(); res.end();
        };
        const authorized = () => {
          try { const current = principal(req); return current.clientId === actor.clientId && store.authorityEpoch === context.authorityEpoch && req.headers['x-didi-authority-epoch'] === context.authorityEpoch; }
          catch { return false; }
        };
        closers.add(close); streamClosers.set(actor.clientId, closers); streamCount++;
        res.on('close', close);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        const flush = (frame: string) => { if (closed) return false; if (!authorized()) { close(); return false; } if (!res.write(frame)) { close(); return false; } return true; };
        timer = setInterval(() => { flush(': heartbeat\n\n'); }, 250);
        try {
          while (!closed) {
            const item = await iterator.next(); if (item.done) break;
            if (!flush(`data: ${JSON.stringify(item.value)}\n\n`)) break;
          }
        } finally { close(); }
        return;
      }
      if (route.kind === 'chat') throw new ServiceError('MODEL_NOT_CONFIGURED', 'Model capability is unavailable', 503);
      if (route.kind !== 'domain') throw new ServiceError('NOT_FOUND', 'Route not found', 404);
      if (!domain) throw new ServiceError('DOMAIN_NOT_CONFIGURED', 'Domain capability is unavailable', 503);
      const domainRoute = route;
      const context = { assistantId: store.assistantId, clientId: actor.clientId, authorityEpoch: store.authorityEpoch, now: new Date(now()).toISOString() };
      if (!route.mutation) { send(res, 200, success(store.transaction(tx => domain.execute(tx, domainRoute.operation, domainRoute.input, context)))); return; }
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) throw new ServiceError('BAD_REQUEST', 'Idempotency-Key required');
      if (req.headers['x-didi-authority-epoch'] !== store.authorityEpoch) throw new ServiceError('STALE_AUTHORITY', 'Authority epoch does not match', 409);
      const fingerprint = hash(canonical({ method, path: url.pathname, input: route.input }));
      let publishLiveRedaction = () => {};
      const response = store.transaction(tx => {
        const prior = tx.get('SELECT * FROM runtime_requests WHERE assistant_id=? AND client_id=? AND request_key=?', [store.assistantId, actor.clientId, key]);
        if (prior) { if (prior.fingerprint !== fingerprint) throw new ServiceError('CONFLICT', 'Idempotency key reused with different request', 409); return JSON.parse(String(prior.response)) as unknown; }
        let deletedText: string | undefined;
        let liveSessionRetainsUntilRebuild = false;
        const deletedId = domainRoute.operation === 'deleteEntry' ? (domainRoute.input as { id: string }).id : undefined;
        if (deletedId !== undefined) {
          try { deletedText = domain.execute(tx, 'resolveEntries', { entryIds: [deletedId] }, context).records[0]?.text; }
          catch (error) { if (!(error instanceof ServiceError && error.code === 'NOT_FOUND')) throw error; }
        }
        const data = domain.execute(tx, domainRoute.operation, domainRoute.input, context);
        if (deletedId !== undefined) {
          redactDeletedMemoryContext(tx, deletedId);
          const liveRedaction = redactDeletedMemorySnapshots(store, tx, deletedId);
          publishLiveRedaction = liveRedaction.publish;
          liveSessionRetainsUntilRebuild = liveRedaction.liveSessionRetainsUntilRebuild;
          scrubDeletedMemoryResponses(tx, store.assistantId, deletedText);
        }
        if (data && typeof (data as unknown as { then?: unknown }).then === 'function') throw new Error('Domain operation must be synchronous');
        const result = success(deletedId === undefined ? data : { ...(data as EntryTombstone), liveSessionRetainsUntilRebuild } satisfies EntryDeletionResponse);
        tx.run('INSERT INTO runtime_requests VALUES (?,?,?,?,?)', [store.assistantId, actor.clientId, key, fingerprint, JSON.stringify(result)]); return result;
      });
      publishLiveRedaction();
      send(res, 200, response);
    } catch (error) {
      const typed = error instanceof ServiceError ? error : error instanceof ChatError
        ? new ServiceError(error.code === 'unavailable' ? 'MODEL_NOT_CONFIGURED' : error.code === 'invalid_input' ? 'BAD_REQUEST' : error.code === 'not_found' ? 'NOT_FOUND' : error.code === 'unauthorized' ? 'FORBIDDEN' : 'CONFLICT', error.message,
          error.code === 'invalid_input' ? 400 : error.code === 'not_found' ? 404 : ['unauthorized'].includes(error.code) ? 403 : error.code === 'unavailable' ? 503 : 409)
        : liveServiceError(error);
      if (!res.headersSent && !res.destroyed) send(res, typed.status, { error: { code: typed.code, message: typed.message, ...(typed.details ? { details: typed.details } : {}) }, requestId });
    }
  };
  const server = createServer({ maxHeaderSize: 16_384, requestTimeout: 10_000, headersTimeout: 10_000 }, (req, res) => { void handler(req, res); });
  const upgrader = live ? createLiveUpgrader({ live, store, origin: () => origin, maxIncomingBytes: live.maxIncomingBytes, maxBufferedBytes: live.maxBufferedBytes }) : undefined;
  if (upgrader) server.on('upgrade', (req, socket, head) => { upgrader.handle(req, socket, head); });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 8765, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing service address');
  origin = `http://127.0.0.1:${address.port}`;
  return { server, origin, close: () => new Promise<void>((resolve, reject) => {
    for (const close of [...alarmStreams]) close();
    for (const closers of [...streamClosers.values()]) for (const close of [...closers]) close();
    const finish = () => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); };
    if (upgrader) void upgrader.close().then(finish, finish); else finish();
  }) };
}
