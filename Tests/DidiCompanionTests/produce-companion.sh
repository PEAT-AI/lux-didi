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
proof_parent="${LUX_DIDI_PROOF_DIR:-${TMPDIR:-/tmp}}"
mkdir -p "$proof_parent"
proof="$(mktemp -d "$proof_parent/didi-companion-proof-${LUX_WORKER_RUN_ID:-$$}.XXXXXX")"
printf 'PROOF-DIR=%s\n' "$proof"
mkdir -p "$proof"
export LUX_MAC_SCREENSHOT="$proof/native-setup-ui.png"
# Retain actual built-binary Keychain imports before disposable bundle cleanup.
otool -Iv "$app/Contents/MacOS/LuxDidi" | grep -E 'SecItem(Add|CopyMatching|Delete)|SecKeychain(Set|Get)UserInteractionAllowed' > "$proof/keychain-binary-imports.txt"
# Real SDK discriminator precedes native fixtures; same declared producer.
python3 Tests/DidiCompanionTests/keychain-sdk.py "$app/Contents/MacOS/LuxDidi" "$proof"
# Reuse the single external kernel/LaunchServices observer under renderer admission.
xcrun clang -Wall -Wextra -Werror -c Tests/DidiCompanionTests/launch-probe/Kernel.c -o "$work/VerificationKernel.o"
xcrun swiftc -parse-as-library -import-objc-header Tests/DidiCompanionTests/launch-probe/Kernel.h Tests/DidiCompanionTests/launch-probe/Identity.swift Tests/DidiCompanionTests/launch-probe/Observer.swift "$work/VerificationKernel.o" -o "$work/verification-observer"
export LUX_VERIFICATION_DRIVER="$work/verification-observer"
mkdir -p "$proof/fixture-launch"
"$LUX_VERIFICATION_DRIVER" --verification "$app" "$proof/fixture-launch" "$(uuidgen)" run "$work/port" "$proof" "$node"
export LUX_REAL_HOST_PROOF_DIR="$proof" LUX_REAL_HOST_NODE="$node"
bash Tests/DidiMacTests/check-mac.sh
