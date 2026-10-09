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
export async function request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; pairing?: boolean } = {}): Promise<T> {
  if (!navigator.onLine) throw new ApiError('OFFLINE', 'You’re offline. Nothing was sent.', 0);
  const method = options.method ?? 'GET';
  if (method !== 'GET' && !options.pairing && !epoch) throw new ApiError('NOT_CONNECTED', 'Reconnect before making changes.', 0);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const fingerprint = JSON.stringify([epoch, method, path, options.body]);
  if (method !== 'GET') {
    const key = pendingKeys.get(fingerprint) ?? crypto.randomUUID();
    pendingKeys.set(fingerprint, key);
    headers['Idempotency-Key'] = key;
    if (!options.pairing) {
      headers['X-Didi-Authority-Epoch'] = epoch!;
      if (!csrfToken) throw new ApiError('NOT_CONNECTED', 'Reconnect before making changes.', 0);
      headers['X-Didi-CSRF'] = csrfToken;
    }
  }
  const response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal });
  const envelope = await response.json();
  pendingKeys.delete(fingerprint);
  if (!response.ok) throw new ApiError(envelope.error?.code ?? 'REQUEST_FAILED', envelope.error?.message ?? 'The service could not finish that request.', response.status);
  if (typeof envelope.authorityEpoch !== 'string' || !('data' in envelope)) throw new ApiError('INVALID_RESPONSE', 'The service returned an unexpected response.', response.status);
  if (epoch && epoch !== envelope.authorityEpoch) { clearAuthority(); authorityChanged?.(); throw new ApiError('AUTHORITY_CHANGED', 'Your connection changed. Reconnect to load the current records.', 409); }
  epoch = envelope.authorityEpoch;
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
