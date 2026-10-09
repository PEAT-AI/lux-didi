#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
# SERVICE owns installation; this lane never downloads or changes manifests.
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
if [[ ! -f "$deps/typescript/bin/tsc" ]]; then
  deps="$root/../lux-didi-service/server/node_modules"
fi
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" ]]; then
  echo 'MODEL CHECK BLOCKED: installed SERVICE TypeScript/@types/node required' >&2
  exit 2
fi
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-model.XXXXXX")"
trap 'rm -rf "$out"' EXIT
cd "$root"
# Standalone worktree has no package.json yet. Emit ESM explicitly; strictness
# matches SERVICE NodeNext. SERVICE compiles these .js imports as NodeNext ESM.
node "$deps/typescript/bin/tsc" --target ES2023 --module ES2022 --moduleResolution Bundler \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --noUnusedLocals --noUnusedParameters --skipLibCheck \
  --types node --typeRoots "$deps/@types" --rootDir server --outDir "$out" \
  server/adapters/model/*.ts server/test/model.test.ts
printf '{"type":"module"}\n' > "$out/package.json"
node --test --test-timeout=15000 "$out/test/model.test.js"
