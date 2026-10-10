import type { SQLRow, Transaction } from '../contracts/storage.js';
import type { JournalKind, LiveFragment, LiveFragmentPage, LiveTerminalOutcome } from './types.js';

/** Kinds the journal persists. Audio, thoughts, modelText and raw transport facts are excluded. */
export const persistedKinds: readonly JournalKind[] = Object.freeze([
  'inputTranscription', 'outputTranscription', 'ready', 'interrupted', 'generationComplete', 'turnComplete', 'waitingForInput',
]);

/**
 * Exact retained UTF8 payload length. Transcription text is the retained payload; marker kinds
 * retain no payload text and therefore account zero bytes. Fixed terminal metadata is excluded.
 */
export function retainedBytes(kind: JournalKind, text: string | null): number {
  return kind === 'inputTranscription' || kind === 'outputTranscription' ? Buffer.byteLength(text ?? '', 'utf8') : 0;
}

export function rowToFragment(row: SQLRow): LiveFragment {
  return {
    liveSessionId: String(row['live_session_id']),
    journalSequence: Number(row['journal_id']),
    providerSequence: row['provider_sequence'] === null || row['provider_sequence'] === undefined ? null : Number(row['provider_sequence']),
    kind: String(row['kind']) as JournalKind,
    text: row['text'] === null || row['text'] === undefined ? null : String(row['text']),
    finished: row['finished'] === null || row['finished'] === undefined ? null : Number(row['finished']) === 1,
    rejectedKind: row['rejected_kind'] === null || row['rejected_kind'] === undefined ? null : String(row['rejected_kind']) as JournalKind,
    rejectedSequence: row['rejected_sequence'] === null || row['rejected_sequence'] === undefined ? null : Number(row['rejected_sequence']),
    arrivedAt: Number(row['arrived_at']),
  };
}

export function parseTerminal(value: unknown): LiveTerminalOutcome | null {
  if (typeof value !== 'string' || !value.length) return null;
  try {
    const parsed = JSON.parse(value) as LiveTerminalOutcome;
    return parsed && typeof parsed === 'object' && typeof parsed.state === 'string' ? parsed : null;
  } catch { return null; }
}

export function readFragmentPage(tx: Transaction, liveSessionId: string, cursor: number, limit: number): LiveFragmentPage {
  const session = tx.get('SELECT lifecycle, journal_complete, terminal_outcome FROM live_sessions WHERE live_session_id=?', [liveSessionId]);
  if (!session) throw new Error('Journal owner session missing');
  const total = Number(tx.get('SELECT COUNT(*) AS n FROM live_journal WHERE live_session_id=? AND kind<>?', [liveSessionId, 'terminal'])!['n']);
  const interruptions = Number(tx.get('SELECT COUNT(*) AS n FROM live_journal WHERE live_session_id=? AND kind=?', [liveSessionId, 'interrupted'])!['n']);
  const rows = tx.all('SELECT * FROM live_journal WHERE live_session_id=? AND journal_id>=? ORDER BY journal_id ASC LIMIT ?', [liveSessionId, cursor, limit]);
  const fragments = rows.map(rowToFragment);
  const last = fragments.at(-1);
  const outcome = parseTerminal(session['terminal_outcome']);
  return {
    liveSessionId, fragments,
    nextCursor: fragments.length < limit ? null : (last ? last.journalSequence + 1 : null),
    counts: { total, returned: fragments.length, fromCursor: cursor },
    interruptions,
    terminal: outcome ? { outcome, complete: Number(session['journal_complete']) === 1 } : null,
  };
}
