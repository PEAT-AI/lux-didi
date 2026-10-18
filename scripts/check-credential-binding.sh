#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
if [[ ! -f "$deps/typescript/bin/tsc" ]]; then
  deps="$root/../lux-didi-service/server/node_modules"
fi
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" || ! -d "$deps/@types/ws" || ! -d "$deps/ws" ]]; then
  echo 'CREDENTIAL BINDING CHECK BLOCKED: installed TypeScript/@types/node/@types/ws/ws required (DIDI_TYPESCRIPT_ROOT)' >&2
  exit 2
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 26) { console.error("CREDENTIAL BINDING CHECK BLOCKED: installed Node >=26 required"); process.exit(2); }'
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-credential-binding.XXXXXX")"
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/source/adapters" "$out/source/live" "$out/source/contracts" "$out/source/test"
cp -R "$root/server/config" "$root/server/prompt" "$out/source/"
cp -R "$root/server/tools" "$root/server/connectors" "$out/source/"
cp -R "$root/server/adapters/model" "$root/server/adapters/live-voice" "$root/server/adapters/mcp" "$out/source/adapters/"
cp -R "$root/server/live/." "$out/source/live/"
cp -R "$root/server/contracts/." "$out/source/contracts/"
# The selected tests side-effect import live-remember/live-declarations and host/log,
# whose transitive modules these directories carry, so the isolated tsc can resolve them.
cp -R "$root/server/chat" "$root/server/domain" "$root/server/host" "$root/server/http" "$root/server/runtime" "$root/server/memory" "$out/source/"
# runtime/store.ts applies the trace store migrations and prunes its content, so this tree needs trace too.
cp -R "$root/server/trace" "$out/source/"
for name in credential-binding provider-config model live-voice prompt live-remember live-declarations mongoose-auth; do
  cp "$root/server/test/$name.test.ts" "$out/source/test/"
done
cp "$root/server/test/live-voice-fixture.ts" "$out/source/test/"
printf '{"type":"module"}\n' > "$out/package.json"
ln -s "$deps" "$out/node_modules"
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters --skipLibCheck \
  --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" \
  "$out"/source/config/*.ts "$out"/source/test/*.ts
for name in credential-binding provider-config model live-voice prompt mongoose-auth; do
  node_test_files --test-reporter=tap --test-timeout=15000 "$out/dist/test/$name.test.js" | tee "$out/$name.log"
  grep -Eq '^# tests [1-9][0-9]*$' "$out/$name.log" || { echo "Zero selected $name tests" >&2; exit 1; }
done
