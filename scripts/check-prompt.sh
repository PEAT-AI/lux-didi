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
  echo 'PROMPT CHECK BLOCKED: installed SERVICE TypeScript/@types/node required' >&2
  exit 2
fi
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-prompt.XXXXXX")"
trap 'rm -rf "$out"' EXIT
cd "$root"
# Stage only this unit under a temporary ESM marker, so the isolated worktree
# follows SERVICE's actual NodeNext conventions without a competing manifest.
mkdir -p "$out/source/adapters/model" "$out/source/test" "$out/source/prompt"
cp server/adapters/model/*.ts "$out/source/adapters/model/"
cp server/prompt/*.ts "$out/source/prompt/"
cp server/test/prompt.test.ts server/test/model.test.ts "$out/source/test/"
printf '{"type":"module"}\n' > "$out/package.json"
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --noUnusedLocals --noUnusedParameters --skipLibCheck \
  --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" \
  "$out"/source/adapters/model/*.ts "$out"/source/prompt/*.ts "$out"/source/test/*.ts
test -f "$out/dist/test/prompt.test.js" # fresh mktemp output; no stale dist accepted
node --test --test-reporter=tap --test-timeout=15000 "$out/dist/test/prompt.test.js" "$out/dist/test/model.test.js" | tee "$out/results.tap"
grep -Eq "^# tests [1-9][0-9]*$" "$out/results.tap"
