#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
export LUX_COMPANION_NPM_CACHE="${LUX_COMPANION_NPM_CACHE:-$HOME/.npm}"
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
"$app/Contents/MacOS/LuxDidi" "$work/port" "$proof" "$node"
export LUX_REAL_HOST_PROOF_DIR="$proof" LUX_REAL_HOST_NODE="$node"
bash Tests/DidiMacTests/check-mac.sh
