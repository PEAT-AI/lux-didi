import { createHash, randomBytes } from 'node:crypto';
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
  /** Card list pages are this long, so paging is exercised. */
  pageSize?: number;
  now: number;
}

export interface TrelloFake {
  resource: string; issuer: string; mcpUrl: string;
  boards: { id: string; name: string; closed: boolean }[];
  lists: FakeList[]; cards: FakeCard[]; labels: FakeLabel[]; checklists: FakeChecklist[];
  /** Every tools/call the server received, in order: tool and arguments. */
  calls: { tool: string; args: Record<string, unknown> }[];
  /** Token requests: grant type and the resource each one named. */
  tokens: { grant: string; resource: string | null }[];
  registrations: Record<string, unknown>[];
  /** Mint a code the way the consent page would, for the URL the browser was handed. */
  consent(authorizeUrl: string): Promise<{ callback: string }>;
  /** The next write tools/call is received and then the connection is cut with no answer. */
  dropNextCall(): void;
  /** The next write tools/call answers with a tool error and changes nothing. */
  failNextCall(): void;
  /** Overrides for discovery documents, to prove refusals. */
  override: { prm?: Record<string, unknown>; as?: Record<string, unknown> };
  accessToken: string;
  close(): Promise<void>;
}

const TOOL_ACTIONS: Record<string, Record<string, { props: string[]; required: string[] }>> = {
  trelloReadMember: { get_me: { props: [], required: [] } },
  trelloReadBoard: { get: { props: ['boardId'], required: ['boardId'] }, list: { props: ['cursor'], required: [] }, list_labels: { props: ['boardId', 'cursor'], required: ['boardId'] } },
  trelloReadList: { list_by_board: { props: ['boardId', 'cursor'], required: ['boardId'] } },
  trelloReadCard: { get: { props: ['cardId'], required: ['cardId'] }, list_by_list: { props: ['listId', 'cursor'], required: ['listId'] } },
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
    update_item: { props: ['checklistId', 'itemId', 'name', 'state'], required: ['checklistId', 'itemId'] },
  },
  trelloWriteBoard: { create: { props: ['name'], required: ['name'] } },
  trelloWriteList: { create: { props: ['boardId', 'name'], required: ['boardId', 'name'] }, move: { props: ['listId', 'boardId'], required: ['listId'] } },
  trelloReadInbox: { list: { props: ['cursor'], required: [] } },
  trelloWriteInbox: { create: { props: ['name'], required: ['name'] } },
  trelloReadPlanner: { get: { props: [], required: [] } },
  trelloWritePlanner: { create: { props: ['start', 'end'], required: ['start', 'end'] } },
};

/** The advertised schemas: one object per tool with an action enum and one branch per action. */
export function fakeToolSchemas(): { name: string; inputSchema: Record<string, unknown> }[] {
  return Object.entries(TOOL_ACTIONS).map(([name, actions]) => {
    const props = new Set(Object.values(actions).flatMap(action => action.props));
    return { name, inputSchema: {
      type: 'object', required: ['action'],
      properties: { action: { type: 'string', enum: Object.keys(actions) }, ...Object.fromEntries([...props].map(prop => [prop, { type: prop === 'dueComplete' ? 'boolean' : prop === 'pos' ? 'number' : 'string' }])) },
      oneOf: Object.entries(actions).map(([action, shape]) => ({ properties: { action: { const: action }, ...Object.fromEntries(shape.props.map(prop => [prop, {}])) }, required: ['action', ...shape.required] })),
    } };
  });
}

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
  const pin = { id: ari('board', objectId(now - 400 * 86_400_000)), name: options.boardName ?? 'Rob', closed: false };
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
  const checklists: FakeChecklist[] = [{ id: ari('checklist', objectId(now - 9 * day)), name: 'Prep', cardId: cards[2]!.id, items: [{ id: ari('check-item', objectId(now - 9 * day)), name: 'Call the venue', state: 'incomplete' }] }];

  const calls: TrelloFake['calls'] = [];
  const tokens: TrelloFake['tokens'] = [];
  const registrations: Record<string, unknown>[] = [];
  const override: TrelloFake['override'] = {};
  let drop = false; let fail = false;
  const state = { accessToken: randomBytes(16).toString('hex'), refreshToken: randomBytes(16).toString('hex') };
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string }>();
  const clients = new Set<string>();
  const sessions = new Set<string>();

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

  let issuer = '';
  let resource = '';
  const mcp = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/v1') {
      json(response, 200, { resource, authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: ['offline_access', 'read:board:trello', 'write:board:trello'], ...override.prm }); return;
    }
    if (url.pathname !== '/v1') { json(response, 503, { message: 'Temporarily Unavailable', status: 503 }); return; }
    if (request.headers.authorization !== `Bearer ${state.accessToken}`) {
      json(response, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${resource.replace('/v1', '')}/.well-known/oauth-protected-resource/v1"` }); return;
    }
    const message = JSON.parse(await body(request)) as { id?: number; method: string; params?: Record<string, unknown> };
    if (message.method === 'initialize') {
      const session = randomBytes(8).toString('hex'); sessions.add(session);
      json(response, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'trello-fake', version: '1' } } }, { 'mcp-session-id': session }); return;
    }
    if (!sessions.has(String(request.headers['mcp-session-id']))) { json(response, 404, { error: 'session' }); return; }
    if (message.method === 'notifications/initialized') { response.writeHead(202).end(); return; }
    if (message.method === 'tools/list') { json(response, 200, { jsonrpc: '2.0', id: message.id, result: { tools: fakeToolSchemas() } }); return; }
    if (message.method === 'tools/call') {
      const tool = String(message.params?.name);
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      calls.push({ tool, args: structuredClone(args) });
      if (drop && tool.startsWith('trelloWrite')) { drop = false; run(tool, args); request.socket.destroy(); return; }
      if (fail && tool.startsWith('trelloWrite')) { fail = false; json(response, 200, { jsonrpc: '2.0', id: message.id, result: toolError('refused') }); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: run(tool, args) })}\n\n`);
      return;
    }
    json(response, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method' } });
  });
  const auth = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const origin = new URL(issuer).origin;
    if (request.method === 'GET' && url.pathname === `/.well-known/oauth-authorization-server/${FAKE_TENANT}`) {
      json(response, 200, { issuer, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${issuer}/dcr/register`,
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], grant_types_supported: ['authorization_code', 'refresh_token'], response_types_supported: ['code'], ...override.as }); return;
    }
    if (request.method === 'POST' && url.pathname === `/${FAKE_TENANT}/dcr/register`) {
      const registration = JSON.parse(await body(request)) as Record<string, unknown>;
      registrations.push(registration);
      const redirects = registration.redirect_uris;
      if (!Array.isArray(redirects) || !redirects.every(uri => typeof uri === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(uri))) { json(response, 400, { error: 'invalid_redirect_uri' }); return; }
      const clientId = randomBytes(8).toString('hex'); clients.add(clientId);
      json(response, 201, { client_id: clientId, redirect_uris: redirects }); return;
    }
    if (request.method === 'POST' && url.pathname === '/oauth/token') {
      const form = new URLSearchParams(await body(request));
      tokens.push({ grant: String(form.get('grant_type')), resource: form.get('resource') });
      if (form.get('resource') !== resource) { json(response, 400, { error: 'invalid_target' }); return; }
      if (form.get('grant_type') === 'authorization_code') {
        const bound = codes.get(String(form.get('code'))); codes.delete(String(form.get('code')));
        const verifier = String(form.get('code_verifier'));
        if (!bound || bound.clientId !== form.get('client_id') || bound.redirectUri !== form.get('redirect_uri') || bound.resource !== resource
          || createHash('sha256').update(verifier).digest('base64url') !== bound.challenge) { json(response, 400, { error: 'invalid_grant' }); return; }
      } else if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== state.refreshToken) { json(response, 400, { error: 'invalid_grant' }); return; }
      } else { json(response, 400, { error: 'unsupported_grant_type' }); return; }
      state.accessToken = randomBytes(16).toString('hex'); state.refreshToken = randomBytes(16).toString('hex');
      json(response, 200, { access_token: state.accessToken, refresh_token: state.refreshToken, expires_in: 3600, token_type: 'Bearer' }); return;
    }
    json(response, 404, {});
  });
  const mcpPort = await listen(mcp);
  const authPort = await listen(auth);
  resource = `http://127.0.0.1:${mcpPort}/v1`;
  issuer = `http://127.0.0.1:${authPort}/${FAKE_TENANT}`;
  return {
    resource, issuer, mcpUrl: resource, boards, lists, cards, labels, checklists, calls, tokens, registrations, override,
    get accessToken() { return state.accessToken; },
    async consent(authorizeUrl: string) {
      const url = new URL(authorizeUrl);
      const clientId = String(url.searchParams.get('client_id'));
      if (!clients.has(clientId) || url.searchParams.get('code_challenge_method') !== 'S256' || url.searchParams.get('resource') !== resource) throw new Error('consent refused');
      const code = randomBytes(12).toString('hex');
      codes.set(code, { clientId, redirectUri: String(url.searchParams.get('redirect_uri')), challenge: String(url.searchParams.get('code_challenge')), resource });
      return { callback: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(String(url.searchParams.get('state')))}` };
    },
    dropNextCall() { drop = true; },
    failNextCall() { fail = true; },
    async close() {
      await new Promise<void>(resolve => { mcp.close(() => resolve()); mcp.closeAllConnections(); });
      await new Promise<void>(resolve => { auth.close(() => resolve()); auth.closeAllConnections(); });
    },
  };
}
