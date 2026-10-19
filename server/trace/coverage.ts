import type { Transaction } from '../contracts/storage.js';

export type DiagnosticLoss = 'trace_write_failed' | 'native_receipt_rejected' | 'journal_write_failed' | 'store_unavailable';
export function markDiagnosticLoss(tx: Transaction, session: string, reason: DiagnosticLoss): void {
  tx.run("UPDATE live_sessions SET diagnostic_metadata_state='partial',diagnostic_content_state=CASE WHEN ?='trace_write_failed' THEN 'partial' ELSE diagnostic_content_state END,native_receipt_state=CASE WHEN ?='native_receipt_rejected' THEN 'partial' ELSE native_receipt_state END,diagnostic_failures=MIN(2147483647,COALESCE(diagnostic_failures,0)+1),diagnostic_last_reason=? WHERE live_session_id=?", [reason,reason,reason,session]);
}
