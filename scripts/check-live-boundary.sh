#!/usr/bin/env bash
# Synthetic task runtime and delivery boundaries. No app, network, audio or owner database.
# Every scenario also runs with an inverted concrete expectation to prove it detects red.
# A fake provider does not prove the real wire. Any source defect fails this gate.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
# EV-R1: dependencies belong to this worktree. A symlink here installs into (and can empty) another
# checkout, so it is refused outright; run `npm ci` inside this worktree's server/ instead.
if [[ -L "$deps" ]]; then
  echo 'BLOCKED: server/node_modules is a symlink; run npm ci in this worktree instead of pointing at another checkout' >&2
  exit 2
fi
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" ]]; then
  echo 'LIVE-BOUNDARY BLOCKED: the server dependencies (typescript, @types/node) are not installed; run npm ci in server/' >&2
  exit 2
fi
cd "$root/server"
"$deps/typescript/bin/tsc" -p tsconfig.json
# The live-boundary harness and runner are compiled here, not through tsconfig.json: this wagon's scope is
# server/test and scripts, so the check names its own two files with the same strict settings instead of
# editing the build config. A type error in either file fails this check.
"$deps/typescript/bin/tsc" --ignoreConfig --outDir dist --rootDir . --module nodenext --moduleResolution nodenext \
  --target ES2023 --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess \
  --noUnusedLocals --noUnusedParameters --skipLibCheck --types node \
  test/live-boundary/harness.ts test/live-boundary/runner.ts test/timeline.test.ts
node --test --test-name-pattern '^task audit' dist/test/timeline.test.js
exec node dist/test/live-boundary/runner.js "$@"
