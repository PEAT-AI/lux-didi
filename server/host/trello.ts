import { OAuthCredentialError, oauthAccessToken, oauthBinding, readOAuthRecord, runOAuthLogin, type OAuthBinding, type OAuthProvider, type OAuthRecord, type OAuthSignInHop } from './oauth-client.js';
import { createTrelloTransport, TRELLO_MCP_URL, type TrelloTokenSource } from '../adapters/trello/client.js';
import { TrelloBoard, type TrelloLog } from '../tools/trello.js';
import { parseJson, readPrivate } from '../config/files.js';
import { join } from 'node:path';

/**
 * The Trello board connection: the official remote MCP server, signed in once by the owner through the
 * shared OAuth client, with its record beside the Mongoose records in the private configuration directory.
 * The resource and issuer are the server's published identities (RFC 9728 and RFC 8414 documents of
 * 2026-10-25); a discovery that names anything else is refused.
 */
export const TRELLO_REFERENCE = 'trello';
export const TRELLO_ISSUER = 'https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3';
/**
 * Read and write on boards, read of the member, the workspace and offline refresh, and the member's Inbox:
 * F10, the owner's quick-capture notes are read there (read:member.inbox) and one of them is moved onto a
 * list of his board (write:member.inbox). Never Planner, never a workspace write. Whether the move also
 * needs the board write scope is settled by the first real sign-in; the board write is asked for anyway
 * because every other write the ruling grants goes through it.
 */
export const TRELLO_SCOPE = 'offline_access read:me read:account read:member:trello read:member.inbox:trello write:member.inbox:trello read:board:trello write:board:trello read:organization:trello';
export const TRELLO_LOGIN_PORT = 8769;
export const TRELLO_PROVIDER: OAuthProvider = { scope: TRELLO_SCOPE, clientName: 'lux-didi', label: 'Trello', defaultPort: TRELLO_LOGIN_PORT };
/** The record names one resource; the row in Settings and the log lines name it `trello`. */
export const TRELLO_ENDPOINT = 'board';

/** The binding for the official server, or for a fixture's own resource and issuer in a test. */
export function trelloBinding(resource = TRELLO_MCP_URL, issuer = TRELLO_ISSUER): OAuthBinding | undefined {
  return oauthBinding(TRELLO_ENDPOINT, resource, issuer);
}

const accept = (binding: OAuthBinding) => (endpoint: string, resource: string): OAuthBinding | undefined =>
  endpoint === binding.endpoint && resource === binding.resource ? binding : undefined;

/** A usable record exists, read without any network. */
export function trelloSignedIn(configDir: string, binding: OAuthBinding | undefined): boolean {
  return binding !== undefined && readOAuthRecord(configDir, TRELLO_REFERENCE, accept(binding)) !== undefined;
}

/** The bearer for each request, refreshed lazily under the shared lock; the closed reason when there is none. */
export function trelloTokenSource(configDir: string, binding: OAuthBinding | undefined, options: { fetch?: typeof fetch; now?: () => number } = {}): TrelloTokenSource {
  return async () => {
    if (!binding) return { ok: false, code: 'not_signed_in' };
    try { return { ok: true, token: await oauthAccessToken(configDir, TRELLO_REFERENCE, binding, { accept: accept(binding) }, options) }; }
    catch (error) {
      const code = error instanceof OAuthCredentialError ? error.code : 'credential-refresh-unavailable';
      if (code === 'credential-missing') return { ok: false, code: 'not_signed_in' };
      if (code === 'credential-refresh-failed' || code === 'credential-consent-expired' || code === 'credential-unavailable') return { ok: false, code: 'auth_failed' };
      return { ok: false, code: 'unavailable' };
    }
  };
}

export interface TrelloLoginOptions {
  configDir: string;
  binding: OAuthBinding | undefined;
  redirectPort?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => void | Promise<void>;
  showAuthorizationUrl?: (url: string) => void;
  onHop?: (hop: OAuthSignInHop) => void;
  now?: () => number;
}

/** The owner's one Trello sign-in: the same discovery, registration, PKCE, callback and exchange as Mongoose. */
export function runTrelloLogin(options: TrelloLoginOptions): Promise<OAuthRecord> {
  return runOAuthLogin({ ...options, provider: TRELLO_PROVIDER, reference: TRELLO_REFERENCE, account: 'owner' });
}

/**
 * W7-R2: the board name lives in the owner's private configuration, never in this public repository.
 * `trello-board.json` beside the sign-in record holds `{"board": "<the name he sees in Trello>"}`; with
 * none, the connector reports not_configured and nothing reaches the server.
 */
export const TRELLO_BOARD_FILE = 'trello-board.json';
const TRELLO_BOARD_LIMIT = 1024;

export function trelloBoardName(configDir: string): string | undefined {
  try {
    const parsed = parseJson(readPrivate(join(configDir, TRELLO_BOARD_FILE), TRELLO_BOARD_LIMIT));
    const board = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { board?: unknown }).board : undefined;
    return typeof board === 'string' && board.trim() !== '' ? board.trim() : undefined;
  } catch { return undefined; }
}

/** The board service over the official server, bound to the stored sign-in. */
export function createTrelloBoard(options: { configDir: string; binding?: OAuthBinding | undefined; boardName?: string; timeZone?: string; fetch?: typeof fetch; now?: () => number; log?: TrelloLog }): TrelloBoard {
  const binding = 'binding' in options ? options.binding : trelloBinding();
  const transport = createTrelloTransport({ ...(binding ? { url: binding.resource } : {}), token: trelloTokenSource(options.configDir, binding, { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) }), ...(options.fetch ? { fetch: options.fetch } : {}) });
  return new TrelloBoard({ transport, signedIn: () => trelloSignedIn(options.configDir, binding), boardName: options.boardName ?? trelloBoardName(options.configDir),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}), ...(options.now ? { now: options.now } : {}), ...(options.log ? { log: options.log } : {}) });
}
