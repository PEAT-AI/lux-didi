#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-companion-check.XXXXXX")"
fixture_pid=""
cleanup() { if [ -n "$fixture_pid" ]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi; rm -rf "$work"; }
trap cleanup EXIT
cd "$root"
mkdir -p "$work/cache"
node="$(command -v node)"
start=$SECONDS
xcrun swiftc -whole-module-optimization -D COMPANION_TEST -parse-as-library -module-cache-path "$work/cache" Sources/LuxDidi/*.swift Tests/DidiCompanionTests/*.swift -o "$work/runtime"
printf 'DURATION companion-compile=%ss\n' "$((SECONDS-start))"
python3 Tests/DidiCompanionTests/fixture.py "$work/port" &
fixture_pid=$!
# Runtime waits for fixture readiness with its own bounded deadline, not a shell polling loop.
app="$work/Companion Proof.app"
mkdir -p "$app/Contents/MacOS"
cp Resources/Info.plist "$app/Contents/Info.plist"
mv "$work/runtime" "$app/Contents/MacOS/LuxDidi"
codesign --force --sign - --entitlements Resources/LuxDidi.entitlements "$app"
codesign --verify --strict "$app"
proof="${LUX_DIDI_PROOF_DIR:-${TMPDIR:-/tmp}/didi-companion-proof-${LUX_WORKER_RUN_ID:-$$}}"
printf 'PROOF-DIR=%s\n' "$proof"
mkdir -p "$proof"
export LUX_MAC_SCREENSHOT="$proof/native-setup-ui.png"
# Shared installed helper only belongs to development checks, never public app runtime.
if ! command -v lux-browser-slot >/dev/null; then echo 'CHECK BLOCKED: lux-browser-slot missing' >&2; exit 75; fi
lux-browser-slot run --wait 120 -- bash -c 'set -e; "$1" "$2" "$3" "$4"; bash Tests/DidiMacTests/check-mac.sh' _ "$app/Contents/MacOS/LuxDidi" "$work/port" "$proof" "$node"
