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
# Stage only this unit under a temporary ESM marker, so the isolated worktree
# follows SERVICE's actual NodeNext conventions without a competing manifest.
mkdir -p "$out/source/adapters/model" "$out/source/test"
cp server/adapters/model/*.ts "$out/source/adapters/model/"
cp server/test/model.test.ts "$out/source/test/"
printf '{"type":"module"}\n' > "$out/package.json"
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --noUnusedLocals --noUnusedParameters --skipLibCheck \
  --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" \
  "$out"/source/adapters/model/*.ts "$out/source/test/model.test.ts"
node --test --test-timeout=15000 "$out/dist/test/model.test.js"
