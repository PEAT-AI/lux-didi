import { randomUUID } from 'node:crypto';
import type { JsonObject } from '../adapters/model/types.js';
import type { SchemaMigration, Transaction } from '../contracts/storage.js';
import { canonicalJSON, sha256 } from './canonical.js';
import { hostLogEvent } from './host-events.js';

/** The composed-note stage tool is a gateway declaration, never a remote MCP one. */
export const STAGE_NOTE_IDENTITY = { name: 'stage_lux_note', accountId: 'gateway:live-voice', resourceId: 'owner-vault' } as const;
export const STAGE_NOTE_PARAMETERS = { type: 'object', properties: {
  title: { type: 'string', minLength: 1, maxLength: 120, description: 'A short title for the note, from this conversation.' },
  body: { type: 'string', minLength: 1, maxLength: 2000, description: 'The note body, from this conversation.' },
  evidenceRefs: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 64 }, description: 'Refs of host evidence for this note.' },
}, required: ['title', 'body', 'evidenceRefs'], additionalProperties: false };

const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,63}$/;
export function validateStageNote(args: unknown): args is { title: string; body: string; evidenceRefs: string[] } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const value = args as Record<string, unknown>;
  if (Object.keys(value).length !== 3) return false;
  const refs = value['evidenceRefs'];
  return typeof value['title'] === 'string' && value['title'].length >= 1 && value['title'].length <= 120
    && typeof value['body'] === 'string' && value['body'].length >= 1 && value['body'].length <= 2000
    && Array.isArray(refs) && refs.length >= 1 && refs.length <= 8 && refs.every(ref => typeof ref === 'string' && REF_SHAPE.test(ref));
}

/** A note is titled and bodied by the host; title plus body is never truncated, only refused. */
export const NOTE_MAX_CHARS = 2000;
/** What the model says when the host could not stage the note at all: a closed code in plain words. */
export const STAGE_FAILED_GUIDANCE = 'The note was not staged. Tell the owner it was not saved and ask them to say it again in one sentence.';
/** R7-W1: a refusal is never named as a Lux failure; she asks him for the words that stage it. */
export const AUTHORIZATION_MISSING_GUIDANCE = "I did not hear a save request in your own words this turn; say 'save it to Lux' and I will stage it.";
export const TITLE_MAX_CHARS = 120;
export const CONFIRM_WINDOW_MS = 30_000;
/** The open guard's bounds, on the journal rows of one owner stretch: three splits, 400 characters. */
export const OWNER_WINDOW_TURNS = 3;
export const OWNER_WINDOW_CHARS = 400;
export const CONFIRM_SETTLE_MS = 1_500;
export const CONFIRM_MAX_TOKENS = 6;
const VAULT_TYPE = 'UNCATEGORIZED';
const VAULT_PROJECT = 'didi-voice';

export const noteKey = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (text: string): string[] => noteKey(text).split(' ').filter(word => word.length > 0);

export type ComposedReason = 'negated' | 'reported' | 'quoted' | 'conditional' | 'ambiguous';
export type ComposedAsk = { readonly decision: 'grant' } | { readonly decision: 'clarify'; readonly reason: ComposedReason }
  | { readonly decision: 'append' } | { readonly decision: 'none' };

/** The verbs that can authorize a create, and the destinations that name lux and nothing else. */
const ASK_VERB = /^(?:naya\s+)?(?:please\s+)?(?:save|remember|put|add|write|store)\b/u;
/** A permission granted in his own words is the same ask: "you have my full permission to save it in Lux". */
const PERMISSION = /\b(?:you\s+(?:have|ve|got)|i\s+give\s+you|give\s+you)\s+(?:my\s+|your\s+)?(?:full\s+|explicit\s+|standing\s+)?permission\b/u;
const DESTINATION = /\b(?:to|in|into)\s+(?:my\s+|the\s+)?(?:lux(?:\s+knowledge)?|knowledge\s+base|vault)\b/u;
const APPEND = /^(?:naya\s+)?(?:please\s+)?(?:add|append|update|change|overwrite|edit|delete|remove|archive|link|restore|replace)\b(?=[\s\S]*\b(?:note|insight|entry|record)\b)/u;
const REPORTED = /^(?:say|says|according to)\b|\b(?:he|she|they|it|someone|rob|you|the [a-z]+)\s+(?:said|says|say|asked|asks|wrote|writes|mentioned|mentions|told|tells|wants|asked me)\b/u;
const QUESTION = /\b(?:how (?:do|can|should|would) (?:i|you)|what(?:'s| is) the (?:way|phrase|command)|can you tell me how)\b/u;
const CONDITIONAL = /^(?:if|when|whenever|unless|should|in case)\b/u;
const NEGATION_LEAD = /^(?:no|not|never|don(?:'| )?t|do not)\b/u;
const NEGATION = /(?:don(?:'| )?t|do not|never|not|no)\b/u;
const ASK_WORD = /\b(?:save|remember|put|add|write|store)\b/u;
const HEDGE = /\b(?:maybe|perhaps|probably|might|could|i think|i guess|possibly)\b/u;
/** A composed note about the conversation itself names its source where a dictation names a store. */
const NOTE_SOURCE = /\b(?:note|summary)\b[^\p{L}\p{N}]+(?:about|from|of)\b[^\p{L}\p{N}]+(?:this|that|what we(?: just)? (?:discussed|talked about)|our (?:conversation|call|discussion))\b/u;

/**
 * Only an imperative save ask authorizes a composed note: an explicit lux destination, or a note about
 * this conversation. A negation, a report of someone else's words, a quoted phrase, a condition or a
 * hedge is a clarification instead, and an append or edit ask is answered as unsupported so it can
 * never become a create.
 */
export function composedAsk(text: string): ComposedAsk {
  const value = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const key = noteKey(value);
  if (!key) return { decision: 'none' };
  if (APPEND.test(key)) return { decision: 'append' };
  if (/"[^"]*"|'[^']*'|\u201c[^\u201d]*\u201d/u.test(value)) return { decision: 'clarify', reason: 'quoted' };
  if (QUESTION.test(key)) return { decision: 'clarify', reason: 'reported' };
  if (REPORTED.test(key)) return { decision: 'clarify', reason: 'reported' };
  if (CONDITIONAL.test(key)) return { decision: 'clarify', reason: 'conditional' };
  // A negation before the verb is the owner refusing, not asking, whatever verb order he used.
  if (NEGATION_LEAD.test(key) && ASK_WORD.test(key) && DESTINATION.test(key)) return { decision: 'clarify', reason: 'negated' };
  // R7-W1: a split ask is judged on the words he said in pieces, so a permission grant counts too.
  const verb = ASK_VERB.test(key) ? key.search(ASK_VERB) : PERMISSION.test(key) && ASK_WORD.test(key) ? key.search(ASK_WORD) : -1;
  if (verb < 0) {
    return HEDGE.test(key) && ASK_WORD.test(key) && DESTINATION.test(key) ? { decision: 'clarify', reason: 'ambiguous' } : { decision: 'none' };
  }
  // A negation between the verb and the destination is still a refusal.
  const destination = key.search(DESTINATION);
  const negation = key.slice(verb).search(NEGATION);
  if (negation >= 0 && negation < destination) return { decision: 'clarify', reason: 'negated' };
  if (HEDGE.test(key) || /\b(?:or|either|and maybe)\b/u.test(key.slice(destination))) return { decision: 'clarify', reason: 'ambiguous' };
  if (destination < 0) {
    // A note about this conversation names its source instead of a store. Staging is still not saving:
    // the frozen read-back and his own confirmation are what authorize the write.
    if (!NOTE_SOURCE.test(key)) return { decision: 'none' };
    if (negation >= 0) return { decision: 'clarify', reason: 'negated' };
    return HEDGE.test(key) ? { decision: 'clarify', reason: 'ambiguous' } : { decision: 'grant' };
  }
  return { decision: 'grant' };
}

const AFFIRM = new Set(['yes', 'yeah', 'yep', 'yup', 'correct', 'right', 'sure', 'ok', 'okay', 'exactly', 'perfect', 'confirm', 'affirmative', 'save', 'do', 'go']);
const AFFIRM_FILLER = new Set(['it', 'that', 'is', 'this', 'ahead', 'please', 'then', 'now', 'thanks', 'thank', 'you', 'the', 'note']);
const DISQUALIFIER = new Set(['no', 'not', 'dont', 'stop', 'cancel', 'wait', 'hold', 'wrong', 'change', 'instead', 'actually', 'but', 'except', 'edit', 'fix', 'never', 'yet', 'and', 'also', 'or']);

/**
 * The confirmation is an exact affirmative under normalisation, at most six tokens, with a closed
 * disqualifier set, so a VAD-split sentence that keeps talking is a cancel and not a consent.
 */
export function confirmAsk(text: string): 'affirm' | 'cancel' {
  const tokens = words(text);
  if (tokens.length === 0 || tokens.length > CONFIRM_MAX_TOKENS) return 'cancel';
  for (const token of tokens) if (DISQUALIFIER.has(token)) return 'cancel';
  const drawn = tokens.every(token => AFFIRM.has(token) || AFFIRM_FILLER.has(token));
  return drawn && tokens.some(token => AFFIRM.has(token)) ? 'affirm' : 'cancel';
}

export type FrozenNote = { readonly state: 'frozen'; readonly payload: string; readonly payloadSha: string }
  | { readonly state: 'refused'; readonly code: 'payload_empty' | 'payload_too_long' };

/** The whole save_insight payload and its digest are frozen here; nothing later may change them. */
export function freezeNote(note: { readonly title: string; readonly body: string }): FrozenNote {
  const title = note.title.replace(/\s+/g, ' ').trim();
  const body = note.body.replace(/\s+/g, ' ').trim();
  if (!title || !body) return { state: 'refused', code: 'payload_empty' };
  if (title.length > TITLE_MAX_CHARS || body.length > NOTE_MAX_CHARS || title.length + body.length > NOTE_MAX_CHARS) {
    return { state: 'refused', code: 'payload_too_long' };
  }
  const payload = canonicalJSON({ content: body, insight_title: title, insight_type: VAULT_TYPE, project: VAULT_PROJECT });
  return { state: 'frozen', payload, payloadSha: sha256(payload) };
}

/** One finalized owner row, as the host reads it out of the journal. */
export interface OwnerTurnRow { readonly journalId: number; readonly text: string; readonly finalOrigin: string; readonly finalizedAt: number }
export type OwnerTurnRead = { readonly state: 'owner_turn'; readonly text: string; readonly evidence: ReadonlySet<string> }
  | { readonly state: 'refused'; readonly code: 'transcript_pending' | 'transcript_typed' };

/**
 * W6-R2 B1: authorization is the owner's own finalized mic turn of THIS turn. Before its transcript
 * is finalized the stage refuses, and a newer-looking read never borrows the previous owner turn.
 */
/**
 * The owner's finalized mic rows of this one stretch, newest first: back to the turn start and the
 * model's last output, under the open guard's bounds. A row outside the confirm window is never part
 * of it, and a typed row never counts.
 */
function ownerStretch(mic: readonly OwnerTurnRow[], turnStartAt: number | undefined, now: number | undefined, spokenAfter: number | undefined): readonly OwnerTurnRow[] {
  const stretch: OwnerTurnRow[] = [];
  for (const row of mic) {
    if (stretch.length === OWNER_WINDOW_TURNS) break;
    if (turnStartAt !== undefined && row.finalizedAt < turnStartAt) break;
    if (now !== undefined && now - row.finalizedAt > CONFIRM_WINDOW_MS) break;
    if (spokenAfter !== undefined && row.journalId <= spokenAfter) break;
    stretch.push(row);
  }
  return stretch;
}

/** Oldest to newest, because the ask is one sentence he said in pieces. */
const composedText = (stretch: readonly OwnerTurnRow[]): string =>
  stretch.map(row => row.text).reverse().join(' ').replace(/\s+/g, ' ').trim().slice(-OWNER_WINDOW_CHARS).trim();

export function currentOwnerTurn(rows: readonly OwnerTurnRow[], turnStartAt: number | undefined, inputFinal: boolean, now?: number, spokenAfter?: number): OwnerTurnRead {
  const mic = rows.filter(row => row.finalOrigin !== 'typed').slice().sort((a, b) => b.journalId - a.journalId);
  const newest = mic[0];
  if (!newest) return { state: 'refused', code: rows.length > 0 ? 'transcript_typed' : 'transcript_pending' };
  if (!inputFinal) return { state: 'refused', code: 'transcript_pending' };
  if (turnStartAt !== undefined && newest.finalizedAt < turnStartAt) return { state: 'refused', code: 'transcript_pending' };
  // A turn flag that outlived its turn is not this turn: an old transcript is never authorization.
  if (now !== undefined && now - newest.finalizedAt > CONFIRM_WINDOW_MS) return { state: 'refused', code: 'transcript_pending' };
  // R7-W1: a VAD split ask is one ask, so the whole finalized stretch of this turn authorizes it.
  return { state: 'owner_turn', text: composedText(ownerStretch(mic, turnStartAt, now, spokenAfter)), evidence: new Set(mic.map(row => `journal:${row.journalId}`)) };
}

export type PlaybackSignalKind = 'received' | 'audible' | 'enqueued' | 'started' | 'drained' | 'interrupted' | 'terminated';
/** One app playback receipt, reduced to what the note boundary needs. */
export interface PlaybackSignal { readonly receipt: PlaybackSignalKind; readonly key: string; readonly wallMs: number }
/** The one segment carrying a stage's read-back. It belongs to a stage, never to a session. */
export interface ReadbackBinding { readonly stageId: string; readonly key: string }
export interface SegmentRead { readonly binding?: ReadbackBinding; readonly note: NoteState }

/**
 * W6-R2 B2 and C1: the read-back is one segment, and the binding names the stage it belongs to. The
 * first segment that starts after the stage is adopted, only that segment's drain arms the stage,
 * only its interruption invalidates it, and a binding from another stage is ignored, so a restaged
 * note in the same call always finds its own read-back.
 */
export function noteSegmentSignal(note: NoteState, binding: ReadbackBinding | undefined, signal: PlaybackSignal): SegmentRead {
  const own = binding !== undefined && binding.stageId === note.stageId ? binding : undefined;
  if (note.state !== 'staged') return own === undefined ? { note } : { binding: own, note };
  const beganAfterStage = signal.wallMs >= note.stagedAt;
  if (signal.receipt === 'started' || signal.receipt === 'received') {
    return own === undefined && beganAfterStage ? { binding: { stageId: note.stageId, key: signal.key }, note } : (own === undefined ? { note } : { binding: own, note });
  }
  if (signal.receipt === 'interrupted' || signal.receipt === 'terminated') {
    if (own !== undefined && signal.key !== own.key) return { binding: own, note };
    if (own === undefined && !beganAfterStage) return { note };
    return { ...(own === undefined ? {} : { binding: own }), note: ended(note, 'invalidated', 'readback_interrupted', signal.wallMs) };
  }
  if (signal.receipt !== 'drained') return own === undefined ? { note } : { binding: own, note };
  if (own === undefined || signal.key !== own.key) return own === undefined ? { note } : { binding: own, note };
  return { binding: own, note: noteReadback(note, signal.wallMs, 'drained') };
}

export type NoteStageName = 'staged' | 'armed' | 'settling' | 'committed' | 'cancelled' | 'invalidated';
export interface NoteState {
  readonly stageId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly body: string;
  readonly payload: string;
  readonly payloadSha: string;
  readonly state: NoteStageName;
  readonly stagedAt: number;
  readonly armedAt?: number;
  readonly settleAt?: number;
  readonly endedAt?: number;
  readonly code?: string;
}

export type StageCode = 'not_enabled' | 'authorization_missing' | 'authorization_refused' | 'append_unsupported'
  | 'evidence_missing' | 'evidence_unknown' | 'payload_empty' | 'payload_too_long';
export type StageOutcome = { readonly state: 'staged'; readonly note: NoteState } | { readonly state: 'refused'; readonly code: StageCode };

export interface StageInput {
  readonly stageId: string;
  readonly sessionId: string;
  readonly ownerText: string;
  readonly title: string;
  readonly body: string;
  readonly evidence: readonly string[];
  readonly heldEvidence: ReadonlySet<string>;
  readonly enabled: boolean;
  readonly now: number;
}

export function beginStage(input: StageInput): StageOutcome {
  if (!input.enabled) return { state: 'refused', code: 'not_enabled' };
  const ask = composedAsk(input.ownerText);
  if (ask.decision === 'none') return { state: 'refused', code: 'authorization_missing' };
  if (ask.decision === 'clarify') return { state: 'refused', code: 'authorization_refused' };
  if (ask.decision === 'append') return { state: 'refused', code: 'append_unsupported' };
  if (input.evidence.length === 0) return { state: 'refused', code: 'evidence_missing' };
  if (!input.evidence.every(ref => input.heldEvidence.has(ref))) return { state: 'refused', code: 'evidence_unknown' };
  const frozen = freezeNote({ title: input.title, body: input.body });
  if (frozen.state === 'refused') return { state: 'refused', code: frozen.code };
  return { state: 'staged', note: {
    stageId: input.stageId, sessionId: input.sessionId, title: input.title.replace(/\s+/g, ' ').trim(), body: input.body.replace(/\s+/g, ' ').trim(),
    payload: frozen.payload, payloadSha: frozen.payloadSha, state: 'staged', stagedAt: input.now,
  } };
}

export interface OwnerTurnFacts { readonly inputAt: number | undefined; readonly inputFinal: boolean }

/**
 * W6 items 1 to 4: the model stages a composed note and nothing more. The owner's own finalized
 * microphone turn is the only authorization, the evidence refs must name journal rows this session
 * holds, and the whole payload is frozen here, before any read-back. W5: it lives beside the rest of
 * the stage state machine so the tool-owner check can drive the shipped function, not a copy.
 */
export function stageComposedNote(tx: Transaction, liveSessionId: string, args: { title: string; body: string; evidenceRefs: string[] },
  turn: OwnerTurnFacts, now: number, enabled: boolean): JsonObject {
  const rows = tx.all("SELECT journal_id,text,final_origin,finalized_at FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' AND finished=1 ORDER BY journal_id DESC LIMIT 50", [liveSessionId])
    .map(row => ({ journalId: Number(row['journal_id']), text: String(row['text'] ?? ''),
      finalOrigin: String(row['final_origin'] ?? 'unknown'), finalizedAt: Number(row['finalized_at'] ?? 0) }));
  // W6-R2 B1: only this turn's finalized mic transcript can authorize, never the previous turn.
  // R7-W1: his words before the model answered are an earlier stretch, never this ask.
  const spoken = tx.get("SELECT MAX(journal_id) AS id FROM live_journal WHERE live_session_id=? AND kind='outputTranscription' AND finished=1", [liveSessionId]);
  const read = currentOwnerTurn(rows, turn.inputAt, turn.inputFinal, now, Number(spoken?.['id'] ?? 0) || undefined);
  if (read.state === 'refused') {
    hostLogEvent({ event: 'lux_note_stage', staged: false, code: read.code });
    return { staged: false, code: read.code };
  }
  const outcome = beginStage({ stageId: randomUUID(), sessionId: liveSessionId, ownerText: read.text,
    title: args.title, body: args.body, evidence: args.evidenceRefs, heldEvidence: read.evidence, enabled, now });
  if (outcome.state === 'refused') {
    hostLogEvent({ event: 'lux_note_stage', staged: false, code: outcome.code });
    return outcome.code === 'authorization_missing'
      ? { staged: false, code: outcome.code, guidance: AUTHORIZATION_MISSING_GUIDANCE }
      : { staged: false, code: outcome.code };
  }
  const note = outcome.note;
  saveNoteState(tx, note);
  hostLogEvent({ event: 'lux_note_stage', staged: true, digest: note.payloadSha.slice(0, 12) });
  return { staged: true, stageId: note.stageId, title: note.title, body: note.body,
    readBack: `Read the note back exactly, then wait for the owner: ${note.title}. ${note.body}` };
}

const ended = (note: NoteState, state: 'cancelled' | 'invalidated', code: string, now: number): NoteState => ({ ...note, state, code, endedAt: now });

/** Confirmation is armed only by the app's own drained receipt for the read-back segment. */
export function noteReadback(note: NoteState, now: number, receipt: 'drained' | 'interrupted'): NoteState {
  if (note.state !== 'staged') return note;
  if (receipt === 'interrupted') return ended(note, 'invalidated', 'readback_interrupted', now);
  return { ...note, state: 'armed', armedAt: now };
}

/** A confirmation is the next finalized owner-mic turn after the read-back, inside its window. */
export function noteOwnerUtterance(note: NoteState, input: { readonly text: string; readonly now: number }): NoteState {
  // Before the read-back no owner turn is a confirmation; a stage that never hears one goes stale.
  if (note.state === 'staged') {
    return input.now - note.stagedAt > CONFIRM_WINDOW_MS ? ended(note, 'cancelled', 'not_armed', input.now) : note;
  }
  if (note.state !== 'armed') return note;
  if (input.now - (note.armedAt ?? note.stagedAt) > CONFIRM_WINDOW_MS) return ended(note, 'cancelled', 'confirm_expired', input.now);
  if (confirmAsk(input.text) !== 'affirm') return ended(note, 'cancelled', 'not_affirmative', input.now);
  return { ...note, state: 'settling', settleAt: input.now + CONFIRM_SETTLE_MS };
}

/** Any further owner fragment inside the settle window cancels: "yes ... wait, make it fifty". */
export function noteOwnerFragment(note: NoteState, now: number): NoteState {
  if (note.state !== 'settling') return note;
  if ((note.settleAt ?? 0) > now) return ended(note, 'cancelled', 'late_fragment', now);
  return note;
}

export function noteSettle(note: NoteState, now: number): NoteState {
  if (note.state !== 'settling' || (note.settleAt ?? 0) > now) return note;
  return { ...note, state: 'committed', endedAt: now };
}

export function noteReceiptJson(receipt: { readonly state: string; readonly code?: string }): JsonObject {
  return { staged: receipt.state === 'staged' || receipt.state === 'armed' || receipt.state === 'settling', ...(receipt.code === undefined ? {} : { code: receipt.code }) };
}

/** One row per composed-note stage: the frozen payload is the only thing a later commit may send. */
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
}];

const noteFromRow = (row: { readonly [key: string]: unknown }): NoteState => ({
  stageId: String(row['stage_id']), sessionId: String(row['live_session_id']), title: String(row['title']), body: String(row['body']),
  payload: String(row['payload_json']), payloadSha: String(row['payload_sha256']), state: String(row['state']) as NoteStageName,
  stagedAt: Number(row['staged_at']),
  ...(row['armed_at'] === null || row['armed_at'] === undefined ? {} : { armedAt: Number(row['armed_at']) }),
  ...(row['settle_at'] === null || row['settle_at'] === undefined ? {} : { settleAt: Number(row['settle_at']) }),
  ...(row['ended_at'] === null || row['ended_at'] === undefined ? {} : { endedAt: Number(row['ended_at']) }),
  ...(row['code'] === null || row['code'] === undefined ? {} : { code: String(row['code']) }),
});

export function saveNoteState(tx: Transaction, note: NoteState): void {
  tx.run(`INSERT INTO lux_note_stages(stage_id,live_session_id,title,body,payload_json,payload_sha256,evidence_json,state,code,staged_at,armed_at,settle_at,ended_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(stage_id) DO UPDATE SET state=excluded.state, code=excluded.code, armed_at=excluded.armed_at, settle_at=excluded.settle_at, ended_at=excluded.ended_at`,
  [note.stageId, note.sessionId, note.title, note.body, note.payload, note.payloadSha, '[]', note.state, note.code ?? null,
    note.stagedAt, note.armedAt ?? null, note.settleAt ?? null, note.endedAt ?? null]);
}

/** The one stage this session may still act on, newest first; a closed stage is never reopened. */
export function openNote(tx: Transaction, liveSessionId: string): NoteState | undefined {
  const row = tx.get("SELECT * FROM lux_note_stages WHERE live_session_id=? AND state IN ('staged','armed','settling') ORDER BY staged_at DESC, rowid DESC LIMIT 1", [liveSessionId]);
  return row ? noteFromRow(row) : undefined;
}

export function noteById(tx: Transaction, stageId: string): NoteState | undefined {
  const row = tx.get('SELECT * FROM lux_note_stages WHERE stage_id=?', [stageId]);
  return row ? noteFromRow(row) : undefined;
}

export function markCommitted(tx: Transaction, stageId: string, insightId: string | undefined): void {
  tx.run("UPDATE lux_note_stages SET state='committed', insight_id=? WHERE stage_id=?", [insightId ?? null, stageId]);
}
