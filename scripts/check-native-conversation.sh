#!/usr/bin/env bash
# Declared producer for the native-conversation-service increment.
# Static impact checks for the touched server/web source, the affected CONNECTED
# backend auth/stream regressions, and the real GPU browser view of shared page
# selection and durable external-run discovery.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
deps="${DIDI_TYPESCRIPT_ROOT:-$PWD/server/node_modules}"
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" ]]; then
  echo 'NATIVE CHECK BLOCKED: installed SERVICE TypeScript/@types/node required' >&2; exit 2
fi
git diff --check
bash scripts/run-local.sh --build-only
# The lane's own test file is compiled here, not added to the shared server include.
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters --skipLibCheck \
  --types node --typeRoots "$deps/@types" --rootDir server --outDir server/dist \
  server/test/native-conversation.test.ts
node server/dist/host/index.js --help | grep -q -- '--config-dir'
for file in server/dist/test/native-conversation.test.js server/dist/test/connected.test.js server/dist/test/http.test.js; do
  test -s "$file" || { echo "Missing selected test: $file" >&2; exit 1; }
done
log=$(mktemp)
trap 'rm -f "$log"' EXIT
status=0
node --test --test-reporter=tap --test-timeout=20000 \
  server/dist/test/native-conversation.test.js \
  server/dist/test/connected.test.js \
  server/dist/test/http.test.js | tee "$log" || status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'Zero selected tests' >&2; exit 1; }
if [ "$status" -ne 0 ]; then exit "$status"; fi
# Real GPU browser admission: a held slot is reported by the helper, never read as a pass.
lux-browser-slot run --priority worker --want 1 --wait 240 -- node web/test/native-conversation.spec.ts
