#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-pending-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -emit-module -module-name DidiPendingRequest \
  "$root/Sources/LuxDidi/PendingRequestStore.swift" -emit-module-path "$work/DidiPendingRequest.swiftmodule"
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -D PENDING_REQUEST_TESTING \
  "$root/Sources/LuxDidi/PendingRequestStore.swift" \
  "$root/Tests/DidiPendingRequestTests/Runner.swift" -o "$work/pending-tests"
DIDI_PENDING_FIXTURE_PARENT="$root/Tests/DidiPendingRequestTests" "$work/pending-tests" --durations=10
