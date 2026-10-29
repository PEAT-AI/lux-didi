import { createHash, randomUUID } from 'node:crypto';
import type { Transaction, SQLRow } from '../contracts/storage.js';
import type { DataClass, JsonObject } from '../adapters/model/types.js';
import { HISTORY_CLASSES, historyForgotten, historySessionEvidence, type HistoryEligibility } from './history-lifecycle.js';
import { fold, tokenize } from './util.js';

export interface HistoryScope {
  ownerId: string; runId: string; conversationId?: string; routeIdentity: string; authorityEpoch: string; revision: number;
  allowedClasses: readonly DataClass[]; currentSessionId?: string;
}
export interface HistoryArguments { query?: string; from?: string; to?: string; limit?: number; cursor?: string; recordRef?: string }
export interface HistorySourceRef {
  kind: 'entry' | 'live' | 'summary'; id: string; first: number; last: number; transcriptKind: string;
  dataClass: DataClass; fingerprint: string;
}
export interface HistoryEvidence { sources: HistorySourceRef[] }
export interface HistoryResult { response: JsonObject; dataClasses: DataClass[]; evidence: HistoryEvidence }
interface RecordValue { ref: HistorySourceRef; text: string; metadata: JsonObject; date: number }
interface SearchSnapshot { runId: string; conversationId?: string; tokens: Map<string, string>; scope: string; expires: number; sources: HistorySourceRef[]; references: string[]; coverage: JsonObject; limit: number; snippets: string[] }
interface Position { snapshot: SearchSnapshot; index: number; offset: number; detail: boolean }
const PAGE_CHARACTERS = 6000;
const REFERENCE_LIFETIME_MS = 30 * 60_000;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const knownClass = (value: unknown): value is DataClass => HISTORY_CLASSES.includes(value as DataClass);

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

function liveValue(tx: Transaction, ownerId: string, id: string, eligibility: HistoryEligibility = new Map()): RecordValue | null {
  if (historyForgotten(tx, id)) return null;
  const session = tx.get(`SELECT h.data_class,h.revision,l.journal_complete FROM history_sessions h JOIN live_sessions l ON l.live_session_id=h.live_session_id
    WHERE h.live_session_id=? AND h.owner_id=? AND l.owner_assistant_id=?`, [id, ownerId, ownerId]);
  if (!session || !knownClass(session.data_class) || !historySessionEvidence(tx, id, eligibility)) return null;
  const rows = tx.all('SELECT * FROM history_turns WHERE live_session_id=? ORDER BY journal_first', [id]);
  if (!rows.length) return null;
  const first = rows[0]!, last = rows.at(-1)!;
  const text = rows.map(row => `${row.role === 'owner' ? 'Owner' : 'Naya'}: ${row.text}`).join('\n');
  const metadata = { sourceId: id, sessionId: id, sourceKind: 'live', role: first.role === 'owner' ? 'user' : 'assistant',
    date: new Date(Number(first.at)).toISOString(), localDate: new Date(Number(first.at)).toLocaleDateString('en-GB'),
    partOfDay: Number(new Date(Number(first.at)).getHours()) < 12 ? 'morning' : Number(new Date(Number(first.at)).getHours()) < 18 ? 'afternoon' : 'evening',
    derivation: 'automatic_transcription', dataClass: session.data_class, revision: session.revision,
    journalFirst: first.journal_first, journalLast: last.journal_last, final: true, journalComplete: session.journal_complete === 1 };
  return { ref: { kind: 'live', id, first: Number(first.journal_first), last: Number(last.journal_last), transcriptKind: 'session', dataClass: session.data_class,
    fingerprint: digest({ metadata, rows }) }, text, metadata, date: Number(first.at) };
}

const RECALL_FILLERS = new Set('a an the i you we she he it they me my your our did do does have has had was were is are be been what when where how why about talked talk said say told tell yesterday story transcript last time conversation conversations remember und oder der die das ein eine ich du wir ihr sie er es im in am an mit von zu auf haben hat hatten war waren ist sind was wie wann wo gestern erzähl erzählt gesagt besprochen'.split(' '));
function recallTerms(query: string): string[] { return [...new Set(tokenize(query))].filter(term => term.length > 1 && !RECALL_FILLERS.has(term)); }
function turnExcerpt(tx: Transaction, id: string, hitId: number, terms: readonly string[]): string {
  const rows = tx.all('SELECT id,role,text FROM history_turns WHERE live_session_id=? ORDER BY journal_first', [id]);
  const index = rows.findIndex(row => Number(row.id) === hitId);
  const hit = rows[index]; if (!hit) return '';
  const label = (row: SQLRow) => row.role === 'owner' ? 'Owner: ' : 'Naya: ';
  const text = String(hit.text), folded = fold(text);
  const foldedMatch = terms.map(term => folded.indexOf(term)).filter(at => at >= 0).sort((a, b) => a - b)[0] ?? 0;
  // F5: folded offsets are not source offsets when ASR text contains combining marks.
  let match = 0, foldedLength = 0;
  for (const character of text) {
    const length = fold(character).length;
    if (foldedLength + length > foldedMatch) break;
    foldedLength += length; match += character.length;
  }
  const start = Math.max(0, match - 130), end = Math.min(text.length, start + 340);
  let excerpt = `${label(hit)}${start ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
  for (const distance of [1, 2, 3, 4]) for (const neighbour of [index + distance, index - distance]) {
    const row = rows[neighbour]; if (!row || excerpt.length >= 520) continue;
    const room = 550 - excerpt.length - label(row).length - 1;
    if (room < 30) continue;
    const body = String(row.text), cropped = body.length > room ? body.slice(0, room - 3) + '...' : body;
    const line = `${label(row)}${cropped}`;
    excerpt = neighbour < index ? `${line}\n${excerpt}` : `${excerpt}\n${line}`;
  }
  return excerpt;
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
  return liveValue(tx, ownerId, ref.id, eligibility);
}

/** Called by the canonical result gate, after every await and before publication. */
export function historyEvidenceCurrent(tx: Transaction, ownerId: string, evidence: HistoryEvidence): boolean {
  const eligibility: HistoryEligibility = new Map();
  return evidence.sources.every(ref => sourceValue(tx, ownerId, ref, eligibility)?.ref.fingerprint === ref.fingerprint);
}

function corpus(tx: Transaction, scope: HistoryScope, query: string, from?: string, to?: string): { records: RecordValue[]; coverage: JsonObject } {
  const records: RecordValue[] = [];
  const eligibility: HistoryEligibility = new Map();
  let unavailableLabels = false, classFiltered = false, legacyRawUnavailable = false;
  const admit = (value: RecordValue | null) => {
    if (!value) { unavailableLabels = true; return; }
    if (!scope.allowedClasses.includes(value.ref.dataClass)) { classFiltered = true; return; }
    if (value.text.trim()) records.push(value);
  };
  for (const row of tx.all('SELECT id FROM entries ORDER BY id')) admit(entryValue(tx, String(row.id)));
  for (const row of tx.all("SELECT id FROM conversation_summaries WHERE status='complete' AND live_session_id<>? ORDER BY id", [scope.currentSessionId ?? ''])) admit(summaryValue(tx, String(row.id), eligibility));
  const terms = recallTerms(query);
  const expression = terms.map(term => `"${term.replaceAll('"', '""')}"*`).join(' OR ');
  const current = scope.currentSessionId ?? '';
  const hits = !tx.get("SELECT 1 FROM sqlite_master WHERE name='live_sessions'") ? [] : expression ? tx.all(`SELECT t.*,bm25(history_turns_fts) AS rank FROM history_turns_fts
    JOIN history_turns t ON t.id=history_turns_fts.rowid JOIN history_sessions h ON h.live_session_id=t.live_session_id JOIN live_sessions l ON l.live_session_id=t.live_session_id
    WHERE history_turns_fts MATCH ? AND h.owner_id=? AND t.live_session_id<>? AND t.at>=? AND t.at<?
    ORDER BY rank,t.role='owner' DESC,l.terminal_at DESC`, [expression, scope.ownerId, current, from ? Date.parse(from) : 0, to ? Date.parse(to) : Number.MAX_SAFE_INTEGER]) : tx.all(`SELECT t.*,0 AS rank FROM history_turns t
    JOIN history_sessions h ON h.live_session_id=t.live_session_id WHERE h.owner_id=? AND t.live_session_id<>? AND t.at>=? AND t.at<? ORDER BY t.at DESC,t.role='owner' DESC`, [scope.ownerId, current, from ? Date.parse(from) : 0, to ? Date.parse(to) : Number.MAX_SAFE_INTEGER]);
  const seen = new Set<string>();
  for (const hit of hits) {
    const id = String(hit.live_session_id);
    if (seen.has(id)) continue;
    const value = liveValue(tx, scope.ownerId, id, eligibility);
    if (!value || !scope.allowedClasses.includes(value.ref.dataClass)) { classFiltered = true; continue; }
    seen.add(id);
    value.metadata['recallExcerpt'] = turnExcerpt(tx, id, Number(hit.id), terms);
    value.metadata['recallRank'] = Number(hit.rank);
    records.push(value);
    if (seen.size >= 5) break;
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
export function createHistoryReader(now: () => number = Date.now): { read(tx: Transaction, scope: HistoryScope, args: HistoryArguments): HistoryResult; releaseRun(runId: string, preserveConversation?: boolean): void; releaseConversation(conversationId?: string): void; releaseReferences(tokens: readonly string[]): void } {
  const positions = new Map<string, Position>();
  const unavailable = (status: string): HistoryResult => ({ response: { status, hits: [], nextCursor: null }, dataClasses: [], evidence: { sources: [] } });
  const token = (position: Position): string => {
    const key = `${position.index}:${position.offset}:${position.detail}`, existing = position.snapshot.tokens.get(key);
    if (existing) return existing;
    const id = randomUUID(); position.snapshot.tokens.set(key, id); positions.set(id, position); return id;
  };
  return {
    releaseRun(runId, preserveConversation = false) { for (const [id, position] of positions) if (position.snapshot.runId === runId && !(preserveConversation && position.snapshot.conversationId)) positions.delete(id); },
    releaseConversation(conversationId) { for (const [id, position] of positions) if (position.snapshot.conversationId && (conversationId === undefined || position.snapshot.conversationId === conversationId)) positions.delete(id); },
    releaseReferences(tokens) {
      const snapshots = new Set(tokens.flatMap(id => positions.get(id)?.snapshot ? [positions.get(id)!.snapshot] : []));
      for (const [id, position] of positions) if (snapshots.has(position.snapshot)) positions.delete(id);
    },
    read(tx, scope, args) {
    if (!validHistoryArguments(args)) return unavailable('invalid_history_arguments');
    for (const [id, value] of positions) if (value.snapshot.expires <= now()) positions.delete(id);
    const scopeKey = digest({ ...scope, runId: scope.conversationId ? `conversation:${scope.conversationId}` : scope.runId });
    let position: Position;
    if (args.cursor || args.recordRef) {
      let stored = positions.get(args.cursor ?? args.recordRef!);
      if (!stored && args.recordRef?.startsWith('session:')) {
        const id = args.recordRef.slice('session:'.length);
        const value = liveValue(tx, scope.ownerId, id);
        if (value && id !== (scope.currentSessionId ?? '') && scope.allowedClasses.includes(value.ref.dataClass)) {
          const snapshot: SearchSnapshot = { runId: scope.runId, ...(scope.conversationId ? { conversationId: scope.conversationId } : {}), tokens: new Map(), scope: scopeKey, expires: now() + REFERENCE_LIFETIME_MS,
            sources: [value.ref], references: [args.recordRef], coverage: { transcripts: 'automatic_transcription_not_verbatim_audio' }, limit: 1, snippets: [] };
          stored = { snapshot, index: 0, offset: 0, detail: true };
          positions.set(args.recordRef, stored);
        }
      }
      if (!stored || stored.snapshot.scope !== scopeKey || (!!args.recordRef && !stored.detail)) return unavailable('history_reference_unavailable');
      position = stored;
    } else {
      const { records, coverage } = corpus(tx, scope, args.query ?? '', args.from, args.to);
      const tokens = recallTerms(args.query ?? '');
      const ranked = records.map(value => ({ value, score: tokens.reduce((sum, term) => sum + (fold(value.text).includes(term) ? 1 : 0), 0) }))
        .filter(({ value, score }) => (value.ref.kind === 'live' || !tokens.length || score > 0) && (value.ref.kind === 'live' || ((!args.from || value.date >= Date.parse(args.from)) && (!args.to || value.date < Date.parse(args.to)))))
        .sort((a, b) => Number(b.value.ref.kind === 'live') - Number(a.value.ref.kind === 'live') || (a.value.ref.kind === 'live' && b.value.ref.kind === 'live' ? Number(a.value.metadata['recallRank']) - Number(b.value.metadata['recallRank']) : b.score - a.score) || b.value.date - a.value.date);
      const snapshot: SearchSnapshot = { runId: scope.runId, ...(scope.conversationId ? { conversationId: scope.conversationId } : {}), tokens: new Map(), scope: scopeKey, expires: now() + REFERENCE_LIFETIME_MS, sources: ranked.map(row => row.value.ref), references: [], coverage, limit: Math.min(args.limit ?? 5, 5), snippets: ranked.map(row => String(row.value.metadata['recallExcerpt'] ?? row.value.text.slice(0, 550))) };
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
    return { response: { status: 'ok', hits: values.map((value, i) => ({ ...value.metadata, recordRef: snapshot.references[index + i], sessionRef: snapshot.references[index + i], snippet: snapshot.snippets[index + i]!, truncated: value.text !== snapshot.snippets[index + i], totalCharacters: value.text.length })),
      totalMatches: snapshot.sources.length, nextCursor, complete: nextCursor === null, coverage: snapshot.coverage }, dataClasses, evidence };
  } };
}
