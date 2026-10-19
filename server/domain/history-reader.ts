import { createHash, randomUUID } from 'node:crypto';
import type { Transaction, SQLRow } from '../contracts/storage.js';
import type { DataClass, JsonObject } from '../adapters/model/types.js';
import { HISTORY_CLASSES, historyForgotten, historySessionEvidence, type HistoryEligibility } from './history-lifecycle.js';
import { fold, tokenize } from './util.js';

export interface HistoryScope {
  ownerId: string; runId: string; routeIdentity: string; authorityEpoch: string; revision: number;
  allowedClasses: readonly DataClass[];
}
export interface HistoryArguments { query?: string; from?: string; to?: string; limit?: number; cursor?: string; recordRef?: string }
export interface HistorySourceRef {
  kind: 'entry' | 'live' | 'summary'; id: string; first: number; last: number; transcriptKind: string;
  dataClass: DataClass; fingerprint: string;
}
export interface HistoryEvidence { sources: HistorySourceRef[] }
export interface HistoryResult { response: JsonObject; dataClasses: DataClass[]; evidence: HistoryEvidence }
interface RecordValue { ref: HistorySourceRef; text: string; metadata: JsonObject; date: number }
interface SearchSnapshot { scope: string; expires: number; sources: HistorySourceRef[]; references: string[]; coverage: JsonObject; limit: number }
interface Position { snapshot: SearchSnapshot; index: number; offset: number; detail: boolean }
const PAGE_CHARACTERS = 6000;
const REFERENCE_LIFETIME_MS = 30 * 60_000;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const knownClass = (value: unknown): value is DataClass => HISTORY_CLASSES.includes(value as DataClass);
const hasTable = (tx: Transaction, name: string): boolean => !!tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);

function entryValue(tx: Transaction, id: string): RecordValue | null {
  const row = tx.get(`SELECT e.*,s.revision AS parent_revision FROM entries e JOIN sessions s ON s.id=e.session_id WHERE e.id=?`, [id]);
  if (!row || tx.get('SELECT 1 FROM entry_tombstones WHERE entry_id=?', [id])) return null;
  const entryLabel = tx.get("SELECT revision,data_class FROM routing_labels WHERE subject_kind='entry' AND subject_id=? ORDER BY revision DESC LIMIT 1", [id]);
  const parentLabel = tx.get("SELECT revision,data_class FROM routing_labels WHERE subject_kind='session' AND subject_id=? ORDER BY revision DESC LIMIT 1", [String(row.session_id)]);
  if (!knownClass(entryLabel?.data_class) || !knownClass(parentLabel?.data_class)) return null;
  const dataClass = HISTORY_CLASSES[Math.max(HISTORY_CLASSES.indexOf(entryLabel.data_class), HISTORY_CLASSES.indexOf(parentLabel.data_class))]!;
  const sources = tx.all("SELECT source_label,provider,external_id,source_timestamp,availability FROM source_references WHERE owner_kind='entry' AND owner_id=? ORDER BY id", [id]);
  for (const source of sources) {
    if (typeof source.provider === 'string' && typeof source.external_id === 'string') {
      if (tx.get('SELECT 1 FROM entry_tombstones WHERE source_kind=? AND source_key=?', [source.provider, source.external_id])) return null;
      if (source.provider === 'live-voice' && historyForgotten(tx, source.external_id.split(':')[0]!)) return null;
    }
  }
  const derivation = sources.some(source => source.provider === 'import-history') ? 'imported_note'
    : sources.some(source => source.provider === 'live-voice') ? 'remembered_note' : 'stored_text';
  const metadata = { sourceId: id, sessionId: row.session_id, sourceKind: 'entry', role: row.role, date: new Date(Number(row.captured_at)).toISOString(), derivation,
    dataClass, revision: row.revision, parentRevision: row.parent_revision, labelRevision: entryLabel.revision, parentLabelRevision: parentLabel.revision, sources };
  const text = String(row.text);
  return { ref: { kind: 'entry', id, first: 0, last: 0, transcriptKind: '', dataClass, fingerprint: digest({ metadata, text }) }, text, metadata, date: Number(row.captured_at) };
}

function liveValue(tx: Transaction, ownerId: string, id: string, rows: SQLRow[], eligibility: HistoryEligibility = new Map()): RecordValue | null {
  if (!rows.length || historyForgotten(tx, id)) return null;
  const session = tx.get(`SELECT h.data_class,h.revision,l.journal_complete FROM history_sessions h JOIN live_sessions l ON l.live_session_id=h.live_session_id
    WHERE h.live_session_id=? AND h.owner_id=? AND l.owner_assistant_id=?`, [id, ownerId, ownerId]);
  if (!session || !knownClass(session.data_class) || !historySessionEvidence(tx, id, eligibility)) return null;
  const first = rows[0]!, last = rows.at(-1)!;
  const text = rows.map(row => String(row.text ?? '')).join('');
  const metadata = { sourceId: `${id}:${first.journal_id}:${last.journal_id}`, sessionId: id, sourceKind: 'live', role: first.kind === 'inputTranscription' ? 'user' : 'assistant',
    date: new Date(Number(first.arrived_at)).toISOString(), derivation: 'automatic_transcription', dataClass: session.data_class, revision: session.revision,
    journalFirst: first.journal_id, journalLast: last.journal_id, final: last.finished === 1, journalComplete: session.journal_complete === 1 };
  return { ref: { kind: 'live', id, first: Number(first.journal_id), last: Number(last.journal_id), transcriptKind: String(first.kind), dataClass: session.data_class,
    fingerprint: digest({ metadata, rows }) }, text, metadata, date: Number(first.arrived_at) };
}

function summaryValue(tx: Transaction, id: string, eligibility: HistoryEligibility = new Map()): RecordValue | null {
  const row = tx.get("SELECT * FROM conversation_summaries WHERE id=? AND status='complete' AND summary IS NOT NULL", [id]);
  if (!row) return null;
  const source = historySessionEvidence(tx, String(row.live_session_id), eligibility);
  if (!source || source.dataClass !== row.data_class || source.revision !== row.source_revision) return null;
  const metadata = { sourceId: id, sessionId: row.live_session_id, sourceKind: 'summary', role: 'assistant', date: new Date(Number(row.ended_at ?? row.created_at)).toISOString(),
    derivation: 'conversation_summary', dataClass: source.dataClass, revision: source.revision, model: row.model, promptVersion: row.prompt_version };
  const text = String(row.summary);
  return { ref: { kind: 'summary', id, first: 0, last: 0, transcriptKind: '', dataClass: source.dataClass, fingerprint: digest({ metadata, text }) }, metadata, text, date: Number(row.ended_at ?? row.created_at) };
}

export function historySummaryEvidence(tx: Transaction, ids: readonly string[]): HistoryEvidence {
  return { sources: ids.map(id => {
    const value = summaryValue(tx, id);
    if (!value) throw new Error('history_source_changed');
    return value.ref;
  }) };
}

function sourceValue(tx: Transaction, ownerId: string, ref: HistorySourceRef, eligibility: HistoryEligibility = new Map()): RecordValue | null {
  if (ref.kind === 'entry') return entryValue(tx, ref.id);
  if (ref.kind === 'summary') return summaryValue(tx, ref.id, eligibility);
  if (!hasTable(tx, 'live_journal')) return null;
  return liveValue(tx, ownerId, ref.id, tx.all(`SELECT journal_id,provider_sequence,kind,text,finished,arrived_at FROM live_journal
    WHERE live_session_id=? AND journal_id>=? AND journal_id<=? AND kind=? ORDER BY journal_id`, [ref.id, ref.first, ref.last, ref.transcriptKind]), eligibility);
}

/** Called by the canonical result gate, after every await and before publication. */
export function historyEvidenceCurrent(tx: Transaction, ownerId: string, evidence: HistoryEvidence): boolean {
  const eligibility: HistoryEligibility = new Map();
  return evidence.sources.every(ref => sourceValue(tx, ownerId, ref, eligibility)?.ref.fingerprint === ref.fingerprint);
}

function corpus(tx: Transaction, scope: HistoryScope): { records: RecordValue[]; coverage: JsonObject } {
  const records: RecordValue[] = [];
  const eligibility: HistoryEligibility = new Map();
  let unavailableLabels = false, classFiltered = false, legacyRawUnavailable = false;
  const admit = (value: RecordValue | null) => {
    if (!value) { unavailableLabels = true; return; }
    if (!scope.allowedClasses.includes(value.ref.dataClass)) { classFiltered = true; return; }
    if (value.text.trim()) records.push(value);
  };
  for (const row of tx.all('SELECT id FROM entries ORDER BY id')) admit(entryValue(tx, String(row.id)));
  for (const row of tx.all("SELECT id FROM conversation_summaries WHERE status='complete' ORDER BY id")) admit(summaryValue(tx, String(row.id), eligibility));
  if (hasTable(tx, 'live_journal')) {
    for (const session of tx.all('SELECT live_session_id FROM live_sessions WHERE owner_assistant_id=? ORDER BY live_session_id', [scope.ownerId])) {
      const id = String(session.live_session_id);
      if (historyForgotten(tx, id)) continue;
      if (!tx.get('SELECT 1 FROM history_sessions WHERE live_session_id=? AND owner_id=?', [id, scope.ownerId])) { legacyRawUnavailable = true; continue; }
      const pending = new Map<string, SQLRow[]>();
      const flush = (kind: string) => { const rows = pending.get(kind); if (rows?.length) admit(liveValue(tx, scope.ownerId, id, rows, eligibility)); pending.delete(kind); };
      for (const row of tx.all(`SELECT journal_id,provider_sequence,kind,text,finished,arrived_at FROM live_journal WHERE live_session_id=? ORDER BY journal_id`, [id])) {
        const kind = String(row.kind);
        if (kind === 'inputTranscription' || kind === 'outputTranscription') {
          const rows = pending.get(kind) ?? []; rows.push(row); pending.set(kind, rows);
          if (row.finished === 1) flush(kind);
        } else if (kind === 'turnComplete' || kind === 'interrupted' || kind === 'terminal') {
          flush('inputTranscription'); flush('outputTranscription');
        }
      }
      flush('inputTranscription'); flush('outputTranscription');
    }
  }
  return { records, coverage: { legacyRawUnavailable, unavailableLabels, classFiltered, scope: 'retained_local_records', transcripts: 'automatic_transcription_not_verbatim_audio' } };
}

export function validHistoryArguments(value: unknown): value is HistoryArguments {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some(key => !['query', 'from', 'to', 'limit', 'cursor', 'recordRef'].includes(key))) return false;
  if (args.cursor !== undefined || args.recordRef !== undefined) return Object.keys(args).length === 1 && typeof (args.cursor ?? args.recordRef) === 'string' && String(args.cursor ?? args.recordRef).length <= 128;
  if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 4096)) return false;
  if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 20)) return false;
  for (const key of ['from', 'to']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(args[key])) || !Number.isFinite(Date.parse(String(args[key]))))) return false;
  if (args.from !== undefined && args.to !== undefined && Date.parse(String(args.from)) >= Date.parse(String(args.to))) return false;
  return typeof args.query === 'string' || args.from !== undefined || args.to !== undefined;
}

/** Metadata snapshots belong to the ToolsOwner lifetime; restart never rehydrates an untrusted cursor. */
export function createHistoryReader(now: () => number = Date.now): { read(tx: Transaction, scope: HistoryScope, args: HistoryArguments): HistoryResult } {
  const positions = new Map<string, Position>();
  const unavailable = (status: string): HistoryResult => ({ response: { status, hits: [], nextCursor: null }, dataClasses: [], evidence: { sources: [] } });
  const token = (position: Position): string => { const id = randomUUID(); positions.set(id, position); return id; };
  return { read(tx, scope, args) {
    if (!validHistoryArguments(args)) return unavailable('invalid_history_arguments');
    for (const [id, value] of positions) if (value.snapshot.expires <= now()) positions.delete(id);
    const scopeKey = digest(scope);
    let position: Position;
    if (args.cursor || args.recordRef) {
      const stored = positions.get(args.cursor ?? args.recordRef!);
      if (!stored || stored.snapshot.scope !== scopeKey || (!!args.recordRef && !stored.detail)) return unavailable('history_reference_unavailable');
      position = stored;
    } else {
      const { records, coverage } = corpus(tx, scope);
      const tokens = [...new Set(tokenize(args.query ?? ''))];
      const ranked = records.map(value => ({ value, score: tokens.reduce((sum, term) => sum + (fold(value.text).includes(term) ? 1 : 0), 0) }))
        .filter(({ value, score }) => (!tokens.length || score > 0) && (!args.from || value.date >= Date.parse(args.from)) && (!args.to || value.date < Date.parse(args.to)))
        .sort((a, b) => b.score - a.score || b.value.date - a.value.date || String(a.value.metadata.sourceId).localeCompare(String(b.value.metadata.sourceId)));
      const snapshot: SearchSnapshot = { scope: scopeKey, expires: now() + REFERENCE_LIFETIME_MS, sources: ranked.map(row => row.value.ref), references: [], coverage, limit: args.limit ?? 10 };
      snapshot.references = snapshot.sources.map((_, index) => token({ snapshot, index, offset: 0, detail: true }));
      position = { snapshot, index: 0, offset: 0, detail: false };
    }
    const { snapshot, index, offset, detail } = position;
    if (!historyEvidenceCurrent(tx, scope.ownerId, { sources: snapshot.sources })) return unavailable('history_snapshot_invalidated');
    const refs = detail ? snapshot.sources.slice(index, index + 1) : snapshot.sources.slice(index, index + snapshot.limit);
    const values = refs.map(ref => sourceValue(tx, scope.ownerId, ref)!);
    const dataClasses = [...new Set(refs.map(ref => ref.dataClass))];
    const evidence = { sources: refs };
    if (detail) {
      const value = values[0]; if (!value) return unavailable('history_reference_unavailable');
      const text = value.text.slice(offset, offset + PAGE_CHARACTERS), complete = offset + text.length >= value.text.length;
      const nextCursor = complete ? null : token({ snapshot, index, offset: offset + text.length, detail: true });
      return { response: { status: 'ok', ...value.metadata, recordRef: snapshot.references[index], text, offset, totalCharacters: value.text.length, complete, nextCursor, coverage: snapshot.coverage }, dataClasses, evidence };
    }
    const nextIndex = index + values.length;
    const nextCursor = nextIndex < snapshot.sources.length ? token({ snapshot, index: nextIndex, offset: 0, detail: false }) : null;
    return { response: { status: 'ok', hits: values.map((value, i) => ({ ...value.metadata, recordRef: snapshot.references[index + i], snippet: value.text.slice(0, 240), totalCharacters: value.text.length })),
      totalMatches: snapshot.sources.length, nextCursor, complete: nextCursor === null, coverage: snapshot.coverage }, dataClasses, evidence };
  } };
}
