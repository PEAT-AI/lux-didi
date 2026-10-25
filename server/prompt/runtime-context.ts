/**
 * Host-generated Live runtime context. Built from the Mac's clock and timezone when a Live session
 * is created (and on each rebuild), never from the model. It carries no private content beyond the
 * session's own connected and unavailable group names.
 */
export interface RuntimeContextInput {
  readonly now: Date;
  readonly timeZone: string;
  readonly connected: readonly string[];
  readonly unavailable: readonly string[];
  /** W6 item 14: what this session may write to lux, as the host reads it, never as the model guesses. */
  readonly vault?: { readonly dictation: boolean; readonly composed: boolean };
}

/** The exact vault-write capability fact, so no answer blames a connector for a write that is off. */
export function vaultCapabilityLine(vault: { readonly dictation: boolean; readonly composed: boolean }): string | undefined {
  if (!vault.dictation) return undefined;
  return vault.composed
    ? 'Vault: Naya saves exactly the note the owner dictates, and a note composed from the conversation only when he asks and confirms the read-back.'
    : 'Vault: Naya saves exactly the note the owner dictates; composed notes are switched off.';
}

const shortWeekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

interface ZonedDate {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly hour: string;
  readonly minute: string;
  readonly weekday: number;
}

function zoned(date: Date, timeZone: string): ZonedDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string): string => parts.find(part => part.type === type)?.value ?? '';
  const weekday = shortWeekdays.indexOf(value('weekday') as (typeof shortWeekdays)[number]);
  return { y: Number(value('year')), m: Number(value('month')), d: Number(value('day')),
    hour: value('hour'), minute: value('minute'), weekday: weekday < 0 ? 0 : weekday };
}

/** The signed ±HH:MM offset of one instant in the session timezone. */
function offset(date: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(date).find(part => part.type === 'timeZoneName')?.value ?? 'GMT';
  if (name === 'GMT' || name === 'UTC') return '+00:00';
  return name.replace(/^GMT/, '');
}

function ymd(parts: { y: number; m: number; d: number }): string {
  return `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
}

/** One date label plus its short weekday, from a y/m/d triple. */
function label(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${ymd({ y, m, d })} (${shortWeekdays[date.getUTCDay()]!})`;
}

/** The human group names a set of granted tool names makes available. */
export function toolGroupNames(toolNames: readonly string[]): string[] {
  const groups: string[] = [];
  const add = (group: string): void => { if (!groups.includes(group)) groups.push(group); };
  for (const name of toolNames) {
    if (name.startsWith('gmail_')) add('mail');
    else if (name.startsWith('calendar_')) add('calendar');
    else if (name.startsWith('mattermost_')) add('team chat');
    else if (name === 'search_knowledge' || name === 'get_insight') add('knowledge base');
    else if (name === 'remember_note') add('memory');
    else if (name.startsWith('ask_mongoose') || name.startsWith('search_mongoose') || name.startsWith('get_knowledge_item') || name.startsWith('read_knowledge_body')) add('company knowledge');
    // L8-10: the web read is a research source, so the session's own list names it when it can run.
    else if (name === 'web_search') add('web search');
  }
  return groups;
}

/** The human group names one configured connector id covers. */
export function connectorGroupNames(connector: string): string[] {
  if (connector === 'google') return ['calendar', 'mail'];
  if (connector === 'mattermost') return ['team chat'];
  if (connector === 'lux-knowledge') return ['knowledge base'];
  if (connector === 'mongoose') return ['company knowledge'];
  return [connector];
}

/**
 * Assemble the runtime context section from the host clock and timezone. Every value is computed;
 * no field is emitted that the shape does not name.
 */
export function buildRuntimeContext(input: RuntimeContextInput): string {
  const now = zoned(input.now, input.timeZone);
  const base = Date.UTC(now.y, now.m - 1, now.d);
  const day = 86_400_000;
  const tomorrow = new Date(base + day);
  const yesterday = new Date(base - day);
  const mondayOffset = (now.weekday + 6) % 7;
  const monday = new Date(base - mondayOffset * day);
  const sunday = new Date(monday.getTime() + 6 * day);
  const weekYmd = (date: Date): string => ymd({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() });
  const weekOffset = (date: Date): string => offset(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12)), input.timeZone);
  const connected = input.connected.length ? input.connected.join(', ') : 'none';
  const unavailable = input.unavailable.length ? input.unavailable.join(', ') : 'none';
  return [
    '# Runtime context',
    '',
    `Now: ${shortWeekdays[now.weekday]!}, ${ymd(now)}, ${now.hour}:${now.minute} ${input.timeZone} (UTC${offset(input.now, input.timeZone)})`,
    `Today: ${label(now.y, now.m, now.d)}. Tomorrow: ${label(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate())}. Yesterday: ${label(yesterday.getUTCFullYear(), yesterday.getUTCMonth() + 1, yesterday.getUTCDate())}.`,
    `This week: ${weekYmd(monday)}T00:00:00${weekOffset(monday)} to ${weekYmd(sunday)}T23:59:59${weekOffset(sunday)}.`,
    `Connected now: ${connected}.`,
    `Not available: ${unavailable}.`,
    ...(input.vault === undefined ? [] : [vaultCapabilityLine(input.vault)].filter((line): line is string => line !== undefined)),
    'Naya can read and search; she cannot send anything to anyone.',
  ].join('\n');
}
