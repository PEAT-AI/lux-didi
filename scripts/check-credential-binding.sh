#!/usr/bin/env bash
set -euo pipefail
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
cp -R "$root/server/adapters/model" "$root/server/adapters/live-voice" "$out/source/adapters/"
cp "$root/server/live/config.ts" "$root/server/live/types.ts" "$out/source/live/"
cp "$root/server/contracts/storage.ts" "$out/source/contracts/"
for name in credential-binding provider-config model live-voice prompt; do
  cp "$root/server/test/$name.test.ts" "$out/source/test/"
done
cp "$root/server/test/live-voice-fixture.ts" "$out/source/test/"
printf '{"type":"module"}\n' > "$out/package.json"
ln -s "$deps" "$out/node_modules"
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters --skipLibCheck \
  --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" \
  "$out"/source/config/*.ts "$out"/source/test/*.ts
for name in credential-binding provider-config model live-voice prompt; do
  node --test --test-reporter=tap --test-timeout=15000 "$out/dist/test/$name.test.js" | tee "$out/$name.log"
  grep -Eq '^# tests [1-9][0-9]*$' "$out/$name.log" || { echo "Zero selected $name tests" >&2; exit 1; }
done
