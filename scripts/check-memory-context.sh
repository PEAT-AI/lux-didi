#!/usr/bin/env bash
# Explicit selected-local-memory check.
#
# Builds the real service (Store/Domain/ChatService) and runs the new
# memory-context tests plus the impacted CHAT and CONNECTED authorization/context
# regressions and the DOMAIN/provenance resolution+label regressions. Compiles
# through the project tsconfig so the check fails on a stale or absent dist, and
# never runs a broad unrelated ring.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
. "$(cd "$(dirname "$0")" && pwd)/lib-toolchain.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
toolchain_blocked || exit $?

git diff --check
bash scripts/run-local.sh --build-only
# Register the new prompt compiler test graphs as well as their emitted test files below.
server/node_modules/.bin/tsc --ignoreConfig --types node --typeRoots server/node_modules/@types \
  --target ES2023 --module NodeNext --moduleResolution NodeNext --strict \
  --noUnusedLocals --noUnusedParameters --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck \
  --rootDir server --outDir server/dist server/test/context-budget.test.ts server/test/memory-block.test.ts

for f in server/dist/chat/index.js server/dist/domain/facade.js server/dist/runtime/store.js \
         server/dist/memory/cli.js server/dist/test/memory-import.test.js \
         server/dist/test/memory-context.test.js server/dist/test/memory-delete.test.js server/dist/test/connected.test.js; do
  test -s "$f" || { echo "check-memory-context: missing build output: $f" >&2; exit 1; }
done

log=$(mktemp)
trap 'rm -f "$log"' EXIT
status=0

# New selection tests + impacted CHAT/HTTP/HOST accept/dispatch/fingerprint/recovery
# and CONNECTED authorization/context regressions, against the real compiled build.
node_test_files_bounded 1200 --test-reporter=tap --test-timeout=30000 \
  server/dist/test/context-budget.test.js server/dist/test/memory-block.test.js \
  server/dist/test/live-memory-note.test.js \
  server/dist/test/memory-import.test.js server/dist/test/memory-context.test.js server/dist/test/memory-delete.test.js \
  server/dist/test/summaries.test.js \
  server/dist/test/chat.test.js server/dist/test/http.test.js \
  server/dist/test/host.test.js server/dist/test/connected.test.js \
  | tee "$log" || status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'check-memory-context: zero selected chat/connected tests' >&2; exit 1; }
if [ "$status" -ne 0 ]; then exit "$status"; fi

# Impacted DOMAIN resolution and routing-label regressions (real Store + Outbox).
node_test_files_bounded 900 --test-reporter=tap --test-timeout=30000 \
  server/test/domain.test.ts server/test/provenance.test.ts \
  | tee "$log" || status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'check-memory-context: zero selected domain tests' >&2; exit 1; }
exit "$status"
