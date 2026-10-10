#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
git diff --check
bash scripts/run-local.sh --build-only
node server/dist/host/index.js --help | grep -q -- '--config-dir'
log=$(mktemp)
trap 'rm -f "$log"' EXIT
status=0
node --test --test-reporter=tap --test-timeout=15000 server/dist/test/{chat,http,host,connected}.test.js | tee "$log" || status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'Zero selected tests' >&2; exit 1; }
if [ "$status" -ne 0 ]; then exit "$status"; fi
lux-browser-slot run --priority worker --want 1 --wait 240 -- node server/test/connected-browser.mjs
