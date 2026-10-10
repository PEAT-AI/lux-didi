import { ServiceError } from '../contracts/errors.js';
import type { DomainOperation, DomainOperations } from '../contracts/domain.js';
export type DomainRoute = { kind: 'domain'; operation: DomainOperation; input: DomainOperations[DomainOperation]['input']; mutation: boolean };
export type ConnectedRoute = { kind: 'connected'; action: 'status' | 'enroll' | 'conversation' | 'revoke' | 'accept' | 'run' | 'cancel' | 'events' | 'conversationEvents'; id: string | null; input: Record<string, unknown>; mutation: boolean };
export type SelectionRoute = { kind: 'selection'; clear: boolean; mutation: boolean; input: Record<string, unknown> };
export type LiveRoute = { kind: 'live'; action: 'status' | 'create' | 'snapshot' | 'journal' | 'revoke' | 'audio'; id: string | null; input: Record<string, unknown>; mutation: boolean };
export type Route = DomainRoute | ConnectedRoute | SelectionRoute | LiveRoute | { kind: 'health' | 'status' | 'pairing' | 'pair' | 'session' | 'logout' | 'chat'; mutation: boolean };
type DirectKind = 'health' | 'status' | 'pairing' | 'pair' | 'session' | 'logout' | 'chat';
const bad = (message: string): never => { throw new ServiceError('BAD_REQUEST', message); };
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('JSON object required'); return value as Record<string, unknown>; }
export function fields(body: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) bad('Unknown field');
  if (required.some(key => !(key in body))) bad('Missing required field');
}
function text(value: unknown, max = 16000): string { if (typeof value !== 'string' || value.length > max) return bad('Invalid string'); return value; }
function zone(value: unknown): string { const result = text(value, 100); try { new Intl.DateTimeFormat('en', { timeZone: result }); } catch { return bad('Invalid timeZone'); } return result; }
function uuid(value: unknown): string { const result = text(value, 36); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) return bad('Invalid UUID'); return result; }
function instant(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().replace('.000Z', 'Z') !== result.replace('.000Z', 'Z')) return bad('Invalid UTC instant');
  return result;
}
function memoryIds(value: unknown): void {
  if (!Array.isArray(value) || value.length > 32) return bad('Selected notes must be a list of at most 32 stored note ids');
  for (const id of value) if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return bad('Selected notes must be exact stored note ids');
}
function connectionIds(value: unknown): void {
  if (!Array.isArray(value) || value.length > 32) return bad('Selected connections must be a list of at most 32 connection ids');
  for (const id of value) if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return bad('Selected connections must be exact configured connection ids');
}
function revision(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return bad('Invalid expectedRevision'); return value; }
function source(value: unknown): void {
  const body = object(value);
  fields(body, ['id', 'label', 'provider', 'accountId', 'externalId', 'sourceTimestamp', 'availability', 'note'], ['id', 'label', 'sourceTimestamp', 'availability']);
  uuid(body.id); text(body.label, 1000); instant(body.sourceTimestamp);
  if (!['present', 'missing'].includes(String(body.availability))) bad('Invalid source availability');
  for (const key of ['provider', 'accountId', 'externalId', 'note']) if (key in body) text(body[key], 1000);
}
function query(url: URL, allowed: readonly string[]): void {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) bad('Unknown or duplicate query parameter');
}
export function resolveRoute(method: string, url: URL, body?: Record<string, unknown>): Route {
  const path = url.pathname;
  let expected: string[] = [];
  const matched = (methods: string[]) => { expected = methods; if (!methods.includes(method)) throw new ServiceError('METHOD_NOT_ALLOWED', 'Method is not allowed', 405); };
  if (path === '/api/v1/live/status') { matched(['GET']); query(url, []); return { kind: 'live', action: 'status', id: null, input: {}, mutation: false }; }
  if (path === '/api/v1/live-sessions') {
    matched(['POST']); query(url, []);
    const input = body ? object(body) : {};
    if (body) {
      fields(input, ['inputClass'], ['inputClass']);
      if (!['ordinary', 'private', 'sensitive'].includes(String(input['inputClass']))) bad('Invalid inputClass');
    }
    return { kind: 'live', action: 'create', id: null, input, mutation: true };
  }
  const liveSession = /^\/api\/v1\/live-sessions\/([^/]+)(?:\/(journal|revoke|audio))?$/.exec(path);
  if (liveSession) {
    const id = liveSession[1]!; const sub = liveSession[2];
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) bad('Invalid Live session id');
    if (sub === 'journal') {
      matched(['GET']); query(url, ['cursor', 'limit']);
      const input: Record<string, unknown> = {};
      const cursor = url.searchParams.get('cursor'), limit = url.searchParams.get('limit');
      if (cursor !== null) { if (!/^\d+$/.test(cursor)) bad('Invalid cursor'); input['cursor'] = Number(cursor); }
      if (limit !== null) { if (!/^\d+$/.test(limit)) bad('Invalid limit'); input['limit'] = Number(limit); }
      return { kind: 'live', action: 'journal', id, input, mutation: false };
    }
    if (sub === 'revoke') { matched(['POST']); query(url, []); return { kind: 'live', action: 'revoke', id, input: {}, mutation: true }; }
    if (sub === 'audio') { matched(['GET']); query(url, []); return { kind: 'live', action: 'audio', id, input: {}, mutation: false }; }
    matched(['GET']); query(url, []); return { kind: 'live', action: 'snapshot', id, input: {}, mutation: false };
  }
  let action: ConnectedRoute['action'] | undefined, id: string | null = null;
  if (path === '/api/v1/chat/status') action = 'status';
  else if (path === '/api/v1/conversations') action = 'enroll';
  else if (path === '/api/v1/chat') action = 'accept';
  else {
    const conversation = /^\/api\/v1\/conversations\/([^/]+)(\/(revoke|events))?$/.exec(path);
    const run = /^\/api\/v1\/chat\/([^/]+)(\/(cancel|events))?$/.exec(path);
    if (conversation) { id = conversation[1]!; action = conversation[3] === 'events' ? 'conversationEvents' : conversation[2] ? 'revoke' : 'conversation'; }
    else if (run) { id = run[1]!; action = run[3] === 'cancel' ? 'cancel' : run[3] === 'events' ? 'events' : 'run'; }
    if (id !== null) uuid(id);
  }
  if (action) {
    const mutation = !['status', 'conversation', 'run'].includes(action);
    matched([mutation ? 'POST' : 'GET']); query(url, []);
    if (body) {
      if (action === 'enroll') { fields(body, ['title', 'timeZone'], ['title', 'timeZone']); text(body.title, 500); zone(body.timeZone); }
      else if (action === 'accept') { fields(body, ['sessionId', 'text', 'retryOf', 'selectedMemoryEntryIds', 'selectedConnectionIds'], ['sessionId', 'text']); uuid(body.sessionId); text(body.text); if (body.retryOf !== undefined) uuid(body.retryOf); if (body.selectedMemoryEntryIds !== undefined) memoryIds(body.selectedMemoryEntryIds); if (body.selectedConnectionIds !== undefined) connectionIds(body.selectedConnectionIds); }
      else fields(body, []);
    }
    return { kind: 'connected', action, id, mutation, input: body ?? {} };
  }
  if (path === '/api/v1/conversation-selection' || path === '/api/v1/conversation-selection/clear') {
    const clear = path.endsWith('/clear');
    matched(clear ? ['POST'] : ['GET', 'POST']); query(url, []);
    if (body) {
      if (clear) fields(body, []);
      else { fields(body, ['sessionId', 'title'], ['sessionId', 'title']); uuid(body.sessionId); if (!text(body.title, 1000).trim()) bad('Invalid title'); }
    }
    return { kind: 'selection', clear, mutation: method === 'POST', input: body ?? {} };
  }
  const special: Record<string, [string, DirectKind]> = { '/health': ['GET', 'health'], '/api/v1/status': ['GET', 'status'], '/api/v1/auth/pairing': ['POST', 'pairing'], '/api/v1/auth/pair': ['POST', 'pair'], '/api/v1/auth/session': ['GET', 'session'], '/api/v1/auth/logout': ['POST', 'logout'] };
  const direct = special[path];
  if (direct) {
    matched([direct[0]]); query(url, []);
    if (body) {
      if (direct[1] === 'pair') { fields(body, ['pairingCode'], ['pairingCode']); text(body.pairingCode, 100); }
      else if (direct[1] === 'chat') { fields(body, ['sessionId', 'text', 'timeZone'], ['sessionId', 'text', 'timeZone']); uuid(body.sessionId); text(body.text); zone(body.timeZone); }
      else fields(body, []);
    }
    return { kind: direct[1] as DirectKind, mutation: direct[0] !== 'GET' };
  }
  let operation: DomainOperation;
  let input: Record<string, unknown> = body ? { ...body } : {};
  const session = /^\/api\/v1\/sessions\/([^/]+)(\/entries)?$/.exec(path);
  const commitment = /^\/api\/v1\/commitments\/([^/]+)(?:\/(complete|cancel|reopen))?$/.exec(path);
  if (path === '/api/v1/sessions') {
    matched(['GET', 'POST']); query(url, []);
    operation = method === 'GET' ? 'listSessions' : 'createSession';
    if (body) { fields(body, ['title', 'timeZone'], ['title', 'timeZone']); text(body.title, 1000); zone(body.timeZone); }
  } else if (session) {
    uuid(session[1]); query(url, []);
    matched(session[2] ? ['POST'] : ['GET']);
    operation = session[2] ? 'appendEntry' : 'getSession';
    if (body) { fields(body, ['text', 'role', 'timeZone', 'sourceRef'], ['text', 'role', 'timeZone']); text(body.text); zone(body.timeZone); if (body.role !== 'user') bad('Only user entries are accepted'); if ('sourceRef' in body) source(body.sourceRef); }
    input[session[2] ? 'sessionId' : 'id'] = session[1];
  } else if (path === '/api/v1/recall') {
    matched(['GET']); query(url, ['q', 'limit']);
    const q = text(url.searchParams.get('q') ?? '');
    const rawLimit = url.searchParams.get('limit') ?? '50';
    if (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 200) bad('Invalid recall limit');
    operation = 'recall'; input = { q, limit: Number(rawLimit) };
  } else if (path === '/api/v1/commitments') {
    matched(['GET', 'POST']); query(url, method === 'GET' ? ['status'] : []);
    operation = method === 'GET' ? 'listCommitments' : 'createCommitment';
    if (method === 'GET' && url.searchParams.has('status')) { const status = url.searchParams.get('status'); if (!['active', 'completed', 'cancelled'].includes(status!)) bad('Invalid status'); input = { status }; }
    if (body) {
      fields(body, ['title', 'notes', 'dueAt', 'timeZone', 'sourceSessionId', 'sourceEntryId'], ['title', 'dueAt', 'timeZone']); text(body.title, 1000); zone(body.timeZone); instant(body.dueAt);
      if ('notes' in body) text(body.notes);
      for (const key of ['sourceSessionId', 'sourceEntryId']) if (key in body && body[key] !== null) uuid(body[key]);
    }
  } else if (commitment) {
    uuid(commitment[1]); query(url, []); matched(commitment[2] ? ['POST'] : ['GET', 'PATCH']);
    operation = commitment[2] ? 'transitionCommitment' : method === 'PATCH' ? 'updateCommitment' : 'getCommitment';
    if (body) {
      fields(body, commitment[2] ? ['expectedRevision'] : ['expectedRevision', 'title', 'notes', 'dueAt', 'timeZone'], ['expectedRevision']); revision(body.expectedRevision);
      if ('title' in body) text(body.title, 1000); if ('notes' in body) text(body.notes); if ('timeZone' in body) zone(body.timeZone); if ('dueAt' in body) instant(body.dueAt);
    }
    input.id = commitment[1]; if (commitment[2]) input.operation = commitment[2];
  } else if (path === '/api/v1/plan') {
    matched(['GET']); query(url, ['date', 'timeZone']); operation = 'plan';
    const date = url.searchParams.get('date') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) bad('Invalid plan date');
    input = { date, timeZone: zone(url.searchParams.get('timeZone')) };
  } else throw new ServiceError('NOT_FOUND', 'Route not found', 404);
  // All paths explicitly matched above. No default dispatch to domain or tools.
  if (!expected.length) throw new ServiceError('NOT_FOUND', 'Route not found', 404);
  return { kind: 'domain', operation, input: input as DomainOperations[DomainOperation]['input'], mutation: method !== 'GET' };
}
