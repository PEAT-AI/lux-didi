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

/** Generous per-tool bounds, named so a reviewer can see the size policy.
 * The list bounds equal the largest slice the connector can fetch, so a list is never cut and
 * never promises paging it cannot honour (W7-R2). Only the lux-knowledge excerpt bound carries a
 * real follow-up (get_insight by id), and the search-hit bound names search_knowledge's limit. */
export const GMAIL_BODY_CHARS = 12000;
export const GMAIL_LIST_MESSAGES = 50;
export const CALENDAR_EVENTS = 50;
export const MATTERMOST_MESSAGE_CHARS = 4000;
export const MATTERMOST_MESSAGES = 60;
export const KNOWLEDGE_EXCERPT_CHARS = 1200;
export const KNOWLEDGE_HITS = 20;
/** A get_insight fetch returns the whole body up to this generous final bound (W7-R4: >= 20000). */
export const KNOWLEDGE_BODY_CHARS = 20000;

export interface ShapedResult {
  text: string;
  partial: boolean;
  originalCharacters: number;
  omittedCharacters: number;
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
function header(source: Record<string, unknown>, name: string): string {
  return str(isRecord(source['headers']) ? source['headers'][name] : undefined);
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

function decodeEntities(text: string): string {
  return text.replace(/&(nbsp|amp|lt|gt|quot|#39|#x27);/gi, match => {
    switch (match.toLowerCase()) {
      case '&nbsp;': return ' ';
      case '&amp;': return '&';
      case '&lt;': return '<';
      case '&gt;': return '>';
      case '&quot;': return '"';
      default: return "'";
    }
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
  body = stripQuotedReply(body);
  body = stripSignature(body);
  body = stripTrackingUrls(body);
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

// --- Gmail ---------------------------------------------------------------------------------

const AUTHORS = /^\s*"?([^"<]*?)"?\s*</;
function senderName(source: Record<string, unknown>): string {
  const from = header(source, 'From');
  return (AUTHORS.exec(from)?.[1] ?? from).trim();
}
function inboxUrl(id: unknown): string | undefined {
  return typeof id === 'string' && id.length > 0 ? `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(id)}` : undefined;
}
function labels(source: Record<string, unknown>): string[] {
  return Array.isArray(source['labelIds']) ? source['labelIds'].filter((value): value is string => typeof value === 'string') : [];
}
function attachmentNames(source: Record<string, unknown>): string[] {
  const list = Array.isArray(source['attachments']) ? source['attachments'] : [];
  return list.map(entry => isRecord(entry) ? str(entry['filename'] ?? entry['name']) : str(entry)).filter(Boolean);
}

export function shapeGmailRead(data: Record<string, unknown>): ShapedResult {
  const subject = header(data, 'Subject') || '(no subject)';
  const head = [
    `subject: ${subject}`,
    `from: ${senderName(data) || 'unknown sender'}`,
    `to: ${header(data, 'To') || 'unknown recipients'}`,
    `date: ${header(data, 'Date') || 'unknown date'}`,
  ];
  const cc = header(data, 'Cc'); if (cc) head.push(`cc: ${cc}`);
  const tags = labels(data); if (tags.length) head.push(`labels: ${tags.join(', ')}`);
  const files = attachmentNames(data); if (files.length) head.push(`attachments: ${files.join(', ')}`);
  const body = cleanMailBody(str(data['body']));
  const cut = cutAtSentence(body, GMAIL_BODY_CHARS);
  const note = cut.omitted > 0 ? `\n\n[omitted: ${cut.omitted} characters of body; final, a single message has no partial re-read]` : '';
  return { text: `${head.join('\n')}\n\n${cut.text}${note}`, partial: cut.omitted > 0, originalCharacters: body.length + head.join('\n').length, omittedCharacters: cut.omitted };
}

export function shapeGmailList(data: Record<string, unknown>): ShapedResult {
  const messages = Array.isArray(data['messages']) ? data['messages'] : [];
  const lines = messages.filter(isRecord).map(entry => {
    const unread = labels(entry).includes('UNREAD') ? ' [unread]' : '';
    const snippet = str(entry['snippet']);
    const threadValue = entry['threadSize'] ?? entry['messageCount'];
    const size = typeof threadValue === 'number' && threadValue > 0 ? ` (thread ${threadValue})` : '';
    const url = inboxUrl(entry['id']);
    return `- ${header(entry, 'Subject') || '(no subject)'} | ${senderName(entry) || 'unknown sender'} | ${header(entry, 'Date') || 'unknown date'}${unread}${size}${snippet ? ` | ${snippet}` : ''}${url ? `\n  source: ${url}` : ''}`;
  });
  const body = listed(lines, GMAIL_LIST_MESSAGES, 'messages');
  return { text: body.text, partial: body.omitted > 0, originalCharacters: lines.join('\n').length, omittedCharacters: body.omitted };
}

// --- Calendar ------------------------------------------------------------------------------

export function shapeGcalCalendars(data: Record<string, unknown>): ShapedResult {
  const calendars = Array.isArray(data['calendars']) ? data['calendars'] : [];
  const lines = calendars.filter(isRecord).map(entry => `- ${field(entry, 'summary', 'name') || str(entry['id']) || 'calendar'}`);
  return shaped(lines.join('\n'));
}

export function shapeGcalList(data: Record<string, unknown>): ShapedResult {
  const events = Array.isArray(data['events']) ? data['events'] : [];
  const blocks = events.filter(isRecord).map(entry => {
    const start = isRecord(entry['start']) ? field(entry['start'], 'dateTime', 'date') : str(entry['start']);
    const title = field(entry, 'summary', 'title') || '(no title)';
    const location = field(entry, 'location');
    const lines = [`- ${start}, ${title}${location ? `, ${location}` : ''}`];
    const attendees = Array.isArray(entry['attendees']) ? entry['attendees'] : [];
    const names = attendees.filter(isRecord).map(a => field(a, 'displayName', 'email')).filter(Boolean);
    if (names.length) lines.push(`  attendees: ${names.join(', ')}`);
    const conference = field(entry, 'hangoutLink') || (isRecord(entry['conferenceData']) ? 'yes' : '');
    if (conference) lines.push('  conference: yes');
    const description = cleanMailBody(field(entry, 'description')).replace(/\n+/g, ' ');
    if (description) lines.push(`  ${description}`);
    const link = field(entry, 'htmlLink');
    if (link) lines.push(`  source: ${link}`);
    return lines.join('\n');
  });
  const body = listed(blocks, CALENDAR_EVENTS, 'events');
  return { text: body.text, partial: body.omitted > 0, originalCharacters: blocks.join('\n').length, omittedCharacters: body.omitted };
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
function renderPost(post: Record<string, unknown>): { lines: string[]; omitted: number } {
  const header2 = [field(post, 'channel', 'channel_name', 'channel_id'), field(post, 'author', 'author_name', 'user_name'), field(post, 'time', 'create_at', 'timestamp')].filter(Boolean).join(' | ');
  const raw = str(post['text'] ?? post['message']);
  const cut = cutAtSentence(raw, MATTERMOST_MESSAGE_CHARS);
  const reactions = reactionCount(post);
  const meta = `${reactions > 0 ? ` (${reactions} reactions)` : ''}${threadPosition(post)}`;
  const permalink = field(post, 'permalink');
  return { lines: [`**${header2 || 'message'}${meta}**`, cut.text, ...(cut.omitted > 0 ? [`[omitted: ${cut.omitted} characters; final, a single post has no partial re-read]`] : []), ...(permalink ? [`source: ${permalink}`] : [])], omitted: cut.omitted };
}

export function shapeMattermost(tool: string, data: unknown): ShapedResult {
  if (typeof data === 'string') return shaped(data);
  if (!isRecord(data)) return shaped(data === undefined ? '' : String(data));
  if (tool === 'mattermost_whoami') {
    const name = field(data, 'username', 'user_name');
    const display = field(data, 'display_name', 'displayName');
    return shaped([name, display].filter(Boolean).join(' | ') || 'authenticated');
  }
  if (tool === 'mattermost_list_channels') {
    const channels = Array.isArray(data['channels']) ? data['channels'] : [];
    return shaped(channels.map(entry => isRecord(entry) ? `- ${field(entry, 'display_name', 'name') || str(entry['id'])}` : `- ${String(entry)}`).join('\n'));
  }
  const posts = (Array.isArray(data['posts']) ? data['posts'] : Array.isArray(data['items']) ? data['items'] : []).filter(isRecord).filter(post => !isSystemPost(post));
  const rendered = posts.map(renderPost);
  const body = listed(rendered.map(entry => entry.lines.join('\n')), MATTERMOST_MESSAGES, 'messages');
  const omitted = body.omitted + rendered.reduce((sum, entry) => sum + entry.omitted, 0);
  return { text: body.text, partial: omitted > 0, originalCharacters: rendered.map(l => l.lines.join('\n')).join('\n').length, omittedCharacters: omitted };
}

// --- lux-knowledge -------------------------------------------------------------------------

function knowledgeHeading(hit: Record<string, unknown>): string {
  const title = field(hit, 'insight_title', 'title', 'name') || `insight ${scalar(hit['id']) || '(untitled)'}`;
  const kind = field(hit, 'insight_type', 'type');
  const date = field(hit, 'updated_at', 'created_at', 'date', 'meeting_date_local');
  const meta = [kind, date].filter(Boolean).join(' | ');
  const id = scalar(hit['id']);
  return `## ${title}${meta ? ` (${meta})` : ''}${id ? ` [id ${id}]` : ''}`;
}
/** A search hit's excerpt. The cut names get_insight, which returns the full body (not this bound). */
function knowledgeExcerpt(hit: Record<string, unknown>): { text: string; omitted: number; original: number } {
  const body = field(hit, 'content', 'excerpt', 'snippet', 'summary');
  const cut = cutAtSentence(body, KNOWLEDGE_EXCERPT_CHARS);
  const id = scalar(hit['id']);
  const note = cut.omitted > 0 ? `\n[omitted: ${cut.omitted} characters; ${id ? `call get_insight with ids=[${id}] for the full insight` : 'final, ask for the full insight by its id'}]` : '';
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
        return { text: hit.text, partial: hit.omitted > 0, originalCharacters: hit.original, omittedCharacters: hit.omitted };
      }
    }
  }
  const cut = cutAtSentence(raw, GMAIL_BODY_CHARS);
  const note = cut.omitted > 0 ? `\n\n[omitted: ${cut.omitted} characters; final, this read has no paging argument]` : '';
  return { text: cut.text + note, partial: cut.omitted > 0, originalCharacters: raw.length, omittedCharacters: cut.omitted };
}

function knowledgeList(hits: Record<string, unknown>[]): ShapedResult {
  const shapedHits = hits.map(knowledgeExcerpt);
  const body = listed(shapedHits.map(hit => hit.text), KNOWLEDGE_HITS, 'hits', `call search_knowledge again with limit=${hits.length} for the rest`);
  const omitted = body.omitted + shapedHits.reduce((sum, hit) => sum + hit.omitted, 0);
  return { text: body.text, partial: omitted > 0, originalCharacters: shapedHits.map(hit => hit.text).join('\n\n').length, omittedCharacters: omitted };
}
