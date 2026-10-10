#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
if [[ ! -f "$deps/typescript/bin/tsc" ]]; then deps="$root/../lux-didi-service/server/node_modules"; fi
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" ]]; then
  echo 'CHAT CHECK BLOCKED: installed SERVICE TypeScript/@types/node required' >&2; exit 2
fi
if [[ ! -d "$root/server/domain" ]]; then
  echo 'CHAT CHECK BLOCKED: accepted DOMAIN source has not landed; not behavioral red' >&2; exit 2
fi
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-chat.XXXXXX")"
trap 'rm -rf "$out"' EXIT
cd "$root"
mkdir -p "$out/source/adapters/model" "$out/source/test"
cp -R server/chat server/domain server/runtime server/contracts server/prompt server/http server/live "$out/source/"
cp -R server/adapters/live-voice "$out/source/adapters/"
ln -s "$deps" "$out/node_modules"
cp server/adapters/model/*.ts "$out/source/adapters/model/"
cp server/test/chat.test.ts server/test/chat-process.ts server/test/prompt.test.ts server/test/model.test.ts server/test/runtime.test.ts server/test/http.test.ts "$out/source/test/"
printf '{"type":"module"}\n' > "$out/package.json"
mapfile_compat=()
while IFS= read -r file; do mapfile_compat+=("$file"); done < <(find "$out/source" -name '*.ts' -type f)
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters --skipLibCheck \
  --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" "${mapfile_compat[@]}"
test -f "$out/dist/test/chat.test.js"
# DOMAIN's accepted test imports ../dist explicitly; point it at fresh output.
mkdir -p "$out/test"
cp server/test/domain.test.ts "$out/test/"
node --test --test-reporter=tap --test-timeout=15000 "$out/dist/test/chat.test.js" "$out/dist/test/prompt.test.js" "$out/dist/test/model.test.js" "$out/test/domain.test.ts" "$out/dist/test/runtime.test.js" | tee "$out/results.tap"
# Only the affected real HTTP boundary regression; package installation/CLI
# tests are unrelated and prohibited by this lane's no-installation contract.
node --test --test-reporter=tap --test-timeout=15000 --test-name-pattern='real domain HTTP client' "$out/dist/test/http.test.js"
grep -Eq '^# tests [1-9][0-9]*$' "$out/results.tap"
