import type { LiveCurrent, EntryDeletionResponse } from './protocol';
export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
// Only volatile authority state. Never persist private records or auth credentials.
let epoch: string | undefined;
let csrfToken: string | undefined;
const pendingKeys = new Map<string, string>();
export type AuthorityReset = 'changed' | 'unauthenticated' | 'logout';
let lifetime = new AbortController();
let authorityChanged: ((reason: AuthorityReset) => void) | undefined;
export function onAuthorityChanged(callback: (reason: AuthorityReset) => void) { authorityChanged = callback; }
export function authorityVersion(): AbortSignal { return lifetime.signal; }
export function assertAuthority(version: AbortSignal): void {
  if (version !== lifetime.signal) throw new ApiError('AUTHORITY_CHANGED', 'Your connection changed. Reconnect to load the current records.', 409);
}
export function clearAuthority(reason: AuthorityReset = 'changed') {
  const previous = lifetime; lifetime = new AbortController();
  epoch = undefined; csrfToken = undefined; pendingKeys.clear();
  previous.abort(); authorityChanged?.(reason);
}
export async function request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; pairing?: boolean; idempotencyKey?: string } = {}): Promise<T> {
  const version = authorityVersion();
  if (!navigator.onLine) throw new ApiError('OFFLINE', 'You’re offline. Nothing was sent.', 0);
  const method = options.method ?? 'GET';
  if (method !== 'GET' && !options.pairing && !epoch) throw new ApiError('NOT_CONNECTED', 'Reconnect before making changes.', 0);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const fingerprint = JSON.stringify([epoch, method, path, options.body]);
  let key: string | undefined;
  if (method !== 'GET') {
    key = options.idempotencyKey ?? pendingKeys.get(fingerprint) ?? crypto.randomUUID();
    pendingKeys.set(fingerprint, key);
    headers['Idempotency-Key'] = key;
    if (!options.pairing) {
      headers['X-Didi-Authority-Epoch'] = epoch!;
      if (!csrfToken) throw new ApiError('NOT_CONNECTED', 'Reconnect before making changes.', 0);
      headers['X-Didi-CSRF'] = csrfToken;
    }
  }
  let response: Response, parsed: unknown;
  try {
    response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal ? AbortSignal.any([version, options.signal]) : version });
    assertAuthority(version);
    parsed = await response.json();
  } catch (error) { assertAuthority(version); throw error; }
  assertAuthority(version);
  const envelope = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  if (!response.ok) {
    const value = envelope?.error;
    const error = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    if (response.status === 401 && !options.pairing) clearAuthority('unauthenticated');
    else if (response.status === 409 && error?.code === 'STALE_AUTHORITY') clearAuthority();
    throw new ApiError(typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED', typeof error?.message === 'string' ? error.message : 'The service could not finish that request.', response.status);
  }
  if (!envelope || typeof envelope.authorityEpoch !== 'string' || !envelope.authorityEpoch.length || !Object.prototype.hasOwnProperty.call(envelope, 'data')) throw new ApiError('INVALID_RESPONSE', 'The service returned an unexpected response.', response.status);
  if (epoch && epoch !== envelope.authorityEpoch) { clearAuthority(); throw new ApiError('AUTHORITY_CHANGED', 'Your connection changed. Reconnect to load the current records.', 409); }
  epoch = envelope.authorityEpoch;
  if (pendingKeys.get(fingerprint) === key) pendingKeys.delete(fingerprint);
  return envelope.data as T;
}
// Exact service-owned auth freeze: service/API.md at f640274fe8ea83bf7687f26d709c399a0961148e.
export const demoMode = document.querySelector('meta[name="didi-test-mode"]')?.getAttribute('content') === 'synthetic';
export async function pair(pairingCode: string) {
  const version = authorityVersion();
  const result = await request<{ csrfToken: string }>('/auth/pair', { method: 'POST', body: { pairingCode }, pairing: true });
  assertAuthority(version);
  csrfToken = result.csrfToken;
}
export async function restoreSession() {
  if (!csrfToken) {
    const version = authorityVersion(), result = await request<{ csrfToken: string }>('/auth/session');
    assertAuthority(version); csrfToken = result.csrfToken;
  }
}
export async function logout() {
  const version = authorityVersion();
  await request('/auth/logout', { method: 'POST', body: {} });
  assertAuthority(version); clearAuthority('logout');
}

/** Read-only live projection. GET stays outside the mutation CSRF path; same-origin cookie. */
export async function fetchLive(cursor: string | number | undefined, signal?: AbortSignal): Promise<LiveCurrent> {
  const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(String(cursor))}`;
  return request<LiveCurrent>(`/live/current${query}`, { signal });
}

/** The browser-safe Live summary whitelist returned by GET /api/v1/live/summary. */
export interface LiveSummary {
  provider: string | null;
  modelId: string | null;
  voice: string | null;
  /**
   * The accent selection the next session start composes with. Unlike provider and voice it describes the next
   * call, not a call in flight: each session start reads it from live.json, which is why a save applies at once.
   */
  accent: string | null;
  /**
   * P3: the pitch-preserving speaking pace the next session start plays at. Read-only here: it is set
   * with the config CLI, because a rate that moved mid-utterance would change her voice.
   */
  playbackRate: number | null;
  personaName: string | null;
  limits: { sessionMs: number; idleMs: number } | null;
  /** Present only while the running provider is OpenAI: the delegation backend its calls use. */
  delegationModel?: string | null;
  profileEnabled: boolean;
}

/** The owner's persisted Live provider and voice; it applies when the service next starts. */
export interface LiveSelection { provider: string; modelId: string; voice: string; accent: string; appliesAt: string }

/** Persist the Live provider, voice and accent choice into live.json. Never touches a call in flight. */
export async function saveLiveSelection(input: { provider: string; voice: string; accent: string }, signal?: AbortSignal): Promise<LiveSelection> {
  return request<LiveSelection>('/live/settings', { method: 'POST', body: input, signal });
}

/** Read-only Live summary. GET with the page cookie; the operator bearer is accepted too. */
export async function fetchLiveSummary(signal?: AbortSignal): Promise<LiveSummary> {
  return request<LiveSummary>('/live/summary', { signal });
}

/** One owner click names the Mongoose endpoint it signs in; the host opens the browser for that endpoint
 * alone and answers with a closed outcome. */
/** The Trello row's one click: the host opens the browser for the board sign-in and answers at once. */
export async function startTrelloSignIn(signal?: AbortSignal): Promise<{ status: 'started'; attemptId: string } | { status: 'failed'; reason: string }> {
  return request<{ status: 'started'; attemptId: string } | { status: 'failed'; reason: string }>('/connectors/trello/sign-in', { method: 'POST', body: {}, signal });
}

export async function startMongooseSignIn(endpoint: 'knowledge' | 'data' | 'crm', signal?: AbortSignal): Promise<{ status: 'started'; attemptId: string } | { status: 'failed'; reason: string }> {
  return request<{ status: 'started'; attemptId: string } | { status: 'failed'; reason: string }>('/connectors/mongoose/sign-in', { method: 'POST', body: { endpoint }, signal });
}

/** Fetch SSE uses the same current browser authority; no URL tokens or resend. */
export async function stream(path: string, signal: AbortSignal, onFrame: (value: unknown) => void, onOpen?: () => void): Promise<void> {
  const version = authorityVersion();
  if (!epoch || !csrfToken) throw new ApiError('NOT_CONNECTED', 'Reconnect before subscribing.', 0);
  let response: Response;
  try { response = await fetch(`/api/v1${path}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([version, signal]),
    headers: { 'Content-Type': 'application/json', 'X-Didi-CSRF': csrfToken, 'X-Didi-Authority-Epoch': epoch }, body: '{}' }); }
  catch (error) { assertAuthority(version); throw error; }
  assertAuthority(version);
  if (!response.ok) {
    let body;
    try { body = await response.json(); } catch (error) { assertAuthority(version); throw error; }
    assertAuthority(version);
    if (response.status === 401) clearAuthority('unauthenticated');
    else if (response.status === 409 && body.error?.code === 'STALE_AUTHORITY') clearAuthority();
    throw new ApiError(body.error?.code ?? 'STREAM_ERROR', body.error?.message ?? 'Cannot subscribe to this run.', response.status);
  }
  if (!response.body) throw new ApiError('STREAM_ERROR', 'No event stream was returned.', 0);
  // The subscription is established on the service before any durable snapshot read.
  onOpen?.();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read(); assertAuthority(version); pending += decoder.decode(value, { stream: !done });
      if (pending.length > 1024 * 1024) throw new ApiError('STREAM_ERROR', 'Event frame exceeded the client limit.', 0);
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) { assertAuthority(version); onFrame(JSON.parse(data)); }
      }
      if (done) break;
    }
  } catch (error) { assertAuthority(version); throw error; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function deleteMemoryEntry(id: string, signal?: AbortSignal): Promise<EntryDeletionResponse> {
  return request<EntryDeletionResponse>(`/entries/${encodeURIComponent(id)}`, { method: 'DELETE', body: {}, ...(signal ? { signal } : {}) });
}

/** One distilled conversation summary as the memory list shows it (session memory v1). */
export interface MemorySummaryItem {
  id: string; liveSessionId: string; status: 'complete' | 'skipped' | 'failed';
  summary: string | null; endedAt: string | null; model: string | null; inputChars: number | null;
  inputTruncated: boolean; injectedSummaryIds: string[]; createdAt: string;
}
export interface MemorySummaryDeleteResponse { deletedIds: string[]; notFound: boolean }

export function listMemorySummaries(signal?: AbortSignal): Promise<{ items: MemorySummaryItem[] }> {
  return request<{ items: MemorySummaryItem[] }>('/memory-summaries', { ...(signal ? { signal } : {}) });
}

export function deleteMemorySummary(id: string, signal?: AbortSignal): Promise<MemorySummaryDeleteResponse> {
  return request<MemorySummaryDeleteResponse>(`/memory-summaries/${encodeURIComponent(id)}`, { method: 'DELETE', body: {}, ...(signal ? { signal } : {}) });
}
