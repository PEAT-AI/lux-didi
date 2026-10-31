import { parseAlarmTime } from './alarm.js';
import type { JsonObject } from '../adapters/model/types.js';
import type { ComposeDispatch, ComposeOutcome } from './types.js';
import { googleConsentLine } from './google.js';

/**
 * The write surface Naya may reach by voice: drafts that only the owner can send, and calendar
 * events that never invite anyone. Everything here is local and pure: the host derives the
 * recipient, the event window and the replay key from the owner's own words, never from a model
 * argument, and the connector call itself belongs to the host's compose port.
 */
export const COMPOSE_IDENTITY = { accountId: 'gateway:live-voice', resourceId: 'owner-compose' } as const;
export const COMPOSE_NAMES = ['draft_email', 'draft_chat', 'create_event', 'delete_event'] as const;
export type ComposeName = (typeof COMPOSE_NAMES)[number];

/** One grant kind per tool, so an email grant can never be spent on a calendar write. */
export type ComposeGrantKind = 'draft_email' | 'draft_chat' | 'create_event' | 'delete_event';
export const COMPOSE_GRANT_KINDS: readonly ComposeGrantKind[] = ['draft_email', 'draft_chat', 'create_event', 'delete_event'];

const MAIL = /\b(?:e-?mails?|mails?)\b/i;
const CHAT = /\b(?:mattermost|dm|dms|chat|channel|thread|ping|slack)\b/i;
const DRAFT_VERB = /\b(?:draft|write|compose|send|reply|respond|message|tell)\b/i;
const CALENDAR = /\b(?:calendar|schedule|book)\b/i;
const BLOCK_VERB = /\b(?:block|add|put|reserve|hold)\b/i;
const BLOCK_NOUN = /\b(?:hour|time|block|slot|event|meeting|gym|appointment|lunch)\b/i;
const SCHEDULE_VERB = /\b(?:schedule|book|block|add|put|move|create|reserve|hold)\b/i;
const CANCEL_VERB = /\b(?:cancel|delete|remove|drop|scrap)\b/i;
const EVENT_NOUN = /\b(?:event|meeting|block|appointment|booking|lunch|gym|slot)\b/i;

/**
 * Which write intents one finalized owner turn carries. Intent words plus the thing being written
 * are enough: this is a vocabulary, not a phrase grammar, and it never depends on word order
 * beyond the verb and its object appearing in the same turn.
 */
export function composeGrantKinds(words: string): readonly ComposeGrantKind[] {
  const kinds: ComposeGrantKind[] = [];
  const mail = MAIL.test(words);
  const chat = CHAT.test(words);
  if (mail && (DRAFT_VERB.test(words) || /\bto\b/i.test(words))) kinds.push('draft_email');
  if (chat && DRAFT_VERB.test(words) && !(mail && !chat)) kinds.push('draft_chat');
  if (CALENDAR.test(words) ? SCHEDULE_VERB.test(words) : BLOCK_VERB.test(words) && BLOCK_NOUN.test(words)) kinds.push('create_event');
  if (CANCEL_VERB.test(words) && (EVENT_NOUN.test(words) || CALENDAR.test(words))) kinds.push('delete_event');
  return kinds;
}

export interface DraftEmailArguments { to: string; subject: string; body: string }
export interface DraftChatArguments { person?: string; channel?: string; root_id?: string; message: string }
export interface CreateEventArgs { summary: string; duration_minutes?: number }
export interface DeleteEventArgs { event_id?: string }

const isText = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max;
const keys = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));

export function validateDraftEmail(args: unknown): args is DraftEmailArguments {
  return keys(args, ['to', 'subject', 'body']) && isText(args['to'], 200) && isText(args['subject'], 300) && isText(args['body'], 8000);
}
export function validateDraftChat(args: unknown): args is DraftChatArguments {
  if (!keys(args, ['person', 'channel', 'root_id', 'message']) || !isText(args['message'], 8000)) return false;
  if (args['person'] !== undefined && !isText(args['person'], 200)) return false;
  if (args['channel'] !== undefined && !isText(args['channel'], 200)) return false;
  if (args['root_id'] !== undefined && !isText(args['root_id'], 200)) return false;
  if ((args['person'] === undefined) === (args['channel'] === undefined)) return false;
  return args['person'] !== undefined || args['root_id'] === undefined;
}
export function validateCreateEvent(args: unknown): args is CreateEventArgs {
  if (!keys(args, ['summary', 'duration_minutes']) || !isText(args['summary'], 200)) return false;
  const minutes = args['duration_minutes'];
  return minutes === undefined || (Number.isSafeInteger(minutes) && Number(minutes) >= 5 && Number(minutes) <= 720);
}
export function validateDeleteEvent(args: unknown): args is DeleteEventArgs {
  return keys(args, ['event_id']) && (args['event_id'] === undefined || isText(args['event_id'], 200));
}

/** One candidate a read actually returned; the model never supplies an address of its own. */
export interface RecipientCandidate { id: string; name: string; address?: string }
export type RecipientResolution =
  | { status: 'ok'; candidate: RecipientCandidate }
  | { status: 'recipient_ambiguous' | 'recipient_unknown'; candidates: string[] };

const spoken = (value: string): string[] => value.toLowerCase().replace(/[^\p{L}\p{N}\s'@.-]/gu, ' ').split(/\s+/).filter(part => part.length > 1);

/**
 * Resolve a spoken name against the candidates a read returned. The owner's own address is never a
 * recipient, and two distinct matches stay ambiguous so she asks instead of picking one.
 */
export function resolveRecipient(words: string, candidates: readonly RecipientCandidate[], ownerAddress?: string): RecipientResolution {
  const owner = ownerAddress?.trim().toLowerCase();
  const wanted = spoken(words);
  const seen = new Map<string, RecipientCandidate>();
  for (const candidate of candidates) {
    const address = candidate.address?.trim().toLowerCase();
    if (address !== undefined && owner !== undefined && address === owner) continue;
    const name = spoken(candidate.name);
    if (!wanted.some(part => name.includes(part))) continue;
    const key = address ?? candidate.id;
    if (!seen.has(key)) seen.set(key, candidate);
  }
  const found = [...seen.values()];
  if (found.length === 1) return { status: 'ok', candidate: found[0]! };
  return { status: found.length === 0 ? 'recipient_unknown' : 'recipient_ambiguous', candidates: found.slice(0, 3).map(candidate => candidate.name) };
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const NUMBERS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, thirty: 30, forty: 40, fifty: 50 };
const DURATION = /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half\s+an?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i;

export type EventWindow =
  | { status: 'ready'; startUtc: number; endUtc: number; timeZone: string; names: string[] }
  | { status: 'clarify'; reason: 'missing_time' | 'unsupported_time_expression' };

function localParts(instant: number, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(key => Number(parts.find(part => part.type === key)?.value));
}

/** The UTC instant of one local wall clock reading, corrected once for the zone offset. */
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const [y, mo, d, h, mi] = localParts(guess, timeZone);
  return guess - (Date.UTC(y!, mo! - 1, d!, h!, mi!, 0) - guess);
}

function durationMinutes(words: string): number {
  const match = DURATION.exec(words);
  if (!match) return 60;
  const unit = match[2]!.toLowerCase();
  const raw = match[1]!.toLowerCase().replace(/\s+/g, ' ');
  const amount = raw === 'half an' || raw.startsWith('half') ? 0.5 : NUMBERS[raw] ?? Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) return 60;
  const minutes = unit.startsWith('h') ? amount * 60 : amount;
  return Math.min(Math.max(Math.round(minutes), 5), 720);
}

/** A bare spoken hour for a named day: "9" is nine in the morning unless he says pm. */
function hourMinute(text: string): { hour: number; minute: number } | undefined {
  const digits = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  const words = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?:\s+(thirty|fifteen))?\s*(am|pm)?\b/i.exec(text);
  const hour = digits ? Number(digits[1]) : words ? NUMBERS[words[1]!.toLowerCase()] ?? 0 : 0;
  const minute = digits ? Number(digits[2] ?? 0) : words && words[2] ? (words[2].toLowerCase() === 'thirty' ? 30 : 15) : 0;
  if (!Number.isInteger(hour) || hour > 23 || minute > 59) return undefined;
  const meridiem = (digits?.[3] ?? words?.[3])?.toLowerCase();
  const settled = meridiem === 'pm' && hour < 12 ? hour + 12 : meridiem === 'am' && hour === 12 ? 0 : hour;
  return { hour: settled, minute };
}

const NOT_A_NAME = new Set(['on', 'at', 'for', 'in', 'and', 'from', 'tomorrow', 'today', 'tonight', 'next', 'this', 'the', 'a', 'an', 'my', 'our', 'about', ...WEEKDAYS]);

/** People he named alongside the event; they are described, never invited. */
export function namedOthers(words: string, ownerName?: string): string[] {
  const match = /\b(?:with|and|together with)\s+([\p{L}][\p{L}'.-]*(?:\s+[\p{L}][\p{L}'.-]*)?)/u.exec(words);
  if (!match) return [];
  const tokens = match[1]!.trim().split(/\s+/).filter(token => !NOT_A_NAME.has(token.toLowerCase()));
  const name = tokens.join(' ');
  if (ownerName !== undefined && name.toLowerCase() === ownerName.toLowerCase()) return [];
  return name.length > 0 ? [name] : [];
}

/**
 * The event window the host trusts: a named weekday settles the date locally, anything else rides
 * the alarm parser's normalisation, and the model's own epoch is never used.
 */
export function eventWindow(words: string, now: number, timeZone: string, ownerName?: string): EventWindow {
  const match = DURATION.exec(words);
  const cleaned = (match ? `${words.slice(0, match.index)} ${words.slice(match.index + match[0].length)}` : words).trim();
  const names = namedOthers(words, ownerName);
  const duration = durationMinutes(words) * 60000;
  const weekday = WEEKDAYS.findIndex(day => new RegExp(`\\b${day}\\b`, 'i').test(cleaned));
  if (weekday >= 0) {
    const time = hourMinute(cleaned);
    if (!time) return { status: 'clarify', reason: 'unsupported_time_expression' };
    const [year, month, day, , ,] = localParts(now, timeZone) as [number, number, number, number, number, number];
    const today = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    let ahead = (weekday - today + 7) % 7;
    let startUtc = zonedInstant(year, month, day + ahead, time.hour, time.minute, timeZone);
    if (startUtc <= now) { ahead += 7; startUtc = zonedInstant(year, month, day + ahead, time.hour, time.minute, timeZone); }
    return { status: 'ready', startUtc, endUtc: startUtc + duration, timeZone, names };
  }
  const parsed = parseAlarmTime(cleaned, now, timeZone);
  if (parsed.status === 'ready') return { status: 'ready', startUtc: parsed.fireAtUtc, endUtc: parsed.fireAtUtc + duration, timeZone: parsed.tz, names };
  if (parsed.status === 'clarify') return { status: 'clarify', reason: parsed.reason === 'unsupported_time_expression' ? 'unsupported_time_expression' : 'missing_time' };
  const time = hourMinute(cleaned);
  if (!time) return { status: 'clarify', reason: 'missing_time' };
  const [year, month, day] = localParts(now, timeZone) as [number, number, number, number, number, number];
  const startUtc = zonedInstant(year, month, day, time.hour, time.minute, timeZone);
  return { status: 'ready', startUtc: startUtc > now ? startUtc : startUtc + 86400000, endUtc: (startUtc > now ? startUtc : startUtc + 86400000) + duration, timeZone, names };
}

/** The owner turn is the replay key, so a retried call can never write twice. */
export const clientRequestId = (turn: string): string => `compose:${turn}`;

/** What she says about a draft: ready in his own box, and sending stays his click. */
export const DRAFT_GUIDANCE = 'The draft is in his own drafts; Naya never sends, he sends it with his click.';
export const EVENT_GUIDANCE = 'No invitations were sent; the names are in the description.';
export const CONNECTOR_NOT_AUTHORIZED = 'connector_not_authorized';

export function draftEmailResult(draft: { draftId: string; to: string; subject: string }): JsonObject {
  return { status: 'draft_ready', draft_id: draft.draftId, to: draft.to, subject: draft.subject, sent: false, say: `The email to ${draft.to} is in your drafts, subject ${draft.subject}. ${DRAFT_GUIDANCE}` };
}
export function draftChatResult(draft: { channelId: string; target: string; rootId?: string }): JsonObject {
  return { status: 'draft_ready', channel_id: draft.channelId, target: draft.target, ...(draft.rootId !== undefined ? { root_id: draft.rootId } : {}), posted: false, say: `The reply to ${draft.target} is in your Mattermost reply box. ${DRAFT_GUIDANCE}` };
}
export function createdEventResult(event: { eventId: string; htmlLink?: string; window: Extract<EventWindow, { status: 'ready' }>; clash?: string }): JsonObject {
  const names = event.window.names.length > 0 ? ` I wrote ${event.window.names.join(', ')} in the description and invited nobody.` : '';
  const clash = event.clash !== undefined ? ` That clashes with ${event.clash}.` : '';
  return {
    status: 'event_created', event_id: event.eventId, start: new Date(event.window.startUtc).toISOString(), end: new Date(event.window.endUtc).toISOString(),
    time_zone: event.window.timeZone, attendees: 0, invitations: 'none', ...(event.clash !== undefined ? { clash: event.clash } : {}),
    say: `${new Date(event.window.startUtc).toISOString()} to ${new Date(event.window.endUtc).toISOString()} is on your calendar.${names}${clash} ${EVENT_GUIDANCE}`,
    ...(event.htmlLink !== undefined ? { html_link: event.htmlLink } : {}),
  };
}
/** A missing token or an unconsented family is one closed answer plus the one command to run. */
export function notAuthorizedResult(family: string, command: string): JsonObject {
  return { status: CONNECTOR_NOT_AUTHORIZED, family, code: CONNECTOR_NOT_AUTHORIZED, say: `I do not have ${family} write access yet. ${command}, then I can do it.` };
}
export const COMPOSE_GUIDANCE = 'Naya drafts email and Mattermost messages and puts owner-only blocks on the calendar. She never sends and never invites.';

/**
 * The host's compose surface, and the only thing that may reach a mail, chat or calendar write.
 * A host that has no consented family answers `not_authorized` with the one command to run; one
 * whose remote result is lost answers `unknown` rather than inventing a success.
 */
export interface ComposeTool { description: string; parameters: JsonObject; validate(args: unknown): boolean }

/** One declaration per ability, each closed: nothing here can address a person or an invitation. */
export const COMPOSE_TOOLS: Readonly<Record<ComposeName, ComposeTool>> = {
  draft_email: {
    description: 'Write an email into his own drafts. Give the name he said, the subject and the body. Naya never sends: sending is his click. There is no recipient address to give and no send.',
    parameters: { type: 'object', properties: { to: { type: 'string', description: 'The name he said, exactly as he said it; the host resolves the address from his own mail.' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'], additionalProperties: false },
    validate: validateDraftEmail,
  },
  draft_chat: {
    description: 'Write a Mattermost message into his reply box, to a person or in a channel thread. Naya never posts: sending is his click.',
    parameters: { type: 'object', properties: { person: { type: 'string' }, channel: { type: 'string' }, root_id: { type: 'string', description: 'The thread root, when he replied in a thread.' }, message: { type: 'string' } }, required: ['message'], additionalProperties: false },
    validate: validateDraftChat,
  },
  create_event: {
    description: 'Put an owner-only block on his own calendar from the day and time he said. Never invite anyone; another name goes in the description. The host reads the time from his words, so give no start or end.',
    parameters: { type: 'object', properties: { summary: { type: 'string' }, duration_minutes: { type: 'integer', minimum: 5, maximum: 720, description: 'Only when he said how long it lasts; omit otherwise, because the host reads the length from his own words.' } }, required: ['summary'], additionalProperties: false },
    validate: validateCreateEvent,
  },
  delete_event: {
    description: 'Remove a block on his calendar that this call made, or one he named without ambiguity. Only events Naya created herself.',
    parameters: { type: 'object', properties: { event_id: { type: 'string', description: 'The event this call created, when he means that one.' } }, additionalProperties: false },
    validate: validateDeleteEvent,
  },
};

/** The target the grant and its claim are bound to, derived from his words and the turn. */
/** Exact id match over this run's own receipts: the block a create_event call actually made. */
export function createdEventIds(rows: readonly { intent_json?: unknown; result_json?: unknown }[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row.intent_json !== 'string' || !row.intent_json.includes('"toolName":"create_event"')) continue;
    if (typeof row.result_json !== 'string') continue;
    try {
      const parsed = JSON.parse(row.result_json) as { response?: { event_id?: unknown }, event_id?: unknown };
      const id = parsed.response?.event_id ?? parsed.event_id;
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    } catch { /* a row without parseable JSON names no event */ }
  }
  return ids;
}

export function composeTarget(name: ComposeName, args: JsonObject, turn: string): string {
  const text = (value: unknown): string => typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (name === 'draft_email') return `mail:${text(args['to'])}`;
  if (name === 'draft_chat') return `chat:${text(args['person'] ?? args['channel'])}${text(args['root_id']) ? `:${text(args['root_id'])}` : ''}`;
  if (name === 'create_event') return `event:${turn}`;
  return `event:${text(args['event_id']) || turn}`;
}

/** What the model hears and what the receipt records, for every outcome the host can report. */
export function composeResult(outcome: ComposeOutcome): JsonObject {
  if (outcome.state === 'done') {
    if (outcome.clash === undefined) return outcome.response;
    return { ...outcome.response, clash: outcome.clash, say: `${String(outcome.response['say'] ?? '')} That clashes with ${outcome.clash}.`.trim() };
  }
  if (outcome.state === 'recipient') {
    const names = outcome.candidates.slice(0, 3);
    const asked = outcome.code === 'recipient_ambiguous'
      ? `I found more than one match: ${names.join(', ')}. Which one did you mean?`
      : `I could not find ${names.length > 0 ? names.join(', ') : 'that name'} in your people. Who did you mean?`;
    return { status: 'refused', code: outcome.code, candidates: names, say: asked };
  }
  if (outcome.state === 'not_authorized') return notAuthorizedResult(outcome.family, outcome.command);
  if (outcome.state === 'unknown') {
    return { status: 'unknown', code: 'write_unknown', say: 'I cannot tell whether that went through, so I will not say it did. Check your own drafts or calendar before asking me again.' };
  }
  return { status: 'failed', code: outcome.reason, say: 'That did not go through, so nothing was written.' };
}

/** Run one write through the host port, with the event window and the description built here. */
export async function runCompose(port: ComposeDispatch, name: ComposeName, args: JsonObject, context: { words: string; clientRequestId: string; now: number; timeZone: string; ownerName?: string }): Promise<ComposeOutcome> {
  if (name === 'draft_email') {
    const input = args as unknown as DraftEmailArguments;
    return await port.draftEmail({ to: input.to, subject: input.subject, body: input.body, clientRequestId: context.clientRequestId });
  }
  if (name === 'draft_chat') {
    const input = args as unknown as DraftChatArguments;
    return await port.draftChat({ ...(input.person !== undefined ? { person: input.person } : {}), ...(input.channel !== undefined ? { channel: input.channel } : {}), ...(input.root_id !== undefined ? { rootId: input.root_id } : {}), message: input.message, clientRequestId: context.clientRequestId });
  }
  if (name === 'delete_event') {
    const input = args as unknown as DeleteEventArgs;
    if (input.event_id === undefined) return { state: 'failed', reason: 'event_not_named' };
    return await port.deleteEvent({ eventId: input.event_id, clientRequestId: context.clientRequestId });
  }
  const window = eventWindow(context.words, context.now, context.timeZone, context.ownerName);
  if (window.status !== 'ready') return { state: 'failed', reason: window.reason };
  const input = args as unknown as CreateEventArgs;
  const description = window.names.length > 0 ? `${input.summary}. Owner-only block; ${window.names.join(', ')} is named here and was not invited.` : `${input.summary}. Owner-only block; no invitations were sent.`;
  return await port.createEvent({ summary: input.summary, startUtc: window.startUtc, endUtc: window.endUtc, timeZone: window.timeZone, description, clientRequestId: context.clientRequestId });
}

/** The family each write needs, and the one line he must act on when it is not consented. */
export const COMPOSE_FAMILY: Readonly<Record<ComposeName, string>> = {
  draft_email: 'the gmail_draft family', draft_chat: 'the Mattermost drafts family',
  create_event: 'the calendar_write family', delete_event: 'the calendar_write family',
};
export const COMPOSE_CONSENT: Readonly<Record<ComposeName, string>> = {
  draft_email: googleConsentLine('gmail_draft'),
  draft_chat: 'auth needed: run mattermost_login once',
  create_event: googleConsentLine('calendar_write'),
  delete_event: googleConsentLine('calendar_write'),
};
/** The closed answer for a family this host cannot reach yet, with the one action to take. */
export const notAuthorizedFor = (name: ComposeName): ComposeOutcome => ({ state: 'not_authorized', family: COMPOSE_FAMILY[name], command: COMPOSE_CONSENT[name] });
