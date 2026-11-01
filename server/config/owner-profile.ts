import { dirname } from 'node:path';
import { ConfigError, fail, parseJson, readPrivate, safeError, validateRoot } from './files.js';
import { OWNER_PROFILE_KEYS, publicOwnerProfile, validateOwnerProfile, type OwnerProfileSnapshot } from '../prompt/index.js';

export type OwnerProfileLoadResult =
  | { readonly status: 'default' | 'configured'; readonly snapshot: OwnerProfileSnapshot }
  | { readonly status: 'error'; readonly code: string; readonly line?: string };

/** The identifier shape a profile key can have: only such a key is ever echoed into the start line. */
const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

/** #698: the first top-level key the owner profile schema does not allow, or undefined when every key fits. */
function unknownProfileKey(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const allowed = value['kind'] === 'default' ? OWNER_PROFILE_KEYS.default : OWNER_PROFILE_KEYS.profile;
  return Object.keys(value).find(name => !allowed.includes(name));
}

/**
 * #698: the plain line a refused start prints. It names the key the owner wrote, echoed only in the shape a
 * profile key can have, and points the composed-notes switch at the provider live.json where it belongs.
 */
export function unknownProfileKeyLine(key: string): string {
  const named = KEY_SHAPE.test(key) ? ` "${key}"` : '';
  const home = key === 'features' || key === 'composedNotes'
    ? ' The composed-notes switch belongs in the provider live.json under features, not in the owner profile.' : '';
  return `the owner profile names an unknown key${named}.${home}`;
}

/** Explicit protected local activation. No discovery, environment or runtime reload. */
export function loadOwnerProfile({ path, ownerId }: { path?: string; ownerId: string }): OwnerProfileLoadResult {
  if (path === undefined) return Object.freeze({ status: 'default', snapshot: publicOwnerProfile(ownerId) });
  try {
    if (!validateRoot(dirname(path))) fail('file_missing');
    const raw = parseJson(readPrivate(path, 65_536));
    // #698: a wrong key is named in a plain line, never only reported as the bare invalid_profile code.
    const unknown = unknownProfileKey(raw);
    if (unknown !== undefined) return Object.freeze({ status: 'error', code: 'invalid_profile', line: unknownProfileKeyLine(unknown) });
    const snapshot = validateOwnerProfile(raw, ownerId);
    if (snapshot.kind !== 'profile') fail('invalid_profile');
    return Object.freeze({ status: 'configured', snapshot });
  } catch (error) {
    const code = error instanceof ConfigError ? error.code : 'invalid_profile';
    return Object.freeze({ status: 'error', code: safeError(new ConfigError(code)).code });
  }
}
