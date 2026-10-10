import type { IncomingMessage } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ServiceError } from '../contracts/errors.js';
import type { Store } from '../runtime/store.js';
import type { LiveContext } from '../live/index.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function equal(a: string, b: string): boolean { return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))); }
const protectedHeaders = ['host', 'origin', 'authorization', 'cookie', 'idempotency-key', 'x-didi-authority-epoch', 'x-didi-live-profile'];

/** Reject duplicate protected security headers. Shared by request routes and the audio upgrade. */
export function rejectDuplicateSecurityHeaders(req: IncomingMessage, names: readonly string[] = protectedHeaders): void {
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    if (names.includes(name) && seen.has(name)) throw new ServiceError('BAD_REQUEST', 'Duplicate security header');
    seen.add(name);
  }
}

export interface OperatorPrincipal { readonly clientId: string; readonly mode: 'bearer' }

/**
 * Operator bearer only. Any Cookie or Origin fails, so a valid browser cookie+CSRF or a same-origin
 * Origin never authorizes Live. Authorization is header-only; no query/subprotocol/frame bearer.
 */
export function operatorPrincipal(req: IncomingMessage, store: Store, origin: string): OperatorPrincipal {
  rejectDuplicateSecurityHeaders(req);
  if (req.headers.host !== new URL(origin).host) throw new ServiceError('FORBIDDEN', 'Host is not allowed', 403);
  if (req.headers.origin !== undefined) throw new ServiceError('FORBIDDEN', 'Origin is not accepted on Live routes', 403);
  if (req.headers.cookie !== undefined) throw new ServiceError('FORBIDDEN', 'Cookie is not accepted on Live routes', 403);
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || !equal(authorization.slice('Bearer '.length), store.adminCredential)) {
    throw new ServiceError('UNAUTHORIZED', 'Bearer authentication required', 401);
  }
  return { clientId: 'local-admin', mode: 'bearer' };
}

/** Opaque authority epoch, matching the existing x-didi-authority-epoch convention. */
export function authorityContext(req: IncomingMessage, store: Store, principal: OperatorPrincipal): LiveContext {
  const epoch = req.headers['x-didi-authority-epoch'];
  if (typeof epoch !== 'string' || !epoch || epoch !== store.authorityEpoch) throw new ServiceError('STALE_AUTHORITY', 'Authority epoch is stale', 409);
  return { clientId: principal.clientId, auditId: randomUUID(), authorityEpoch: epoch };
}
