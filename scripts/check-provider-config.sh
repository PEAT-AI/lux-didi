#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
if [[ ! -f "$deps/typescript/bin/tsc" ]]; then
  deps="$root/../lux-didi-service/server/node_modules"
fi
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" ]]; then
  echo 'PROVIDER CONFIG CHECK BLOCKED: installed SERVICE TypeScript/@types/node required' >&2
  exit 2
fi
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-provider-config.XXXXXX")"
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/source/config" "$out/source/prompt" "$out/source/adapters/model" "$out/source/test"
cp "$root"/server/config/*.ts "$out/source/config/"
cp "$root"/server/prompt/*.ts "$out/source/prompt/"
cp "$root"/server/adapters/model/types.ts "$out/source/adapters/model/"
cp "$root/server/test/provider-config.test.ts" "$out/source/test/"
printf '{"type":"module"}\n' > "$out/package.json"
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --noUnusedLocals --noUnusedParameters --skipLibCheck \
  --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" \
  "$out"/source/config/*.ts "$out"/source/prompt/*.ts \
  "$out"/source/adapters/model/types.ts "$out"/source/test/provider-config.test.ts
node "$out/dist/config/cli.js" --help
node --test --test-reporter=tap --test-timeout=15000 "$out/dist/test/provider-config.test.js" | tee "$out/results.tap"
grep -Eq '^# tests [1-9][0-9]*$' "$out/results.tap"
