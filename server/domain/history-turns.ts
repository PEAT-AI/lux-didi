import type { SQLRow, Transaction } from '../contracts/storage.js';
import { historyForgotten } from './history-lifecycle.js';

/** Product memory is independent of summary outcomes and of debug journal retention. */
export function persistHistoryTurns(tx: Transaction, liveSessionId: string): number {
  if (historyForgotten(tx, liveSessionId)) return 0;
  const session = tx.get("SELECT lifecycle FROM live_sessions WHERE live_session_id=?", [liveSessionId]);
  if (session?.lifecycle !== 'terminal') return 0;
  const pending = new Map<string, SQLRow[]>();
  let inserted = 0;
  for (const row of tx.all(`SELECT journal_id,kind,text,finished,arrived_at FROM live_journal
    WHERE live_session_id=? ORDER BY journal_id`, [liveSessionId])) {
    const kind = String(row.kind);
    if (kind !== 'inputTranscription' && kind !== 'outputTranscription') {
      if (kind === 'turnComplete' || kind === 'interrupted' || kind === 'terminal') pending.clear();
      continue;
    }
    const fragments = pending.get(kind) ?? [];
    fragments.push(row); pending.set(kind, fragments);
    if (row.finished !== 1) continue;
    pending.delete(kind);
    // A pruned fragment must not silently become an apparently complete quote.
    if (fragments.some(fragment => fragment.text === null)) continue;
    const text = fragments.map(fragment => String(fragment.text)).join('');
    if (!text.trim()) continue;
    const first = fragments[0]!;
    const count = tx.run(`INSERT OR IGNORE INTO history_turns(live_session_id,journal_first,journal_last,role,text,at)
      VALUES(?,?,?,?,?,?)`, [liveSessionId, first.journal_id!, row.journal_id!, kind === 'inputTranscription' ? 'owner' : 'assistant', text, first.arrived_at!]);
    if (count) {
      const turn = tx.get('SELECT id FROM history_turns WHERE live_session_id=? AND journal_first=?', [liveSessionId, first.journal_id!])!;
      tx.run('INSERT INTO history_turns_fts(rowid,text) VALUES(?,?)', [turn.id!, text]);
      inserted += count;
    }
  }
  return inserted;
}

/** R104-R1: legacy authority is restrictive, never inferred from today's route. */
export function backfillHistoryTurns(tx: Transaction): number {
  if (!tx.get("SELECT 1 FROM sqlite_master WHERE name='history_turns'" ) || !tx.get("SELECT 1 FROM sqlite_master WHERE name='live_journal'")) return 0;
  let inserted = 0;
  for (const session of tx.all(`SELECT DISTINCT l.live_session_id,l.owner_assistant_id,l.created_at FROM live_sessions l
    JOIN live_journal j ON j.live_session_id=l.live_session_id
    WHERE l.lifecycle='terminal' AND j.kind IN ('inputTranscription','outputTranscription') AND j.text IS NOT NULL`)) {
    const id = String(session.live_session_id);
    if (historyForgotten(tx, id)) continue;
    tx.run(`INSERT OR IGNORE INTO history_sessions(live_session_id,owner_id,data_class,revision,created_at)
      VALUES(?,?,'sensitive',1,?)`, [id, session.owner_assistant_id!, session.created_at!]);
    inserted += persistHistoryTurns(tx, id);
  }
  return inserted;
}

export function deleteHistoryTurns(tx: Transaction, liveSessionId: string): void {
  for (const turn of tx.all('SELECT id,text FROM history_turns WHERE live_session_id=?', [liveSessionId])) {
    tx.run("INSERT INTO history_turns_fts(history_turns_fts,rowid,text) VALUES('delete',?,?)", [turn.id!, turn.text!]);
  }
  tx.run('DELETE FROM history_turns WHERE live_session_id=?', [liveSessionId]);
}

/** Recovery/maintenance path, including recovery from an interrupted index write. */
export function rebuildHistoryTurnIndex(tx: Transaction): void {
  tx.run("INSERT INTO history_turns_fts(history_turns_fts) VALUES('rebuild')");
}
