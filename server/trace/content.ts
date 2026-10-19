import type { DataClass } from '../adapters/model/types.js';
import type { SQLRow, SQLValue, Transaction } from '../contracts/storage.js';
import { historySessionEvidence } from '../domain/history-lifecycle.js';

export interface DiagnosticContentAuthority { ownerId: string; allowedClasses: readonly DataClass[] }
export interface DiagnosticContentRead {
  all(sql: string, params?: readonly SQLValue[]): SQLRow[];
  get(sql: string, params?: readonly SQLValue[]): SQLRow | undefined;
}
export type DiagnosticContentAccess = { state: 'allowed'; dataClass: DataClass; revision: number }
  | { state: 'denied'; reason: 'authority_required' | 'legacy_unavailable' | 'source_changed' | 'class_denied' };

/** All diagnostic content, including legacy previews, passes this same canonical lifecycle gate. */
export function diagnosticContentAccess(read: DiagnosticContentRead, session: string, authority?: DiagnosticContentAuthority): DiagnosticContentAccess {
  if (!authority) return { state: 'denied',reason: 'authority_required' };
  const required = ['history_sessions','history_dependencies','history_exclusions','live_sessions'];
  if (required.some(name => !read.get("SELECT name FROM sqlite_schema WHERE type='table' AND name=?",[name]))) return { state: 'denied',reason: 'legacy_unavailable' };
  const row = read.get('SELECT l.owner_assistant_id,h.owner_id FROM live_sessions l LEFT JOIN history_sessions h ON h.live_session_id=l.live_session_id WHERE l.live_session_id=?',[session]);
  if (!row || row.owner_id === null) return { state: 'denied',reason: 'legacy_unavailable' };
  if (row.owner_id !== authority.ownerId || row.owner_assistant_id !== authority.ownerId) return { state: 'denied',reason: 'source_changed' };
  const tx: Transaction = { all: (sql,params) => read.all(sql,params),get: (sql,params) => read.get(sql,params),run: () => { throw new Error('diagnostic_reader_is_read_only'); } };
  const current = historySessionEvidence(tx,session);
  if (!current) return { state: 'denied',reason: 'source_changed' };
  return authority.allowedClasses.includes(current.dataClass) ? { state: 'allowed',...current } : { state: 'denied',reason: 'class_denied' };
}
