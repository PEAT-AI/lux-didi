import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';

export type ConfigErrorCode = 'unsupported_platform' | 'directory_type' | 'directory_symlink' | 'directory_owner' | 'directory_mode' | 'file_missing' | 'file_type' | 'file_symlink' | 'file_owner' | 'file_mode' | 'file_links' | 'too_large' | 'invalid_utf8' | 'invalid_json' | 'invalid_profile' | 'invalid_secret' | 'invalid_reference' | 'invalid_source' | 'invalid_arguments' | 'destination_exists' | 'io_error' | 'initialization_failed';
export class ConfigError extends Error {
  constructor(readonly code: ConfigErrorCode) {
    super(`Provider configuration error: ${code}`);
    this.name = 'ConfigError';
  }
}
export function fail(code: ConfigErrorCode): never { throw new ConfigError(code); }
export function safeError(error: unknown): ConfigError {
  return error instanceof ConfigError ? error : new ConfigError('io_error');
}
function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}
export function currentUid(): number {
  if (!process.getuid || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) fail('unsupported_platform');
  return process.getuid();
}
/** Internal descriptor predicate. Production supplies only currentUid(), never configuration/request input. */
export function validateOwner(stat: Stats, expectedUid: number, code: 'file_owner' | 'directory_owner'): void {
  if (stat.uid !== expectedUid) fail(code);
}
export function validateFile(stat: Stats, limit: number): void {
  if (!stat.isFile()) fail('file_type');
  validateOwner(stat, currentUid(), 'file_owner');
  if ((stat.mode & 0o7777) !== 0o600) fail('file_mode');
  if (stat.nlink !== 1) fail('file_links');
  if (stat.size > limit) fail('too_large');
}
/** Host trusts ancestors; Node has no openat. Same-UID path replacement is outside this boundary. */
export function validateRoot(path: string): boolean {
  const uid = currentUid();
  let initial: Stats;
  try { initial = lstatSync(path); }
  catch (e) { if (errorCode(e) === 'ENOENT') return false; throw safeError(e); }
  if (initial.isSymbolicLink()) fail('directory_symlink');
  if (!initial.isDirectory()) fail('directory_type');
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || stat.ino !== initial.ino || stat.dev !== initial.dev) fail('directory_type');
    validateOwner(stat, uid, 'directory_owner');
    if ((stat.mode & 0o7777) !== 0o700) fail('directory_mode');
    return true;
  } catch (e) { throw safeError(e); }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** All reads are bounded and use the validated opened descriptor; no readFile(path) race. */
export function readPrivate(path: string, limit: number): string {
  currentUid();
  let fd: number | undefined;
  try {
    const initial = lstatSync(path);
    if (initial.isSymbolicLink()) fail('file_symlink');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    validateFile(stat, limit);
    if (stat.ino !== initial.ino || stat.dev !== initial.dev) fail('file_type');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) fail('too_large');
    validateFile(fstatSync(fd), limit);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { return fail('invalid_utf8'); }
  } catch (e) {
    if (errorCode(e) === 'ENOENT') fail('file_missing');
    if (errorCode(e) === 'ELOOP') fail('file_symlink');
    throw safeError(e);
  } finally { if (fd !== undefined) closeSync(fd); }
}
/** JSON.parse owns syntax. A token pass rejects duplicate names (including escaped identity names). */
export function parseJson(text: string): unknown {
  let result: unknown;
  try { result = JSON.parse(text); } catch { return fail('invalid_json'); }
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (tokens[i + 1] === ':' && token?.startsWith('"')) {
      const names = stack[stack.length - 1];
      const name = JSON.parse(token) as string;
      if (!names || names.has(name)) fail('invalid_json');
      names.add(name);
    }
  }
  return result;
}
export function fields(raw: unknown, names: readonly string[], code: ConfigErrorCode): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(code);
  const object = raw as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))) fail(code);
  return object;
}
