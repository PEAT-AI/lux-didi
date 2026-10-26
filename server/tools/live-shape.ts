/**
 * Rich, clean shaping for the text a tool result puts in front of the Live model (and Chat,
 * which reads the same `response.text` field). The full unshaped wire result is retained
 * separately in the MCP payload/entity store, so shaping here never destroys evidence.
 *
 * Two rules:
 *  - meaning over bytes: never cut mid-sentence, and keep the substance (bodies, every listed
 *    message's fields, excerpts, attendees);
 *  - an explicit omission note whenever a named limit cuts, so a trimmed result can never be
 *    mistaken for the whole thing.
 */

/**
 * W15: an attendee is named from the roster when the address or the display name binds to a person,
 * so the owner hears "Ravi Example" rather than a mail address; an unknown attendee keeps its own name.
 */
export function attendeeName(attendee: Record<string, unknown>): string {
  const email = typeof attendee['email'] === 'string' ? attendee['email'] : '';
  const display = typeof attendee['displayName'] === 'string' ? attendee['displayName'] : '';
  const snapshot = peopleSnapshot();
  const person = snapshot === null || email.length === 0 ? undefined : personByEmail(snapshot, email);
  return person?.name ?? (display || email);
}

/** Per-tool budgets for the text a tool result puts in front of the Live model. Each bound is
 * named so a reviewer can see the size policy: 3 knowledge hits with 400-character bodies, 8
 * Mattermost posts with 250-character bodies, 10 mail messages with 300-character excerpts (1500
 * for one requested message), and 8 calendar events of 300 characters, which holds time, title, the
 * open handle line and the eight attendee names a schedule answer needs. LIVE_RESULT_CHARS is the
 * hard ceiling on any single model-visible result, and LIVE_COMBINED_CHARS the larger ceiling for
 * a result that combines several sources. */
import { bodySourceLinks, gmailThreadUrl, mintOpenLine, openDestination, withOpenHandles } from './open-handles.js';
import { peopleSnapshot, personByEmail } from '../people/index.js';
export const GMAIL_BODY_CHARS = 1500;
export const GMAIL_LIST_MESSAGES = 10;
export const GMAIL_LIST_EXCERPT_CHARS = 300;
export const CALENDAR_EVENTS = 8;
export const CALENDAR_EVENT_CHARS = 300;
/** How many attendee names one event line carries; the rest are counted (#574). */
export const CALENDAR_ATTENDEE_NAMES = 8;

/** L8-01: the room the attendee names get of their own, so a long title or event handle never squeezes them out. */
export const CALENDAR_ATTENDEE_LINE_CHARS = 200;

/** #574 and L8-01: the true head count first, then as many whole names as the line holds, then the rest
 * counted. A helper that truncated its own list only supports a lower bound and an unnumbered tail. */
function attendeeNamesLine(names: readonly string[], upstreamOmitted: boolean): string {
  const people = (count: number): string => `${count} ${count === 1 ? 'person' : 'people'}`;
  const head = `  attendees: ${upstreamOmitted ? `at least ${people(names.length)}` : people(names.length)}`;
  const render = (count: number): string => {
    const rest = names.length - count;
    const tail = upstreamOmitted ? ' and others' : rest > 0 ? ` and ${rest} more` : '';
    return count === 0 ? head : `${head}: ${names.slice(0, count).join(', ')}${tail}`;
  };
  let count = Math.min(names.length, CALENDAR_ATTENDEE_NAMES);
  while (count > 0 && render(count).length > CALENDAR_ATTENDEE_LINE_CHARS) count -= 1;
  return render(count);
}
export const MATTERMOST_MESSAGE_CHARS = 250;
export const MATTERMOST_MESSAGES = 8;
/** How many ranked channels ever reach the connector-internal projection. A company archive can
 * hold thousands; the active few lead a bounded list. M1 de-advertised mattermost_list_channels,
 * so this projection is never a model-visible Live tool result and keeps its own count bound. */
export const MATTERMOST_CHANNELS = 40;
export const KNOWLEDGE_EXCERPT_CHARS = 400;
export const KNOWLEDGE_HITS = 3;
/** A get_insight fetch is the explicit "read the whole entry" path, so it keeps the generous final
 * bound (W7-R4: >= 20000) instead of the 2000-character single-result ceiling. */
export const KNOWLEDGE_BODY_CHARS = 20000;
/** A ranked Markdown search reply shows every hit: the leading body whole, one sentence-cut excerpt each
 * behind it, under one total bound. MED-1022: the leading bound is the search's own body window, so the
 * common one-note answer needs no get_insight hop; the total holds that body plus five excerpts. */
export const KNOWLEDGE_RANKED_TOP_CHARS = 3000;
export const KNOWLEDGE_RANKED_EXCERPT_CHARS = 600;
export const KNOWLEDGE_RANKED_TOTAL_CHARS = 6400;
/** Hard ceiling on the shaped text of any single model-visible Live tool result, and the larger
 * ceiling for a result that combines several sources (for example a brief). */
export const LIVE_RESULT_CHARS = 2000;
export const LIVE_COMBINED_CHARS = 3000;

export interface ShapedSource { title: string; url?: string; sourceType?: string }
export interface CalendarEvent { id: string; start: string; line: string; bodyTruncated: boolean }
export interface CalendarPage { upstreamIncomplete?: boolean; events: CalendarEvent[]; received: number; localOmitted: number; unread: number; nextPageToken?: string }
export interface CalendarScope { received: number; partial: boolean }
export interface MailMessage { id: string; threadId: string; internalDate: string; line: string; bodyTruncated: boolean; /** E5 (#612): bulk mail, so a triage read can rank it after a person. */ bulk?: boolean; /** E5 (#612): the owner's own message, so its thread needs no cold read. */ sent?: boolean }
export interface MailPage { messages: MailMessage[]; received: number; invalid: number; localOmitted: number; nextPageToken?: string; upstreamIncomplete?: boolean; /** C-LIVE: the source's own total for the query, when it reports one (Gmail resultSizeEstimate). */ total?: number }
/** #6: the ranker's own retrieval metadata, read before the preamble is stripped and carried for research. */
export interface KnowledgeConfidence { confidence: string; top?: string; candidates?: string }
export interface ShapedResult {
  knowledgeConfidence?: KnowledgeConfidence;
  mailPage?: MailPage;
  calendarPage?: CalendarPage;
  calendarScope?: CalendarScope;
  text: string;
  partial: boolean;
  originalCharacters: number;
  omittedCharacters: number;
  /** Named link sources emitted out of band, never as raw urls inside `text`. */
  sources?: ShapedSource[];
  /** Mattermost only: which upstream shape was recognised, for metadata logging. */
  shape?: MattermostShape;
  /** Mattermost only: how many posts or channels the shape carried. */
  itemCount?: number;
}

/** The shaped form of an unbounded string: `partial` is true only when the tail was dropped. */
export function shaped(text: string): ShapedResult {
  return { text, partial: false, originalCharacters: text.length, omittedCharacters: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function scalar(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}
function field(source: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) { const value = str(source[name]); if (value) return value; }
  return '';
}
/** The Gmail helper returns `headers` as a name/value map for one message read and as an
 * array of `{ name, value }` for a list entry (the metadata GET shape). Accept both, so a
 * listed message keeps the sender and date the connector carried. */
function header(source: Record<string, unknown>, name: string): string {
  const headers = source['headers'];
  if (isRecord(headers)) return decodeEntities(str(headers[name]));
  if (Array.isArray(headers)) {
    const match = headers.find(entry => isRecord(entry) && str(entry['name']).toLowerCase() === name.toLowerCase());
    return match ? decodeEntities(str((match as Record<string, unknown>)['value'])) : '';
  }
  return '';
}
/** A run of text cut at the last sentence boundary before `limit`, so it never stops mid-sentence. */
export function cutAtSentence(text: string, limit: number): { text: string; omitted: number } {
  if (text.length <= limit) return { text, omitted: 0 };
  const head = text.slice(0, limit);
  let boundary = -1;
  for (const marker of ['\n', '.', '!', '?']) boundary = Math.max(boundary, head.lastIndexOf(marker));
  let cut: string;
  if (boundary > 0) cut = head.slice(0, boundary + 1);
  else {
    // No sentence end: fall back to the last whole word, never a raw character index.
    let space = -1;
    for (let index = head.length - 1; index >= 0; index--) { if (/\s/u.test(head[index]!)) { space = index; break; } }
    cut = space > 0 ? head.slice(0, space) : head;
  }
  return { text: cut.trimEnd(), omitted: text.length - cut.length };
}
/** Join list items under a count ceiling. `followUp` names a real argument the model can pass to
 * get more, or is empty when the tool has no way to fetch another slice (report as final). */
function listed(items: string[], limit: number, label: string, followUp?: string): { text: string; omitted: number } {
  const shown = items.slice(0, limit);
  const omitted = items.length - shown.length;
  const suffix = omitted > 0 ? `\n\n[omitted: ${omitted} more ${label}; ${followUp ?? 'final, this tool has no paging argument'}]` : '';
  return { text: shown.join('\n') + suffix, omitted };
}
/** The model-only bracket annotations a shaped result appends: the omission/paging note
 * (`[omitted: ...]`), the retired calendar character cut (`[+N chars]`, still stripped from stored evidence), and the `[id ...]` handle the model
 * needs to re-read one message, event or insight. The owner-facing evidence copy strips them; the
 * model's own copy keeps them. */
export const MODEL_ONLY_NOTE = /[ \t]*\n*\[(?:omitted: [^\]\n]*|\+\d+ chars|id [^\]\s]*)\]/g;
/** Uses the exported matcher alone, so the owner path and any caller can never diverge on the shape. */
export function stripModelOnlyNotes(text: string): string {
  return text.replace(MODEL_ONLY_NOTE, '');
}
/** The hard per-result ceiling on model-visible text. A result already under `budget` is untouched;
 * otherwise it is cut at a sentence boundary and an omission note names the dropped characters and
 * how to ask for the rest, so the whole text (note included) stays within `budget`. */
export function capped(result: ShapedResult, budget: number = LIVE_RESULT_CHARS): ShapedResult {
  if (result.text.length <= budget) return withOpenHandles(result);
  const note = (omitted: number): string => `\n\n[omitted: ${omitted} characters to keep this result under ${budget}; ask a narrower question or for fewer items for the rest]`;
  const first = cutAtSentence(result.text, budget);
  const recut = cutAtSentence(result.text, Math.max(0, budget - note(first.omitted).length));
  const text = `${recut.text}${note(recut.omitted)}`.slice(0, budget);
  return withOpenHandles({ ...result, text, partial: true, omittedCharacters: result.omittedCharacters + recut.omitted });
}
/** Drop dial-in boilerplate that a calendar invite appends to its description: phone numbers, PIN
 * codes and "more phone numbers" links are noise no spoken answer needs. */
const DIAL_IN = /[^.\n]*(?:dial[- ]?in|join by phone|more phone numbers|pin:\s*\d+)[^.\n]*\.?/gi;
export function stripDialIn(text: string): string {
  return text.replace(DIAL_IN, '').replace(/\s{2,}/g, ' ').trim();
}

// --- noise removal -------------------------------------------------------------------------

const MIME_LINE = /^(content-type|content-transfer-encoding|mime-version|content-disposition|content-id|x-attachment-id|boundary)\s*:/i;
const QUOTE_MARKERS = [
  /^>+/m,
  /^on .+ wrote:$/im,
  /^-{2,}\s*original message\s*-{2,}$/im,
  /^_{10,}$/m,
  /^from:\s.+\r?\n(?:sent|to|subject):/im,
];
const SIGNATURE_MARKERS = [/^--\s*$/m, /^sent from my /im, /^get outlook for /im];
const TRACKING_QUERY = /[?&](?:utm_|fbclid|gclid|mc_eid|mc_cid|_hsenc|_hsmi|mkt_tok)=/i;
const DATA_IMAGE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const CID_REF = /\[cid:[^\]]+\]|src=["']cid:[^"']+["']/gi;

/** Decode the HTML entities a mail snippet or header carries into plain text, once, at the
 * boundary where the connector result becomes model text. The UI never unescapes: it keeps
 * rendering this text as text. */
function decodeEntities(text: string): string {
  return text.replace(/&(nbsp|amp|lt|gt|quot|apos|#x[0-9a-f]+|#[0-9]+);/gi, match => {
    const body = match.slice(1, -1).toLowerCase();
    switch (body) {
      case 'nbsp': return ' ';
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': case '#39': case '#x27': return "'";
      default: break;
    }
    const code = body.startsWith('#x') ? Number.parseInt(body.slice(2), 16) : body.startsWith('#') ? Number.parseInt(body.slice(1), 10) : Number.NaN;
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}
/** Convert an HTML mail body to plain text: drop script/style, break on block tags, strip the rest. */
export function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
/** Strip every quoted reply chain below the first marker (keeps the new message only). */
export function stripQuotedReply(text: string): string {
  let cut = -1;
  for (const pattern of QUOTE_MARKERS) {
    const match = pattern.exec(text);
    if (match && (cut === -1 || match.index < cut)) cut = match.index;
  }
  return cut >= 0 ? text.slice(0, cut).trimEnd() : text;
}
/** Drop a trailing signature block. */
export function stripSignature(text: string): string {
  let cut = -1;
  for (const pattern of SIGNATURE_MARKERS) {
    const match = pattern.exec(text);
    if (match && (cut === -1 || match.index < cut)) cut = match.index;
  }
  return cut >= 0 ? text.slice(0, cut).trimEnd() : text;
}
/** Remove tracking-only URLs, leaving meaningful links and source links intact. */
export function stripTrackingUrls(text: string): string {
  return text.split('\n').map(line => {
    const urls = line.match(/https?:\/\/[^\s)]+/g) ?? [];
    if (!urls.length || !urls.every(url => TRACKING_QUERY.test(url))) return line;
    let cleaned = line;
    for (const url of urls) cleaned = cleaned.split(url).join(''.padEnd(0));
    return cleaned.replace(/[<(]\s*[)>]/g, '').replace(/\s{2,}/g, ' ').trimEnd();
  }).join('\n');
}
/** Full mail-body cleaning pipeline: MIME boilerplate, inline data, HTML, quotes, signature, trackers. */
export function cleanMailBody(raw: string): string {
  let body = raw;
  body = body.split('\n').filter(line => !MIME_LINE.test(line.trim())).join('\n');
  body = body.replace(DATA_IMAGE, '').replace(CID_REF, '');
  if (/<\w+[\s>]/.test(body)) body = htmlToText(body);
  else body = decodeEntities(body);
  body = stripQuotedReply(body);
  body = stripSignature(body);
  body = stripTrackingUrls(body);
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

// --- Gmail ---------------------------------------------------------------------------------

const AUTHORS = /^\s*"?([^"<]*?)"?\s*</;
/** E5 (#612): what a triage read ranks by, read here because this is where the headers and labels are. */
function mailReplyNeed(entry: Record<string, unknown>, from: string): { bulk?: boolean; sent?: boolean } {
  const listed = header(entry, 'List-Unsubscribe') !== '' || header(entry, 'List-Id') !== '';
  // The sender's address, not the display name, is what says a machine wrote it.
  const bulk = listed || /no-?reply|do-?not-?reply|notifications?@/iu.test(from);
  return { ...(bulk ? { bulk: true } : {}), ...(labels(entry).includes('SENT') ? { sent: true } : {}) };
}

function senderName(source: Record<string, unknown>): string {
  const from = header(source, 'From');
  return (AUTHORS.exec(from)?.[1] ?? from).trim();
}
/** C-OPEN 4: the thread in all mail under the proven account; a message with no thread id opens by its own id. */
function threadUrl(entry: Record<string, unknown>): string | undefined {
  const thread = str(entry['threadId']) || str(entry['id']);
  return thread.length > 0 ? gmailThreadUrl(thread) : undefined;
}
function labels(source: Record<string, unknown>): string[] {
  return Array.isArray(source['labelIds']) ? source['labelIds'].filter((value): value is string => typeof value === 'string') : [];
}
function attachmentNames(source: Record<string, unknown>): string[] {
  const list = Array.isArray(source['attachments']) ? source['attachments'] : [];
  return list.map(entry => isRecord(entry) ? str(entry['filename'] ?? entry['name']) : str(entry)).filter(Boolean);
}

function mailHeaders(data: Record<string, unknown>): string[] {
  const subject = header(data, 'Subject') || '(no subject)';
  const head = [`subject: ${subject}`];
  const from = senderName(data); if (from) head.push(`from: ${from}`);
  const to = header(data, 'To'); if (to) head.push(`to: ${to}`);
  const date = header(data, 'Date'); if (date) head.push(`date: ${date}`);
  const cc = header(data, 'Cc'); if (cc) head.push(`cc: ${cc}`);
  const tags = labels(data); if (tags.length) head.push(`labels: ${tags.join(', ')}`);
  const files = attachmentNames(data); if (files.length) head.push(`attachments: ${files.join(', ')}`);
  return head;
}

/** Full received text for host retention; display cleaning must not destroy reply chains. */
export function receivedGmailBody(data: Record<string, unknown>): string | undefined {
  if (data['format'] === 'metadata' || typeof data['body'] !== 'string') return undefined;
  return `${mailHeaders(data).join('\n')}\n\n${data['body'].replace(/\r\n?/gu, '\n')}`;
}

export function shapeGmailRead(data: Record<string, unknown>): ShapedResult {
  const head = mailHeaders(data);
  const metadata = data['format'] === 'metadata';
  const received = metadata ? '' : str(data['body']).replace(/\r\n?/gu, '\n');
  const body = cleanMailBody(received);
  const cut = cutAtSentence(body, GMAIL_BODY_CHARS);
  const coverage = isRecord(data['bodyCoverage']) ? data['bodyCoverage'] : {};
  const unavailable = !metadata && typeof data['body'] !== 'string';
  const sourceNote = metadata ? '[Metadata-only view requested; body was not acquired.]' : unavailable ? '[Body unavailable in source response; no body bytes acquired.]' : coverage['complete'] === false ? '[Source reports incomplete inline body coverage.]' : coverage['complete'] !== true ? '[Source inline body completeness is unverified.]' : '';
  const omitted = Math.max(0, received.length - body.length) + cut.omitted;
  const note = omitted > 0 ? `\n\n[omitted: ${omitted} received characters of body omitted from this display]` : '';
  // C-OPEN 2: the message itself opens; a link inside its body is someone else's text and never does.
  const url = threadUrl(data);
  const subject = header(data, 'Subject');
  const sources = url ? [{ title: subject ? `Gmail: ${subject}` : 'Open in Gmail', url, sourceType: 'gmail' }] : [];
  return capped({ text: `${head.join('\n')}\n\n${cut.text}${note}${sourceNote ? `\n${sourceNote}` : ''}`, partial: omitted > 0 || unavailable || coverage['complete'] === false, originalCharacters: received.length + head.join('\n').length, omittedCharacters: omitted, sources });
}

export function shapeGmailList(data: Record<string, unknown>): ShapedResult {
  const messages = Array.isArray(data['messages']) ? data['messages'] : [];
  const sources: ShapedSource[] = [];
  const normalized: MailMessage[] = [];
  const lines = messages.filter(isRecord).map(entry => {
    const unread = labels(entry).includes('UNREAD') ? ' [unread]' : '';
    const snippet = decodeEntities(str(entry['snippet']));
    const excerpt = snippet ? cutAtSentence(snippet, GMAIL_LIST_EXCERPT_CHARS).text : '';
    const threadValue = entry['threadSize'] ?? entry['messageCount'];
    const size = typeof threadValue === 'number' && threadValue > 0 ? ` (thread ${threadValue})` : '';
    const named = header(entry, 'Subject');
    const url = threadUrl(entry);
    if (url) sources.push({ title: named ? `Gmail: ${named}` : 'Open in Gmail', url, sourceType: 'gmail' });
    // Open2: the handle line rides its own item, so a reply rebuilt from `- ` lines keeps it there.
    const openLine = url ? mintOpenLine({ title: named ? `Gmail: ${named}` : 'Open in Gmail', url, sourceType: 'gmail' }) : undefined;
    const idValue = str(entry['id']);
    // A field the source truly lacks is omitted, never filled with the word "unknown".
    const segments: string[] = [named || '(no subject)'];
    const sender = senderName(entry);
    if (sender) segments.push(`from: ${sender}`);
    const date = header(entry, 'Date');
    if (date) segments.push(`date: ${date}${unread}${size}`);
    else if (`${unread}${size}`.trim()) segments.push(`${unread}${size}`.trim());
    if (excerpt) segments.push(excerpt);
    const full = `- ${segments.join(' | ')}${idValue ? ` [id ${idValue}]` : ''}`;
    const cut = cutAtSentence(full, 600);
    const line = openLine ? `${cut.text}\n${openLine}` : cut.text;
    if (idValue) normalized.push({ id: idValue, threadId: str(entry['threadId']), internalDate: scalar(entry['internalDate']), line, bodyTruncated: cut.omitted > 0 || snippet.length > excerpt.length, ...mailReplyNeed(entry, header(entry, 'From')) });
    return line;
  });
  const body = listed(lines, GMAIL_LIST_MESSAGES, 'messages');
  const upstream = Boolean(data['nextPageToken']) || data['sourceIncomplete'] === true;
  const note = data['nextPageToken'] ? '\n[upstream continuation available]' : data['sourceIncomplete'] === true ? '\n[upstream coverage incomplete; no continuation token received]' : '';
  const nextPageToken = str(data['nextPageToken']);
  const invalid = messages.length - normalized.length;
  return { ...capped({ text: `${body.text}${note}`, partial: body.omitted > 0 || upstream || invalid > 0 || normalized.some(message => message.bodyTruncated), originalCharacters: lines.join('\n').length, omittedCharacters: lines.slice(GMAIL_LIST_MESSAGES).join('\n').length, sources }),
    mailPage: { messages: normalized, received: messages.length, invalid, localOmitted: Math.max(0, normalized.length - GMAIL_LIST_MESSAGES), ...(nextPageToken ? { nextPageToken } : {}), ...(data['sourceIncomplete'] === true && !nextPageToken ? { upstreamIncomplete: true } : {}), ...(Number.isSafeInteger(data['resultSizeEstimate']) && Number(data['resultSizeEstimate']) >= 0 ? { total: Number(data['resultSizeEstimate']) } : {}) } };
}

// --- Drive ---------------------------------------------------------------------------------

/** C-OPEN 3: what a listing of several plausible files says instead of opening one of them. */
export const DRIVE_CHOOSE_GUIDANCE = 'Several Drive files match and none is open. Read him two or three names with their modified dates and ask which one he means; then look up his pick with a drive lookup of id: and its id. Never read an id aloud.';
/** How many Drive files one listing shows; the helper returns at most ten, newest first. */
export const DRIVE_FILES_SHOWN = 5;
const DRIVE_KINDS: Readonly<Record<string, string>> = {
  'application/vnd.google-apps.presentation': 'Slides deck',
  'application/vnd.google-apps.document': 'Google Doc',
  'application/vnd.google-apps.spreadsheet': 'Google Sheet',
  'application/vnd.google-apps.folder': 'folder',
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint deck',
  'application/vnd.ms-powerpoint': 'PowerPoint deck',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
  'application/msword': 'Word document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel sheet',
  'application/vnd.ms-excel': 'Excel sheet',
};

/** One file as a line the model may speak from, and the viewer link the host may mint from. Only webViewLink is read. */
function driveItem(file: Record<string, unknown>): { name: string; line: string; viewer?: string } {
  const name = str(file['name']).replace(/https?:\/\/\S+/giu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || '(untitled)';
  const kind = DRIVE_KINDS[str(file['mimeType'])] ?? 'file';
  const modified = /^\d{4}-\d{2}-\d{2}/.exec(str(file['modifiedTime']))?.[0];
  const owners = Array.isArray(file['owners']) ? file['owners'].filter(isRecord) : [];
  const owner = owners.length > 0 ? str(owners[0]!['displayName']).slice(0, 80) : '';
  const id = /^[A-Za-z0-9_-]{1,256}$/.test(str(file['id'])) ? str(file['id']) : '';
  const destination = typeof file['webViewLink'] === 'string' ? openDestination(file['webViewLink']) : undefined;
  const viewer = destination !== undefined && (destination.kind === 'docs' || destination.kind === 'drive') ? destination.url : undefined;
  const segments = [name, kind, ...(modified ? [`modified ${modified}`] : []), ...(owner ? [`owner ${owner}`] : []), ...(viewer ? [] : ['no viewer link'])];
  return { name, line: `- ${segments.join(' | ')}${id ? ` [id ${id}]` : ''}`, ...(viewer ? { viewer } : {}) };
}

/** One clear file: its line and, when its viewer link passes the policy, its handle line. */
function driveOpenable(item: { name: string; line: string; viewer?: string }): { text: string; sources: ShapedSource[] } {
  if (item.viewer === undefined) return { text: item.line, sources: [] };
  const source = { title: `Drive: ${item.name}`, url: item.viewer, sourceType: 'drive' };
  const open = mintOpenLine(source);
  return { text: open === undefined ? item.line : `${item.line}\n${open}`, sources: [source] };
}

/**
 * C-OPEN 2 and 3: a name search. One match mints its handle from webViewLink; several plausible matches mint
 * nothing and ask, so a fresh drive_get_file of his pick is what opens; none says so.
 */
export function shapeDriveSearch(data: Record<string, unknown>): ShapedResult {
  const files = Array.isArray(data['files']) ? data['files'].filter(isRecord) : [];
  if (files.length === 0) return capped({ text: 'No Drive file matched that name. Nothing is open.', partial: data['sourceIncomplete'] === true, originalCharacters: 0, omittedCharacters: 0 });
  const items = files.slice(0, DRIVE_FILES_SHOWN).map(driveItem);
  const more = data['sourceIncomplete'] === true || files.length > items.length;
  const tail = more ? `\nThese are the newest ${items.length} of more; a narrower name finds the rest.` : '';
  if (items.length === 1) {
    const one = driveOpenable(items[0]!);
    return capped({ text: `${one.text}${tail}`, partial: more, originalCharacters: one.text.length, omittedCharacters: 0, sources: one.sources });
  }
  const text = `${DRIVE_CHOOSE_GUIDANCE}\n${items.map(item => item.line).join('\n')}${tail}`;
  return capped({ text, partial: more, originalCharacters: text.length, omittedCharacters: 0 });
}

/** C-OPEN 3: the fresh read of the file he picked; only this result mints the handle that opens it. */
export function shapeDriveFile(data: Record<string, unknown>): ShapedResult {
  if (str(data['id']) === '' && str(data['name']) === '') return capped({ text: 'That Drive file was not found. Nothing is open.', partial: false, originalCharacters: 0, omittedCharacters: 0 });
  const item = driveItem(data);
  if (data['trashed'] === true) return capped({ text: `${item.line} | in the trash, not opened`, partial: false, originalCharacters: item.line.length, omittedCharacters: 0 });
  const one = driveOpenable(item);
  return capped({ text: one.text, partial: false, originalCharacters: one.text.length, omittedCharacters: 0, sources: one.sources });
}

// --- Calendar ------------------------------------------------------------------------------

export function shapeGcalCalendars(data: Record<string, unknown>): ShapedResult {
  const calendars = Array.isArray(data['calendars']) ? data['calendars'] : [];
  // The id stays in the shaped line so the host can read events from every calendar the owner keeps.
  const lines = calendars.filter(isRecord).map(entry => {
    const name = field(entry, 'summary', 'name') || 'calendar';
    const id = str(entry['id']);
    return id ? `- ${name} [${id}]` : `- ${name}`;
  });
  return { ...capped(shaped(lines.join('\n'))), calendarScope: { received: lines.length, partial: Boolean(data['nextPageToken'] || data['partial'] || data['sourceIncomplete']) } };
}

export function shapeGcalList(data: Record<string, unknown>): ShapedResult {
  const events = Array.isArray(data['events']) ? data['events'] : [];
  const sources: ShapedSource[] = [];
  const normalized: CalendarEvent[] = [];
  const blocks = events.filter(isRecord).map(entry => {
    const start = isRecord(entry['start']) ? field(entry['start'], 'dateTime', 'date') : str(entry['start']);
    const named = field(entry, 'summary', 'title');
    const title = named || '(no title)';
    const location = field(entry, 'location');
    const eventId = str(entry['id']);
    // A merged fan-out tags the event with its calendar name; a single-calendar read does not.
    const calendar = field(entry, 'calendar');
    const header = `- ${start}, ${title}${location ? `, ${location}` : ''}${calendar ? ` | ${calendar}` : ''}${eventId ? ` [id ${eventId}]` : ''}`;
    // A header longer than the whole per-event bound is no title but a wall of text: it alone is cut.
    const headerCut = header.length <= CALENDAR_EVENT_CHARS ? undefined : cutAtSentence(header, CALENDAR_EVENT_CHARS);
    const lines = [headerCut === undefined ? header : `${headerCut.text} [omitted: the rest of this line]`];
    const link = field(entry, 'htmlLink');
    if (link) sources.push({ title: named ? `Calendar: ${named}` : 'Open in Google Calendar', url: link, sourceType: 'calendar' });
    const openLine = link ? mintOpenLine({ title: named ? `Calendar: ${named}` : 'Open in Google Calendar', url: link, sourceType: 'calendar' }) : undefined;
    if (openLine) lines.push(openLine);
    const attendees = Array.isArray(entry['attendees']) ? entry['attendees'] : [];
    const names = attendees.filter(isRecord).map(a => attendeeName(a)).filter(Boolean);
    // L8-01: the people lines are whole, never the part a cut removes, and carry no character count.
    if (names.length) lines.push(attendeeNamesLine(names, entry['attendeesOmitted'] === true));
    const organizer = isRecord(entry['organizer']) ? field(entry['organizer'], 'displayName', 'email') : '';
    if (organizer) lines.push(`  organizer: ${organizer}`);
    const conference = field(entry, 'hangoutLink') || (isRecord(entry['conferenceData']) ? 'yes' : '');
    if (conference) lines.push('  conference: yes');
    // Only the description is cut against what is left of the per-event bound.
    const description = stripDialIn(cleanMailBody(field(entry, 'description'))).replace(/\n+/g, ' ');
    let cutDescription = headerCut !== undefined;
    if (description) {
      const room = CALENDAR_EVENT_CHARS - lines.join('\n').length - 3;
      if (description.length <= room) lines.push(`  ${description}`);
      else {
        cutDescription = true;
        const note = ' [omitted: the rest of the description]';
        const cut = cutAtSentence(description, Math.max(0, room - note.length));
        if (cut.text) lines.push(`  ${cut.text}${note}`);
        else lines[lines.length - 1] = `${lines[lines.length - 1]!} [omitted: the description]`;
      }
    }
    const line = lines.join('\n');
    normalized.push({ id: eventId, start, line, bodyTruncated: cutDescription });
    return line;
  });
  const unread = isRecord(data['partial']) && typeof data['partial']['unread'] === 'number' && data['partial']['unread'] > 0 ? data['partial']['unread'] : 0;
  const body = listed(blocks, CALENDAR_EVENTS, 'events');
  const text = unread > 0 ? `${body.text}\n[calendar read incomplete: ${unread} calendar${unread === 1 ? '' : 's'} not read]` : body.text;
  const nextPageToken = str(data['nextPageToken']);
  return { ...capped({ text, partial: body.omitted > 0 || unread > 0 || Boolean(nextPageToken) || data['sourceIncomplete'] === true || normalized.some(event => event.bodyTruncated), originalCharacters: blocks.join('\n').length, omittedCharacters: blocks.slice(CALENDAR_EVENTS).join('\n').length, sources }),
    calendarPage: { ...(data['sourceIncomplete'] === true && !nextPageToken ? { upstreamIncomplete: true } : {}), events: normalized, received: normalized.length, localOmitted: Math.max(0, normalized.length - CALENDAR_EVENTS), unread, ...(nextPageToken ? { nextPageToken } : {}) } };
}

// --- Mattermost ----------------------------------------------------------------------------

const SYSTEM_TEXT = /(joined the channel|left the channel|added to the channel|removed from the channel|has joined|has left)/i;
function reactionCount(post: Record<string, unknown>): number {
  const direct = post['reactions'];
  if (Array.isArray(direct)) return direct.length;
  if (isRecord(direct)) return Object.values(direct).reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
  const metadata = isRecord(post['metadata']) ? post['metadata'] : {};
  const reactions = metadata['reactions'];
  return Array.isArray(reactions) ? reactions.length : 0;
}
function threadPosition(post: Record<string, unknown>): string {
  const replies = post['reply_count'] ?? post['replyCount'] ?? post['threadSize'];
  return typeof replies === 'number' && replies > 0 ? ` (${replies} replies)` : '';
}
function isSystemPost(post: Record<string, unknown>): boolean {
  if (field(post, 'type').startsWith('system_')) return true;
  return SYSTEM_TEXT.test(field(post, 'text', 'message'));
}
function renderPost(post: Record<string, unknown>): { lines: string[]; omitted: number; source?: ShapedSource } {
  const channel = field(post, 'channel', 'channel_name', 'channel_id');
  const author = field(post, 'author', 'author_name', 'user_name', 'username');
  const time = field(post, 'time', 'timestamp') || scalar(post['create_at']);
  const postId = str(post['id'] ?? post['post_id']);
  const header2 = [channel, author, time].filter(Boolean).join(' | ') + (postId ? ` [post ${postId}]` : '');
  // C-CHAT (L4-10): a webhook post's words live in its attachment text, rendered after the message.
  const message = str(post['text'] ?? post['message']);
  const attachment = str(post['attachmentText']).trim();
  const raw = attachment === '' ? message : message.trim() === '' ? attachment : `${message}\n${attachment}`;
  const cut = cutAtSentence(raw, MATTERMOST_MESSAGE_CHARS);
  const reactions = reactionCount(post);
  const meta = `${reactions > 0 ? ` (${reactions} reactions)` : ''}${threadPosition(post)}`;
  const permalink = field(post, 'permalink', 'url');
  const label = channel ? `Mattermost: #${channel}` : author ? `Mattermost: @${author}` : 'Open in Mattermost';
  return {
    lines: [`**${header2 || 'message'}${meta}**`, cut.text, ...(cut.omitted > 0 ? [`[omitted: ${cut.omitted} characters; final, a single post has no partial re-read]`] : [])],
    omitted: cut.omitted,
    ...(permalink ? { source: { title: label, url: permalink, sourceType: 'mattermost' } } : {}),
  };
}

function channelPosts(channel: Record<string, unknown>): number | undefined {
  const value = channel['posts'] ?? channel['postCount'];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function channelLastActivity(channel: Record<string, unknown>): string {
  return field(channel, 'lastSyncAt', 'lastActivityAt', 'last_post_at');
}
/** Most posts first, then most recent activity, then name: the active few lead a bounded list. */
function channelRank(a: unknown, b: unknown): number {
  const left: Record<string, unknown> = isRecord(a) ? a : {};
  const right: Record<string, unknown> = isRecord(b) ? b : {};
  const posts = (channelPosts(right) ?? -1) - (channelPosts(left) ?? -1);
  if (posts !== 0) return posts;
  const leftAt = channelLastActivity(left);
  const rightAt = channelLastActivity(right);
  if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
  const leftName = field(left, 'displayName', 'display_name', 'name');
  const rightName = field(right, 'displayName', 'display_name', 'name');
  return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
}
/** Name plus post count plus last activity, so the few channels shown are the useful ones. */
function channelLine(entry: unknown): string {
  if (!isRecord(entry)) return String(entry);
  const name = field(entry, 'displayName', 'display_name', 'name') || str(entry['id']);
  const posts = channelPosts(entry);
  const last = channelLastActivity(entry);
  const facts = [posts === undefined ? '' : `${posts} posts`, last ? `${field(entry, 'lastSyncAt') ? 'archive synced' : 'last activity'} ${last}` : ''].filter(Boolean);
  return facts.length > 0 ? `${name} | ${facts.join(' | ')}` : name;
}
/** Epoch milliseconds for a post, whether it carries an ISO stamp or a raw create_at. */
function postTime(post: Record<string, unknown>): number {
  const stamp = field(post, 'timestamp', 'time') || scalar(post['create_at']);
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? Number(stamp) || 0 : parsed;
}

/** The Mattermost output shapes the shaper recognises; `unrecognised` fails loud, never ''. */
export type MattermostShape =
  | 'whoami' | 'channels' | 'posts_array' | 'posts_map' | 'items' | 'results' | 'thread' | 'empty' | 'text' | 'unrecognised';

/** A completed projection that shaped to nothing becomes an explicit note, never an empty string.
 *  VOICE-R2: the note names the source and the query so an empty read is never voiced as a canned
 *  "no results", and it tells the model to mention it only when the owner asked about that source. */
export function noEmptyResult(text: string, source?: string, query?: string): string {
  if (text.trim() !== '') return text;
  const asked = query !== undefined && query.trim() !== '' ? ` for "${query.trim()}"` : '';
  const named = source === undefined ? 'The source lookup' : `The ${source} lookup`;
  return `${named}${asked} came back empty. Say so in your own words only if the owner asked about that source; never announce an empty result unasked.`;
}

function emptyMattermostNote(tool: string): string {
  if (tool === 'mattermost_search') return 'No messages matched.';
  if (tool === 'mattermost_get_channel_history') return 'No messages in this channel for that window.';
  if (tool === 'mattermost_get_thread') return 'No messages in this thread.';
  if (tool === 'mattermost_list_channels') return 'No channels.';
  return 'No messages.';
}
function mattermostNote(tool: string): ShapedResult {
  return { text: emptyMattermostNote(tool), partial: false, originalCharacters: 0, omittedCharacters: 0, shape: 'empty', itemCount: 0 };
}
function mattermostProjection(text: string, shape: MattermostShape, itemCount: number): ShapedResult {
  return { text, partial: false, originalCharacters: text.length, omittedCharacters: 0, shape, itemCount };
}
function rawOf(data: unknown): string {
  if (typeof data === 'string') return data;
  try { return JSON.stringify(data) ?? ''; } catch { return String(data); }
}
/** An id map of posts, ordered by the `order` id list when present, else by create_at. */
function postsFromMap(map: Record<string, unknown>, order: unknown): Record<string, unknown>[] {
  if (Array.isArray(order)) {
    const ordered = order.map(id => (typeof id === 'string' ? map[id] : undefined)).filter(isRecord);
    if (ordered.length > 0) return ordered;
  }
  return Object.values(map).filter(isRecord).sort((a, b) => Number(scalar(a['create_at'])) - Number(scalar(b['create_at'])));
}
/** A shape no branch recognises fails loud: the raw text trimmed by the existing W7 budget. */
function unrecognisedMattermost(raw: string): ShapedResult {
  const cut = cutAtSentence(raw, MATTERMOST_MESSAGE_CHARS);
  const text = `[unrecognised Mattermost shape; raw result follows]\n${cut.text}`;
  return { text, partial: cut.omitted > 0, originalCharacters: raw.length, omittedCharacters: cut.omitted, shape: 'unrecognised', itemCount: 0 };
}
/** Extract the post list from any shape the connector may pass through. */
function postsOf(data: unknown): { posts: Record<string, unknown>[]; shape: MattermostShape } | undefined {
  if (Array.isArray(data)) return { posts: data.filter(isRecord), shape: 'items' };
  if (!isRecord(data)) return undefined;
  if (Array.isArray(data['posts'])) return { posts: data['posts'].filter(isRecord), shape: 'posts_array' };
  if (isRecord(data['posts'])) return { posts: postsFromMap(data['posts'], data['order']), shape: 'posts_map' };
  if (Array.isArray(data['items'])) return { posts: data['items'].filter(isRecord), shape: 'items' };
  if (isRecord(data['items'])) return { posts: Object.values(data['items']).filter(isRecord), shape: 'items' };
  if (Array.isArray(data['results'])) return { posts: data['results'].filter(isRecord), shape: 'results' };
  if (isRecord(data['results'])) return { posts: Object.values(data['results']).filter(isRecord), shape: 'results' };
  if (isRecord(data['root']) || Array.isArray(data['replies'])) return { posts: [...(isRecord(data['root']) ? [data['root']] : []), ...(Array.isArray(data['replies']) ? data['replies'].filter(isRecord) : [])], shape: 'thread' };
  return undefined;
}

export function shapeMattermost(tool: string, data: unknown): ShapedResult {
  const raw = rawOf(data);
  if (typeof data === 'string') return data.trim() === '' ? mattermostNote(tool) : shaped(data);
  if (tool === 'mattermost_whoami') {
    if (!isRecord(data)) return raw.trim() === '' ? mattermostNote(tool) : unrecognisedMattermost(raw);
    const name = field(data, 'username', 'user_name');
    const display = field(data, 'display_name', 'displayName');
    return capped(mattermostProjection([name, display].filter(Boolean).join(' | ') || 'authenticated', 'whoami', 1));
  }
  if (tool === 'mattermost_list_channels') {
    const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data['channels']) ? data['channels'] : undefined;
    if (!list) return raw.trim() === '' ? mattermostNote(tool) : unrecognisedMattermost(raw);
    if (list.length === 0) return mattermostNote(tool);
    const lines = [...list].sort(channelRank).map(entry => `- ${channelLine(entry)}`);
    const body = listed(lines, MATTERMOST_CHANNELS, 'channels');
    return mattermostProjection(body.text, 'channels', list.length);
  }
  const extracted = postsOf(data);
  if (!extracted) return raw.trim() === '' ? mattermostNote(tool) : unrecognisedMattermost(raw);
  const visible = extracted.posts.filter(post => !isSystemPost(post));
  if (visible.length === 0) return mattermostNote(tool);
  const newestFirst = tool === 'mattermost_search' || tool === 'mattermost_get_channel_history';
  const ordered = newestFirst ? [...visible].sort((a, b) => postTime(b) - postTime(a)) : visible;
  const rendered = ordered.map(renderPost);
  const body = listed(rendered.map(entry => entry.lines.join('\n')), MATTERMOST_MESSAGES, 'messages');
  const omitted = body.omitted + rendered.reduce((sum, entry) => sum + entry.omitted, 0);
  const sources = rendered.map(entry => entry.source).filter((source): source is ShapedSource => source !== undefined);
  // C-CHAT (AUD-002, L4-03): a search's own match count leads the text, so "8 of 71" is said, never "8 of 8".
  const total = tool === 'mattermost_search' && isRecord(data) && Number.isSafeInteger(data['total']) ? Number(data['total']) : undefined;
  return capped({ text: total === undefined ? body.text : `matched: ${total}\n${body.text}`, partial: omitted > 0, originalCharacters: rendered.map(l => l.lines.join('\n')).join('\n').length, omittedCharacters: omitted, shape: extracted.shape, itemCount: visible.length, sources });
}

// --- lux-knowledge -------------------------------------------------------------------------

/** The remote search returns its digest as Markdown whose first line is an H1 header and whose
 * next block is an italic retrieval-metadata line. Neither belongs in front of the Live model or in
 * the answer card (#254); the hits and their ids stay untouched. */
const KNOWLEDGE_HEADER = /^#\s*Knowledge Search\b.*$/u;
const KNOWLEDGE_METADATA = /^_.*(?:confidence:|top score:|relevant candidate:).*$/u;
/** #6: the confidence line is stripped from the model text but never lost: research reads it here. */
function knowledgeConfidenceOf(raw: string): KnowledgeConfidence | undefined {
  for (const line of raw.split('\n')) {
    if (!KNOWLEDGE_METADATA.test(line.trim())) continue;
    const confidence = /confidence:\s*([a-z]+)/u.exec(line)?.[1];
    if (confidence === undefined) continue;
    const top = /top score:\s*([\d.]+)/u.exec(line)?.[1];
    const candidates = /relevant candidate:\s*([a-z]+)/u.exec(line)?.[1];
    return { confidence, ...(top === undefined ? {} : { top }), ...(candidates === undefined ? {} : { candidates }) };
  }
  return undefined;
}
function stripKnowledgePreamble(raw: string): string {
  return raw.split('\n').filter(line => {
    const trimmed = line.trim();
    return !KNOWLEDGE_HEADER.test(trimmed) && !KNOWLEDGE_METADATA.test(trimmed);
  }).join('\n').replace(/^\n+/u, '');
}
function knowledgeHeading(hit: Record<string, unknown>): string {
  const title = field(hit, 'insight_title', 'title', 'name') || `insight ${scalar(hit['id']) || '(untitled)'}`;
  const kind = field(hit, 'insight_type', 'type');
  const date = field(hit, 'updated_at', 'created_at', 'date', 'meeting_date_local');
  const meta = [kind, date].filter(Boolean).join(' | ');
  const id = scalar(hit['id']);
  return `### ${title}${meta ? ` (${meta})` : ''}${id ? ` [id ${id}]` : ''}`;
}
/** A search hit's excerpt. The cut names the research tool, which reads the whole entry by its id. */
function knowledgeExcerpt(hit: Record<string, unknown>): { text: string; omitted: number; original: number } {
  const body = field(hit, 'content', 'excerpt', 'snippet', 'summary');
  const cut = cutAtSentence(body, KNOWLEDGE_EXCERPT_CHARS);
  const id = scalar(hit['id']);
  const note = cut.omitted > 0 ? `\n[omitted: ${cut.omitted} characters; ${id ? `ask research with ids=[${id}] for the whole note` : 'final, ask research again with this note id for the whole note'}]` : '';
  return { text: `${knowledgeHeading(hit)}\n${cut.text}${note}`, omitted: cut.omitted, original: body.length };
}
/** A get_insight body, returned in full up to a generous final bound (OUTCOME 1). */
function knowledgeBody(hit: Record<string, unknown>): { text: string; omitted: number; original: number } {
  const body = field(hit, 'content', 'text', 'body');
  const cut = cutAtSentence(body, KNOWLEDGE_BODY_CHARS);
  const note = cut.omitted > 0 ? `\n[omitted: ${cut.omitted} characters; final, this read has no paging argument]` : '';
  return { text: `${knowledgeHeading(hit)}\n${cut.text}${note}`, omitted: cut.omitted, original: body.length };
}

/** Shape a lux-knowledge result. JSON hits become title/type/date/excerpt; anything else is kept. */
export function shapeLuxKnowledge(tool: string, raw: string): ShapedResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  if (Array.isArray(parsed)) {
    const hits = parsed.filter(isRecord);
    if (hits.length) return knowledgeList(hits);
  }
  if (isRecord(parsed)) {
    const list = Array.isArray(parsed['results']) ? parsed['results'] : Array.isArray(parsed['insights']) ? parsed['insights'] : Array.isArray(parsed['hits']) ? parsed['hits'] : undefined;
    if (list) {
      const hits = list.filter(isRecord);
      if (hits.length) return knowledgeList(hits);
    }
    if (tool === 'get_insight') {
      const body = field(parsed, 'content', 'text', 'body');
      if (body || parsed['insights'] === undefined && parsed['results'] === undefined) {
        const hit = knowledgeBody(parsed);
        return withOpenHandles({ text: hit.text, partial: hit.omitted > 0, originalCharacters: hit.original, omittedCharacters: hit.omitted, sources: bodySourceLinks(hit.text) });
      }
    }
  }
  const confidence = knowledgeConfidenceOf(raw);
  // #6/#580: the ranker line never reaches the model text; it travels as a field on the shape, where
  // research reads it and voices the hedge. Never invented: only the fields the server itself sent.
  const carry = (result: ShapedResult): ShapedResult => confidence === undefined ? result
    : { ...result, knowledgeConfidence: confidence };
  const ranked = knowledgeRanked(raw);
  if (ranked) return carry(ranked);
  const clean = stripKnowledgePreamble(raw);
  const cut = cutAtSentence(clean, GMAIL_BODY_CHARS);
  const note = cut.omitted > 0 ? `\n\n[omitted: ${cut.omitted} characters; final, this read has no paging argument]` : '';
  return carry(withOpenHandles({ text: cut.text + note, partial: cut.omitted > 0, originalCharacters: clean.length, omittedCharacters: cut.omitted, sources: bodySourceLinks(cut.text) }));
}

const KNOWLEDGE_HIT_START = /^(?:- )?\*\*#([0-9]+)\*\*/u;
const KNOWLEDGE_SCORE_LINE = /^\s*Score:/u;

/** ROUTE-1022 K17: the hit count the digest states above its hits, so the coverage line is the server's. */
const KNOWLEDGE_HIT_COUNT = /\b(\d{1,3})\s+(?:hits?|results?|insights?|entries|matches)\b/iu;
function statedHitCount(raw: string): number | undefined {
  const header = raw.split('\n').map(line => line.trim()).find(line => KNOWLEDGE_HEADER.test(line));
  if (header === undefined) return undefined;
  const count = Number(KNOWLEDGE_HIT_COUNT.exec(header)?.[1] ?? Number.NaN);
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

/** A ranked Markdown search reply: every '**#id**' block is one hit, and no hit is dropped silently. */
function knowledgeRanked(raw: string): ShapedResult | undefined {
  const clean = stripKnowledgePreamble(raw);
  const parts = clean.split(/^(?=(?:- )?\*\*#[0-9]+\*\*)/mu).filter(part => KNOWLEDGE_HIT_START.test(part));
  if (parts.length === 0) return undefined;
  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  let original = 0;
  let trimmed = 0;
  for (const part of parts) {
    const block = part.trim();
    original += block.length;
    const lines = block.split('\n');
    const header = lines[0] ?? block;
    let scoreAt = -1;
    for (let index = lines.length - 1; index > 0; index -= 1) { if (KNOWLEDGE_SCORE_LINE.test(lines[index]!)) { scoreAt = index; break; } }
    const inner = lines.slice(1, scoreAt > 0 ? scoreAt : lines.length).join('\n').trim();
    const score = scoreAt > 0 ? lines[scoreAt]!.trim() : '';
    // MED-1022: the leading hit is the answer, so it keeps the body window the search asked for; the
    // hits behind it keep the short excerpt. A voice reply carries no bullet when it found one entry,
    // so the bound follows the hit's position, never a shape marker in the text.
    const cut = cutAtSentence(inner, kept.length === 0 ? KNOWLEDGE_RANKED_TOP_CHARS : KNOWLEDGE_RANKED_EXCERPT_CHARS);
    const id = KNOWLEDGE_HIT_START.exec(header)?.[1];
    const note = cut.omitted > 0 ? `[excerpt cut: ${cut.omitted} characters omitted; ask research again with ids=[${id ?? 'the id above'}] for this note's whole text]` : '';
    const text = [header, cut.text, score, note].filter(line => line.length > 0).join('\n');
    if (kept.length > 0 && used + text.length + 2 > KNOWLEDGE_RANKED_TOTAL_CHARS) { trimmed += 1; omitted += block.length; continue; }
    kept.push(text);
    used += text.length + 2;
    omitted += cut.omitted;
  }
  // K17: the server may state more hits than its digest carried, and the coverage line says so.
  const total = Math.max(statedHitCount(raw) ?? 0, parts.length);
  const short = trimmed > 0 || total > kept.length;
  const tail = short ? `\n\n[showing ${kept.length} of ${total} hits; ask a narrower question or a higher limit for the rest]` : '';
  const text = `${kept.join('\n\n')}${tail}`;
  return withOpenHandles({ text, partial: short || omitted > 0, originalCharacters: original, omittedCharacters: omitted, sources: bodySourceLinks(text) });
}

function knowledgeList(hits: Record<string, unknown>[]): ShapedResult {
  const shapedHits = hits.map(knowledgeExcerpt);
  const body = listed(shapedHits.map(hit => hit.text), KNOWLEDGE_HITS, 'hits', `call search_knowledge again with limit=${hits.length} for the rest`);
  const omitted = body.omitted + shapedHits.reduce((sum, hit) => sum + hit.omitted, 0);
  return capped({ text: body.text, partial: omitted > 0, originalCharacters: shapedHits.map(hit => hit.text).join('\n\n').length, omittedCharacters: omitted, sources: hits.flatMap(hit => bodySourceLinks(field(hit, 'content', 'excerpt', 'snippet', 'summary'))) });
}
