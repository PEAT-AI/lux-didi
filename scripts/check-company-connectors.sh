#!/usr/bin/env bash
# Acceptance check for the Mongoose and Mattermost read connectors (W-H) and the Trello board (W7).
# Synthetic fixtures only: no network, no real Mongoose or Mattermost service, no credentials.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" || ! -d "$deps/@modelcontextprotocol/server" || ! -d "$deps/@modelcontextprotocol/client" ]]; then
  echo 'COMPANY CONNECTORS CHECK BLOCKED: verified TypeScript/Node types/MCP SDK assembly required' >&2
  exit 2
fi
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-company.XXXXXX")"
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/source/"{tools,contracts,domain,runtime,connectors,test,config,host,adapters/model,adapters/mcp,adapters/live-voice,adapters/trello,trace,live,prompt,http}
cp "$root"/server/tools/*.ts "$out/source/tools/"
cp "$root"/server/contracts/*.ts "$out/source/contracts/"
cp "$root/server/runtime/store.ts" "$out/source/runtime/"
# runtime/store.ts applies the trace store migrations and prunes its content: copy those modules too.
cp "$root"/server/trace/*.ts "$out/source/trace/"
cp "$root/server/runtime/outbox.ts" "$out/source/runtime/"
cp "$root"/server/connectors/*.ts "$out/source/connectors/"
cp "$root"/server/adapters/model/*.ts "$out/source/adapters/model/"
cp "$root"/server/adapters/mcp/*.ts "$out/source/adapters/mcp/"
# server/tools imports the Live provider union type: copy its declaration module too.
cp "$root/server/adapters/live-voice/types.ts" "$out/source/adapters/live-voice/"
cp "$root"/server/config/{mcp,files}.ts "$out/source/config/"
# W15: tools and connectors resolve people through the host snapshot, so the staged tree carries it.
mkdir -p "$out/source/people"
cp "$root"/server/people/*.ts "$out/source/people/"
cp "$root/server/host/mcp.ts" "$out/source/host/"
# C-FILLER: the trello suite asserts its padded-write log line survives safeEvent, so the host log and the
# modules it closes over (its events, prompt, routes and stop-phrase imports) ride along.
cp "$root/server/host/log.ts" "$root/server/host/events.ts" "$out/source/host/"
cp "$root"/server/prompt/*.ts "$out/source/prompt/"
cp "$root/server/http/routes.ts" "$out/source/http/"
cp "$root/server/live/stop-phrase.ts" "$out/source/live/"
# host/mcp.ts resolves the host-owned OAuth record for a Mongoose session.
cp "$root/server/host/mongoose-auth.ts" "$out/source/host/"
cp "$root/server/host/oauth-client.ts" "$out/source/host/"
cp "$root/server/host/mongoose-login.ts" "$out/source/host/"
# server/tools imports the debug journal receipt and the memory read model: copy those modules too.
cp "$root"/server/domain/*.ts "$out/source/domain/"
cp "$root/server/test/mongoose-connector.test.ts" "$out/source/test/"
cp "$root/server/test/mongoose-cold-start.test.ts" "$out/source/test/"
cp "$root/server/test/research-data-route.test.ts" "$out/source/test/"
cp "$root/server/test/mongoose-auth.test.ts" "$out/source/test/"
# The sign-in contract: the real host login against a synthetic Mongoose that enforces the server's own rules.
cp "$root/server/test/mongoose-signin-contract.test.ts" "$root/server/test/mongoose-contract-fake.ts" "$out/source/test/"
cp "$root/server/test/mattermost-connector.test.ts" "$out/source/test/"
# The Trello board: the official server's OAuth pair and MCP tools, faked on two loopback origins.
cp "$root/server/host/trello.ts" "$out/source/host/"
cp "$root/server/adapters/trello/client.ts" "$out/source/adapters/trello/"
cp "$root/server/test/trello-board.test.ts" "$root/server/test/trello-fake.ts" "$out/source/test/"
cp "$root/server/test/mattermost-attention.test.ts" "$out/source/test/"
cp "$root/server/test/mattermost-people.test.ts" "$out/source/test/"
# C-DEPTH11: the calendar selection, the attendee projection and the mail no-payload contract.
cp "$root/server/test/google-calendar-depth.test.ts" "$root/server/test/live-shape.test.ts" "$root/server/test/research-calendar.test.ts" "$root/server/test/research-mail-empty.test.ts" "$out/source/test/"
mkdir -p "$out/source/test/fixtures"
cp "$root/server/test/fixtures/stdio-mattermost-child.mjs" "$out/source/test/fixtures/"
cp "$root/server/test/fixtures/stdio-mattermost-attention-child.mjs" "$out/source/test/fixtures/"
cp "$root/server/test/fixtures/stdio-mattermost-people-child.mjs" "$out/source/test/fixtures/"
printf '{"type":"module"}\n' > "$out/package.json"
ln -s "$deps" "$out/node_modules"
inputs=()
while IFS= read -r -d '' f; do inputs+=("$f"); done < <(find "$out/source" -name '*.ts' -print0)
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters \
  --skipLibCheck --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" "${inputs[@]}"
mkdir -p "$out/dist/test/fixtures"
cp "$root/server/test/fixtures/stdio-mattermost-child.mjs" "$out/dist/test/fixtures/"
cp "$root/server/test/fixtures/stdio-mattermost-attention-child.mjs" "$out/dist/test/fixtures/"
cp "$root/server/test/fixtures/stdio-mattermost-people-child.mjs" "$out/dist/test/fixtures/"
mkdir -p "$out/test/fixtures"
cp "$root/server/test/fixtures/mongoose-literal-sanitized.json" "$out/test/fixtures/"
cp "$root/server/test/fixtures/mongoose-discovery.json" "$root/server/test/fixtures/mongoose-data-live.json" "$out/test/fixtures/"
node_test_files --test-timeout=15000 "$out/dist/test/mongoose-connector.test.js" "$out/dist/test/mongoose-cold-start.test.js" "$out/dist/test/research-data-route.test.js" "$out/dist/test/mongoose-auth.test.js" "$out/dist/test/mongoose-signin-contract.test.js" "$out/dist/test/mattermost-connector.test.js" "$out/dist/test/mattermost-attention.test.js" "$out/dist/test/trello-board.test.js" "$out/dist/test/mattermost-people.test.js" "$out/dist/test/google-calendar-depth.test.js" "$out/dist/test/live-shape.test.js" "$out/dist/test/research-calendar.test.js" "$out/dist/test/research-mail-empty.test.js"
