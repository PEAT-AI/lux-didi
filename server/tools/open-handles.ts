import { hostLogEvent } from './host-events.js';

/**
 * Handles and the open destination policy. A handle is minted only here, from a structured source
 * record the host already built, so no model argument and no retrieved sentence can register one.
 */

export const HANDLE_PATTERN = /^L[0-9]{1,4}$/;
export const OPEN_HANDLE_CAP = 3;
export const HOME_APPS = ['gmail', 'calendar', 'mattermost'] as const;
export type HomeApp = (typeof HOME_APPS)[number];
export type OpenKind = 'gmail' | 'calendar' | 'docs' | 'drive' | 'youtube' | 'mattermost' | 'home' | 'file' | 'app' | 'web';
export type OpenProvenance = 'structured' | 'knowledge_body';
export interface OpenHandle { handle: string; url: string; kind: OpenKind; provenance: OpenProvenance; title: string }
export interface SourceLink { title: string; url?: string; sourceType?: string }

const REJECT_PATH = /(^|\/)(url|redirect|export|download)(\/|$)/;
/** An account address Gmail accepts in place of the account index; the host takes it from the Gmail proof. */
const ACCOUNT_ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;
const MAIL_PATH = /^\/mail\/u\/(\d{1,2}|[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+)\/?$/;
const CALENDAR_PATH = /^\/(calendar\/)?event\/?$/;
/** The link the Calendar API returns for an event: www.google.com, exactly this path, and an eid. */
const CALENDAR_EVENT_LINK = '/calendar/event';
const CALENDAR_HOME = /^\/$/;
const DOCS_PATH = /^\/(document|presentation|spreadsheets)\/d\/[A-Za-z0-9_-]{1,256}(\/(edit|view))?\/?$/;
const DRIVE_PATH = /^\/(file\/d\/[A-Za-z0-9_-]{1,256}|drive\/folders\/[A-Za-z0-9_-]{1,256})(\/view)?\/?$/;
const SHORT_VIDEO_PATH = /^\/[A-Za-z0-9_-]{1,64}\/?$/;
const MATTERMOST_POST = /^\/(t\/)?[A-Za-z0-9._-]{1,64}\/pl\/[A-Za-z0-9]{1,64}\/?$/;
const MATTERMOST_CHANNEL = /^\/(t\/)?[A-Za-z0-9._-]{1,64}\/channels\/[A-Za-z0-9._-]{1,64}\/?$/;

let mattermostHost: string | undefined;

/** The Mattermost origin is learned from a connector permalink, never from a model argument. */
export function noteMattermostOrigin(raw: string): void {
  if (mattermostHost !== undefined) return;
  const host = hostOf(raw);
  if (host === undefined) return;
  let url: URL;
  try { url = new URL(raw); } catch { return; }
  if (!MATTERMOST_POST.test(url.pathname) && !MATTERMOST_CHANNEL.test(url.pathname)) return;
  mattermostHost = host;
}

export function mattermostOrigin(): string | undefined { return mattermostHost }

function hostOf(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '' ? url.hostname.toLowerCase() : undefined;
  } catch { return undefined; }
}

/** https, no userinfo, no explicit port, an exact host and a viewer path shape; never a redirect route. */
export function openDestination(raw: string): { url: string; kind: OpenKind } | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return undefined;
  if (REJECT_PATH.test(url.pathname) || url.searchParams.has('q') || url.searchParams.has('redirect') || url.searchParams.has('export')) return undefined;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host === 'mail.google.com') return MAIL_PATH.test(path) ? { url: url.href, kind: 'gmail' } : undefined;
  if (host === 'calendar.google.com') {
    if (CALENDAR_HOME.test(path)) return { url: url.href, kind: 'calendar' };
    return CALENDAR_PATH.test(path) && url.searchParams.has('eid') ? { url: url.href, kind: 'calendar' } : undefined;
  }
  if (host === 'www.google.com') return path === CALENDAR_EVENT_LINK && url.searchParams.has('eid') ? { url: url.href, kind: 'calendar' } : undefined;
  if (host === 'docs.google.com') return DOCS_PATH.test(path) ? { url: url.href, kind: 'docs' } : undefined;
  if (host === 'drive.google.com') return DRIVE_PATH.test(path) ? { url: url.href, kind: 'drive' } : undefined;
  if (host === 'www.youtube.com' || host === 'youtube.com') {
    return path === '/watch' && Boolean(url.searchParams.get('v')) ? { url: url.href, kind: 'youtube' } : undefined;
  }
  if (host === 'youtu.be') return SHORT_VIDEO_PATH.test(path) ? { url: url.href, kind: 'youtube' } : undefined;
  if (host === mattermostHost && (MATTERMOST_POST.test(path) || MATTERMOST_CHANNEL.test(path))) return { url: url.href, kind: 'mattermost' };
  return undefined;
}

let gmailAddress: string | undefined;
let accountUnknownLogged = false;

/** C-OPEN 4: the account the Gmail connector proved at host start; anything that is not an address is none. */
export function noteGmailAccount(value: string | undefined): void {
  gmailAddress = typeof value === 'string' && ACCOUNT_ADDRESS.test(value) ? value : undefined;
}

export function gmailAccount(): string | undefined { return gmailAddress }

/** The account segment of a Gmail link; /u/0 only when the connector reported no account, and the log says so once per session. */
function gmailAccountSegment(): string {
  if (gmailAddress !== undefined) return gmailAddress;
  if (!accountUnknownLogged) { accountUnknownLogged = true; hostLogEvent({ event: 'gmail_account_unknown' }); }
  return '0';
}

/** A thread in all mail, so an archived thread opens too, under the signed-in account. */
export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/${gmailAccountSegment()}/#all/${encodeURIComponent(threadId)}`;
}

/** The three home pages the owner may ask for; every destination is fixed here, never by an argument. */
export function homeDestination(app: HomeApp): { url: string; kind: OpenKind } | undefined {
  if (app === 'gmail') return { url: `https://mail.google.com/mail/u/${gmailAccountSegment()}/`, kind: 'home' };
  if (app === 'calendar') return { url: 'https://calendar.google.com/', kind: 'home' };
  return mattermostHost === undefined ? undefined : { url: `https://${mattermostHost}/`, kind: 'home' };
}

const handles = new Map<string, OpenHandle>();
/** Open2: a minted handle is openable only once its `open:` line reached the model in this session. */
const exposed = new Set<string>();
let session: string | undefined;
let minted = 0;

/** One registry per Live session: a new session drops every handle the last one minted. */
export function beginHandleSession(runId: string): void {
  if (session === runId) return;
  handles.clear(); exposed.clear(); mintedLines.clear(); minted = 0; session = runId; accountUnknownLogged = false;
}

export function endHandleSession(runId: string): void {
  if (session !== runId) return;
  handles.clear(); exposed.clear(); mintedLines.clear(); minted = 0; session = undefined; accountUnknownLogged = false;
}

/** A handle resolves only when its line was in the text the model was actually given. */
export function resolveHandle(handle: string): OpenHandle | undefined {
  return HANDLE_PATTERN.test(handle) && exposed.has(handle) ? handles.get(handle) : undefined;
}

/**
 * Open2: called with the text handed to the model, so a handle minted for a result it never saw stays
 * closed. Minting alone exposes nothing.
 */
export function exposeHandles(text: string): void {
  // OPEN2-R5: only an exact line this session minted can expose its handle, so a lookalike inside delivered
  // content (a mail body, a chat post, a note) never opens an item the model was never shown. The line is
  // compared raw and JSON-escaped, because a delivered tool result is JSON text; a line the reply carries
  // inline, such as the calendar day line, is still an exact substring of it.
  for (const line of mintedLines) {
    if (!text.includes(line) && !text.includes(JSON.stringify(line).slice(1, -1))) continue;
    const handle = /^open: (L[0-9]{1,4}) = /.exec(line)?.[1];
    if (handle !== undefined && handles.has(handle)) exposed.add(handle);
  }
}

/** A line shaped like a handle line, which only the host writes; tool text carrying one is stripped. */
const OPEN_LINE = /^\s*open: L[0-9]{1,4}(?:\s*=|\s|$)/;
/** The exact handle lines this session minted, so a lookalike inside a body is never taken for one. */
const mintedLines = new Set<string>();

/**
 * Open2: a mail body, note or chat post cannot smuggle a handle line into the model text. Only a line
 * the host itself minted survives, and this runs before any minting this result still owes.
 */
export function stripOpenLines(text: string): string {
  if (!text.includes('open: L')) return text;
  return text.split('\n').filter(line => !OPEN_LINE.test(line) || mintedLines.has(line.trim())).join('\n');
}

function safeTitle(title: string): string {
  const clean = title.replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();
  return clean.length === 0 ? 'item' : clean.slice(0, 120);
}

function kindTitle(raw: string): string {
  const url = new URL(raw);
  if (url.pathname.includes('/presentation/')) return 'Slides';
  if (url.pathname.includes('/spreadsheets/')) return 'Spreadsheet';
  if (url.hostname === 'docs.google.com') return 'Document';
  if (url.hostname === 'drive.google.com') return 'Drive file';
  if (url.hostname.endsWith('youtube.com') || url.hostname === 'youtu.be') return 'Video';
  if (url.hostname === 'calendar.google.com' || url.hostname === 'www.google.com') return 'Calendar event';
  if (url.hostname === 'mail.google.com') return 'Gmail thread';
  return 'Mattermost thread';
}

/** A structured source is checked at mint time; the handle carries only what the open path may use. */
function sourceDestination(source: SourceLink): { url: string; kind: OpenKind } | undefined {
  if (typeof source.url !== 'string') return undefined;
  if (source.sourceType === 'mattermost') noteMattermostOrigin(source.url);
  const destination = openDestination(source.url);
  if (!destination || destination.kind === 'home') return undefined;
  return destination;
}

/** One item's handle line; the provenance is the only trace of where the destination came from. */
export function mintOpenLine(source: SourceLink): string | undefined {
  const destination = sourceDestination(source);
  if (!destination) return undefined;
  const provenance: OpenProvenance = source.sourceType === 'knowledge' ? 'knowledge_body' : 'structured';
  const handle = `L${++minted}`;
  const title = safeTitle(source.title);
  handles.set(handle, { handle, url: destination.url, kind: destination.kind, provenance, title });
  const line = `open: ${handle} = ${title}${provenance === 'knowledge_body' ? ' (from knowledge note)' : ''}`;
  mintedLines.add(line);
  return line;
}

export function withOpenHandles<T extends { text: string; sources?: readonly SourceLink[] }>(result: T): T {
  const text = stripOpenLines(result.text);
  const stripped = text === result.text ? result : { ...result, text };
  // A shaper that already attached a handle to its own item keeps it; nothing is minted twice.
  if (text.split('\n').some(line => OPEN_LINE.test(line))) return stripped;
  const lines: string[] = [];
  for (const source of result.sources ?? []) {
    if (lines.length >= OPEN_HANDLE_CAP) break;
    const line = mintOpenLine(source);
    if (line !== undefined) lines.push(line);
  }
  return lines.length === 0 ? stripped : { ...stripped, text: `${text}\n${lines.join('\n')}` };
}

/**
 * Links the host pulls out of the owner's own knowledge notes; every one still passes the destination
 * policy. A mail body is someone else's text, so a link inside one is never minted (C-OPEN 2).
 */
export function bodySourceLinks(text: string, sourceType: 'knowledge' = 'knowledge'): SourceLink[] {
  const found: SourceLink[] = [];
  for (const raw of text.match(/https:\/\/[^\s<>"'`)\]]+/g) ?? []) {
    if (found.length >= OPEN_HANDLE_CAP) break;
    const destination = openDestination(raw.replace(/[.,;:]+$/, ''));
    if (!destination || destination.kind === 'home') continue;
    if (found.some(link => link.url === destination.url)) continue;
    found.push({ title: kindTitle(destination.url), url: destination.url, sourceType });
  }
  return found;
}

/**
 * C-OPENWEB8: the web addresses the owner may ask for. The host builds every one with URL and
 * URLSearchParams from the words he said, so no model argument can carry a path, a query or a port.
 */
export const WEB_KINDS = ['maps', 'site', 'search'] as const;
export type WebKind = (typeof WEB_KINDS)[number];

/** A spoken domain: one registrable domain and nothing else. A path, query, port or userinfo fails this. */
const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_SHAPE = new RegExp(`^${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+$`, 'u');
/** Public suffixes with two labels, so "example co uk" keeps its three. */
const TWO_LABEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'co.nz', 'co.za', 'com.br', 'co.jp', 'com.mx', 'co.in', 'com.sg']);

/** The registrable domain of a host: the public suffix plus one label, or the host itself. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./u, '').replace(/\.+$/u, '').split('.').filter(Boolean);
  const last = labels.slice(-2).join('.');
  return labels.length > 2 && TWO_LABEL_SUFFIXES.has(last) ? labels.slice(-3).join('.') : last;
}

/** A spoken "dot" between two words is the dot of a domain: "plantix dot net" reads as one address. */
export function spokenDots(text: string): string {
  let out = text.toLowerCase();
  for (let pass = 0; pass < 5 && /(\p{L}|\p{N})\s+dot\s+(\p{L}|\p{N})/u.test(out); pass += 1) {
    out = out.replace(/(\p{L}|\p{N})\s+dot\s+(\p{L}|\p{N})/gu, '$1.$2');
  }
  return out;
}

/** The domain he spoke, or undefined when the words are a name rather than a domain. */
export function spokenDomain(target: string): string | undefined {
  // A closing period or a stray comma is the sentence, not the address.
  const value = spokenDots(target).trim().replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
  if (!DOMAIN_SHAPE.test(value)) return undefined;
  return registrableDomain(value) === value ? value : undefined;
}

/** The one origin a site root may open: https, a registrable domain and no path or query at all. */
export function siteRootUrl(domain: string): string | undefined {
  if (spokenDomain(domain) !== domain) return undefined;
  return new URL(`https://${domain}/`).toString();
}

/** "<A> to <B>" or "directions to <B>": the one place the owner's words name two places. */
function directionsOf(words: string): { destination: string; origin?: string } | undefined {
  const direct = /^directions\s+to\s+(.+)$/u.exec(words);
  if (direct?.[1]) return { destination: direct[1] };
  const pair = /^(.+?)\s+to\s+(.+)$/u.exec(words);
  return pair?.[1] && pair[2] ? { origin: pair[1], destination: pair[2] } : undefined;
}

export interface WebDestination { url: string; domain: string }

/** The Google Maps or Google search address for the owner's words; never built by concatenation. */
export function webDestination(kind: WebKind, target: string): WebDestination | undefined {
  const words = target.replace(/\s+/gu, ' ').trim();
  if (words.length === 0) return undefined;
  if (kind === 'maps') {
    const directions = directionsOf(words);
    const url = new URL(directions ? 'https://www.google.com/maps/dir/' : 'https://www.google.com/maps/search/');
    url.searchParams.set('api', '1');
    if (directions) {
      url.searchParams.set('destination', directions.destination);
      if (directions.origin) url.searchParams.set('origin', directions.origin);
    } else url.searchParams.set('query', words);
    return { url: url.toString(), domain: 'google.com' };
  }
  if (kind === 'search') {
    const url = new URL('https://www.google.com/search');
    url.searchParams.set('q', words);
    return { url: url.toString(), domain: 'google.com' };
  }
  const domain = spokenDomain(words);
  const url = domain === undefined ? undefined : siteRootUrl(domain);
  return url === undefined || domain === undefined ? undefined : { url, domain };
}
