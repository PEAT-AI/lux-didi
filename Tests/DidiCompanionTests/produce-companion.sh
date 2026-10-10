#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
export LUX_COMPANION_NPM_CACHE="${LUX_COMPANION_NPM_CACHE:-$HOME/.npm}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
# The verification launch runs the fixture with cwd /, so a launched app cannot
# resolve repo-relative paths. Publish the source root explicitly; the observer
# forwards its environment to the launched bundle.
export LUX_COMPANION_SOURCE_ROOT="$root"

# Leased run phase. Compilation and bundling already ran outside the browser
# lease below. This phase receives explicit absolute artifact paths and never
# creates or removes the outer tempdir; it traps only its own children.
if [ "${1:-}" = "--leased-run" ]; then
  work="$2"; proof="$3"; node="$4"
  app="$work/Companion Proof.app"
  fixture_pid=""
  cleanup() { if [ -n "$fixture_pid" ]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi; }
  trap cleanup EXIT
  cd "$root"
  export LUX_MAC_SCREENSHOT="$proof/native-setup-ui.png"
  # Real SDK discriminator precedes native fixtures; same declared producer.
  python3 Tests/DidiCompanionTests/keychain-sdk.py "$app/Contents/MacOS/LuxDidi" "$proof"
  # Runtime waits for fixture readiness with its own bounded deadline, not a shell polling loop.
  python3 Tests/DidiCompanionTests/fixture.py "$work/port" &
  fixture_pid=$!
  # Reuse the single external kernel/LaunchServices observer under renderer admission.
  export LUX_VERIFICATION_DRIVER="$work/verification-observer"
  mkdir -p "$proof/fixture-launch"
  "$LUX_VERIFICATION_DRIVER" --verification "$app" "$proof/fixture-launch" "$(uuidgen)" run "$work/port" "$proof" "$node"
  export LUX_REAL_HOST_PROOF_DIR="$proof" LUX_REAL_HOST_NODE="$node"
  bash Tests/DidiMacTests/check-mac.sh
  exit
fi

# Prepare phase: compilation and bundling only, with no browser lease and no
# LaunchServices registration, native launch or capture. One outer tempdir and
# one trap own all prepared state for both phases.
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-companion-check.XXXXXX")"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
cd "$root"
mkdir -p "$work/cache"
node="$(command -v node)"
start=$SECONDS
/usr/bin/nice -n 10 xcrun swiftc -j 1 -num-threads 1 -whole-module-optimization -D COMPANION_TEST -parse-as-library -module-cache-path "$work/cache" Sources/LuxDidi/*.swift Tests/DidiCompanionTests/*.swift -o "$work/runtime"
printf 'DURATION companion-compile=%ss\n' "$((SECONDS-start))"
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
# Retain actual built-binary Keychain imports before disposable bundle cleanup.
otool -Iv "$app/Contents/MacOS/LuxDidi" | grep -E 'SecItem(Add|CopyMatching|Delete)|SecKeychain(Set|Get)UserInteractionAllowed' > "$proof/keychain-binary-imports.txt"
/usr/bin/nice -n 10 xcrun clang -Wall -Wextra -Werror -c Tests/DidiCompanionTests/launch-probe/Kernel.c -o "$work/VerificationKernel.o"
/usr/bin/nice -n 10 xcrun swiftc -j 1 -num-threads 1 -parse-as-library -import-objc-header Tests/DidiCompanionTests/launch-probe/Kernel.h Tests/DidiCompanionTests/launch-probe/Identity.swift Tests/DidiCompanionTests/launch-probe/Observer.swift "$work/VerificationKernel.o" -o "$work/verification-observer"
# The nested real-app compilation also runs outside the lease, into prepared artifacts.
export LUX_MAC_ARTIFACTS="$work/mac"
bash Tests/DidiMacTests/check-mac.sh --prepare "$LUX_MAC_ARTIFACTS"
# One leased run phase. Every LaunchServices registration, native launch, UI/AX
# capture and browser stays inside the existing slot and its acquisition deadline.
lux-browser-slot run --wait 120 -- bash "$root/Tests/DidiCompanionTests/produce-companion.sh" --leased-run "$work" "$proof" "$node"
