#!/usr/bin/env bash
# #918: nine history integration suites existed and no check ran them. They import the compiled
# service from server/dist, so this check builds first and then names every file: a suite the
# build never emitted is a named failure, and a run that selected zero tests is a red.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
. "$(cd "$(dirname "$0")" && pwd)/lib-toolchain.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
toolchain_blocked || exit $?

git diff --check
bash scripts/run-local.sh --build-only

log=$(mktemp)
trap 'rm -f "$log"' EXIT
status=0
node_test_files --test-reporter=tap --test-timeout=30000 \
  server/test/history-chat-continuation.integration.mjs \
  server/test/history-chat-summary.integration.mjs \
  server/test/history-chat-tool.integration.mjs \
  server/test/history-forget.integration.mjs \
  server/test/history-gate.integration.mjs \
  server/test/history-lineage.integration.mjs \
  server/test/history-reader.integration.mjs \
  server/test/history-retention.integration.mjs \
  server/test/history-summary.integration.mjs \
  | tee "$log" || status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'check-history: zero selected history tests' >&2; exit 1; }
exit "$status"
