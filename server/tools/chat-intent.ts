/**
 * C-CHAT (W2b): which team-chat read a spoken ask wants. The ask shapes are the owner's own: what a person
 * wrote him, what the two of them discussed, what is new in a named channel, his group chat with some people,
 * and a plain topic search. A person or a channel is passed on as the words he said; the chat connector
 * resolves them strictly and asks back when they are ambiguous, so nothing here guesses an account.
 */
import type { JsonObject } from '../adapters/model/types.js';
import type { IntentSubCall } from './intent.js';

export type ChatIntentKind = 'person-said' | 'person-overview' | 'channel-recent' | 'group-chat' | 'topic-search';

/** A backwards window in local days. `future` marks an ask about days that have not happened yet. */
export interface ChatWindow { from?: string; to?: string; future?: boolean }

export interface ChatIntent {
  kind: ChatIntentKind;
  /** The person as spoken, for person-said and person-overview. */
  person?: string;
  /** The people as spoken, for group-chat. */
  people?: string[];
  /** The channel name as spoken, cleaned of the words around it. */
  channel?: string;
  /** person-said: only their posts, or both sides of the conversation. */
  sides?: 'theirs' | 'both';
  /** The topic words left once names, channel words and chat words are removed. */
  terms: string;
  window: ChatWindow;
}

/** The composite chat read the connector answers (server/connectors/mattermost.ts `MATTERMOST_CHAT_TOOL`). */
export const CHAT_READ_TOOL = 'mattermost_chat';
/** The plain chat search a topic ask keeps. */
const CHAT_SEARCH_TOOL = 'mattermost_search';

const NAME = String.raw`(\p{L}[\p{L}'’.-]*(?:\s+\p{L}[\p{L}'’.-]*)?)`;
const SAID_VERBS = 'write|wrote|written|say|said|send|sent|post|posted|tell|told|message|messaged|ask|asked|share|shared|reply|replied|answer|answered';
/** "what did Ada write me", "what has Ada said": only their side. */
const PERSON_SAID = new RegExp(String.raw`\bwhat (?:did|has|have|had) ${NAME} (?:${SAID_VERBS})\b`, 'iu');
/** "messages from Ada", "the latest from Ada", "anything from Ada": only their side. */
const PERSON_FROM = new RegExp(String.raw`\b(?:messages?|posts?|dms?|notes?|latest|anything|something|news) (?:from|by) ${NAME}`, 'iu');
/** "my DMs with Ada", "my chat with Ada": both sides of the direct conversation. */
const PERSON_WITH = new RegExp(String.raw`\b(?:dms?|direct messages?|direct chats?|private chats?|chats?|conversations?|messages?|thread) with ${NAME}`, 'iu');
/** "what did I discuss with Ada", "what have Ada and I talked about": everything the two exchanged. */
const PERSON_DISCUSS = new RegExp(String.raw`\b(?:discuss|discussed|talk about|talked about|talk|talked|chat about|chatted about|chatted|speak about|spoke about|speak|spoke) with ${NAME}`, 'iu');
const PERSON_AND_I = new RegExp(String.raw`\b${NAME} and (?:i|me) (?:discuss|discussed|talk|talked|chat|chatted|spoke|speak)\b`, 'iu');
/** "my group chat with Ada and Kim". */
const GROUP_WITH = /\bgroup (?:chats?|dms?|messages?|conversations?|threads?)? ?with ((?:\p{L}[\p{L}'’.-]*)(?:(?:\s*,\s*|\s+and\s+|\s*&\s*)\p{L}[\p{L}'’.-]*){1,3})/iu;
/** The spoken channel shapes: "#ops", "the channel named X", "in the X channel", "in the X team chat", "channel X". */
const CHANNEL_HASH = /#([\p{L}\p{N}][\p{L}\p{N}._-]{0,59})/u;
const CHANNEL_CALLED = /\b(?:channel|team chat|group chat|chat)s? (?:that is |which is )?(?:named|called|is called|is named)\s+(.{1,60}?)(?=$|[?!,]|\.(?:\s|$)|\s(?:about|on|for|from|since|this|last|today|yesterday|lately|recently)\b)/iu;
const CHANNEL_BEFORE = /\b(?:in|on|from|of|inside|at)\s+(?:the |my |our )?(.{1,60}?)\s+(?:team chat|channel|chat channel|team channel|chat group)s?\b/iu;
const CHANNEL_AFTER = /\b(?:the )?channel\s+(?!named\b|called\b|is\b)(.{1,60}?)(?=$|[?!,]|\.(?:\s|$)|\s(?:about|on|for|from|since|this|last|today|yesterday|lately|recently)\b)/iu;

/** Words that are never a person: pronouns, "anyone", the team. */
const NOT_A_PERSON = new Set(['i', 'me', 'we', 'us', 'you', 'they', 'them', 'he', 'him', 'she', 'her', 'it', 'anyone', 'anybody', 'someone', 'somebody', 'everyone', 'everybody', 'people', 'team', 'the', 'my', 'our', 'your', 'nobody', 'this', 'that']);
/** Words a captured name may carry on its right edge that belong to the sentence, never to the name. */
const NAME_TAIL = new Set(['about', 'on', 'in', 'this', 'last', 'today', 'yesterday', 'lately', 'recently', 'me', 'us', 'and', 'or', 'the', 'week', 'month', 'morning', 'so', 'far', 'since', 'over', 'from', 'for', 'to', 'at', 'regarding', 'yet', 'please', 'again', 'there', 'here']);
/** Words a spoken channel name opens or closes with that are never part of the name (#664, L1-01). */
const CHANNEL_EDGE = new Set(['a', 'an', 'the', 'my', 'our', 'this', 'that', 'named', 'called', 'is', 'team', 'chat', 'channel', 'group', 'mattermost', 'slack']);
/** A placeholder a model writes where a name belongs (#664). */
const CHANNEL_PLACEHOLDER = /^(?:name|channel|exact|string|called|exact name)$/iu;

/** The words that say "chat" and "what was said", never a topic to search for. */
const CHAT_FILLER = new Set([
  'chat', 'chats', 'channel', 'channels', 'team', 'mattermost', 'slack', 'dm', 'dms', 'direct', 'message', 'messages', 'group', 'groups', 'private', 'conversation', 'conversations', 'thread', 'threads',
  'post', 'posts', 'posted', 'write', 'wrote', 'written', 'say', 'said', 'send', 'sent', 'tell', 'told', 'messaged', 'ask', 'asked', 'share', 'shared', 'reply', 'replied', 'answer', 'answered',
  'discuss', 'discussed', 'talk', 'talked', 'chatted', 'speak', 'spoke', 'latest', 'newest', 'recent', 'recently', 'lately', 'new', 'news', 'anything', 'something', 'everything', 'happening', 'happened', 'going',
  'named', 'called', 'what', 'whats', "what's", 'did', 'has', 'have', 'had', 'me', 'my', 'i', 'we', 'us', 'and', 'with', 'from', 'by', 'in', 'on', 'the', 'a', 'an', 'is', 'are', 'of', 'to', 'about',
  'this', 'last', 'past', 'week', 'month', 'today', 'yesterday', 'topics', 'topic', 'stuff', 'things', 'update', 'updates',
]);

function cleanName(raw: string): string | undefined {
  const parts = raw.trim().replace(/[.,!?;:'’]+$/u, '').split(/\s+/u).filter(Boolean);
  while (parts.length > 0 && NAME_TAIL.has(parts[parts.length - 1]!.toLowerCase())) parts.pop();
  if (parts.length === 0) return undefined;
  const name = parts.join(' ');
  return NOT_A_PERSON.has(parts[0]!.toLowerCase()) ? undefined : name;
}

function cleanChannel(raw: string): string | undefined {
  const parts = raw.trim().replace(/[.!?,;:]+$/u, '').split(/\s+/u).filter(Boolean);
  while (parts.length > 0 && CHANNEL_EDGE.has(parts[0]!.toLowerCase())) parts.shift();
  while (parts.length > 0 && CHANNEL_EDGE.has(parts[parts.length - 1]!.toLowerCase())) parts.pop();
  const name = parts.join(' ');
  return name === '' || CHANNEL_PLACEHOLDER.test(name) ? undefined : name;
}

/** The channel a question names, cleaned of "named", "called", "team chat" and articles, or nothing. */
export function spokenChannel(question: string): string | undefined {
  const hash = CHANNEL_HASH.exec(question)?.[1];
  if (hash !== undefined) return hash;
  for (const shape of [CHANNEL_CALLED, CHANNEL_BEFORE, CHANNEL_AFTER]) {
    const found = shape.exec(question)?.[1];
    const name = found === undefined ? undefined : cleanChannel(found);
    if (name !== undefined) return name;
  }
  return undefined;
}

function groupPeople(question: string): string[] | undefined {
  const list = GROUP_WITH.exec(question)?.[1];
  if (list === undefined) return undefined;
  const names = list.split(/\s*,\s*|\s+and\s+|\s*&\s*/iu).map(cleanName).filter((name): name is string => name !== undefined);
  return names.length >= 2 ? [...new Set(names)].slice(0, 4) : undefined;
}

/** Whether the ask is one of the person, group or channel chat shapes, so the chat source is routed for it. */
export function chatAsk(question: string): boolean {
  if (groupPeople(question) !== undefined) return true;
  for (const shape of [PERSON_SAID, PERSON_FROM, PERSON_WITH, PERSON_DISCUSS, PERSON_AND_I]) {
    const found = shape.exec(question)?.[1];
    if (found !== undefined && cleanName(found) !== undefined) return true;
  }
  return CHANNEL_HASH.test(question) || CHANNEL_CALLED.test(question) || CHANNEL_BEFORE.test(question);
}

// ---- backwards windows in the owner's zone -------------------------------------------------------

const DAY_MS = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function localDay(nowMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
}
function shift(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, date!) + days * DAY_MS).toISOString().slice(0, 10);
}
function weekday(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, date!)).getUTCDay();
}
function mondayOf(day: string): string {
  return shift(day, -((weekday(day) + 6) % 7));
}

/**
 * The window a chat ask names, looking backwards: chat holds what was said, so a day that has not come yet
 * names no chat window at all (N-1: "the conference next week" sent a future start and read nothing).
 */
export function chatWindow(question: string, nowMs: number, timeZone: string): ChatWindow {
  const text = question.toLowerCase();
  const today = localDay(nowMs, timeZone);
  if (/\b(?:tomorrow|next week|next month|upcoming|coming week|next (?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/u.test(text)) return { future: true };
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(text)?.[1];
  if (iso !== undefined) return iso > today ? { future: true } : { from: iso, to: iso };
  if (/\btoday\b|\bthis morning\b/u.test(text)) return { from: today };
  if (/\byesterday\b/u.test(text)) { const day = shift(today, -1); return { from: day, to: day }; }
  if (/\blast week\b/u.test(text)) { const monday = shift(mondayOf(today), -7); return { from: monday, to: shift(monday, 6) }; }
  if (/\bthis week\b/u.test(text)) return { from: mondayOf(today) };
  if (/\b(?:past|last) (?:7|seven) days\b|\bpast week\b|\bthis past week\b/u.test(text)) return { from: shift(today, -7) };
  if (/\bthis month\b/u.test(text)) return { from: `${today.slice(0, 7)}-01` };
  if (/\blast month\b/u.test(text)) {
    const first = `${today.slice(0, 7)}-01`;
    const previousEnd = shift(first, -1);
    return { from: `${previousEnd.slice(0, 7)}-01`, to: previousEnd };
  }
  const named = new RegExp(`\\b(?:last |on )?(${WEEKDAYS.join('|')})\\b`, 'u').exec(text)?.[1];
  if (named !== undefined) {
    const back = (weekday(today) - WEEKDAYS.indexOf(named) + 7) % 7;
    const day = shift(today, -back);
    return { from: day, to: day };
  }
  return {};
}

/** "about the pilot plan": the topic of a person, group or channel read is what the owner said it was about. */
const ABOUT = /\b(?:about|regarding|concerning|on the topic of)\s+(.{1,80}?)(?=$|[?!,;]|\.(?:\s|$)|\s(?:this|last|today|yesterday|since|lately|recently|in the|on the|from)\b)/iu;
const ABOUT_STOP = new Set(['the', 'a', 'an', 'our', 'my', 'his', 'her', 'their', 'that', 'this', 'it', 'its', 'of', 'for', 'to', 'and', 'or']);

function aboutTerms(question: string, removed: readonly string[]): string {
  const spoken = ABOUT.exec(question)?.[1];
  if (spoken === undefined) return '';
  const drop = new Set(removed.flatMap(entry => entry.toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter(Boolean));
  return spoken.split(/\s+/u)
    .map(word => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(word => word !== '' && !drop.has(word) && !ABOUT_STOP.has(word) && !CHAT_FILLER.has(word))
    .slice(0, 4).join(' ');
}

/**
 * The chat read an ask wants. `terms` are the topic words the research route already compiled (fillers and
 * date operators gone) and stay the query of a plain topic search. A person, group or channel read narrows
 * only by what the owner said it was about, so a model's topic paraphrase (a surname, "update") never
 * turns a read of the right conversation into an empty one.
 */
export function chatIntent(question: string, options: { terms: string; nowMs: number; timeZone: string }): ChatIntent {
  const window = chatWindow(question, options.nowMs, options.timeZone);
  const people = groupPeople(question);
  if (people !== undefined) return { kind: 'group-chat', people, terms: aboutTerms(question, people), window };
  const person = (shape: RegExp): string | undefined => {
    const found = shape.exec(question)?.[1];
    return found === undefined ? undefined : cleanName(found);
  };
  const discussed = person(PERSON_DISCUSS) ?? person(PERSON_AND_I);
  if (discussed !== undefined) return { kind: 'person-overview', person: discussed, terms: aboutTerms(question, [discussed]), window };
  const withThem = person(PERSON_WITH);
  if (withThem !== undefined) return { kind: 'person-said', person: withThem, sides: 'both', terms: aboutTerms(question, [withThem]), window };
  const said = person(PERSON_SAID) ?? person(PERSON_FROM);
  if (said !== undefined) return { kind: 'person-said', person: said, sides: 'theirs', terms: aboutTerms(question, [said]), window };
  const channel = spokenChannel(question);
  if (channel !== undefined) return { kind: 'channel-recent', channel, terms: aboutTerms(question, [channel]), window };
  return { kind: 'topic-search', terms: options.terms, window };
}

/** The one sub-call a chat intent issues. A topic search keeps the plain search; the rest use the chat read. */
export function chatSubs(intent: ChatIntent, limit: number, fallbackQuery: string): IntentSubCall[] {
  const window: JsonObject = {};
  if (!intent.window.future && intent.window.from !== undefined) window['from_date'] = intent.window.from;
  if (!intent.window.future && intent.window.to !== undefined) window['to_date'] = intent.window.to;
  const query = intent.terms.trim();
  if (intent.kind === 'topic-search') {
    const args: JsonObject = { query: query !== '' ? query : fallbackQuery, limit };
    if (window['from_date'] !== undefined) args['after'] = window['from_date'];
    if (window['to_date'] !== undefined) args['before'] = window['to_date'];
    return [{ key: 'c0', name: CHAT_SEARCH_TOOL, args }];
  }
  const args: JsonObject = { intent: intent.kind === 'person-said' ? 'person' : intent.kind === 'person-overview' ? 'overview' : intent.kind === 'channel-recent' ? 'channel' : 'group', limit, ...window };
  if (intent.person !== undefined) args['person'] = intent.person;
  if (intent.people !== undefined) args['people'] = intent.people;
  if (intent.channel !== undefined) args['channel'] = intent.channel;
  if (intent.sides !== undefined) args['sides'] = intent.sides;
  if (query !== '') args['query'] = query;
  return [{ key: 'c0', name: CHAT_READ_TOOL, args }];
}
