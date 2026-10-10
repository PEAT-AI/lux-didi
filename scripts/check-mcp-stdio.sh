#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" || ! -d "$deps/@modelcontextprotocol/server" || ! -d "$deps/@modelcontextprotocol/client" ]]; then
  echo 'MCP STDIO CHECK BLOCKED: verified TypeScript/Node types/MCP SDK assembly required' >&2
  exit 2
fi
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-mcp-stdio.XXXXXX")"
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/source/"{tools,contracts,runtime,connectors,test,config,host,adapters/model,adapters/mcp}
cp "$root"/server/tools/*.ts "$out/source/tools/"
cp "$root"/server/contracts/{storage,errors}.ts "$out/source/contracts/"
cp "$root/server/runtime/store.ts" "$out/source/runtime/"
cp "$root/server/connectors/lux-knowledge.ts" "$out/source/connectors/"
cp "$root"/server/adapters/model/*.ts "$out/source/adapters/model/"
cp "$root"/server/adapters/mcp/*.ts "$out/source/adapters/mcp/"
cp "$root"/server/config/{mcp,files}.ts "$out/source/config/"
cp "$root/server/host/mcp.ts" "$out/source/host/"
cp "$root/server/test/mcp-stdio.test.ts" "$out/source/test/"
mkdir -p "$out/source/test/fixtures"
cp "$root/server/test/fixtures/stdio-mcp-child.mjs" "$out/source/test/fixtures/"
printf '{"type":"module"}\n' > "$out/package.json"
ln -s "$deps" "$out/node_modules"
inputs=()
while IFS= read -r -d '' f; do inputs+=("$f"); done < <(find "$out/source" -name '*.ts' -print0)
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters \
  --skipLibCheck --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" "${inputs[@]}"
mkdir -p "$out/dist/test/fixtures"
cp "$root/server/test/fixtures/stdio-mcp-child.mjs" "$out/dist/test/fixtures/"
node --test --test-timeout=15000 "$out/dist/test/mcp-stdio.test.js"
