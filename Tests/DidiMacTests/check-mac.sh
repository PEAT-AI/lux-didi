#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-mac-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
keychain_home="${CFFIXED_USER_HOME:-$HOME}"
export HOME="$work/home" CFFIXED_USER_HOME="$work/home"
mkdir -p "$HOME" "$work/cache"
cd "$root"
start=$SECONDS
xcrun swiftc -whole-module-optimization -module-cache-path "$work/cache" Sources/LuxDidi/AppPorts.swift Sources/LuxDidi/NativeKeychainPolicy.swift Sources/LuxDidi/CompanionClient.swift Tests/DidiMacTests/main.swift -o "$work/seams"
"$work/seams"
printf 'DURATION seam-compile-and-run=%ss (test-only duration above)\n' "$((SECONDS-start))"
app="$work/Lux Didi.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp Resources/Info.plist "$app/Contents/Info.plist"
xcrun swiftc -whole-module-optimization -module-cache-path "$work/cache" -parse-as-library Sources/LuxDidi/*.swift -o "$app/Contents/MacOS/LuxDidi"
codesign --force --sign - --entitlements Resources/LuxDidi.entitlements "$app"
codesign --verify --strict "$app"
if "$app/Contents/MacOS/LuxDidi" --installed-proof >"$work/invalid-proof.log" 2>&1; then
  echo 'MAC-PROOF FAIL: malformed installed proof flags accepted' >&2; exit 1
fi
grep -q 'INSTALLED-PROOF INVALID' "$work/invalid-proof.log"
"$app/Contents/MacOS/LuxDidi" --self-check
"$app/Contents/MacOS/LuxDidi" --ui-proof "${LUX_MAC_SCREENSHOT:-$work/native-ui.png}"
printf 'MAC-NATIVE PASS total=%ss\n' "$((SECONDS-start))"

if [ -n "${LUX_REAL_HOST_PROOF_DIR:-}" ]; then
  # Installed proof keeps explicit private state and an install-derived synthetic
  # account. Only that invocation retains the inherited login-Keychain HOME;
  # an invented HOME has no login keychain and enters legacy creation UI.
  HOME="$keychain_home" CFFIXED_USER_HOME="$keychain_home" bash Tests/DidiCompanionTests/check-real-host.sh "$app" "$LUX_REAL_HOST_PROOF_DIR" "$LUX_REAL_HOST_NODE"
fi
