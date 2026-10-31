/** Where the source tree is, from wherever the compiled test happens to run. */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The regression fixtures exist only in the source tree, so they are the marker that finds it. */
const MARKER = 'test/fixtures/regressions/postcall-session.json';

export function locate(relative: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let at = 0; at < 8; at += 1) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`cannot locate ${relative}`);
}

export function serverDir(): string {
  return join(locate(MARKER), '../../../..');
}

export function scenariosDir(): string {
  return join(serverDir(), 'test/eval-release/scenarios');
}

export function recordingsDir(): string {
  return join(serverDir(), 'test/eval-release/recordings');
}

export function regressionsDir(): string {
  return join(serverDir(), 'test/fixtures/regressions');
}
