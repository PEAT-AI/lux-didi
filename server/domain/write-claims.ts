import type { Transaction } from '../contracts/storage.js';

/**
 * C-MEMORYTRUTH: a summary may only say a write happened when a tool receipt settled it, and it may not
 * deny a write the store can see. The host applies this after the model call and again when an earlier
 * call's summary is composed into the start instruction, so the owner's memory and the next greeting agree
 * with the records. Nothing here reads or rewrites a stored row: it works on the text on its way out.
 */

/** The four write surfaces a spoken summary names, so a claim is matched to the tool that would settle it. */
export type WriteKind = 'event' | 'alarm' | 'note' | 'message';

const TOOL_KINDS: Readonly<Record<string, WriteKind>> = {
  // Only the creating tool settles a creation claim: a successful delete must never make "Naya created the
  // event" true, and no DONE verb speaks of deletion, so a delete needs no kind of its own here.
  create_event: 'event',
  set_alarm: 'alarm', snooze_alarm: 'alarm',
  remember_note: 'note', stage_lux_note: 'note', save_to_vault: 'note', trello_write: 'note',
  draft_email: 'message', draft_chat: 'message',
};

/** Past-tense completion verbs, per surface. A spoken "I will set it" is not a claim of this shape. */
const DONE: Readonly<Record<WriteKind, RegExp>> = {
  event: /\b(?:created|added|scheduled|booked|rescheduled|set up|put (?:it )?on (?:the|your) calendar)\b/i,
  alarm: /\b(?:set|armed|scheduled|created)\b/i,
  note: /\b(?:saved|stored|wrote|written|remembered|kept|logged|added)\b/i,
  message: /\b(?:sent|drafted|wrote|written|posted|delivered)\b/i,
};

const NOUNS: Readonly<Record<WriteKind, RegExp>> = {
  event: /\b(?:event|events|meeting|meetings|appointment|appointments|calendar|invite)\b/i,
  alarm: /\b(?:alarm|alarms)\b/i,
  note: /\b(?:note|notes|reminder|reminders|memo|card|list)\b/i,
  message: /\b(?:email|e-mail|message|messages|chat|draft|reply)\b/i,
};

/** A sentence that records a refusal or a failure, the other way a claim can be wrong. */
const NOT_DONE = /\b(?:could ?not|couldn't|unable to|failed|was refused|were refused|did not|didn't|was denied|no[ t] able)\b/i;
/** An ask, an intention or an unanswered request is never a claim about the store, whatever verb follows. */
const NOT_A_CLAIM = /\b(?:asked|asks|wanted|wants|requested|going to|planned to|to create|to add|to set|to schedule|to save|to send|still to do|left to do)\b/i;

/** One settled terminal tool record as the tools layer sealed it. */
export interface WriteReceipt { readonly name: string; readonly outcome: string }

/** An alarm the alarms table holds as armed at the moment of the read. */
export interface ActiveAlarm { readonly id: string; readonly fireAtUtc: number; readonly tz: string; readonly label: string }

export interface WriteFacts {
  /** The surfaces a completed tool call settled in this session. */
  readonly settled: ReadonlySet<WriteKind>;
}

export function writeFacts(receipts: readonly WriteReceipt[]): WriteFacts {
  const settled = new Set<WriteKind>();
  for (const receipt of receipts) {
    if (receipt.outcome !== 'succeeded') continue;
    const kind = TOOL_KINDS[receipt.name];
    if (kind !== undefined) settled.add(kind);
  }
  return { settled };
}

export interface GuardedClaims {
  readonly text: string;
  /** How many sentences were dropped and how many survived, the only numbers the log carries. */
  readonly dropped: number;
  readonly kept: number;
}

/**
 * A sentence is a run of text up to a sentence end, so a dropped claim never leaves its neighbours cut. A dot
 * inside a number ("9.30") or an abbreviation is not a sentence end, so the run continues past it.
 */
function sentences(text: string): readonly string[] {
  return text.match(/[^.!?]+(?:[.!?]+(?!\d)[\s]*|$)/g) ?? (text ? [text] : []);
}

/** True when the sentence claims a change that the records do not support, or denies one they record. */
function contradicts(sentence: string, facts: WriteFacts): boolean {
  if (NOT_A_CLAIM.test(sentence)) return false;
  const denied = NOT_DONE.test(sentence);
  for (const kind of Object.keys(NOUNS) as readonly WriteKind[]) {
    if (!NOUNS[kind].test(sentence)) continue;
    const saysDone = DONE[kind].test(sentence);
    if (!saysDone && !denied) continue;
    // An alarm claim is settled by this call's own set or snooze receipt, never by the presence of some other
    // armed alarm: an unrelated armed row cannot make a refused 6 am alarm true, and a receipt keeps a true
    // claim even when the alarm has already rung out of the live table. The alarms table still owns the seed
    // line the next call reads.
    if (denied && facts.settled.has(kind)) return true;
    if (saysDone && !facts.settled.has(kind)) return true;
  }
  return false;
}

/**
 * Drop every sentence of a summary or an open loop that the records do not support. A summary with no
 * write claim is returned byte-identical, so the length and format of an ordinary summary never change.
 */
export function guardWriteClaims(text: string, facts: WriteFacts): GuardedClaims {
  const all = sentences(text);
  const kept = all.filter(sentence => !contradicts(sentence, facts));
  const dropped = all.length - kept.length;
  if (dropped === 0) return { text, dropped, kept: kept.length };
  return { text: kept.join('').replace(/\s+/g, ' ').trim(), dropped, kept: kept.length };
}

/** The alarms the table holds as armed, oldest first, or null when this store has no alarms table. */
export function activeAlarms(tx: Transaction): readonly ActiveAlarm[] | null {
  if (!tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='alarms'", [])) return null;
  return tx.all("SELECT id,fire_at_utc,tz,label FROM alarms WHERE state IN ('pending','ringing') ORDER BY fire_at_utc", [])
    .map(row => ({ id: String(row['id']), fireAtUtc: Number(row['fire_at_utc']), tz: String(row['tz']), label: String(row['label']) }));
}
