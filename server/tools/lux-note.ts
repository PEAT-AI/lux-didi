import type { SchemaMigration } from '../contracts/storage.js';
import { canonicalJSON, sha256 } from './canonical.js';

export const STAGE_NOTE_IDENTITY = { name: 'stage_lux_note', accountId: 'gateway:live-voice', resourceId: 'owner-vault' } as const;
export const STAGE_NOTE_PARAMETERS = { type: 'object', properties: {
  title: { type: 'string', minLength: 1, maxLength: 120, description: 'A short title for the note, from this conversation.' },
  body: { type: 'string', minLength: 1, maxLength: 4000, description: 'The note body, from this conversation.' },
  evidenceRefs: { type: 'array', minItems: 0, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 64 }, description: 'Optional owner journal:<id> or held tool:<callId> evidence refs.' },
}, required: ['title', 'body'], additionalProperties: false };

const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,63}$/;
export function validateStageNote(args: unknown): args is { title: string; body: string; evidenceRefs?: string[] } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const value = args as Record<string, unknown>;
  if (Object.keys(value).some(key => !['title', 'body', 'evidenceRefs'].includes(key))) return false;
  const refs = value['evidenceRefs'];
  return typeof value['title'] === 'string' && value['title'].length >= 1 && value['title'].length <= 120
    && typeof value['body'] === 'string' && value['body'].length >= 1
    && (refs === undefined || Array.isArray(refs) && refs.length <= 8 && refs.every(ref => typeof ref === 'string' && REF_SHAPE.test(ref)));
}

/** A note is titled and bodied by the host; title plus body is never truncated, only refused. */
export const NOTE_MAX_CHARS = 4000;
export const TITLE_MAX_CHARS = 120;
export const STAGE_NOTE_GUIDANCE = 'Call it when he asks; the host reads his words. Save a model-composed title and body into Lux immediately. The receipt says Saved and gives the insight id only after the write succeeds. No confirmation round.';
export const STAGE_FAILED_GUIDANCE = 'The note was not saved because the write failed.';
const VAULT_TYPE = 'UNCATEGORIZED';
const VAULT_PROJECT = 'didi-voice';

export type FrozenNote = { readonly state: 'frozen'; readonly payload: string; readonly payloadSha: string }
  | { readonly state: 'refused'; readonly code: 'payload_empty' | 'too_long' };

/** The whole save_insight payload and its digest are frozen here; nothing later may change them. */
export function freezeNote(note: { readonly title: string; readonly body: string; readonly externalContextPresent?: boolean }): FrozenNote {
  const title = note.title.replace(/\s+/g, ' ').trim();
  const body = note.body.trim();
  if (!title || !body) return { state: 'refused', code: 'payload_empty' };
  if (title.length > TITLE_MAX_CHARS || body.length > NOTE_MAX_CHARS + (note.externalContextPresent ? 512 : 0)) {
    return { state: 'refused', code: 'too_long' };
  }
  const payload = canonicalJSON({ content: body, insight_title: title, insight_type: VAULT_TYPE, project: VAULT_PROJECT });
  return { state: 'frozen', payload, payloadSha: sha256(payload) };
}

export const luxNoteMigrations: readonly SchemaMigration[] = [{
  owner: 'lux-note',
  version: 1,
  statements: [
    `CREATE TABLE lux_note_stages (
       stage_id TEXT PRIMARY KEY,
       live_session_id TEXT NOT NULL,
       turn_id TEXT,
       title TEXT NOT NULL,
       body TEXT NOT NULL,
       payload_json TEXT NOT NULL,
       payload_sha256 TEXT NOT NULL,
       evidence_json TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN ('staged','armed','settling','committed','cancelled','invalidated')),
       code TEXT,
       insight_id TEXT,
       staged_at INTEGER NOT NULL,
       armed_at INTEGER,
       settle_at INTEGER,
       ended_at INTEGER,
       UNIQUE (live_session_id, payload_sha256)
     )`,
    `CREATE INDEX lux_note_stages_open ON lux_note_stages(live_session_id, staged_at)`,
  ],
}, { owner: 'lux-note', version: 2, statements: [
  'ALTER TABLE lux_note_stages ADD COLUMN external_context_present INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE lux_note_stages ADD COLUMN owner_journal_ids_json TEXT NOT NULL DEFAULT '[]'",
  'ALTER TABLE lux_note_stages ADD COLUMN conversation_watermark INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE lux_note_stages ADD COLUMN confirmation_text TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE lux_note_stages ADD COLUMN full_readback INTEGER NOT NULL DEFAULT 0',
] }, { owner: 'lux-note', version: 3, statements: [
  "UPDATE lux_note_stages SET state='cancelled',code='confirmation_removed' WHERE state IN ('staged','armed','settling')",
] }];

