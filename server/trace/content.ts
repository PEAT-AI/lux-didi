import type { DataClass } from '../adapters/model/types.js';
import type { SQLRow, SQLValue, Transaction } from '../contracts/storage.js';
import { HISTORY_CLASSES, historySessionEvidence } from '../domain/history-lifecycle.js';
import { current as currentRoutingLabel } from '../domain/labels.js';
import { historyEvidenceCurrent, type HistoryEvidence } from '../domain/history-reader.js';

export interface DiagnosticContentAuthority { ownerId: string; allowedClasses: readonly DataClass[] }
export interface DiagnosticContentRead {
  all(sql: string, params?: readonly SQLValue[]): SQLRow[];
  get(sql: string, params?: readonly SQLValue[]): SQLRow | undefined;
}
export type DiagnosticContentAccess = { state: 'allowed'; dataClass: DataClass; revision: number }
  | { state: 'denied'; reason: 'authority_required' | 'legacy_unavailable' | 'source_changed' | 'class_denied' };

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const knownClass = (value: unknown): value is DataClass => HISTORY_CLASSES.includes(value as DataClass);
const hasTable = (read: DiagnosticContentRead, name: string): boolean => !!read.get("SELECT name FROM sqlite_schema WHERE type='table' AND name=?", [name]);
const denied = (reason: 'legacy_unavailable' | 'source_changed' | 'class_denied'): DiagnosticContentAccess => ({ state: 'denied', reason });

function chatAccess(read: DiagnosticContentRead, tx: Transaction, row: SQLRow, authority: DiagnosticContentAuthority): DiagnosticContentAccess {
  if (row.owner_assistant_id !== authority.ownerId) return denied('source_changed');
  if (['chat_run_policy', 'sessions', 'entries', 'routing_labels', 'entry_tombstones'].some(name => !hasTable(read, name))) return denied('legacy_unavailable');
  const user = read.get('SELECT session_id FROM entries WHERE id=?', [row.user_entry_id!]);
  if (!user || user.session_id !== row.session_id || read.get('SELECT 1 FROM entry_tombstones WHERE entry_id=?', [row.user_entry_id!])) return denied('source_changed');
  const trace: unknown = typeof row.trace === 'string' ? JSON.parse(row.trace) : null;
  if (!record(trace) || !record(trace.diagnostic)) return denied('legacy_unavailable');
  const marker = trace.diagnostic;
  if (Object.keys(marker).some(key => !['version', 'dataClasses'].includes(key)) || marker.version !== 1
      || !Array.isArray(marker.dataClasses) || !marker.dataClasses.length || !marker.dataClasses.every(knownClass)
      || new Set(marker.dataClasses).size !== marker.dataClasses.length) return denied('source_changed');
  const capturedClasses = marker.dataClasses as DataClass[];
  const policy = read.get('SELECT selected_labels FROM chat_run_policy WHERE run_id=?', [row.run_id!]);
  const labels: unknown = typeof policy?.selected_labels === 'string' ? JSON.parse(policy.selected_labels) : null;
  if (!Array.isArray(labels) || !labels.length) return denied('source_changed');
  const keys = new Set<string>();
  let userRevision: number | undefined;
  let ownParent = false;
  for (const label of labels) {
    if (!record(label) || Object.keys(label).some(key => !['kind', 'id', 'schemaVersion', 'ownerId', 'dataClass', 'revision'].includes(key))
        || !['session', 'entry'].includes(String(label.kind)) || typeof label.id !== 'string' || !label.id
        || label.schemaVersion !== 1 || label.ownerId !== authority.ownerId || !knownClass(label.dataClass)
        || !Number.isSafeInteger(label.revision) || Number(label.revision) < 1) return denied('source_changed');
    const key = JSON.stringify([label.kind, label.id]);
    if (keys.has(key)) return denied('source_changed');
    keys.add(key);
    const current = currentRoutingLabel(tx, { kind: label.kind as 'session' | 'entry', id: label.id });
    if (current.dataClass !== label.dataClass || current.revision !== label.revision) return denied('source_changed');
    if (!authority.allowedClasses.includes(label.dataClass)) return denied('class_denied');
    if (label.kind === 'entry') {
      const entry = read.get('SELECT session_id FROM entries WHERE id=?', [label.id]);
      if (!entry || read.get('SELECT 1 FROM entry_tombstones WHERE entry_id=?', [label.id])
          || !labels.some(parent => record(parent) && parent.kind === 'session' && parent.id === entry.session_id)) return denied('source_changed');
      if (label.id === row.user_entry_id) userRevision = Number(label.revision);
    } else if (label.id === row.session_id) ownParent = true;
  }
  if (!ownParent || userRevision === undefined) return denied('source_changed');
  const evidence = trace.summaryEvidence;
  if (!record(evidence) || Object.keys(evidence).some(key => key !== 'sources') || !Array.isArray(evidence.sources)
      || evidence.sources.some(source => !record(source)
        || Object.keys(source).some(key => !['kind', 'id', 'first', 'last', 'transcriptKind', 'dataClass', 'fingerprint'].includes(key))
        || !['entry', 'live', 'summary'].includes(String(source.kind)) || typeof source.id !== 'string'
        || !knownClass(source.dataClass) || typeof source.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(source.fingerprint)
        || !Number.isSafeInteger(source.first) || !Number.isSafeInteger(source.last) || typeof source.transcriptKind !== 'string')) return denied('source_changed');
  if (!historyEvidenceCurrent(tx, authority.ownerId, evidence as unknown as HistoryEvidence)) return denied('source_changed');
  if (!capturedClasses.every(c => authority.allowedClasses.includes(c))) return denied('class_denied');
  const dataClass = HISTORY_CLASSES.filter(c => capturedClasses.includes(c)).at(-1)!;
  return { state: 'allowed', dataClass, revision: userRevision };
}

/** All diagnostic content, including legacy previews, passes this same canonical lifecycle gate. */
export function diagnosticContentAccess(read: DiagnosticContentRead, session: string, authority?: DiagnosticContentAuthority): DiagnosticContentAccess {
  if (!authority) return { state: 'denied', reason: 'authority_required' };
  try {
    const live = hasTable(read, 'live_sessions') ? read.get('SELECT live_session_id FROM live_sessions WHERE live_session_id=?', [session]) : undefined;
    const chat = hasTable(read, 'chat_runs') ? read.get('SELECT run_id,session_id,user_entry_id,owner_assistant_id,trace FROM chat_runs WHERE run_id=?', [session]) : undefined;
    if (live && chat) return denied('source_changed');
    const tx: Transaction = {
      all: (sql, params) => read.all(sql, params), get: (sql, params) => read.get(sql, params),
      run: () => { throw new Error('diagnostic_reader_is_read_only'); },
    };
    if (!live && chat) return chatAccess(read, tx, chat, authority);
    const required = ['history_sessions', 'history_dependencies', 'history_exclusions', 'live_sessions'];
    if (required.some(name => !hasTable(read, name))) return denied('legacy_unavailable');
    const row = read.get('SELECT l.owner_assistant_id,h.owner_id FROM live_sessions l LEFT JOIN history_sessions h ON h.live_session_id=l.live_session_id WHERE l.live_session_id=?', [session]);
    if (!row || row.owner_id === null) return denied('legacy_unavailable');
    if (row.owner_id !== authority.ownerId || row.owner_assistant_id !== authority.ownerId) return denied('source_changed');
    const current = historySessionEvidence(tx, session);
    if (!current) return denied('source_changed');
    return authority.allowedClasses.includes(current.dataClass) ? { state: 'allowed', ...current } : denied('class_denied');
  } catch { return denied('source_changed'); }
}
