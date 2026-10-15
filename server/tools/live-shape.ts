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

/** Per-tool budgets for the text a tool result puts in front of the Live model. Each bound is
 * named so a reviewer can see the size policy: 3 knowledge hits with 400-character bodies, 8
 * Mattermost posts with 250-character bodies, 5 mail messages with 300-character excerpts (1500
 * for one requested message), and 8 calendar events of 150 characters. LIVE_RESULT_CHARS is the
 * hard ceiling on any single model-visible result, and LIVE_COMBINED_CHARS the larger ceiling for
 * a result that combines several sources. */
export const GMAIL_BODY_CHARS = 1500;
export const GMAIL_LIST_MESSAGES = 5;
export const GMAIL_LIST_EXCERPT_CHARS = 300;
export const CALENDAR_EVENTS = 8;
export const CALENDAR_EVENT_CHARS = 150;
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
/** Hard ceiling on the shaped text of any single model-visible Live tool result, and the larger
 * ceiling for a result that combines several sources (for example a brief). */
export const LIVE_RESULT_CHARS = 2000;
export const LIVE_COMBINED_CHARS = 3000;

export interface ShapedSource { title: string; url?: string; sourceType?: string }
export interface ShapedResult {
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
/** The hard per-result ceiling on model-visible text. A result already under `budget` is untouched;
 * otherwise it is cut at a sentence boundary and an omission note names the dropped characters and
 * how to ask for the rest, so the whole text (note included) stays within `budget`. */
export function capped(result: ShapedResult, budget: number = LIVE_RESULT_CHARS): ShapedResult {
  if (result.text.length <= budget) return result;
  const note = (omitted: number): string => `\n\n[omitted: ${omitted} characters to keep this result under ${budget}; ask a narrower question or for fewer items for the rest]`;
  const first = cutAtSentence(result.text, budget);
  const recut = cutAtSentence(result.text, Math.max(0, budget - note(first.omitted).length));
  const text = `${recut.text}${note(recut.omitted)}`.slice(0, budget);
  return { ...result, text, partial: true, omittedCharacters: result.omittedCharacters + recut.omitted };
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
  return capped({ text: `${head.join('\n')}\n\n${cut.text}${note}`, partial: cut.omitted > 0, originalCharacters: body.length + head.join('\n').length, omittedCharacters: cut.omitted });
}

export function shapeGmailList(data: Record<string, unknown>): ShapedResult {
  const messages = Array.isArray(data['messages']) ? data['messages'] : [];
  const sources: ShapedSource[] = [];
  const lines = messages.filter(isRecord).map(entry => {
    const unread = labels(entry).includes('UNREAD') ? ' [unread]' : '';
    const snippet = str(entry['snippet']);
    const excerpt = snippet ? cutAtSentence(snippet, GMAIL_LIST_EXCERPT_CHARS).text : '';
    const threadValue = entry['threadSize'] ?? entry['messageCount'];
    const size = typeof threadValue === 'number' && threadValue > 0 ? ` (thread ${threadValue})` : '';
    const named = header(entry, 'Subject');
    const url = inboxUrl(entry['id']);
    if (url) sources.push({ title: named ? `Gmail: ${named}` : 'Open in Gmail', url, sourceType: 'gmail' });
    return `- ${named || '(no subject)'} | ${senderName(entry) || 'unknown sender'} | ${header(entry, 'Date') || 'unknown date'}${unread}${size}${excerpt ? ` | ${excerpt}` : ''}`;
  });
  const body = listed(lines, GMAIL_LIST_MESSAGES, 'messages');
  return capped({ text: body.text, partial: body.omitted > 0, originalCharacters: lines.join('\n').length, omittedCharacters: body.omitted, sources });
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
  return capped(shaped(lines.join('\n')));
}

export function shapeGcalList(data: Record<string, unknown>): ShapedResult {
  const events = Array.isArray(data['events']) ? data['events'] : [];
  const sources: ShapedSource[] = [];
  const blocks = events.filter(isRecord).map(entry => {
    const start = isRecord(entry['start']) ? field(entry['start'], 'dateTime', 'date') : str(entry['start']);
    const named = field(entry, 'summary', 'title');
    const title = named || '(no title)';
    const location = field(entry, 'location');
    const lines = [`- ${start}, ${title}${location ? `, ${location}` : ''}`];
    const attendees = Array.isArray(entry['attendees']) ? entry['attendees'] : [];
    const names = attendees.filter(isRecord).map(a => field(a, 'displayName', 'email')).filter(Boolean);
    if (names.length) lines.push(`  attendees: ${names.join(', ')}`);
    const conference = field(entry, 'hangoutLink') || (isRecord(entry['conferenceData']) ? 'yes' : '');
    if (conference) lines.push('  conference: yes');
    const description = stripDialIn(cleanMailBody(field(entry, 'description'))).replace(/\n+/g, ' ');
    if (description) lines.push(`  ${description}`);
    const link = field(entry, 'htmlLink');
    if (link) sources.push({ title: named ? `Calendar: ${named}` : 'Open in Google Calendar', url: link, sourceType: 'calendar' });
    const cut = cutAtSentence(lines.join('\n'), CALENDAR_EVENT_CHARS);
    if (cut.omitted === 0) return lines.join('\n');
    const note = (omitted: number): string => ` [+${omitted} chars]`;
    const recut = cutAtSentence(lines.join('\n'), Math.max(0, CALENDAR_EVENT_CHARS - note(cut.omitted).length));
    return `${recut.text}${note(recut.omitted)}`;
  });
  const body = listed(blocks, CALENDAR_EVENTS, 'events');
  return capped({ text: body.text, partial: body.omitted > 0, originalCharacters: blocks.join('\n').length, omittedCharacters: body.omitted, sources });
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
  const header2 = [channel, author, time].filter(Boolean).join(' | ');
  const raw = str(post['text'] ?? post['message']);
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
  const facts = [posts === undefined ? '' : `${posts} posts`, last ? `last activity ${last}` : ''].filter(Boolean);
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

/** A completed projection that shaped to nothing becomes an explicit note, never an empty string. */
export function noEmptyResult(text: string): string {
  return text.trim() === '' ? 'No results.' : text;
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
  return capped({ text: body.text, partial: omitted > 0, originalCharacters: rendered.map(l => l.lines.join('\n')).join('\n').length, omittedCharacters: omitted, shape: extracted.shape, itemCount: visible.length, sources });
}

// --- lux-knowledge -------------------------------------------------------------------------

/** The remote search returns its digest as Markdown whose first line is an H1 header and whose
 * next block is an italic retrieval-metadata line. Neither belongs in front of the Live model or in
 * the answer card (#254); the hits and their ids stay untouched. */
const KNOWLEDGE_HEADER = /^#\s*Knowledge Search\b.*$/u;
const KNOWLEDGE_METADATA = /^_.*(?:confidence:|top score:|relevant candidate:).*$/u;
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
  const clean = stripKnowledgePreamble(raw);
  const cut = cutAtSentence(clean, GMAIL_BODY_CHARS);
  const note = cut.omitted > 0 ? `\n\n[omitted: ${cut.omitted} characters; final, this read has no paging argument]` : '';
  return { text: cut.text + note, partial: cut.omitted > 0, originalCharacters: clean.length, omittedCharacters: cut.omitted };
}

function knowledgeList(hits: Record<string, unknown>[]): ShapedResult {
  const shapedHits = hits.map(knowledgeExcerpt);
  const body = listed(shapedHits.map(hit => hit.text), KNOWLEDGE_HITS, 'hits', `call search_knowledge again with limit=${hits.length} for the rest`);
  const omitted = body.omitted + shapedHits.reduce((sum, hit) => sum + hit.omitted, 0);
  return capped({ text: body.text, partial: omitted > 0, originalCharacters: shapedHits.map(hit => hit.text).join('\n\n').length, omittedCharacters: omitted });
}
