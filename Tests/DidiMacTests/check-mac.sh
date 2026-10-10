#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
keychain_home="${CFFIXED_USER_HOME:-$HOME}"

# Prepare: compile and bundle only, outside the browser lease. The artifact
# directory is owned by the caller, which owns the tempdir and its trap.
if [ "${1:-}" = "--prepare" ]; then
  artifacts="${2:?check-mac.sh --prepare needs an artifact directory}"
  mkdir -p "$artifacts/home" "$artifacts/cache"
  cd "$root"
  app="$artifacts/Lux Didi.app"
  start=$SECONDS
  /usr/bin/nice -n 10 xcrun swiftc -j 1 -num-threads 1 -whole-module-optimization -module-cache-path "$artifacts/cache" Sources/LuxDidi/AppPorts.swift Sources/LuxDidi/NativeKeychainPolicy.swift Sources/LuxDidi/CompanionClient.swift Tests/DidiMacTests/main.swift -o "$artifacts/seams"
  "$artifacts/seams"
  printf 'DURATION seam-compile-and-run=%ss (test-only duration above)\n' "$((SECONDS-start))"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp Resources/Info.plist "$app/Contents/Info.plist"
  /usr/bin/nice -n 10 xcrun swiftc -j 1 -num-threads 1 -whole-module-optimization -module-cache-path "$artifacts/cache" -parse-as-library Sources/LuxDidi/*.swift -o "$app/Contents/MacOS/LuxDidi"
  codesign --force --sign - --entitlements Resources/LuxDidi.entitlements "$app"
  codesign --verify --strict "$app"
  exit 0
fi

# Leased run phase: native launches only, from the prepared absolute artifacts.
artifacts="${LUX_MAC_ARTIFACTS:?check-mac.sh needs LUX_MAC_ARTIFACTS from the prepare phase}"
app="$artifacts/Lux Didi.app"
cd "$root"
start=$SECONDS
export HOME="$artifacts/home" CFFIXED_USER_HOME="$artifacts/home"
if "$app/Contents/MacOS/LuxDidi" --installed-proof >"$artifacts/invalid-proof.log" 2>&1; then
  echo 'MAC-PROOF FAIL: malformed installed proof flags accepted' >&2; exit 1
fi
grep -q 'INSTALLED-PROOF INVALID' "$artifacts/invalid-proof.log"
"$app/Contents/MacOS/LuxDidi" --self-check
"$app/Contents/MacOS/LuxDidi" --ui-proof "${LUX_MAC_SCREENSHOT:-$artifacts/native-ui.png}"
printf 'MAC-NATIVE PASS total=%ss\n' "$((SECONDS-start))"

if [ -n "${LUX_REAL_HOST_PROOF_DIR:-}" ]; then
  # Installed proof keeps explicit private state and an install-derived synthetic
  # account. Only that invocation retains the inherited login-Keychain HOME;
  # an invented HOME has no login keychain and enters legacy creation UI.
  HOME="$keychain_home" CFFIXED_USER_HOME="$keychain_home" bash Tests/DidiCompanionTests/check-real-host.sh "$app" "$LUX_REAL_HOST_PROOF_DIR" "$LUX_REAL_HOST_NODE"
fi
