import type { Transaction } from '../contracts/storage.js';
import type { JsonObject } from '../adapters/model/types.js';
import * as memory from '../domain/memory.js';
import * as labels from '../domain/labels.js';

/** This identity belongs to the gateway, never to a remote MCP declaration. */
export const REMEMBER_IDENTITY = { name: 'remember_note', accountId: 'gateway:live-voice', resourceId: 'owner-memory' } as const;
export const REMEMBER_PARAMETERS = { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 500 }, kind: { type: 'string', enum: ['fact', 'preference', 'task'] } }, required: ['text', 'kind'], additionalProperties: false };
export function validateRemember(args: unknown): args is { text: string; kind: 'fact' | 'preference' | 'task' } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const value = args as Record<string, unknown>;
  return Object.keys(value).length === 2 && typeof value.text === 'string' && value.text.length >= 1 && value.text.length <= 500
    && typeof value.kind === 'string' && ['fact', 'preference', 'task'].includes(value.kind);
}
const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,;:]+$/, '').trim();
const command = /^(?:naya\s*,?\s+)?remember\b(?:\s+that\b)?\s*:?\s*/i;
const classified = /^(?:naya\s*,?\s+)?remember\s+(?:privately\b|(?:this\s+)?(?:as\s+)?(?:private|sensitive)\b|(?:this|that)\s+(?:is|as)\s+(?:private|sensitive)\b)/i;

/** All reads and the write share the tool owner's transaction: duplicate calls cannot race. */
export function rememberOwnerNote(tx: Transaction, liveSessionId: string, args: { text: string; kind: 'fact' | 'preference' | 'task' }, now: number): JsonObject {
  // A bounded journal window, assembled into owner turns, not provider/model arguments.
  const rows = tx.all("SELECT journal_id,text,finished FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' ORDER BY journal_id DESC LIMIT 64", [liveSessionId]).reverse();
  const turns: { seq: number; text: string }[] = [];
  let pending = '';
  for (const row of rows) {
    pending += String(row.text ?? '');
    if (Number(row.finished) === 1) { turns.push({ seq: Number(row.journal_id), text: pending }); pending = ''; }
  }
  const turn = turns.reverse().find(turn => command.test(turn.text.trim().replace(/\s+/g, ' ')));
  if (!turn) return { remembered: false, code: 'owner_transcript_not_final' };
  const utterance = turn.text.trim();
  if (classified.test(utterance)) return { remembered: false, code: 'private_memory_unsupported' };
  const payload = utterance.replace(command, '').trim();
  const pointer = normalized(args.text), ownerText = normalized(payload);
  if (!pointer || !ownerText || !ownerText.includes(pointer)) return { remembered: false, code: 'owner_text_mismatch' };
  const externalId = `${liveSessionId}:${turn.seq}`;
  const existing = tx.get("SELECT owner_id FROM source_refs WHERE owner_kind='entry' AND provider='live-voice' AND external_id=?", [externalId]);
  if (existing) return { remembered: false, code: 'already_remembered', entryId: String(existing.owner_id) };
  const clock = { now: () => now };
  const session = memory.createSession(tx, { title: 'Live voice memory', startedAt: now, timeZone: 'UTC' }, clock);
  labels.correct(tx, { subject: { kind: 'session', id: session.id }, expectedRevision: 0, dataClass: 'ordinary' }, now);
  const entry = memory.appendEntry(tx, { sessionId: session.id, text: payload, capturedAt: now, timeZone: 'UTC',
    source: { label: `live-voice ${liveSessionId}`, provider: 'live-voice', accountId: liveSessionId, externalId, sourceTimestamp: now, availability: 'present', note: `kind:${args.kind}` } }, clock);
  labels.correct(tx, { subject: { kind: 'entry', id: entry.id }, expectedRevision: 0, dataClass: 'ordinary' }, now);
  return { remembered: true, entryId: entry.id };
}
