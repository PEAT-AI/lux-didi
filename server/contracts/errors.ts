export type ErrorCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'BAD_REQUEST' | 'NOT_FOUND' | 'METHOD_NOT_ALLOWED' | 'PAYLOAD_TOO_LARGE' | 'CONFLICT' | 'STALE_AUTHORITY' | 'DOMAIN_NOT_CONFIGURED' | 'MODEL_NOT_CONFIGURED' | 'INTERNAL_ERROR' | 'WRITER_LOCKED' | 'STORE_CLOSED' | 'TRANSACTION_EXPIRED';
export class ServiceError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly status = 400, public readonly details?: Record<string, unknown>) { super(message); this.name = 'ServiceError'; }
}
export interface Success<T> { data: T; requestId: string; authorityEpoch: string }
export interface Failure { error: { code: ErrorCode; message: string; details?: Record<string, unknown> }; requestId: string }
