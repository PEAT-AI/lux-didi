#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
# Every compile targets the app's declared minimum (same source as build-macos-app.sh), so
# SDK deprecations newer than the minimum stay warnings under -warnings-as-errors.
minimum_macos="$(/usr/bin/plutil -extract LSMinimumSystemVersion raw "$root/Resources/Info.plist")"
[[ "$minimum_macos" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || { echo 'check-pending-request.sh: macOS minimum must be a numeric version' >&2; exit 2; }
target="arm64-apple-macosx$minimum_macos"
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-pending-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  -emit-module -module-name DidiPendingRequest \
  "$root/Sources/LuxDidi/PendingRequestStore.swift" -emit-module-path "$work/DidiPendingRequest.swiftmodule"
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  -D PENDING_REQUEST_TESTING \
  "$root/Sources/LuxDidi/PendingRequestStore.swift" \
  "$root/Tests/DidiPendingRequestTests/Runner.swift" -o "$work/pending-tests"
DIDI_PENDING_FIXTURE_PARENT="$root/Tests/DidiPendingRequestTests" "$work/pending-tests" --durations=10
