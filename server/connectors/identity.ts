import type { ConnectorEvidence, ConnectorResult } from './index.js';

/**
 * Owner-identity verification for the identity-bearing connectors (release 3f).
 *
 * The operator asserts one expected owner identity; each connector proves its own account once
 * at host start with the connector's own tool. Comparison is exact and case-insensitive. A proof
 * failure is never a refusal: the connector stays usable, only a positive mismatch refuses it.
 * Identity values never reach the host log: only a connector name and two booleans.
 */
export const IDENTITY_TIMEOUT_MS = 4000;

/** One identity-bearing connector's own-account probe, bound to the reader that can call it. */
export interface IdentitySource {
  /** Tool whose result reports the connector's own account identity. */
  tool: string;
  args: Record<string, unknown>;
  /** Every identity string the decoded result reports; empty when the result carries none. */
  values(decoded: unknown): string[];
  /**
   * Fail closed: an unproven identity refuses the connector even when no owner identity is
   * configured (lux-didi #495). Google sets it, because the helper pins its own account and a
   * silent unverified read is indistinguishable from an empty mailbox.
   */
  strict?: boolean;
  /**
   * What a clean answer proves. `identity` (the default) needs a value the account is known by;
   * `consent` (LOGS.md L-02, the Drive family) proves that the family may read at all, because the
   * helper reports no own-account identity for Drive. A typed refusal is unproven either way.
   */
  proves?: 'identity' | 'consent';
}

/**
 * The closed code set a Google helper refuses with (lux-cli E2). Only a code from this set ever
 * reaches a spoken source reason, so neither an address nor a token path can travel with it.
 */
export const IDENTITY_ERROR_CODES = ['account_mismatch', 'identity_unverified', 'credential_missing', 'identity_timeout', 'credential_refresh_failed', 'credential_revoked',
  // LOGS.md L-02: the Drive family's own refusal -- the read consent was never granted.
  'scope_missing'] as const;
export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[number];

function closedCode(token: string | undefined): IdentityErrorCode | undefined {
  if (token === undefined) return undefined;
  const code = token.trim().toLowerCase().replace(/-/g, '_');
  return (IDENTITY_ERROR_CODES as readonly string[]).includes(code) ? code as IdentityErrorCode : undefined;
}

/** The helper's typed refusal code from one error envelope: never the free text around it. */
export function helperErrorCode(decoded: unknown): IdentityErrorCode | undefined {
  if (!isRecord(decoded)) return undefined;
  const content = decoded['content'];
  const first = Array.isArray(content) ? content[0] : undefined;
  const text = isRecord(first) && typeof first['text'] === 'string' ? first['text'] : undefined;
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return closedCode(typeof parsed['error'] === 'string' ? parsed['error'] : typeof parsed['code'] === 'string' ? parsed['code'] : undefined);
  } catch { /* prose error: read its leading token instead */ }
  return closedCode(/^\s*([A-Za-z][A-Za-z_-]{2,40})\s*[:\s]/.exec(text)?.[1]);
}

/** The closed identity proof the host keeps in memory: booleans for the log, the value for the local UI. */
export interface IdentityProof {
  /** The connector answered with at least one identity value. */
  proven: boolean;
  /** null when unproven, or when no owner identity is configured (nothing to match against). */
  match: boolean | null;
  /** The connector's own primary identity value, for the local UI only; never logged. */
  value: string | null;
  /** Why the helper refused to prove an identity; a closed code, so no address or path travels. */
  code?: IdentityErrorCode;
}

export type IdentityAction = 'offer' | 'refuse' | 'unproven';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

/** Unwrap the connector's MCP result to its payload: content text JSON, then the `data` field when present. */
function payloadOf(decoded: unknown): unknown {
  if (!isRecord(decoded)) return undefined;
  if (Array.isArray(decoded['content'])) {
    const first = decoded['content'][0];
    if (!isRecord(first) || typeof first['text'] !== 'string') return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(first['text']); } catch { return undefined; }
    return isRecord(parsed) && isRecord(parsed['data']) ? parsed['data'] : parsed;
  }
  return isRecord(decoded['data']) ? decoded['data'] : decoded;
}

/** Trim and case-fold; the identity comparison is exact, never a substring or a domain suffix. */
export function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

/** True when at least one connector-reported value exactly (case-insensitively) equals an expected identity. */
export function identityMatch(expected: readonly string[], actual: readonly string[]): boolean {
  const wanted = new Set(expected.filter(value => value.length > 0).map(normalizeIdentity));
  return actual.some(value => wanted.has(normalizeIdentity(value)));
}

/** Gmail proves itself with the profile's emailAddress. */
export function gmailIdentityValues(decoded: unknown): string[] {
  const payload = payloadOf(decoded);
  return isRecord(payload) ? strings(payload['emailAddress']) : [];
}

/** Calendar proves itself with the primary calendar id; a shared calendar is not an account. */
export function calendarIdentityValues(decoded: unknown): string[] {
  const payload = payloadOf(decoded);
  if (!isRecord(payload) || !Array.isArray(payload['calendars'])) return [];
  const list = payload['calendars'].filter(isRecord);
  const primary = list.filter(entry => entry['primary'] === true);
  const chosen = primary.length > 0 ? primary : list.filter(entry => typeof entry['id'] === 'string' && entry['id'].includes('@'));
  return chosen.flatMap(entry => strings(entry['id']));
}

/** Mattermost proves itself with the session's username and email; either may match. */
export function mattermostIdentityValues(decoded: unknown): string[] {
  const payload = payloadOf(decoded);
  return isRecord(payload) ? [...strings(payload['username']), ...strings(payload['email'])] : [];
}

/**
 * Mongoose proves itself with the access card `get_started` returns: the identity block names the
 * signed-in employee, and its email is the only value compared. The card's endpoints are not identity.
 */
export function mongooseIdentityValues(decoded: unknown): string[] {
  const payload = payloadOf(decoded);
  if (!isRecord(payload)) return [];
  const identity = payload['identity'];
  return isRecord(identity) ? strings(identity['email']) : [];
}

/** Classify one identity probe: a refused/unknown result or an empty value set is unproven. */
export function classifyIdentity(result: ConnectorResult, source: IdentitySource, expected: readonly string[]): IdentityProof {
  if (!('decodedResult' in result)) {
    const code = closedCode(result.reason);
    return code ? { proven: false, match: null, value: null, code } : { proven: false, match: null, value: null };
  }
  const values = source.values((result as ConnectorEvidence).decodedResult);
  const code = helperErrorCode((result as ConnectorEvidence).decodedResult);
  // A consent probe answers one question: did the family read, or did the helper refuse it? There is
  // no account value to compare, so a clean answer is the proof and a typed refusal is the reason.
  if (source.proves === 'consent') return code ? { proven: false, match: null, value: null, code } : { proven: true, match: null, value: null };
  const value = values[0] ?? null;
  if (value === null) return code ? { proven: false, match: null, value: null, code } : { proven: false, match: null, value: null };
  if (expected.length === 0) return { proven: true, match: null, value };
  return { proven: true, match: identityMatch(expected, values), value };
}

/** The one decision the host takes on a proof: offer the connector, refuse a mismatch, else keep it
 * unproven. A `strict` source refuses an unproven identity as well, so a proof failure never offers. */
export function identityAction(proof: IdentityProof, strict = false): IdentityAction {
  if (proof.match === false) return 'refuse';
  if (strict && !proof.proven) return 'refuse';
  return proof.proven ? 'offer' : 'unproven';
}

/** The closed reason code a refusal is reported under: a mismatch is its own code, and any other
 * refusal names the helper's code, defaulting to identity_unverified. Never free text. */
export function refusalCode(proof: IdentityProof): 'identity_mismatch' | IdentityErrorCode {
  return proof.match === false ? 'identity_mismatch' : proof.code ?? 'identity_unverified';
}

/**
 * Run one connector identity probe under a short timeout. A throw, a timeout, a refused call or an
 * empty value set is unproven, never a refusal: the connector stays usable and is shown unverified.
 */
export async function proveIdentity(input: {
  source: IdentitySource;
  expected: readonly string[];
  call(tool: string, args: Record<string, unknown>): Promise<ConnectorResult>;
  timeoutMs?: number;
}): Promise<IdentityProof> {
  const timeoutMs = input.timeoutMs ?? IDENTITY_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      input.call(input.source.tool, input.source.args),
      new Promise<ConnectorResult>(resolve => { timer = setTimeout(() => resolve({ state: 'unknown', reason: 'identity_timeout' }), timeoutMs); }),
    ]);
    return classifyIdentity(result, input.source, input.expected);
  } catch {
    return { proven: false, match: null, value: null };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Closed projection of a stored proof for the status payload; anything unvalidated is dropped. */
export function projectIdentity(value: unknown): IdentityProof | undefined {
  if (!isRecord(value) || typeof value['proven'] !== 'boolean') return undefined;
  const match = value['match'];
  if (match !== null && typeof match !== 'boolean') return undefined;
  const raw = value['value'];
  const identityValue = typeof raw === 'string' && raw.length > 0 && raw.length <= 254 ? raw : null;
  const code = closedCode(typeof value['code'] === 'string' ? value['code'] : undefined);
  return { proven: value['proven'], match, value: identityValue, ...(code ? { code } : {}) };
}

/**
 * One identity proof per boot per connector account (H19): two endpoints of the same account, a
 * mailbox and a calendar for example, prove the same account once, never twice. Endpoints connect
 * concurrently, so the in-flight promise is what is shared, not only its result. Only a proven proof
 * is kept, so an unproven connector probes again on the next connect and a later login is picked up.
 */
export function identityProofMemo(): (key: string, probe: () => Promise<IdentityProof>) => Promise<IdentityProof> {
  const attempts = new Map<string, Promise<IdentityProof>>();
  return (key, probe) => {
    const running = attempts.get(key);
    if (running !== undefined) return running;
    const attempt = probe().then(proof => { if (!proof.proven) attempts.delete(key); return proof; },
      (error: unknown) => { attempts.delete(key); throw error; });
    attempts.set(key, attempt);
    return attempt;
  };
}
