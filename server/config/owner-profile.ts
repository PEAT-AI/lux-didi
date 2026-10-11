import { dirname } from 'node:path';
import { ConfigError, fail, parseJson, readPrivate, safeError, validateRoot } from './files.js';
import { publicOwnerProfile, validateOwnerProfile, type OwnerProfileSnapshot } from '../prompt/index.js';

export type OwnerProfileLoadResult =
  | { readonly status: 'default' | 'configured'; readonly snapshot: OwnerProfileSnapshot }
  | { readonly status: 'error'; readonly code: string };

/** Explicit protected local activation. No discovery, environment or runtime reload. */
export function loadOwnerProfile({ path, ownerId }: { path?: string; ownerId: string }): OwnerProfileLoadResult {
  if (path === undefined) return Object.freeze({ status: 'default', snapshot: publicOwnerProfile(ownerId) });
  try {
    if (!validateRoot(dirname(path))) fail('file_missing');
    const snapshot = validateOwnerProfile(parseJson(readPrivate(path, 65_536)), ownerId);
    if (snapshot.kind !== 'profile') fail('invalid_profile');
    return Object.freeze({ status: 'configured', snapshot });
  } catch (error) {
    const code = error instanceof ConfigError ? error.code : 'invalid_profile';
    return Object.freeze({ status: 'error', code: safeError(new ConfigError(code)).code });
  }
}
