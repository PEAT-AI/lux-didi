#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
if [[ ! -f "$deps/typescript/bin/tsc" ]]; then deps="$root/../lux-didi-service/server/node_modules"; fi
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" || ! -d "$deps/@modelcontextprotocol/server" ]]; then
  echo 'TOOL OWNER CHECK BLOCKED: installed TypeScript/Node types/MCP SDK required' >&2
  exit 2
fi
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-tool-owner.XXXXXX")"
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/source/"{tools,contracts,runtime,connectors,test,adapters/model,adapters/mcp}
cp "$root"/server/tools/*.ts "$out/source/tools/"
cp "$root"/server/contracts/{storage,errors}.ts "$out/source/contracts/"
cp "$root/server/runtime/store.ts" "$out/source/runtime/"
cp "$root/server/connectors/lux-knowledge.ts" "$out/source/connectors/"
cp "$root"/server/adapters/model/*.ts "$out/source/adapters/model/"
cp "$root"/server/adapters/mcp/*.ts "$out/source/adapters/mcp/"
cp "$root/server/test/tool-owner.test.ts" "$out/source/test/"
printf '{"type":"module"}\n' > "$out/package.json"
ln -s "$deps" "$out/node_modules"
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters \
  --skipLibCheck --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" \
  "$out/source/test/tool-owner.test.ts"
node --test --test-timeout=15000 "$out/dist/test/tool-owner.test.js"
