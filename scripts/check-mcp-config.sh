#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" || ! -d "$deps/@modelcontextprotocol/server" || ! -d "$deps/@modelcontextprotocol/client" ]]; then
  echo 'MCP CONFIG CHECK BLOCKED: verified TypeScript/Node types/MCP SDK assembly required' >&2
  exit 2
fi
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-mcp-config.XXXXXX")"
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/source/"{tools,contracts,runtime,connectors,test,config,host,adapters/model,adapters/mcp}
cp "$root"/server/tools/*.ts "$out/source/tools/"
cp "$root"/server/contracts/{storage,errors}.ts "$out/source/contracts/"
cp "$root/server/runtime/store.ts" "$out/source/runtime/"
cp "$root/server/connectors/lux-knowledge.ts" "$out/source/connectors/"
cp "$root"/server/adapters/model/*.ts "$out/source/adapters/model/"
cp "$root"/server/adapters/mcp/*.ts "$out/source/adapters/mcp/"
cp "$root/server/config/files.ts" "$out/source/config/"
# Red baseline may not have the new implementation yet; dynamic imports fail observably.
inputs=("$out/source/test/mcp-config.test.ts")
for file in config/mcp.ts config/mcp-cli.ts host/mcp.ts; do
  if [[ -f "$root/server/$file" ]]; then cp "$root/server/$file" "$out/source/$file"; inputs+=("$out/source/$file"); fi
done
cp "$root/server/test/mcp-config.test.ts" "$out/source/test/"
printf '{"type":"module"}\n' > "$out/package.json"
ln -s "$deps" "$out/node_modules"
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters \
  --skipLibCheck --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" "${inputs[@]}"
node --test --test-timeout=15000 "$out/dist/test/mcp-config.test.js"
