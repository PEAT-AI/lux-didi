/**
 * Handles and the open destination policy. A handle is minted only here, from a structured source
 * record the host already built, so no model argument and no retrieved sentence can register one.
 */

export const HANDLE_PATTERN = /^L[0-9]{1,4}$/;
export const OPEN_HANDLE_CAP = 3;
export const HOME_APPS = ['gmail', 'calendar', 'mattermost'] as const;
export type HomeApp = (typeof HOME_APPS)[number];
export type OpenKind = 'gmail' | 'calendar' | 'docs' | 'drive' | 'youtube' | 'mattermost' | 'home' | 'file' | 'app';
export type OpenProvenance = 'structured' | 'knowledge_body' | 'mail_body';
export interface OpenHandle { handle: string; url: string; kind: OpenKind; provenance: OpenProvenance; title: string }
export interface SourceLink { title: string; url?: string; sourceType?: string }

const REJECT_PATH = /(^|\/)(url|redirect|export|download)(\/|$)/;
const MAIL_PATH = /^\/mail\/u\/\d+\/?$/;
const CALENDAR_PATH = /^\/(calendar\/)?event\/?$/;
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
  if (REJECT_PATH.test(url.pathname) || url.searchParams.has('q') || url.searchParams.has('redirect')) return undefined;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host === 'mail.google.com') return MAIL_PATH.test(path) ? { url: url.href, kind: 'gmail' } : undefined;
  if (host === 'calendar.google.com') {
    if (CALENDAR_HOME.test(path)) return { url: url.href, kind: 'calendar' };
    return CALENDAR_PATH.test(path) && url.searchParams.has('eid') ? { url: url.href, kind: 'calendar' } : undefined;
  }
  if (host === 'docs.google.com') return DOCS_PATH.test(path) ? { url: url.href, kind: 'docs' } : undefined;
  if (host === 'drive.google.com') return DRIVE_PATH.test(path) ? { url: url.href, kind: 'drive' } : undefined;
  if (host === 'www.youtube.com' || host === 'youtube.com') {
    return path === '/watch' && Boolean(url.searchParams.get('v')) ? { url: url.href, kind: 'youtube' } : undefined;
  }
  if (host === 'youtu.be') return SHORT_VIDEO_PATH.test(path) ? { url: url.href, kind: 'youtube' } : undefined;
  if (host === mattermostHost && (MATTERMOST_POST.test(path) || MATTERMOST_CHANNEL.test(path))) return { url: url.href, kind: 'mattermost' };
  return undefined;
}

/** The three home pages the owner may ask for; every destination is fixed here, never by an argument. */
export function homeDestination(app: HomeApp): { url: string; kind: OpenKind } | undefined {
  if (app === 'gmail') return { url: 'https://mail.google.com/mail/u/0/', kind: 'home' };
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
  handles.clear(); exposed.clear(); minted = 0; session = runId;
}

export function endHandleSession(runId: string): void {
  if (session !== runId) return;
  handles.clear(); exposed.clear(); minted = 0; session = undefined;
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
  for (const match of text.matchAll(/\bopen: (L[0-9]{1,4}) = /g)) if (handles.has(match[1]!)) exposed.add(match[1]!);
}

/** A line shaped like a handle line, which only the host writes; tool text carrying one is stripped. */
const OPEN_LINE = /^\s*open: L[0-9]{1,4}(?:\s*=|[\s]|$)/;

/** Open2: a mail body or note cannot smuggle a handle line into the model text before minting runs. */
export function stripOpenLines(text: string): string {
  if (!text.includes('open: L')) return text;
  return text.split('\n').filter(line => !OPEN_LINE.test(line)).join('\n');
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
  if (url.hostname === 'calendar.google.com') return 'Calendar event';
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
  const provenance: OpenProvenance = source.sourceType === 'knowledge' ? 'knowledge_body' : source.sourceType === 'mail_body' ? 'mail_body' : 'structured';
  const handle = `L${++minted}`;
  const title = safeTitle(source.title);
  handles.set(handle, { handle, url: destination.url, kind: destination.kind, provenance, title });
  return `open: ${handle} = ${title}${provenance === 'knowledge_body' ? ' (from knowledge note)' : ''}`;
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

/** Links the host pulls out of a body it shaped; every one still passes the destination policy. */
export function bodySourceLinks(text: string, sourceType: 'knowledge' | 'mail_body' = 'knowledge'): SourceLink[] {
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
