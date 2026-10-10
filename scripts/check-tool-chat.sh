#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps=/Users/rob/GitHub/lux-didi-runtime-release/server/node_modules
webdeps=/Users/rob/GitHub/lux-didi-runtime-release/web/node_modules
for path in "$deps/typescript/bin/tsc" "$deps/@types/node/package.json" "$deps/@types/ws/package.json" "$deps/@modelcontextprotocol/server/package.json" "$webdeps/vite/bin/vite.js" "$webdeps/playwright/package.json"; do
  if [[ ! -f "$path" ]]; then
    echo "TOOL CHAT SETUP BLOCKED: required dependency absent: $path" >&2
    exit 2
  fi
done
node --input-type=module - "$deps" <<'JS'
import { createRequire } from 'node:module';
const require = createRequire(`${process.argv[2]}/typescript/package.json`);
for (const [name, expected] of [['typescript', '6.0.3'], ['@types/node', '26.6.4'], ['@types/ws', '8.18.2']]) {
  const version = require(`${name}/package.json`).version;
  if (version !== expected) { console.error(`TOOL CHAT SETUP BLOCKED: ${name} expected ${expected}, got ${version}`); process.exit(2); }
}
JS
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-tool-chat.XXXXXX")"
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/source/test" "$out/web"
# Compile only the two new TS roots and their actual import graph. Copying
# dependency directories does not select or execute their existing tests.
for name in adapters chat config connectors contracts domain host http live prompt runtime tools; do
  cp -R "$root/server/$name" "$out/source/$name"
done
cp "$root/server/package.json" "$out/source/package.json"
cp -R "$root/server/test/." "$out/source/test/"
ln -s "$deps" "$out/source/node_modules"
ln -s "$deps" "$out/node_modules"
printf '{"type":"module"}\n' > "$out/package.json"
echo 'TOOL CHAT PHASE=compile roots=tool-chat.test.ts,tool-chat-process.ts,connected.test.ts'
node "$deps/typescript/bin/tsc" --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters \
  --skipLibCheck --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" \
  "$out/source/test/tool-chat.test.ts" "$out/source/test/tool-chat-process.ts" "$out/source/test/connected.test.ts"
echo 'TOOL CHAT PHASE=focused-runtime'
node --test --test-concurrency=1 --test-reporter=tap --test-timeout=15000 "$out/dist/test/tool-chat.test.js"
# Build the actual current browser in isolation; never mutate another lane's
# node_modules or dist, download a browser, or start the normal application.
cp -R "$root/web/src" "$out/web/src"
for name in index.html package.json tsconfig.json vite.config.ts vite.config.js vite.config.mjs; do
  if [[ -f "$root/web/$name" ]]; then cp "$root/web/$name" "$out/web/$name"; fi
done
if [[ -d "$root/web/public" ]]; then cp -R "$root/web/public" "$out/web/public"; fi
ln -s "$webdeps" "$out/web/node_modules"
echo 'TOOL CHAT PHASE=browser-build'
node "$deps/typescript/bin/tsc" --noEmit --project "$out/web/tsconfig.json"
node "$webdeps/vite/bin/vite.js" build "$out/web"
# The real connected caller (R2): the actual composeChat/ownerProfile/P-snapshot callsite, not a fixture.
echo 'TOOL CHAT PHASE=connected-runtime'
node --test --test-concurrency=1 --test-reporter=tap --test-timeout=15000 "$out/dist/test/connected.test.js"
node --check "$root/server/test/tool-chat-browser.mjs"
export DIDI_TOOL_CHAT_DEPENDENCIES="$deps"
export DIDI_TOOL_CHAT_PROCESS="$out/dist/test/tool-chat-process.js"
export DIDI_TOOL_CHAT_WEB_ROOT="$out/web/dist"
echo 'TOOL CHAT PHASE=browser-runtime'
lux-browser-slot run --priority worker --want 1 --wait 120 -- \
  node --test --test-reporter=tap --test-timeout=45000 "$root/server/test/tool-chat-browser.mjs"
