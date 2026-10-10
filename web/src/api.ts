export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
// Only volatile authority state. Never persist private records or auth credentials.
let epoch: string | undefined;
let csrfToken: string | undefined;
const pendingKeys = new Map<string, string>();
let authorityChanged: (() => void) | undefined;
export function onAuthorityChanged(callback: () => void) { authorityChanged = callback; }
export function clearAuthority() { epoch = undefined; csrfToken = undefined; pendingKeys.clear(); }
export async function request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; pairing?: boolean; idempotencyKey?: string } = {}): Promise<T> {
  if (!navigator.onLine) throw new ApiError('OFFLINE', 'You’re offline. Nothing was sent.', 0);
  const method = options.method ?? 'GET';
  if (method !== 'GET' && !options.pairing && !epoch) throw new ApiError('NOT_CONNECTED', 'Reconnect before making changes.', 0);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const fingerprint = JSON.stringify([epoch, method, path, options.body]);
  if (method !== 'GET') {
    const key = options.idempotencyKey ?? pendingKeys.get(fingerprint) ?? crypto.randomUUID();
    pendingKeys.set(fingerprint, key);
    headers['Idempotency-Key'] = key;
    if (!options.pairing) {
      headers['X-Didi-Authority-Epoch'] = epoch!;
      if (!csrfToken) throw new ApiError('NOT_CONNECTED', 'Reconnect before making changes.', 0);
      headers['X-Didi-CSRF'] = csrfToken;
    }
  }
  const response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal });
  const parsed: unknown = await response.json();
  const envelope = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  if (!response.ok) {
    const value = envelope?.error;
    const error = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    throw new ApiError(typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED', typeof error?.message === 'string' ? error.message : 'The service could not finish that request.', response.status);
  }
  if (!envelope || typeof envelope.authorityEpoch !== 'string' || !envelope.authorityEpoch.length || !Object.prototype.hasOwnProperty.call(envelope, 'data')) throw new ApiError('INVALID_RESPONSE', 'The service returned an unexpected response.', response.status);
  if (epoch && epoch !== envelope.authorityEpoch) { clearAuthority(); authorityChanged?.(); throw new ApiError('AUTHORITY_CHANGED', 'Your connection changed. Reconnect to load the current records.', 409); }
  epoch = envelope.authorityEpoch;
  pendingKeys.delete(fingerprint);
  return envelope.data as T;
}
// Exact service-owned auth freeze: service/API.md at f640274fe8ea83bf7687f26d709c399a0961148e.
export const demoMode = document.querySelector('meta[name="didi-test-mode"]')?.getAttribute('content') === 'synthetic';
export async function pair(pairingCode: string) {
  const result = await request<{ csrfToken: string }>('/auth/pair', { method: 'POST', body: { pairingCode }, pairing: true });
  csrfToken = result.csrfToken;
}
export async function restoreSession() {
  if (!csrfToken) csrfToken = (await request<{ csrfToken: string }>('/auth/session')).csrfToken;
}
export async function logout() {
  await request('/auth/logout', { method: 'POST', body: {} });
  clearAuthority();
}

/** Fetch SSE uses the same current browser authority; no URL tokens or resend. */
export async function stream(path: string, signal: AbortSignal, onFrame: (value: unknown) => void, onOpen?: () => void): Promise<void> {
  if (!epoch || !csrfToken) throw new ApiError('NOT_CONNECTED', 'Reconnect before subscribing.', 0);
  const response = await fetch(`/api/v1${path}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', 'X-Didi-CSRF': csrfToken, 'X-Didi-Authority-Epoch': epoch }, body: '{}' });
  if (!response.ok) { const body = await response.json(); throw new ApiError(body.error?.code ?? 'STREAM_ERROR', body.error?.message ?? 'Cannot subscribe to this run.', response.status); }
  if (!response.body) throw new ApiError('STREAM_ERROR', 'No event stream was returned.', 0);
  // The subscription is established on the service before any durable snapshot read.
  onOpen?.();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read(); pending += decoder.decode(value, { stream: !done });
      if (pending.length > 1024 * 1024) throw new ApiError('STREAM_ERROR', 'Event frame exceeded the client limit.', 0);
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) onFrame(JSON.parse(data));
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
