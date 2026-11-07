import type { Store } from '../runtime/store.js';

/** Synthetic persisted call prerequisites, not the post-call history projection. */
export function seedLuxTurn(store: Store, sessionId: string, id: number, role: 'owner' | 'assistant', text: string, at: number): void {
  store.transaction(tx => {
    tx.run(`INSERT OR IGNORE INTO live_sessions (live_session_id,owner_assistant_id,authority_epoch,idempotency_key,fingerprint,
      client_id,audit_id,profile_identity,prompt_identity,lifecycle,dispatch_intent,ready,journal_events,journal_bytes,journal_complete,consumer_state,created_at,updated_at)
      VALUES (?,?,?,?,?,'synthetic-client','synthetic-audit','synthetic-profile','synthetic-prompt','active',1,1,0,0,1,'attached',?,?)`,
    [sessionId, store.assistantId, store.authorityEpoch, sessionId, sessionId, at, at]);
    tx.run(`INSERT OR IGNORE INTO live_journal(journal_id,live_session_id,kind,text,finished,payload_bytes,arrived_at)
      VALUES(?,?,?,?,1,?,?)`, [id, sessionId, role === 'owner' ? 'inputTranscription' : 'outputTranscription', text, Buffer.byteLength(text), at]);
  });
}
