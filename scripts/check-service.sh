#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../server"
npm run typecheck
npm run build
for file in dist/test/runtime.test.js dist/test/http.test.js; do
  test -s "$file" || { echo "Missing selected test: $file" >&2; exit 1; }
done
log=$(mktemp)
trap 'rm -f "$log"' EXIT
node --test --test-reporter=tap --test-timeout=15000 dist/test/runtime.test.js dist/test/http.test.js | tee "$log"
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'Zero selected tests' >&2; exit 1; }
