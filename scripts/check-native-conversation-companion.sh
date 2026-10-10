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
  Sources/LuxDidi/PendingRequestStore.swift Sources/LuxDidi/ConnectedDraft.swift \
  Tests/DidiNativeConversationTests/Runner.swift -o "$work/conversation-tests"
DIDI_TEST_FIXTURE_PARENT="$root/Tests/DidiNativeConversationTests" "$work/conversation-tests" --durations=10
# Worktree-local, lockfile-exact offline dependency setup; no global install.
if [[ ! -f server/node_modules/typescript/bin/tsc ]]; then npm --prefix server ci --offline --ignore-scripts --no-audit --no-fund; fi
node server/node_modules/typescript/bin/tsc -p server/tsconfig.json
node Tests/DidiNativeConversationTests/HTTP.mjs "$work/conversation-tests"
# Canonical store's affected safety/process-death regressions.
bash scripts/check-pending-request.sh
