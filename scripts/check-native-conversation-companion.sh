#!/bin/bash
# Phase 1: Foundation coordinator and canonical authenticated Host/CHAT only.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-conversation-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cd "$root"
git diff --check
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -emit-module -module-name DidiConnectedDraft \
  Sources/LuxDidi/PendingRequestStore.swift Sources/LuxDidi/ConnectedDraft.swift \
  -emit-module-path "$work/DidiConnectedDraft.swiftmodule"
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -D PENDING_REQUEST_TESTING \
  Sources/LuxDidi/PendingRequestStore.swift Sources/LuxDidi/ConnectedDraft.swift \
  Tests/DidiNativeConversationTests/Runner.swift -o "$work/conversation-tests"
# A behavioral sensitivity check, not an absent-source/fixture-startup red:
# isolate one broken write-before-wire transition in a temporary source copy.
python3 - "$root/Sources/LuxDidi/ConnectedDraft.swift" "$work/ConnectedDraft.swift" <<'PY_MUTANT'
import sys
source = open(sys.argv[1]).read()
needle = "let marked = try await store.markDispatchUnknown(saved.identity)"
assert source.count(needle) == 1, "sensitivity seam moved"
open(sys.argv[2], "w").write(source.replace(needle, "let marked = saved"))
PY_MUTANT
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -D PENDING_REQUEST_TESTING \
  Sources/LuxDidi/PendingRequestStore.swift "$work/ConnectedDraft.swift" \
  Tests/DidiNativeConversationTests/Runner.swift -o "$work/sensitivity-tests"
set +e
DIDI_TEST_FIXTURE_PARENT="$root/Tests/DidiNativeConversationTests" "$work/sensitivity-tests" --durations=10 >"$work/sensitivity.log" 2>&1
sensitivity_status=$?
set -e
[[ "$sensitivity_status" -eq 1 ]] || { echo "FAIL: broken coordinator did not fail behaviorally"; exit 1; }
grep -q 'missing durable dispatch marker' "$work/sensitivity.log"
echo "SENSITIVITY RED: skipped durable markDispatchUnknown, Foundation runtime EXIT=$sensitivity_status"
cat "$work/sensitivity.log"
DIDI_TEST_FIXTURE_PARENT="$root/Tests/DidiNativeConversationTests" "$work/conversation-tests" --durations=10
# Worktree-local, lockfile-exact offline dependency setup; no global install.
if [[ ! -f server/node_modules/typescript/bin/tsc ]]; then npm --prefix server ci --offline --ignore-scripts --no-audit --no-fund; fi
if [[ ! -f web/node_modules/vite/bin/vite.js ]]; then npm --prefix web ci --offline --ignore-scripts --no-audit --no-fund; fi
npm --prefix web run build
node server/node_modules/typescript/bin/tsc -p server/tsconfig.json
node Tests/DidiNativeConversationTests/HTTP.mjs "$work/conversation-tests"
# Canonical store's affected safety/process-death regressions.
bash scripts/check-pending-request.sh
