#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-mac-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export HOME="$work/home" CFFIXED_USER_HOME="$work/home"
mkdir -p "$HOME" "$work/cache"
cd "$root"
start=$SECONDS
xcrun swiftc -module-cache-path "$work/cache" Sources/LuxDidi/AppPorts.swift Tests/DidiMacTests/main.swift -o "$work/seams"
"$work/seams"
printf 'DURATION seams=%ss\n' "$((SECONDS-start))"
app="$work/Lux Didi.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp Resources/Info.plist "$app/Contents/Info.plist"
xcrun swiftc -module-cache-path "$work/cache" -parse-as-library Sources/LuxDidi/*.swift -o "$app/Contents/MacOS/LuxDidi"
codesign --force --sign - --entitlements Resources/LuxDidi.entitlements "$app"
codesign --verify --strict "$app"
"$app/Contents/MacOS/LuxDidi" --self-check
"$app/Contents/MacOS/LuxDidi" --ui-proof "${LUX_MAC_SCREENSHOT:-/Users/rob/.lux/reports/lux-didi-overnight-1009/mac/native-ui.png}"
printf 'MAC-NATIVE PASS total=%ss\n' "$((SECONDS-start))"
