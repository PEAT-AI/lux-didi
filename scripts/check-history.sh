#!/usr/bin/env bash
# #918: nine history integration suites existed and no check ran them. They import the compiled
# service from server/dist, so this check builds first and then names every file: a suite the
# build never emitted is a named failure, and a run that selected zero tests is a red.
#
# CHECKS-R2: three of the nine hold at this head and are wired here. Six rotted while no check owned them; each
# is named with its failing assertion under FOLLOW-UP in the wagon report and stays out of this check until its
# owner rules, so a known-stale suite can neither make the release gate red nor be quietly rewritten to pass:
#   history-chat-continuation, history-chat-tool, history-forget, history-gate, history-reader, history-summary
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
  server/test/history-chat-summary.integration.mjs \
  server/test/history-lineage.integration.mjs \
  server/test/history-retention.integration.mjs \
  | tee "$log" || status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'check-history: zero selected history tests' >&2; exit 1; }
exit "$status"
