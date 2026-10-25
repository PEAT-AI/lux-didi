#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
# SERVICE owns installation; this lane never downloads or changes manifests.
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
if [[ ! -f "$deps/typescript/bin/tsc" ]]; then
  deps="$root/../lux-didi-service/server/node_modules"
fi
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" ]]; then
  echo 'PROMPT CHECK BLOCKED: installed SERVICE TypeScript/@types/node required' >&2
  exit 2
fi
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-prompt.XXXXXX")"
trap 'rm -rf "$out"' EXIT
cd "$root"
# Stage only this unit under a temporary ESM marker, so the isolated worktree
# follows SERVICE's actual NodeNext conventions without a competing manifest.
mkdir -p "$out/source/adapters/model" "$out/source/adapters/live-voice" "$out/source/adapters/mcp" "$out/source/connectors" "$out/source/test" "$out/source/prompt" "$out/source/tools" "$out/source/host" "$out/source/http" "$out/source/config" "$out/source/contracts" "$out/source/trace" "$out/source/domain" "$out/source/live"
cp server/adapters/model/*.ts "$out/source/adapters/model/"
cp server/adapters/live-voice/types.ts "$out/source/adapters/live-voice/"
# #562: the prompt content test reads the accepted Live instruction through the adapter, so the adapter
# and the two modules it imports are staged; nothing else of the adapter tree is compiled.
cp server/adapters/live-voice/openai.ts server/adapters/live-voice/resample.ts "$out/source/adapters/live-voice/"
# The adapter types name the host's trace port (O1b-A), so stage the trace kinds and the record door.
cp server/trace/kinds.ts server/trace/record.ts server/trace/clock.ts "$out/source/trace/"
cp server/domain/history-reader.ts server/domain/history-lifecycle.ts server/domain/util.ts server/domain/contract.ts "$out/source/domain/"
cp server/adapters/mcp/port.ts server/adapters/mcp/registry.ts "$out/source/adapters/mcp/"
cp server/connectors/google.ts "$out/source/connectors/"
cp server/tools/vault-write.ts "$out/source/tools/"
cp server/tools/redact.ts "$out/source/tools/"
cp server/tools/declarations.ts server/tools/host-events.ts server/tools/research.ts server/tools/intent.ts server/tools/live-shape.ts server/tools/open-handles.ts server/tools/types.ts server/tools/history.ts server/tools/diagnostic-input.ts server/tools/canonical.ts server/tools/received-body.ts server/tools/remember.ts server/tools/calendar-window.ts server/tools/web-search.ts server/tools/chat-intent.ts "$out/source/tools/"
cp server/prompt/*.ts "$out/source/prompt/"
cp server/host/log.ts "$out/source/host/"
# host/log.ts names the stop gate constants, so stage the module it imports.
cp server/live/stop-phrase.ts "$out/source/live/"
cp server/http/routes.ts "$out/source/http/"
cp server/config/files.ts "$out/source/config/"
cp server/contracts/*.ts "$out/source/contracts/"
cp server/test/prompt.test.ts server/test/model.test.ts server/test/live-persona.test.ts server/test/runtime-context.test.ts server/test/research.test.ts server/test/research-shape.test.ts server/test/research-web.test.ts server/test/research-routed.test.ts server/test/research-calendar.test.ts server/test/research-coverage.test.ts server/test/research-drive.test.ts server/test/chat-prompt.test.ts "$out/source/test/"
# W11-R1: server/test/research-mail-query.test.ts lands from fix/w11-mail-queries-1021; stage it
# whenever this tree carries it, so this check is green on either side of that merge.
[[ -f server/test/research-mail-query.test.ts ]] && cp server/test/research-mail-query.test.ts "$out/source/test/"
printf '{"type":"module"}\n' > "$out/package.json"
# The staged declarations import ws and the MCP SDK types: resolve them from the one installed tree.
ln -s "$deps" "$out/node_modules"
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --noUnusedLocals --noUnusedParameters --skipLibCheck \
  --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" \
  "$out"/source/adapters/model/*.ts "$out"/source/adapters/live-voice/openai.ts "$out"/source/prompt/*.ts "$out"/source/tools/*.ts "$out"/source/test/*.ts
test -f "$out/dist/test/prompt.test.js" # fresh mktemp output; no stale dist accepted
tests=("$out/dist/test/prompt.test.js" "$out/dist/test/model.test.js" "$out/dist/test/live-persona.test.js" "$out/dist/test/runtime-context.test.js" "$out/dist/test/research.test.js" "$out/dist/test/research-web.test.js" "$out/dist/test/research-routed.test.js" "$out/dist/test/research-shape.test.js" "$out/dist/test/research-coverage.test.js" "$out/dist/test/chat-prompt.test.js") "$out/dist/test/research-drive.test.js")
# W11-R1: server/test/research-mail-query.test.ts lands from fix/w11-mail-queries-1021; stage and run
# it here whenever this tree carries it, so this check is green on either side of that merge.
if [[ -f "$out/source/test/research-mail-query.test.ts" ]]; then
  tests+=("$out/dist/test/research-mail-query.test.js")
fi
node_test_files --test-reporter=tap --test-timeout=15000 "${tests[@]}" | tee "$out/results.tap"
grep -Eq "^# tests [1-9][0-9]*$" "$out/results.tap"
# #562: the accepted prompt content, byte for byte, over the same strict compile staged above.
mkdir -p "$out/test/fixtures"
cp server/test/prompt-content.integration.mjs "$out/test/"
cp server/test/fixtures/prompt-final.json server/test/fixtures/prompt-character-excluded.json "$out/test/fixtures/"
node "$out/test/prompt-content.integration.mjs"
