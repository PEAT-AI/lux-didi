import type { TrelloCallCode, TrelloCallResult, TrelloServerTool, TrelloTransport } from '../../tools/trello.js';

/**
 * The one Trello REST client: api.trello.com/1 with the owner's own API key and token as query
 * parameters, exactly the operations the board uses and nothing wider. No sign-in, no OAuth, no
 * session: a key file the owner imports once. A key and a token are never logged, never returned and
 * never put in an error.
 */
export const TRELLO_API_URL = 'https://api.trello.com/1';
const TIMEOUT_MS = 12_000;
/** A reply is read up to this many bytes and no further, so no body is buffered without a bound. */
const REPLY_LIMIT = 1_048_576;
const FIELDS = 'username,email,fullName';

type Args = Record<string, unknown>;

/** Per action: the fields the server accepts. The board plans every call against this and nothing else. */
export const TRELLO_ACTIONS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  trelloReadMember: { get_me: [] },
  trelloReadBoard: { list: ['cursor'], list_labels: ['boardId', 'cursor'] },
  trelloReadList: { list_by_board: ['boardId', 'cursor'] },
  trelloReadCard: { get: ['cardId'], list_by_list: ['listId', 'cursor'], list_comments: ['cardId', 'cursor'] },
  trelloReadChecklist: { list_by_card: ['cardId', 'cursor'] },
  trelloReadInbox: { list: ['cursor'] },
  trelloWriteCard: {
    create: ['listId', 'name', 'desc', 'due', 'pos'], update: ['cardId', 'name', 'desc', 'due', 'dueComplete'],
    move: ['cardId', 'listId', 'pos'], archive: ['cardId'],
    add_label: ['cardId', 'labelId'], attach_label: ['cardId', 'labelId'], remove_label: ['cardId', 'labelId'], detach_label: ['cardId', 'labelId'],
  },
  trelloWriteChecklist: {
    create: ['cardId', 'name', 'pos'], add_item: ['checklistId', 'name', 'pos'], create_item: ['checklistId', 'name', 'pos'],
    update_item: ['checklistId', 'itemId', 'name', 'state'],
  },
};

/** The advertised shapes the board's planner reads: one branch per action, its own fields only. */
export function trelloSchemas(): TrelloServerTool[] {
  return Object.entries(TRELLO_ACTIONS).map(([name, actions]) => ({
    name, inputSchema: {
      type: 'object', required: ['action'],
      oneOf: Object.entries(actions).map(([action, props]) => ({
        properties: { action: { const: action }, ...Object.fromEntries(props.map(prop => [prop, {}])) }, required: ['action'],
      })),
    },
  }));
}

export interface TrelloRestOptions {
  /** The owner rule: the member behind the key must be this member. Checked once, before the first call. */
  identity?: { email?: string; username?: string };
  /** The base every request goes to; api.trello.com/1 in the product, a loopback origin in a test. */
  url?: string;
  /** The owner's key and token, read from the private key file; nothing at all means not configured. */
  credentials: () => Promise<{ ok: true; key: string; token: string } | { ok: false; code: TrelloCallCode }>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface Request { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; query?: Record<string, string>; body?: Args }

const defined = (value: Args): Args => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

/** One accepted call as its REST requests: the same operation, in Trello's own words. */
export function trelloRequests(tool: string, args: Args): { requests: Request[]; cardId?: string } | undefined {
  const action = String(args.action ?? '');
  if (TRELLO_ACTIONS[tool]?.[action] === undefined) return undefined;
  const card = typeof args.cardId === 'string' ? args.cardId : undefined;
  const path = (segments: readonly (string | undefined)[]): string => segments.filter(segment => segment !== undefined).map(segment => encodeURIComponent(String(segment))).join('/');
  switch (`${tool}.${action}`) {
    case 'trelloReadMember.get_me': return { requests: [{ method: 'GET', path: 'members/me', query: { fields: FIELDS } }] };
    case 'trelloReadBoard.list': return { requests: [{ method: 'GET', path: 'boards', ...(typeof args.cursor === 'string' ? { query: { cursor: args.cursor } } : {}) }] };
    case 'trelloReadBoard.list_labels': return { requests: [{ method: 'GET', path: `boards/${path([String(args.boardId)])}/labels`, ...(typeof args.cursor === 'string' ? { query: { cursor: args.cursor } } : {}) }] };
    case 'trelloReadList.list_by_board': return { requests: [{ method: 'GET', path: `boards/${path([String(args.boardId)])}/lists`, ...(typeof args.cursor === 'string' ? { query: { cursor: args.cursor } } : {}) }] };
    case 'trelloReadCard.get': return { requests: [{ method: 'GET', path: `cards/${path([card])}` }] };
    case 'trelloReadCard.list_by_list': return { requests: [{ method: 'GET', path: `lists/${path([String(args.listId)])}/cards`, ...(typeof args.cursor === 'string' ? { query: { cursor: args.cursor } } : {}) }] };
    case 'trelloReadCard.list_comments': return { requests: [{ method: 'GET', path: `cards/${path([card])}/actions`, query: { filter: 'commentCard' } }] };
    case 'trelloReadChecklist.list_by_card': return { requests: [{ method: 'GET', path: `cards/${path([card])}/checklists` }] };
    case 'trelloWriteCard.create': return { requests: [{ method: 'POST', path: 'cards', body: defined({ idList: args.listId, name: args.name, desc: args.desc, due: args.due, pos: args.pos }) }] };
    case 'trelloWriteCard.update': return { requests: [{ method: 'PUT', path: `cards/${path([card])}`, body: defined({ name: args.name, desc: args.desc, due: args.due, dueComplete: args.dueComplete }) }], ...(card ? { cardId: card } : {}) };
    case 'trelloWriteCard.move': return { requests: [{ method: 'PUT', path: `cards/${path([card])}`, body: defined({ idList: args.listId, pos: args.pos }) }], ...(card ? { cardId: card } : {}) };
    case 'trelloWriteCard.archive': return { requests: [{ method: 'PUT', path: `cards/${path([card])}`, body: { closed: true } }], ...(card ? { cardId: card } : {}) };
    case 'trelloWriteCard.add_label': case 'trelloWriteCard.attach_label':
      return { requests: [{ method: 'POST', path: `cards/${path([card])}/idLabels`, body: { value: args.labelId } }], ...(card ? { cardId: card } : {}) };
    case 'trelloWriteCard.remove_label': case 'trelloWriteCard.detach_label':
      return { requests: [{ method: 'DELETE', path: `cards/${path([card])}/idLabels/${path([String(args.labelId)])}` }], ...(card ? { cardId: card } : {}) };
    case 'trelloWriteChecklist.create': return { requests: [{ method: 'POST', path: 'checklists', body: defined({ idCard: args.cardId, name: args.name, pos: args.pos }) }] };
    case 'trelloWriteChecklist.add_item': case 'trelloWriteChecklist.create_item':
      return { requests: [{ method: 'POST', path: `checklists/${path([String(args.checklistId)])}/checkItems`, body: defined({ name: args.name, pos: args.pos }) }] };
    case 'trelloWriteChecklist.update_item':
      return { requests: [{ method: 'PUT', path: `checklists/${path([String(args.checklistId)])}/checkItems/${path([String(args.itemId)])}`, body: defined({ name: args.name, state: args.state }) }] };
    // The Atlassian Inbox is a product surface with no REST endpoint: the read refuses rather than answering empty.
    case 'trelloReadInbox.list': return undefined;
    default: return undefined;
  }
}

/** The owner rule: the email when Trello gives one, otherwise the configured username. */
export function identityMatches(member: unknown, identity: { email?: string; username?: string }): boolean {
  const record = member && typeof member === 'object' ? member as { username?: unknown; email?: unknown } : {};
  const email = typeof record.email === 'string' && record.email.trim() !== '' ? record.email.trim().toLowerCase() : undefined;
  const username = typeof record.username === 'string' && record.username.trim() !== '' ? record.username.trim().toLowerCase() : undefined;
  const wantedEmail = identity.email?.trim().toLowerCase();
  const wantedUsername = identity.username?.trim().toLowerCase();
  if (email !== undefined && wantedEmail !== undefined) return email === wantedEmail;
  return username !== undefined && wantedUsername !== undefined && username === wantedUsername;
}

/** https everywhere, except a loopback origin, which is how a test stands in for the real host. */
export function trelloOriginAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  } catch { return false; }
}

/** Read the body under a hard byte bound; a reply over it is no reply at all. */
async function readBounded(response: Response, limit: number): Promise<string | undefined> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
}

const retryAfterMs = (response: Response): number => {
  const header = response.headers.get('retry-after');
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 30_000) : 1000;
};

export function createTrelloRestTransport(options: TrelloRestOptions): TrelloTransport {
  const base = (options.url ?? TRELLO_API_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  let verified: Promise<{ ok: true; value: unknown } | { ok: false; code: TrelloCallCode }> | undefined;

  return {
    async tools(): Promise<{ ok: true; value: readonly TrelloServerTool[] } | { ok: false; code: TrelloCallCode }> {
      return { ok: true, value: trelloSchemas() };
    },

    async call(tool: string, args: Args, signal?: AbortSignal): Promise<TrelloCallResult> {
      // The Atlassian Inbox is not reachable with a key and a token: the boards and cards REST API has
      // no inbox, so the read says so in words instead of answering with an empty list.
      if (tool === 'trelloReadInbox' && String(args.action) === 'list') return { ok: false, code: 'inbox_unavailable' };
      const planned = trelloRequests(tool, args);
      if (!planned) return { ok: false, code: 'not_allowed' };
      if (!trelloOriginAllowed(base)) return { ok: false, code: 'not_allowed' };
      const credentials = await options.credentials();
      if (!credentials.ok) return { ok: false, code: credentials.code };
      /** One request, its typed refusal, and the body read under the byte bound. */
      const perform = async (request: Request, key: string, token: string): Promise<{ ok: true; value: unknown } | { ok: false; code: TrelloCallCode }> => {
        const url = new URL(`${base}/${request.path}`);
        url.searchParams.set('key', key);
        url.searchParams.set('token', token);
        for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value);
        const attempt = async (): Promise<Response | { ok: false; code: TrelloCallCode }> => {
          try {
            return await doFetch(url, {
              method: request.method,
              headers: { accept: 'application/json', ...(request.body ? { 'content-type': 'application/json' } : {}) },
              ...(request.body ? { body: JSON.stringify(request.body) } : {}),
              redirect: 'error',
              signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
            });
          } catch {
            // A read that never got an answer changed nothing; a write may have landed, so it stays unknown.
            return { ok: false, code: request.method === 'GET' ? 'unavailable' : 'unknown' };
          }
        };
        let response = await attempt();
        if (!(response instanceof Response)) return response;
        if (response.status === 429) {
          await sleep(retryAfterMs(response));
          response = await attempt();
          if (!(response instanceof Response)) return response;
          if (response.status === 429) return { ok: false, code: 'rate_limited' };
        }
        if (response.status === 401 || response.status === 403) return { ok: false, code: 'credential_revoked' };
        if (response.status === 404) return { ok: false, code: 'tool_error' };
        if (response.status >= 500) return { ok: false, code: 'unavailable' };
        if (!response.ok) return { ok: false, code: 'tool_error' };
        const text = await readBounded(response, REPLY_LIMIT);
        if (text === undefined) return { ok: false, code: 'protocol_error' };
        try { return { ok: true, value: text === '' ? undefined : JSON.parse(text) }; } catch { return { ok: false, code: 'protocol_error' }; }
      };
      if (options.identity) {
        verified ??= (async (): Promise<{ ok: true; value: unknown } | { ok: false; code: TrelloCallCode }> => {
          const me = await perform({ method: 'GET', path: 'members/me', query: { fields: FIELDS } }, credentials.key, credentials.token);
          if (!me.ok) return me;
          return identityMatches(me.value, options.identity!) ? { ok: true, value: {} } : { ok: false, code: 'credential_mismatch' };
        })();
        const owner = await verified;
        if (!owner.ok) return owner;
      }
      for (const request of planned.requests) {
        const sent = await perform(request, credentials.key, credentials.token);
        if (!sent.ok) return sent;
        const value = sent.value;
        // A write is answered by the record it changed; another card's record is attributed to nothing.
        if (planned.cardId !== undefined) {
          const holder = value && typeof value === 'object' ? value as { id?: unknown; card?: { id?: unknown } } : {};
          const record = holder.card?.id ?? holder.id;
          if (typeof record === 'string' && record !== planned.cardId) return { ok: false, code: 'protocol_error' };
        }
        return { ok: true, value };
      }
      return { ok: false, code: 'unknown' };
    },
  };
}
