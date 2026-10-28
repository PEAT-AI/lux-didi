import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A synthetic Trello MCP server and its authorization server, on two loopback origins like the real
 * pair (the resource and the issuer are different origins, and the issuer has a path). Tool names,
 * action dispatch and ARI ids follow the server's published skill (skills/trello-use/SKILL.md); the
 * exact input schemas are not published without a sign-in, so these are the fake's own, strict:
 * a field the action does not use is rejected. Boards, lists, cards and labels are invented.
 */
export const FAKE_TENANT = 'Tenant0fake';
/** The board name every fixture pins: no private name belongs in this public repository (W7-R2, F11). */
export const SYNTHETIC_BOARD = 'Harbour Notes';
export const FAKE_WORKSPACE = 'w0fake';
const ari = (entity: string, id: string) => `ari:cloud:trello::${entity}/workspace/${FAKE_WORKSPACE}/${id}`;
let counter = 0;
/** A Trello-style object id whose first eight hex digits are the creation second. */
export function objectId(createdAtMs: number): string {
  counter += 1;
  return Math.floor(createdAtMs / 1000).toString(16).padStart(8, '0') + counter.toString(16).padStart(16, '0');
}

export interface FakeCard { id: string; name: string; desc: string; due: string | null; dueComplete: boolean; listId: string; boardId: string; closed: boolean; labelIds: string[] }
export interface FakeList { id: string; name: string; boardId: string; closed: boolean }
export interface FakeLabel { id: string; name: string; color: string; boardId: string }
export interface FakeChecklist { id: string; name: string; cardId: string; items: { id: string; name: string; state: 'complete' | 'incomplete' }[] }

export interface TrelloFakeOptions {
  /** Board name the owner pins; a second board holds a foreign list and card. */
  boardName?: string;
  /** Collection pages are this long, so paging is exercised. */
  pageSize?: number;
  /** The key and token the owner's key file carries; any other pair is refused with 401. */
  key?: string;
  token?: string;
  /** The member `GET /1/members/me` answers with, so an identity mismatch can be exercised. */
  member?: { id: string; username: string; email?: string; fullName?: string };
  now: number;
}

export interface TrelloFake {
  /** The loopback origin the REST client is pointed at, standing in for https://api.trello.com/1. */
  url: string;
  key: string; token: string;
  member: { id: string; username: string; email?: string; fullName?: string };
  boards: { id: string; name: string; closed: boolean }[];
  lists: FakeList[]; cards: FakeCard[]; labels: FakeLabel[]; checklists: FakeChecklist[];
  /** Every call the REST surface received, in order: the server tool and action it stands for. */
  calls: { tool: string; args: Record<string, unknown> }[];
  /** The next write is received and then the connection is cut with no answer. */
  dropNextCall(): void;
  /** The next write answers 400 and changes nothing. */
  failNextCall(): void;
  /** The next N calls answer 429 with this Retry-After, before any work is done. */
  rateLimitNextCall(times: number, retryAfterSeconds?: number): void;
  /** The next write answers with a reply carrying another id. */
  replyWithWrongId(): void;
  /** The next write is answered with a reply at least this many bytes. */
  bloatNextReply(bytes: number): void;
  close(): Promise<void>;
}

const TOOL_ACTIONS: Record<string, Record<string, { props: string[]; required: string[] }>> = {
  trelloReadMember: { get_me: { props: [], required: [] } },
  trelloReadBoard: { get: { props: ['boardId'], required: ['boardId'] }, list: { props: ['cursor'], required: [] }, list_labels: { props: ['boardId', 'cursor'], required: ['boardId'] } },
  trelloReadList: { list_by_board: { props: ['boardId', 'cursor'], required: ['boardId'] } },
  trelloReadCard: { get: { props: ['cardId'], required: ['cardId'] }, list_by_list: { props: ['listId', 'cursor'], required: ['listId'] }, list_comments: { props: ['cardId', 'cursor'], required: ['cardId'] } },
  trelloReadChecklist: { list_by_card: { props: ['cardId', 'cursor'], required: ['cardId'] } },
  trelloSearch: { search: { props: ['query'], required: ['query'] } },
  trelloWriteCard: {
    create: { props: ['listId', 'name', 'desc', 'due', 'pos'], required: ['listId', 'name'] },
    update: { props: ['cardId', 'name', 'desc', 'due', 'dueComplete'], required: ['cardId'] },
    move: { props: ['cardId', 'listId', 'pos'], required: ['cardId', 'listId'] },
    archive: { props: ['cardId'], required: ['cardId'] },
    add_label: { props: ['cardId', 'labelId'], required: ['cardId', 'labelId'] },
    remove_label: { props: ['cardId', 'labelId'], required: ['cardId', 'labelId'] },
  },
  trelloWriteChecklist: {
    create: { props: ['cardId', 'name', 'pos'], required: ['cardId', 'name'] },
    add_item: { props: ['checklistId', 'name', 'pos'], required: ['checklistId', 'name'] },
    update_item: { props: ['cardId', 'checklistId', 'itemId', 'name', 'state'], required: ['checklistId', 'itemId'] },
  },
  trelloWriteBoard: { create: { props: ['name'], required: ['name'] } },
  trelloWriteList: { create: { props: ['boardId', 'name'], required: ['boardId', 'name'] }, move: { props: ['listId', 'boardId'], required: ['listId'] } },
  trelloReadPlanner: { get: { props: [], required: [] } },
  trelloWritePlanner: { create: { props: ['start', 'end'], required: ['start', 'end'] } },
};

/** The advertised schemas: one object per tool with an action enum and one branch per action. */
async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
const json = (response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(value));
};
async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as AddressInfo).port;
}

export async function startTrelloFake(options: TrelloFakeOptions): Promise<TrelloFake> {
  const now = options.now;
  const pageSize = options.pageSize ?? 2;
  const pin = { id: ari('board', objectId(now - 400 * 86_400_000)), name: options.boardName ?? SYNTHETIC_BOARD, closed: false };
  const other = { id: ari('board', objectId(now - 300 * 86_400_000)), name: 'Team board', closed: false };
  const boards = [pin, other];
  const listNames = ['Sprint', 'Short Term Backlog', 'Long Term Backlog', 'Ideas', 'Waiting for X', 'Done'];
  const lists: FakeList[] = listNames.map(name => ({ id: ari('list', objectId(now - 200 * 86_400_000)), name, boardId: pin.id, closed: false }));
  lists.push({ id: ari('list', objectId(now - 100 * 86_400_000)), name: 'Sprint', boardId: other.id, closed: false });
  const labels: FakeLabel[] = [
    { id: ari('label', objectId(now - 90 * 86_400_000)), name: '', color: 'green', boardId: pin.id },
    { id: ari('label', objectId(now - 90 * 86_400_000)), name: '', color: 'red', boardId: pin.id },
  ];
  const listId = (name: string, boardId = pin.id) => lists.find(list => list.name === name && list.boardId === boardId)!.id;
  const card = (name: string, list: string, extra: Partial<FakeCard> = {}, createdAt = now - 10 * 86_400_000): FakeCard =>
    ({ id: ari('card', objectId(createdAt)), name, desc: '', due: null, dueComplete: false, listId: listId(list), boardId: pin.id, closed: false, labelIds: [], ...extra });
  const day = 86_400_000;
  const cards: FakeCard[] = [
    card('Draft the quarterly plan', 'Sprint', { due: new Date(now - 2 * day).toISOString() }),
    card('Review the pilot budget', 'Sprint', { due: new Date(now + 2 * 3_600_000).toISOString() }),
    card('Book the venue', 'Sprint', { due: new Date(now + 3 * day).toISOString() }),
    card('Call the plumber', 'Short Term Backlog'),
    card('Renew the passport', 'Short Term Backlog'),
    card('Sort the photo archive', 'Long Term Backlog'),
    card('Garden shed idea', 'Ideas'),
    card('Quick note from the phone', 'Ideas', {}, now - 60_000),
    card('Answer from the bank', 'Waiting for X'),
    card('Old finished task', 'Done'),
    card('Another finished task', 'Done'),
    card('Plan review', 'Short Term Backlog'),
    card('Plan review', 'Long Term Backlog'),
  ];
  cards.push({ id: ari('card', objectId(now - 5 * day)), name: 'Foreign card', desc: '', due: null, dueComplete: false, listId: listId('Sprint', other.id), boardId: other.id, closed: false, labelIds: [] });
  const comments = [{ id: ari('comment', objectId(now - 2 * day)), cardId: cards[2]!.id, text: 'Rang the venue, they hold the room until Friday' }];
  const checklists: FakeChecklist[] = [{ id: ari('checklist', objectId(now - 9 * day)), name: 'Prep', cardId: cards[2]!.id, items: [{ id: ari('check-item', objectId(now - 9 * day)), name: 'Call the venue', state: 'incomplete' }] }];

  const calls: TrelloFake['calls'] = [];
  let drop = false; let fail = false; let wrongId = false; let bloat: number | undefined;
  let limited: { times: number; retryAfter: number } | undefined;

  const cardJson = (value: FakeCard) => ({ id: value.id, name: value.name, desc: value.desc, due: value.due, dueComplete: value.dueComplete, listId: value.listId, boardId: value.boardId, closed: value.closed,
    labels: value.labelIds.map(id => labels.find(label => label.id === id)!).map(label => ({ id: label.id, name: label.name, color: label.color })), dateLastActivity: new Date(now).toISOString() });
  const page = <T>(items: T[], cursor: unknown) => {
    const start = typeof cursor === 'string' ? Number(cursor) : 0;
    const slice = items.slice(start, start + pageSize);
    const next = start + pageSize < items.length ? String(start + pageSize) : undefined;
    return { slice, pageInfo: { hasNextPage: next !== undefined, ...(next ? { endCursor: next } : {}) } };
  };
  const toolError = (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] });
  const ok = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

  function run(tool: string, args: Record<string, unknown>): unknown {
    const shape = TOOL_ACTIONS[tool]?.[String(args.action)];
    if (!shape) return toolError('unknown tool or action');
    if (Object.keys(args).some(key => key !== 'action' && !shape.props.includes(key))) return toolError('field not used by this action');
    if (shape.required.some(key => args[key] === undefined)) return toolError('missing field');
    const findCard = (id: unknown) => cards.find(entry => entry.id === id);
    switch (`${tool}.${String(args.action)}`) {
      case 'trelloReadMember.get_me': return ok({ id: 'ari:cloud:trello::user/0', prefs: { timezone: 'UTC' } });
      case 'trelloReadBoard.list': { const p = page(boards, args.cursor); return ok({ boards: p.slice, pageInfo: p.pageInfo }); }
      case 'trelloReadBoard.list_labels': { const p = page(labels.filter(label => label.boardId === args.boardId), args.cursor); return ok({ labels: p.slice, pageInfo: p.pageInfo }); }
      case 'trelloReadList.list_by_board': { const p = page(lists.filter(list => list.boardId === args.boardId && !list.closed), args.cursor); return ok({ lists: p.slice.map(list => ({ id: list.id, name: list.name, closed: list.closed })), pageInfo: p.pageInfo }); }
      case 'trelloReadCard.list_by_list': { const p = page(cards.filter(entry => entry.listId === args.listId && !entry.closed), args.cursor); return ok({ cards: p.slice.map(cardJson), pageInfo: p.pageInfo }); }
      case 'trelloReadCard.get': { const found = findCard(args.cardId); return found ? ok({ card: cardJson(found) }) : toolError('not found'); }
      case 'trelloReadCard.list_comments': { const p = page(comments.filter(entry => entry.cardId === args.cardId), args.cursor); return ok({ comments: p.slice.map(entry => ({ id: entry.id, text: entry.text })), pageInfo: p.pageInfo }); }
      case 'trelloReadChecklist.list_by_card': { const p = page(checklists.filter(list => list.cardId === args.cardId), args.cursor); return ok({ checklists: p.slice.map(list => ({ id: list.id, name: list.name, checkItems: list.items })), pageInfo: p.pageInfo }); }
      case 'trelloWriteCard.create': {
        if (!lists.some(list => list.id === args.listId)) return toolError('list not found');
        const created: FakeCard = { id: ari('card', objectId(now)), name: String(args.name), desc: String(args.desc ?? ''), due: typeof args.due === 'string' ? args.due : null, dueComplete: false, listId: String(args.listId), boardId: lists.find(list => list.id === args.listId)!.boardId, closed: false, labelIds: [] };
        cards.push(created); return ok({ card: cardJson(created) });
      }
      case 'trelloWriteCard.update': {
        const found = findCard(args.cardId); if (!found) return toolError('not found');
        if (args.name !== undefined) found.name = String(args.name);
        if (args.desc !== undefined) found.desc = String(args.desc);
        if (args.due !== undefined) found.due = args.due === null ? null : String(args.due);
        if (args.dueComplete !== undefined) found.dueComplete = args.dueComplete === true;
        return ok({ card: cardJson(found) });
      }
      case 'trelloWriteCard.move': { const found = findCard(args.cardId); if (!found || !lists.some(list => list.id === args.listId)) return toolError('not found'); found.listId = String(args.listId); return ok({ card: cardJson(found) }); }
      case 'trelloWriteCard.archive': { const found = findCard(args.cardId); if (!found) return toolError('not found'); found.closed = true; return ok({ card: cardJson(found) }); }
      case 'trelloWriteCard.add_label': { const found = findCard(args.cardId); if (!found) return toolError('not found'); if (!found.labelIds.includes(String(args.labelId))) found.labelIds.push(String(args.labelId)); return ok({ card: cardJson(found) }); }
      case 'trelloWriteCard.remove_label': { const found = findCard(args.cardId); if (!found) return toolError('not found'); found.labelIds = found.labelIds.filter(id => id !== args.labelId); return ok({ card: cardJson(found) }); }
      case 'trelloWriteChecklist.create': { const created: FakeChecklist = { id: ari('checklist', objectId(now)), name: String(args.name), cardId: String(args.cardId), items: [] }; checklists.push(created); return ok({ checklist: { id: created.id, name: created.name } }); }
      case 'trelloWriteChecklist.add_item': {
        const list = checklists.find(entry => entry.id === args.checklistId); if (!list) return toolError('not found');
        const item = { id: ari('check-item', objectId(now)), name: String(args.name), state: 'incomplete' as const }; list.items.push(item); return ok({ checkItem: item });
      }
      case 'trelloWriteChecklist.update_item': {
        const list = checklists.find(entry => entry.id === args.checklistId); const item = list?.items.find(entry => entry.id === args.itemId);
        if (!item) return toolError('not found'); if (args.state === 'complete' || args.state === 'incomplete') item.state = args.state; return ok({ checkItem: item });
      }
      default: return toolError('not implemented in the fake');
    }
  }

  // The REST surface: api.trello.com/1, key and token as query parameters, exactly the calls the board makes.
  const key = options.key ?? 'fakekey00000000000000000';
  const token = options.token ?? 'faketoken0000000000000000';
  const member = options.member ?? { id: 'member0fake', username: 'robplantix', email: 'rob@plantix.net', fullName: 'Rob' };
  const only = (payload: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
    Object.fromEntries(keys.filter(name => payload[name] !== undefined).map(name => [name, payload[name]]));

  /** One REST request as the server tool and action it stands for; nothing else is reachable. */
  function route(method: string, parts: string[], query: URLSearchParams, payload: Record<string, unknown>): [string, Record<string, unknown>] | undefined {
    const path = `/${parts.join('/')}`;
    const id = (index: number) => decodeURIComponent(parts[index] ?? '');
    const page = (args: Record<string, unknown>): Record<string, unknown> => query.get('cursor') === null ? args : { ...args, cursor: String(query.get('cursor')) };
    if (method === 'GET' && path === '/members/me/boards') return ['trelloReadBoard', page({ action: 'list' })];
    if (method === 'GET' && parts[0] === 'boards' && parts[2] === 'labels') return ['trelloReadBoard', page({ action: 'list_labels', boardId: id(1) })];
    if (method === 'GET' && parts[0] === 'boards' && parts[2] === 'lists') return ['trelloReadList', page({ action: 'list_by_board', boardId: id(1) })];
    if (method === 'GET' && parts[0] === 'lists' && parts[2] === 'cards') return ['trelloReadCard', page({ action: 'list_by_list', listId: id(1) })];
    if (method === 'GET' && parts[0] === 'cards' && parts[2] === 'actions') return ['trelloReadCard', page({ action: 'list_comments', cardId: id(1) })];
    if (method === 'GET' && parts[0] === 'cards' && parts[2] === 'checklists') return ['trelloReadChecklist', page({ action: 'list_by_card', cardId: id(1) })];
    if (method === 'GET' && parts[0] === 'cards' && parts.length === 2) return ['trelloReadCard', { action: 'get', cardId: id(1) }];
    if (method === 'POST' && path === '/cards') return ['trelloWriteCard', { action: 'create', ...only(payload, ['name', 'desc', 'due', 'pos']), listId: payload.idList }];
    if (method === 'PUT' && parts[0] === 'cards' && parts.length === 2) {
      if ('closed' in payload) return ['trelloWriteCard', { action: 'archive', cardId: id(1) }];
      if ('idList' in payload) return ['trelloWriteCard', { action: 'move', cardId: id(1), listId: payload.idList, ...only(payload, ['pos']) }];
      return ['trelloWriteCard', { action: 'update', cardId: id(1), ...only(payload, ['name', 'desc', 'due', 'dueComplete']) }];
    }
    if (method === 'POST' && parts[0] === 'cards' && parts[2] === 'idLabels') return ['trelloWriteCard', { action: 'add_label', cardId: id(1), labelId: payload.value }];
    if (method === 'DELETE' && parts[0] === 'cards' && parts[2] === 'idLabels') return ['trelloWriteCard', { action: 'remove_label', cardId: id(1), labelId: id(3) }];
    if (method === 'POST' && path === '/checklists') return ['trelloWriteChecklist', { action: 'create', cardId: payload.idCard, name: payload.name, ...only(payload, ['pos']) }];
    if (method === 'POST' && parts[0] === 'checklists' && parts[2] === 'checkItems') return ['trelloWriteChecklist', { action: 'add_item', checklistId: id(1), name: payload.name, ...only(payload, ['pos']) }];
    if (method === 'PUT' && parts[0] === 'cards' && parts[2] === 'checkItem') return ['trelloWriteChecklist', { action: 'update_item', cardId: id(1), checklistId: checklists.find(list => list.cardId === id(1) && list.items.some(item => item.id === id(3)))?.id, itemId: id(3), ...only(payload, ['name', 'state']) }];
    return undefined;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('key') !== key || url.searchParams.get('token') !== token) { json(response, 401, { message: 'invalid key or token' }); return; }
    if (request.method === 'GET' && url.pathname === '/1/members/me') { json(response, 200, member); return; }
    const method = request.method ?? 'GET';
    const raw = method === 'GET' ? '' : await body(request);
    const payload = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>;
    const planned = route(method, url.pathname.replace(/^\/1\//, '').split('/'), url.searchParams, payload);
    if (!planned) { json(response, 404, { message: 'no route' }); return; }
    if (limited && limited.times > 0) {
      limited.times -= 1;
      json(response, 429, { message: 'rate limited' }, { 'retry-after': String(limited.retryAfter) });
      return;
    }
    const [tool, args] = planned;
    calls.push({ tool, args: structuredClone(args) });
    // The write lands and the answer never comes: the caller cannot know, which is the case worth reading back.
    if (drop && tool.startsWith('trelloWrite')) { drop = false; run(tool, args); request.socket.destroy(); return; }
    if (fail && tool.startsWith('trelloWrite')) { fail = false; json(response, 400, { message: 'refused' }); return; }
    const answer = run(tool, args) as { isError?: boolean; content: { text: string }[] };
    const text = answer.content[0]?.text ?? '';
    if (answer.isError === true) { json(response, 400, { message: text }); return; }
    let value: unknown = JSON.parse(text);
    if (wrongId) {
      wrongId = false;
      const record = value as { card?: { id?: string } };
      value = record.card ? { ...record, card: { ...record.card, id: ari('card', objectId(now - 700 * 86_400_000)) } } : { items: [{}], pad: '' };
    }
    if (bloat !== undefined) { value = { ...(value as Record<string, unknown>), pad: 'x'.repeat(bloat) }; bloat = undefined; }
    json(response, 200, value);
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/1`, key, token, member, boards, lists, cards, labels, checklists, calls,
    dropNextCall() { drop = true; },
    failNextCall() { fail = true; },
    rateLimitNextCall(times: number, retryAfterSeconds = 1) { limited = { times, retryAfter: retryAfterSeconds }; },
    replyWithWrongId() { wrongId = true; },
    bloatNextReply(bytes: number) { bloat = bytes; },
    async close() { await new Promise<void>(resolve => { server.close(() => resolve()); }); },
  };
}
