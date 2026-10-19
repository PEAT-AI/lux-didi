import type { Transaction } from '../contracts/storage.js';
import type { DataClass } from '../adapters/model/types.js';

export const HISTORY_CLASSES: readonly DataClass[] = ['ordinary', 'private', 'sensitive'];

export function historyForgotten(tx: Transaction, liveSessionId: string): boolean {
  return !!tx.get("SELECT 1 FROM history_exclusions WHERE source_kind='live' AND source_id=?", [liveSessionId])
    || !!tx.get("SELECT 1 FROM entry_tombstones WHERE source_kind='live-voice' AND substr(source_key,1,36)=?", [liveSessionId]);
}

export function historySessionClass(tx: Transaction, liveSessionId: string): DataClass | null {
  const row = tx.get('SELECT data_class FROM history_sessions WHERE live_session_id=?', [liveSessionId]);
  return row && HISTORY_CLASSES.includes(row.data_class as DataClass) ? row.data_class as DataClass : null;
}

/** Only the trusted CREATE owner records eligibility; migrations never infer legacy authority. */
export function recordHistorySession(tx: Transaction, id: string, ownerId: string, permitted: readonly DataClass[], injectedSummaryIds: readonly string[], now: number): void {
  const ceiling = [...HISTORY_CLASSES].reverse().find(value => permitted.includes(value));
  if (!ceiling || permitted.some(value => !HISTORY_CLASSES.includes(value)) || historyForgotten(tx, id)) throw new Error('history_lifecycle_denied');
  tx.run('INSERT INTO history_sessions(live_session_id,owner_id,data_class,revision,created_at) VALUES(?,?,?,1,?)', [id, ownerId, ceiling, now]);
  for (const summaryId of injectedSummaryIds) {
    const parent = tx.get('SELECT live_session_id FROM conversation_summaries WHERE id=?', [summaryId]);
    if (!parent || historyForgotten(tx, String(parent.live_session_id))) throw new Error('history_dependency_unavailable');
    tx.run('INSERT OR IGNORE INTO history_dependencies(child_session_id,parent_session_id) VALUES(?,?)', [id, String(parent.live_session_id)]);
  }
}

/** Atomic content-free exclusion of a source and every known derived session, including unsummarized children. */
export function forgetHistorySessions(tx: Transaction, ids: readonly string[], now: number): string[] {
  const excluded = new Set(ids);
  const dependencies = tx.all('SELECT child_session_id,parent_session_id FROM history_dependencies');
  const summaries = tx.all('SELECT id,live_session_id,injected_summary_ids FROM conversation_summaries');
  const summarySessions = new Map(summaries.map(row => [String(row.id), String(row.live_session_id)]));
  for (const row of summaries) {
    const injected: unknown = JSON.parse(String(row.injected_summary_ids));
    if (!Array.isArray(injected)) throw new Error('history_lineage_invalid');
    for (const id of injected) {
      const parent = summarySessions.get(String(id));
      if (parent) dependencies.push({ child_session_id: row.live_session_id!, parent_session_id: parent });
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of dependencies) if (excluded.has(String(row.parent_session_id)) && !excluded.has(String(row.child_session_id))) {
      excluded.add(String(row.child_session_id)); grew = true;
    }
  }
  const deletedIds: string[] = [];
  for (const id of excluded) {
    tx.run("INSERT OR IGNORE INTO history_exclusions(source_kind,source_id,forgotten_at) VALUES('live',?,?)", [id, now]);
    tx.run('UPDATE history_sessions SET revision=revision+1 WHERE live_session_id=?', [id]);
    for (const row of summaries.filter(row => row.live_session_id === id)) {
      const summaryId = String(row.id); deletedIds.push(summaryId);
      tx.run("INSERT OR IGNORE INTO history_exclusions(source_kind,source_id,forgotten_at) VALUES('summary',?,?)", [summaryId, now]);
    }
    tx.run('DELETE FROM conversation_summaries WHERE live_session_id=?', [id]);
  }
  return deletedIds;
}
