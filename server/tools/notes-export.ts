import type { JsonObject } from '../adapters/model/types.js';
import type { SchemaMigration, Transaction } from '../contracts/storage.js';
import { randomUUID } from 'node:crypto';
import { sha256 } from './canonical.js';
import type { VaultTransport, VaultTransportResult } from './vault-write.js';

/** At most this many rows leave in one flush, and at most that many in one rolling day. */
export const EXPORT_FLUSH_LIMIT = 10;
export const EXPORT_DAY_LIMIT = 20;
export const EXPORT_DAY_MS = 86_400_000;
/** A note near an existing row this close is skipped: it is the same note said again. */
export const EXPORT_NEAR_DUPLICATE = 0.95;
const VAULT_PROJECT = 'didi-voice';

export type ExportKind = 'fact' | 'preference' | 'task';
export interface ExportCandidate { readonly id: string; readonly text: string; readonly kind: ExportKind }
export interface ExportSelection { readonly selected: readonly ExportCandidate[]; readonly skipped: number; readonly remaining: number }

export const exportKey = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Trailing counts only: metadata, never owner speech. */
export interface ExportSummary { readonly exported: number; readonly skipped: number; readonly failed: number; readonly unknown: number; readonly remaining: number }

/**
 * The selection is a pure decision: fact and preference notes only, one row per normalised text,
 * nothing the ledger already holds, nothing a lux row is already close to, and both the flush and
 * the day ceilings are read before a single row is chosen.
 */
export function exportPlan(input: {
  readonly candidates: readonly ExportCandidate[];
  readonly exportedKeys: ReadonlySet<string>;
  readonly nearDuplicates: ReadonlyMap<string, number>;
  readonly flushRemaining: number;
  readonly dayRemaining: number;
}): ExportSelection {
  const ceiling = Math.max(0, Math.min(input.flushRemaining, input.dayRemaining));
  const selected: ExportCandidate[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let eligible = 0;
  for (const candidate of input.candidates) {
    if (candidate.kind !== 'fact' && candidate.kind !== 'preference') { skipped += 1; continue; }
    const key = exportKey(candidate.text);
    if (!key) { skipped += 1; continue; }
    if (input.exportedKeys.has(key) || seen.has(key)) { skipped += 1; continue; }
    const near = input.nearDuplicates.get(key);
    if (near !== undefined && near > EXPORT_NEAR_DUPLICATE) { skipped += 1; continue; }
    seen.add(key);
    eligible += 1;
    if (selected.length < ceiling) selected.push(candidate);
  }
  return { selected, skipped, remaining: eligible - selected.length };
}

/** The body keeps its provenance so a reader in lux knows where the row came from. */
export function provenanceLine(input: { readonly sessionId: string; readonly at: number }): string {
  return `Source: didi-voice remember_note, session ${input.sessionId}, ${new Date(input.at).toISOString()}`;
}

/** The body a flush sends: the note in the owner's words, then one provenance line. */
export function exportBody(input: { readonly text: string; readonly sessionId: string; readonly at: number }): string {
  return `${input.text.replace(/\s+/g, ' ').trim()}\n\n${provenanceLine(input)}`;
}

export function exportType(kind: ExportKind): 'USER_PREFERENCE' | 'UNCATEGORIZED' {
  return kind === 'preference' ? 'USER_PREFERENCE' : 'UNCATEGORIZED';
}

/** One row per export attempt, written before the call, so a crash leaves an attempt and never a replay. */
export const notesExportMigrations: readonly SchemaMigration[] = [{
  owner: 'notes-export',
  version: 1,
  statements: [
    `CREATE TABLE note_exports (
       export_key TEXT PRIMARY KEY,
       entry_id TEXT NOT NULL,
       live_session_id TEXT NOT NULL,
       body_sha256 TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN ('dispatching','inserted','duplicate','failed','unknown')),
       attempted_at INTEGER NOT NULL,
       settled_at INTEGER,
       insight_id TEXT
     )`,
    `CREATE INDEX note_exports_attempted ON note_exports(attempted_at)`,
  ],
}];

export interface NotesExporterOptions {
  readonly store: { transaction<T>(body: (tx: Transaction) => T): T };
  readonly sessionId: string;
  readonly transport: VaultTransport;
  readonly nearDuplicate: (text: string) => Promise<number | undefined>;
  readonly now: () => number;
  readonly log: (event: JsonObject) => void;
  readonly enabled: boolean;
}

/** Counts of the rows attempted inside the rolling day, which the day ceiling is read from. */
export function attemptsSince(tx: Transaction, since: number): number {
  const row = tx.get('SELECT COUNT(*) AS n FROM note_exports WHERE attempted_at>=?', [since]);
  return Number(row?.['n'] ?? 0);
}

export function exportedKeys(tx: Transaction): Set<string> {
  const keys = new Set<string>();
  for (const row of tx.all('SELECT export_key FROM note_exports', [])) keys.add(String(row['export_key']));
  return keys;
}

/**
 * The session-end flush. Every row is attempted once: the ledger row is written before the call,
 * so a crash mid-flight is an attempt with an unknown outcome, never an automatic retry.
 */
export class NotesExporter {
  constructor(private readonly options: NotesExporterOptions) {}

  async flush(candidates: readonly ExportCandidate[]): Promise<ExportSummary> {
    if (!this.options.enabled) return { exported: 0, skipped: candidates.length, failed: 0, unknown: 0, remaining: 0 };
    const now = this.options.now();
    const state = this.options.store.transaction(tx => ({
      exported: exportedKeys(tx),
      dayRemaining: Math.max(0, EXPORT_DAY_LIMIT - attemptsSince(tx, now - EXPORT_DAY_MS)),
    }));
    const nearDuplicates = new Map<string, number>();
    for (const candidate of candidates) {
      const key = exportKey(candidate.text);
      if (nearDuplicates.has(key) || state.exported.has(key)) continue;
      const near = await this.options.nearDuplicate(candidate.text);
      if (near !== undefined) nearDuplicates.set(key, near);
    }
    const plan = exportPlan({ candidates, exportedKeys: state.exported, nearDuplicates, flushRemaining: EXPORT_FLUSH_LIMIT, dayRemaining: state.dayRemaining });
    let exported = 0, failed = 0, unknown = 0;
    for (const candidate of plan.selected) {
      const key = exportKey(candidate.text);
      const at = this.options.now();
      const body = exportBody({ text: candidate.text, sessionId: this.options.sessionId, at });
      this.options.store.transaction(tx => tx.run(
        'INSERT OR IGNORE INTO note_exports(export_key,entry_id,live_session_id,body_sha256,state,attempted_at) VALUES (?,?,?,?,?,?)',
        [key, candidate.id, this.options.sessionId, sha256(body), 'dispatching', at]));
      let result: VaultTransportResult;
      try { result = await this.options.transport.save({ content: body, title: candidate.text.replace(/\s+/g, ' ').trim().slice(0, 120), insightType: exportType(candidate.kind), project: VAULT_PROJECT }); }
      catch { result = { outcome: 'unknown' }; }
      const settled = this.options.now();
      this.options.store.transaction(tx => tx.run('UPDATE note_exports SET state=?, settled_at=?, insight_id=? WHERE export_key=?',
        [result.outcome, settled, result.outcome === 'inserted' ? result.insightId : null, key]));
      if (result.outcome === 'inserted') exported += 1;
      else if (result.outcome === 'unknown' || result.outcome === 'unavailable') unknown += 1;
      else failed += 1;
    }
    this.options.log({ event: 'notes_export', exported, skipped: plan.skipped, failed, unknown, remaining: plan.remaining, id: randomUUID().slice(0, 8) });
    return { exported, skipped: plan.skipped, failed, unknown, remaining: plan.remaining };
  }
}
