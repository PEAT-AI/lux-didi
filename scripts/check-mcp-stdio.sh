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
mkdir -p "$out/source/adapters/mcp" "$out/source/test/fixtures"
cp "$root"/server/adapters/mcp/*.ts "$out/source/adapters/mcp/"
cp "$root/server/test/mcp-stdio.test.ts" "$out/source/test/"
cp "$root/server/test/fixtures/stdio-mcp-child.mjs" "$out/source/test/fixtures/"
printf '{"type":"module"}\n' > "$out/package.json"
ln -s "$deps" "$out/node_modules"
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters \
  --skipLibCheck --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" \
  "$out/source/test/mcp-stdio.test.ts"
mkdir -p "$out/dist/test/fixtures"
cp "$root/server/test/fixtures/stdio-mcp-child.mjs" "$out/dist/test/fixtures/"
node --test --test-timeout=15000 "$out/dist/test/mcp-stdio.test.js"
