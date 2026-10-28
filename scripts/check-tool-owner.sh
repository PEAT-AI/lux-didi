#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
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
mkdir -p "$out/source/"{tools,contracts,runtime,connectors,domain,test,host,adapters/model,adapters/mcp,adapters/live-voice,trace,people}
# W15: tools, connectors and the prompt resolve people through the host snapshot, so the staged tree
# carries that module, its config door and its import closure too.
mkdir -p "$out/source/config"
cp "$root"/server/config/files.ts "$out/source/config/"
cp "$root"/server/people/*.ts "$out/source/people/"
# server/trace imports the domain modules (labels, history-reader, history-lifecycle): copy them too.
cp "$root"/server/domain/*.ts "$out/source/domain/"
cp "$root"/server/tools/*.ts "$out/source/tools/"
cp "$root"/server/contracts/{storage,errors,domain,mail-operators}.ts "$out/source/contracts/"
cp "$root/server/runtime/store.ts" "$out/source/runtime/"
# runtime/store.ts applies the trace store migrations and prunes its content: copy those modules too.
cp "$root"/server/trace/*.ts "$out/source/trace/"
# server/tools imports the debug journal receipt: copy the module it compiles against.
cp "$root"/server/connectors/*.ts "$out/source/connectors/"
cp "$root"/server/adapters/model/*.ts "$out/source/adapters/model/"
cp "$root"/server/adapters/mcp/*.ts "$out/source/adapters/mcp/"
# server/tools imports the Live provider union type: copy its declaration module too.
cp "$root/server/adapters/live-voice/types.ts" "$out/source/adapters/live-voice/"
cp "$root/server/test/tool-owner.test.ts" "$out/source/test/"
cp "$root/server/test/live-shape.test.ts" "$out/source/test/"
cp "$root/server/test/redact.test.ts" "$out/source/test/"
cp "$root/server/test/open-destinations.test.ts" "$out/source/test/"
# C-OPEN 1: one destination table and both allowlist sources, so the host and native lists stay identical.
mkdir -p "$out/dist/test/fixtures"
cp "$root/server/test/fixtures/open-destinations.json" "$root/server/test/fixtures/open-evals.json" "$out/dist/test/fixtures/"
cp "$root/server/tools/open-handles.ts" "$out/dist/test/fixtures/parity-open-handles.ts"
cp "$root/Sources/LuxDidi/NativeActions.swift" "$out/dist/test/fixtures/parity-NativeActions.swift"
# W6: the composed-note machine and the notes exporter are pure modules beside the vault writer,
# so their suites compile and run with the owner registry that they extend.
cp "$root/server/test/lux-note.test.ts" "$out/source/test/"
# W5: the composed stage suite opens the real state schema, and the live migrations it needs are
# tools-only (lux-note, vault), so the live schema rides along without the live host.
mkdir -p "$out/source/live"
cp "$root/server/live/"{schema,config,types}.ts "$out/source/live/"
# lux-note validates the live profile, whose config door composes the public prompt.
mkdir -p "$out/source/prompt"
cp "$root"/server/prompt/*.ts "$out/source/prompt/"
cp "$root"/server/config/*.ts "$out/source/config/"
cp "$root"/server/adapters/live-voice/*.ts "$out/source/adapters/live-voice/"
printf '{"type":"module"}\n' > "$out/package.json"
ln -s "$deps" "$out/node_modules"
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters \
  --skipLibCheck --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" \
  "$out/source/test/tool-owner.test.ts" "$out/source/test/live-shape.test.ts" "$out/source/test/redact.test.ts" "$out/source/test/open-destinations.test.ts" "$out/source/test/lux-note.test.ts"
node_test_files --test-timeout=15000 "$out/dist/test/tool-owner.test.js" "$out/dist/test/live-shape.test.js" "$out/dist/test/redact.test.js" "$out/dist/test/open-destinations.test.js" "$out/dist/test/lux-note.test.js"
