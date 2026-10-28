import { randomUUID } from 'node:crypto';
import type { JsonObject } from '../adapters/model/types.js';
import type { SchemaMigration, Transaction } from '../contracts/storage.js';
import { canonicalJSON, sha256 } from './canonical.js';
import { hostLogEvent } from './host-events.js';

/** The composed-note stage tool is a gateway declaration, never a remote MCP one. */
export const STAGE_NOTE_IDENTITY = { name: 'stage_lux_note', accountId: 'gateway:live-voice', resourceId: 'owner-vault' } as const;
export const STAGE_NOTE_PARAMETERS = { type: 'object', properties: {
  title: { type: 'string', minLength: 1, maxLength: 120, description: 'A short title for the note, from this conversation.' },
  body: { type: 'string', minLength: 1, maxLength: 4000, description: 'The note body, from this conversation.' },
  evidenceRefs: { type: 'array', minItems: 0, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 64 }, description: 'Refs of host evidence for this note.' },
}, required: ['title', 'body', 'evidenceRefs'], additionalProperties: false };

const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,63}$/;
export function validateStageNote(args: unknown): args is { title: string; body: string; evidenceRefs: string[] } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const value = args as Record<string, unknown>;
  if (Object.keys(value).length !== 3) return false;
  const refs = value['evidenceRefs'];
  return typeof value['title'] === 'string' && value['title'].length >= 1 && value['title'].length <= 120
    && typeof value['body'] === 'string' && value['body'].length >= 1 && value['body'].length <= 4000
    && Array.isArray(refs) && refs.length <= 8 && refs.every(ref => typeof ref === 'string' && REF_SHAPE.test(ref));
}

/** A note is titled and bodied by the host; title plus body is never truncated, only refused. */
export const NOTE_MAX_CHARS = 4000;
export const STAGE_NOTE_GUIDANCE = 'Saving into Lux uses only stage_lux_note: supply a title and conversation synthesis of at most 4,000 characters after an owner save request. Speak the host readBack verbatim from the tool result, including provenance; it is not owner speech. Wait for playback to finish and the owner to confirm. On read it all, speak the complete title and body before asking again. Say saved and name the title only after the host reports an insight id. authorization_missing means a fresh owner save request is required. authorization_refused means the request was qualified or negated. evidence_unknown means a citation is not held by this conversation. too_long means it was not staged; offer to split it. not_enabled means saving is disabled. payload_empty means a title and body are required. vault_unavailable means the vault could not be reached; it was not saved. outcome_unknown means the write result is unknown; do not retry or claim success. readback_mismatch means confirmation was not armed; it was not saved. not_affirmative means the note was not saved.';
/** What the model says when the host could not stage the note at all: a closed code in plain words. */
export const STAGE_FAILED_GUIDANCE = 'The note was not staged. Tell the owner it was not saved and ask them to say it again in one sentence.';
/** R7-W1: a refusal is never named as a Lux failure; she asks him for the words that stage it. */
export const AUTHORIZATION_MISSING_GUIDANCE = "I did not hear a save request in your own words this turn; say 'save it to Lux' and I will stage it.";
export const TITLE_MAX_CHARS = 120;
export const CONFIRM_WINDOW_MS = 30_000;
/** W1-R1: the open guard's bounds, on the journal rows of one owner stretch: six splits, 600 characters. */
export const OWNER_WINDOW_TURNS = 6;
export const OWNER_WINDOW_CHARS = 600;
export const CONFIRM_SETTLE_MS = 1_500;
export const CONFIRM_MAX_TOKENS = 6;
const VAULT_TYPE = 'UNCATEGORIZED';
const VAULT_PROJECT = 'didi-voice';

export const noteKey = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (text: string): string[] => noteKey(text).split(' ').filter(word => word.length > 0);

export type ComposedReason = 'negated' | 'reported' | 'quoted' | 'conditional' | 'ambiguous';
export type ComposedAsk = { readonly decision: 'grant' } | { readonly decision: 'clarify'; readonly reason: ComposedReason }
  | { readonly decision: 'append' } | { readonly decision: 'none' };

/**
 * The verbs that can authorize a create, and the destinations that name lux and nothing else. W1-R2: the
 * ask can sit anywhere in a stretch he said in pieces, so the verb is a word, not a leading anchor.
 */
const ASK_WORD = /\b(?:save|remember|put|add|write|store|note)\b/u;
const DESTINATION = /\b(?:to|in|into)\s+(?:my\s+|the\s+)?(?:lux(?:\s+knowledge)?|knowledge\s+base|vault)\b/u;
const APPEND = /^(?:naya\s+)?(?:please\s+)?(?:add|append|update|change|overwrite|edit|delete|remove|archive|link|restore|replace)\b(?=[\s\S]*\b(?:note|insight|entry|record)\b)/u;
const REPORTED = /^(?:say|says|according to)\b|\b(?:he|she|they|it|someone|rob|you|the [a-z]+)\s+(?:said|says|say|asked|asks|wrote|writes|mentioned|mentions|told|tells|wants|asked me)\b/u;
const QUESTION = /\b(?:how (?:do|can|should|would) (?:i|you)|what(?:'s| is) the (?:way|phrase|command)|can you tell me how)\b/u;
const CONDITIONAL = /^(?:if|when|whenever|unless|should|in case)\b/u;
/** W1-R4: a negation is a word, contractions included, and it governs across a short framing chain. */
const NEGATION = /\b(?:(?:don|didn|doesn|won|wouldn|couldn|shouldn|isn|aren|wasn|weren|hasn|haven|ain|can)(?:'| )?t|cannot|not|never|no)\b/u;
/** A token that a split contraction ends in: noteKey turns "don't" into "don t". */
const CONTRACTION_TAIL = new Set(['don', 'didn', 'doesn', 'won', 'wouldn', 'couldn', 'shouldn', 'isn', 'aren', 'wasn', 'weren', 'hasn', 'haven', 'ain', 'can']);
/** The auxiliaries and framing words a negation carries to its verb: "don't want to save" is a refusal. */
const FRAMING = new Set(['want', 'wants', 'wanted', 'need', 'needs', 'needed', 'have', 'has', 'had', 'try', 'tries', 'tried',
  'intend', 'intends', 'intended', 'mean', 'means', 'meant', 'ever', 'to', 'be', 'will', 'would', 'going', 'really', 'just']);
const FRAMING_CHAIN = 6;
const HEDGE = /\b(?:maybe|perhaps|probably|might|could|i think|i guess|possibly)\b/u;
/** W1-R4: the words of the stretch, with a split contraction ("don t") kept as one token. */
const askTokens = (key: string): string[] => {
  const merged: string[] = [];
  for (const token of key.split(' ')) {
    const last = merged.length - 1;
    if (token === 't' && last >= 0 && CONTRACTION_TAIL.has(merged[last]!)) merged[last] = `${merged[last]} t`;
    else merged.push(token);
  }
  return merged;
};

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
  // W1-R2: a save verb and a lux destination anywhere in the stretch are the ask.
  if (!ASK_WORD.test(key)) {
    return HEDGE.test(key) && DESTINATION.test(key) ? { decision: 'clarify', reason: 'ambiguous' } : { decision: 'none' };
  }
  const destination = key.search(DESTINATION);
  // W1-R4: every save verb before the destination is judged, and a negation governs across a short
  // framing chain, so "don't want to save" refuses while a self-correction followed by an ask grants.
  const tokens = askTokens(key);
  const offsets: number[] = [];
  let at = 0;
  for (const token of tokens) { offsets.push(at); at += token.length + 1; }
  const governed = (index: number): boolean => {
    let before = index - 1;
    for (let step = 0; before >= 0 && step < FRAMING_CHAIN && FRAMING.has(tokens[before]!); step += 1) before -= 1;
    return before >= 0 && NEGATION.test(tokens[before]!);
  };
  const asked = tokens.some((token, index) => ASK_WORD.test(token)
    && (destination < 0 || (offsets[index] ?? 0) < destination) && !governed(index));
  if (HEDGE.test(key) || /\b(?:or|either|and maybe)\b/u.test(key.slice(destination))) return { decision: 'clarify', reason: 'ambiguous' };
  if (destination < 0) {
    // A note about this conversation names its source instead of a store. Staging is still not saving:
    // the frozen read-back and his own confirmation are what authorize the write.
    if (!NOTE_SOURCE.test(key) && !/\b(?:this|all of this|that)\b/u.test(key)) return { decision: 'none' };
    return asked ? { decision: 'grant' } : { decision: 'clarify', reason: 'negated' };
  }
  return asked ? { decision: 'grant' } : { decision: 'clarify', reason: 'negated' };
}

const CLOSED_AFFIRMATIVES = new Set(['yes', 'yes save it', 'save it', 'go ahead', 'do it', 'save this note']);

/** Only a closed owner affirmative can authorize this candidate, never a word bag. */
export function confirmAsk(text: string): 'affirm' | 'cancel' {
  return CLOSED_AFFIRMATIVES.has(noteKey(text)) ? 'affirm' : 'cancel';
}

export type FrozenNote = { readonly state: 'frozen'; readonly payload: string; readonly payloadSha: string }
  | { readonly state: 'refused'; readonly code: 'payload_empty' | 'too_long' };

/** The whole save_insight payload and its digest are frozen here; nothing later may change them. */
export function freezeNote(note: { readonly title: string; readonly body: string }): FrozenNote {
  const title = note.title.replace(/\s+/g, ' ').trim();
  const body = note.body.trim();
  if (!title || !body) return { state: 'refused', code: 'payload_empty' };
  if (title.length > TITLE_MAX_CHARS || body.length > NOTE_MAX_CHARS) {
    return { state: 'refused', code: 'too_long' };
  }
  const payload = canonicalJSON({ content: body, insight_title: title, insight_type: VAULT_TYPE, project: VAULT_PROJECT });
  return { state: 'frozen', payload, payloadSha: sha256(payload) };
}

/** One finalized owner row, as the host reads it out of the journal. */
export interface OwnerTurnRow { readonly journalId: number; readonly text: string; readonly finalOrigin: string; readonly finalizedAt: number }
export type OwnerTurnRead = { readonly state: 'owner_turn'; readonly text: string; readonly evidence: ReadonlySet<string> }
  | { readonly state: 'refused'; readonly code: 'transcript_pending' | 'transcript_typed' };

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

/**
 * W6-R2 B1: authorization is the owner's own finalized mic turn of THIS turn. Before its transcript
 * is finalized the stage refuses, and a newer-looking read never borrows the previous owner turn.
 * R7-W1: that turn is the whole finalized stretch he said in pieces, not only its newest fragment.
 */
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
  readonly externalContextPresent?: boolean;
  readonly ownerJournalIds?: readonly number[];
  readonly watermark?: number;
  readonly confirmationText?: string;
}

export type StageCode = 'not_enabled' | 'authorization_missing' | 'authorization_refused' | 'append_unsupported'
  | 'evidence_missing' | 'evidence_unknown' | 'payload_empty' | 'too_long';
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
  readonly externalContextPresent?: boolean;
  readonly ownerJournalIds?: readonly number[];
  readonly watermark?: number;
}

export function beginStage(input: StageInput): StageOutcome {
  if (!input.enabled) return { state: 'refused', code: 'not_enabled' };
  const ask = composedAsk(input.ownerText);
  if (ask.decision === 'none') return { state: 'refused', code: 'authorization_missing' };
  if (ask.decision === 'clarify') return { state: 'refused', code: 'authorization_refused' };
  if (ask.decision === 'append') return { state: 'refused', code: 'append_unsupported' };
  if (!input.evidence.every(ref => input.heldEvidence.has(ref))) return { state: 'refused', code: 'evidence_unknown' };
  const body = input.externalContextPresent ? `${input.body.trim()}\n\n${NOTE_PROVENANCE}` : input.body.trim();
  const frozen = freezeNote({ title: input.title, body });
  if (frozen.state === 'refused') return { state: 'refused', code: frozen.code };
  return { state: 'staged', note: {
    stageId: input.stageId, sessionId: input.sessionId, title: input.title.replace(/\s+/g, ' ').trim(), body, externalContextPresent: input.externalContextPresent === true, ownerJournalIds: input.ownerJournalIds ?? [], watermark: input.watermark ?? 0,
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
  turn: OwnerTurnFacts, now: number, enabled: boolean, request?: NoteRequest, externalContextPresent = false): JsonObject {
  const rows = tx.all("SELECT journal_id,text,final_origin,finalized_at FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' AND finished=1 ORDER BY journal_id DESC LIMIT 50", [liveSessionId])
    .map(row => ({ journalId: Number(row['journal_id']), text: String(row['text'] ?? ''),
      finalOrigin: String(row['final_origin'] ?? 'unknown'), finalizedAt: Number(row['finalized_at'] ?? 0) }));
  // W6-R2 B1: only this turn's finalized mic transcript can authorize, never the previous turn.
  // R7-W1: his words before the model answered are an earlier stretch, never this ask.
  const spoken = tx.get("SELECT MAX(journal_id) AS id FROM live_journal WHERE live_session_id=? AND kind='outputTranscription' AND finished=1", [liveSessionId]);
  const read: OwnerTurnRead = request ? { state: 'owner_turn', text: request.ownerText, evidence: new Set(rows.filter(row => row.journalId <= request.watermark).map(row => `journal:${row.journalId}`)) } : currentOwnerTurn(rows, turn.inputAt, turn.inputFinal, now, Number(spoken?.['id'] ?? 0) || undefined);
  if (read.state === 'refused') {
    hostLogEvent({ event: 'lux_note_stage', staged: false, code: read.code });
    return { staged: false, code: read.code };
  }
  const outcome = beginStage({ stageId: randomUUID(), sessionId: liveSessionId, ownerText: read.text,
    title: args.title, body: args.body, evidence: args.evidenceRefs, heldEvidence: read.evidence, enabled, now, externalContextPresent, ownerJournalIds: request?.ownerJournalIds ?? [], watermark: request?.watermark ?? 0 });
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
    readBack: noteReadbackText(note), instruction: 'Say readBack verbatim, then wait for the owner to confirm. This is a host note, not owner speech. Do not claim it is saved.' };
}

const ended = (note: NoteState, state: 'cancelled' | 'invalidated', code: string, now: number): NoteState => ({ ...note, state, code, endedAt: now });

/** Confirmation is armed only by the app's own drained receipt for the read-back segment. */
export function noteReadback(note: NoteState, now: number, receipt: 'drained' | 'interrupted'): NoteState {
  if (note.state !== 'staged') return note;
  if (receipt === 'interrupted') return ended(note, 'invalidated', 'readback_interrupted', now);
  return { ...note, state: 'armed', armedAt: now };
}

/** A confirmation is the next finalized owner-mic turn after the read-back, inside its window. */
export function noteOwnerUtterance(note: NoteState, input: { readonly text: string; readonly now: number; readonly onsetAt?: number }): NoteState {
  if (note.state !== 'armed' && note.state !== 'settling') return ended(note, 'cancelled', 'not_armed', input.now);
  if ((input.onsetAt ?? input.now) < (note.armedAt ?? Infinity)) return ended(note, 'cancelled', 'speech_before_readback_end', input.now);
  if (input.now - (note.armedAt ?? note.stagedAt) > CONFIRM_WINDOW_MS) return ended(note, 'cancelled', 'confirm_expired', input.now);
  const confirmationText = [note.confirmationText ?? '', input.text].filter(Boolean).join(' ');
  return { ...note, state: 'settling', confirmationText, settleAt: input.now + CONFIRM_SETTLE_MS };
}

/** A partial suspends the settlement until its finalized fragment can be merged. */
export function noteOwnerFragment(note: NoteState, _now: number): NoteState {
  if (note.state !== 'settling') return note;
  const { settleAt: _settleAt, ...pending } = note;
  return pending;
}

export function noteSettle(note: NoteState, now: number): NoteState {
  if (note.state !== 'settling' || note.settleAt === undefined || note.settleAt > now) return note;
  if (confirmAsk(note.confirmationText ?? '') !== 'affirm') return ended(note, 'cancelled', 'not_affirmative', now);
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
}, { owner: 'lux-note', version: 2, statements: [
  'ALTER TABLE lux_note_stages ADD COLUMN external_context_present INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE lux_note_stages ADD COLUMN owner_journal_ids_json TEXT NOT NULL DEFAULT '[]'",
  'ALTER TABLE lux_note_stages ADD COLUMN conversation_watermark INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE lux_note_stages ADD COLUMN confirmation_text TEXT NOT NULL DEFAULT ''",
] }];

const noteFromRow = (row: { readonly [key: string]: unknown }): NoteState => ({
  stageId: String(row['stage_id']), sessionId: String(row['live_session_id']), title: String(row['title']), body: String(row['body']),
  payload: String(row['payload_json']), payloadSha: String(row['payload_sha256']), state: String(row['state']) as NoteStageName,
  stagedAt: Number(row['staged_at']),
  ...(row['armed_at'] === null || row['armed_at'] === undefined ? {} : { armedAt: Number(row['armed_at']) }),
  ...(row['settle_at'] === null || row['settle_at'] === undefined ? {} : { settleAt: Number(row['settle_at']) }),
  ...(row['ended_at'] === null || row['ended_at'] === undefined ? {} : { endedAt: Number(row['ended_at']) }),
  externalContextPresent: Number(row['external_context_present'] ?? 0) === 1,
  ownerJournalIds: JSON.parse(String(row['owner_journal_ids_json'] ?? '[]')) as number[],
  watermark: Number(row['conversation_watermark'] ?? 0),
  confirmationText: String(row['confirmation_text'] ?? ''),
  ...(row['code'] === null || row['code'] === undefined ? {} : { code: String(row['code']) }),
});

export function saveNoteState(tx: Transaction, note: NoteState): void {
  tx.run(`INSERT INTO lux_note_stages(stage_id,live_session_id,title,body,payload_json,payload_sha256,evidence_json,state,code,staged_at,armed_at,settle_at,ended_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(stage_id) DO UPDATE SET state=excluded.state, code=excluded.code, armed_at=excluded.armed_at, settle_at=excluded.settle_at, ended_at=excluded.ended_at`,
  [note.stageId, note.sessionId, note.title, note.body, note.payload, note.payloadSha, '[]', note.state, note.code ?? null,
    note.stagedAt, note.armedAt ?? null, note.settleAt ?? null, note.endedAt ?? null]);
  tx.run('UPDATE lux_note_stages SET external_context_present=?,owner_journal_ids_json=?,conversation_watermark=?,confirmation_text=? WHERE stage_id=?',
    [note.externalContextPresent ? 1 : 0, JSON.stringify(note.ownerJournalIds ?? []), note.watermark ?? 0, note.confirmationText ?? '', note.stageId]);
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

export const NOTE_PROVENANCE = 'Provenance: this note includes content from mail, web or chat read in that session.';
export interface NoteRequest {
  readonly ownerText: string;
  readonly ownerJournalIds: readonly number[];
  readonly watermark: number;
}

/** Session-owned authority. Model arguments can neither mint nor refresh this token. */
export class NoteRequestGate {
  #block: number | undefined;
  #fragments: { id: number; text: string }[] = [];
  #claimedBlock: number | undefined;
  #request: NoteRequest | undefined;
  externalContextPresent = false;

  observeOwner(block: number, journalId: number, text: string): void {
    if (block !== this.#block) { this.#block = block; this.#fragments = []; this.#request = undefined; }
    this.#fragments.push({ id: journalId, text });
    const ownerText = this.#fragments.map(fragment => fragment.text).join(' ');
    this.#request = block !== this.#claimedBlock && composedAsk(ownerText).decision === 'grant'
      ? { ownerText, ownerJournalIds: this.#fragments.map(fragment => fragment.id), watermark: journalId } : undefined;
  }

  claim(): NoteRequest | undefined {
    const request = this.#request;
    this.#request = undefined;
    this.#claimedBlock = this.#block;
    return request;
  }

  externalRead(): void { this.#request = undefined; this.#claimedBlock = this.#block; }
  externalResult(): void { this.externalContextPresent = true; }
  disconnect(): void { this.#request = undefined; this.#fragments = []; this.#claimedBlock = this.#block; }
}

/** Every paragraph or bullet contributes a first sentence; the model cannot choose what is read. */
export function noteReadbackText(note: Pick<NoteState, 'title' | 'body'>): string {
  const paragraphs = note.body.split(/\n\s*\n|\n(?=\s*(?:[-*+]\s|\d+[.)]\s))/u)
    .map(paragraph => paragraph.trim()).filter(Boolean);
  const tainted = paragraphs.includes(NOTE_PROVENANCE);
  const sentences = paragraphs.filter(paragraph => paragraph !== NOTE_PROVENANCE).map(paragraph => {
    const text = paragraph.replace(/^\s*(?:[-*+]\s|\d+[.)]\s)/u, '');
    return text.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? text;
  });
  return [note.title, ...(tainted ? [NOTE_PROVENANCE] : []), ...sentences].join('\n');
}

/** Multiset overlap counts repeated words too; extra unrelated speech also lowers the score. */
export function readbackMatches(expected: string, spoken: string): boolean {
  const left = words(expected), right = words(spoken);
  if (left.length === 0 || right.length === 0) return false;
  const counts = new Map<string, number>();
  for (const word of left) counts.set(word, (counts.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of right) {
    const count = counts.get(word) ?? 0;
    if (count > 0) { shared += 1; counts.set(word, count - 1); }
  }
  return shared / Math.max(left.length, right.length) >= 0.9;
}
