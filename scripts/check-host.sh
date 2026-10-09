#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
# Exercise the documented build producer, using the current compiler layout.
bash scripts/run-local.sh --build-only
log=$(mktemp)
trap 'rm -f "$log"' EXIT
for file in server/dist/test/host.test.js server/dist/test/http.test.js; do
  test -s "$file" || { echo "Missing selected test: $file" >&2; exit 1; }
done
node --test --test-reporter=tap --test-timeout=15000 server/dist/test/host.test.js server/dist/test/http.test.js | tee "$log"
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'Zero selected tests' >&2; exit 1; }
# Deliberately not the web fixture producer: this drives the shipped UI on the real host.
lux-browser-slot run --priority worker --want 1 --wait 240 -- node server/test/host-browser.mjs
