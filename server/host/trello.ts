import { createTrelloRestTransport, identityMatches, trelloRequests, TRELLO_API_URL } from '../adapters/trello/client.js';
import { TrelloBoard, type TrelloLog } from '../tools/trello.js';
import { parseJson, readPrivate } from '../config/files.js';
import { join } from 'node:path';

/**
 * The Trello board connection with the owner's own API key: one private key file, read with the same
 * reader as the board name, and the REST client behind it. There is no sign-in, no OAuth record and no
 * browser hand-off: the key is the connection.
 */
export const TRELLO_KEY_FILE = 'trello-key.json';
/** W7-R2: the board name and the owner's identity live in the owner's private configuration. */
export const TRELLO_BOARD_FILE = 'trello-board.json';
const TRELLO_FILE_LIMIT = 1024;

export interface TrelloCredentials { key: string; token: string }
export interface TrelloConfig { board?: string; ownerIdentity?: string; ownerTrelloUsername?: string }

const record = (configDir: string, file: string): Record<string, unknown> | undefined => {
  try {
    const parsed = parseJson(readPrivate(join(configDir, file), TRELLO_FILE_LIMIT));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
};
const written = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/** The owner's key and token, or nothing: the file is 0600, its own uid and never a symlink. */
export function trelloKey(configDir: string): TrelloCredentials | undefined {
  const file = record(configDir, TRELLO_KEY_FILE);
  const key = written(file?.key);
  const token = written(file?.token);
  return key && token ? { key, token } : undefined;
}

export function trelloConfig(configDir: string): TrelloConfig {
  const file = record(configDir, TRELLO_BOARD_FILE);
  return {
    ...(written(file?.board) ? { board: written(file?.board)! } : {}),
    ...(written(file?.ownerIdentity) ? { ownerIdentity: written(file?.ownerIdentity)! } : {}),
    ...(written(file?.ownerTrelloUsername) ? { ownerTrelloUsername: written(file?.ownerTrelloUsername)! } : {}),
  };
}

export function trelloBoardName(configDir: string): string | undefined { return trelloConfig(configDir).board; }

/** A key file, a board name and a named owner: without all three the connector is not configured. */
export function trelloConfigured(configDir: string): boolean {
  const config = trelloConfig(configDir);
  return trelloKey(configDir) !== undefined && config.board !== undefined && (config.ownerIdentity !== undefined || config.ownerTrelloUsername !== undefined);
}

/** The owner's expected Trello identity, from the private configuration; empty means nothing is checked. */
function expectedIdentity(config: TrelloConfig): { email?: string; username?: string } {
  return { ...(config.ownerIdentity ? { email: config.ownerIdentity } : {}), ...(config.ownerTrelloUsername ? { username: config.ownerTrelloUsername } : {}) };
}

export interface TrelloIdentityOptions {
  configDir: string;
  url?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface TrelloMember { username?: string; email?: string; fullName?: string }
export type TrelloIdentityOutcome = { ok: true; member: TrelloMember } | { ok: false; code: 'not_configured' | 'unavailable' | 'credential_revoked' | 'credential_mismatch' };

/**
 * The owner rule for every connection: the member behind the key is the owner. A Trello member's email
 * is compared with ownerIdentity; when Trello withholds it, the username must be the configured one.
 * Only booleans and closed codes leave this function, never a member record.
 */
export async function trelloIdentity(options: TrelloIdentityOptions): Promise<TrelloIdentityOutcome> {
  const credentials = trelloKey(options.configDir);
  const config = trelloConfig(options.configDir);
  if (!credentials) return { ok: false, code: 'not_configured' };
  const planned = trelloRequests('trelloReadMember', { action: 'get_me' });
  if (!planned) return { ok: false, code: 'not_configured' };
  const url = new URL(`${(options.url ?? TRELLO_API_URL).replace(/\/+$/, '')}/members/me`);
  url.searchParams.set('fields', 'username,email,fullName');
  url.searchParams.set('key', credentials.key);
  url.searchParams.set('token', credentials.token);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 12_000) });
  } catch { return { ok: false, code: 'unavailable' }; }
  if (response.status === 401 || response.status === 403) return { ok: false, code: 'credential_revoked' };
  if (!response.ok) return { ok: false, code: 'unavailable' };
  let parsed: unknown;
  try { parsed = JSON.parse(await response.text()); } catch { return { ok: false, code: 'unavailable' }; }
  const member = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as TrelloMember : {};
  if (!identityMatches(member, expectedIdentity(config))) return { ok: false, code: 'credential_mismatch' };
  const username = written(member.username);
  const email = written(member.email);
  return { ok: true, member: { ...(username ? { username } : {}), ...(email ? { email } : {}), ...(written(member.fullName) ? { fullName: written(member.fullName)! } : {}) } };
}

export interface TrelloBoardOptions {
  configDir: string;
  /** The REST base; the product host, or a loopback origin in a test. */
  url?: string;
  boardName?: string;
  timeZone?: string;
  now?: () => number;
  log?: TrelloLog;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** The board service over the owner's key, bound to the private configuration directory. */
export function createTrelloBoard(options: TrelloBoardOptions): TrelloBoard {
  const transport = createTrelloRestTransport({
    ...(options.url ? { url: options.url } : {}),
    credentials: async () => {
      const credentials = trelloKey(options.configDir);
      return credentials ? { ok: true as const, ...credentials } : { ok: false as const, code: 'not_signed_in' as const };
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    // Every call first proves the key belongs to the owner: an email match, else the configured username.
    ...(trelloConfig(options.configDir).ownerIdentity !== undefined || trelloConfig(options.configDir).ownerTrelloUsername !== undefined
      ? { identity: expectedIdentity(trelloConfig(options.configDir)) } : {}),
  });
  return new TrelloBoard({
    transport,
    signedIn: () => trelloKey(options.configDir) !== undefined,
    boardName: options.boardName ?? trelloBoardName(options.configDir),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
}
