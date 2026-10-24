#!/usr/bin/env bash
# The local service: type-check and build, then the runtime store and HTTP tests.
# Exits non-zero on the first failing test; the compiled copy proves nothing about a stale dist.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../server"
npm run typecheck
npm run build
for file in dist/test/runtime.test.js dist/test/http.test.js; do
  test -s "$file" || { echo "Missing selected test: $file" >&2; exit 1; }
done
log=$(mktemp)
trap 'rm -f "$log"' EXIT
node_test_files --test-reporter=tap --test-timeout=15000 dist/test/runtime.test.js dist/test/http.test.js | tee "$log"
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'Zero selected tests' >&2; exit 1; }
