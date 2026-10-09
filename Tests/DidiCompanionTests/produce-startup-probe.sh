#!/bin/bash
set -euo pipefail
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-startup-probe.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export LUX_COMPANION_NPM_CACHE="${LUX_COMPANION_NPM_CACHE:-$HOME/.npm}"
export HOME="$work/home" CFFIXED_USER_HOME="$work/home"
mkdir -p "$HOME" "$work/cache" "$work/Didi.app/Contents/MacOS" "$work/Didi.app/Contents/Resources"
proof="$(mktemp -d "${TMPDIR:-/tmp}/didi-startup-artifacts.XXXXXX")"
chmod 700 "$proof"
printf 'PROBE-DIR=%s\n' "$proof"
cp Resources/Info.plist "$work/Didi.app/Contents/Info.plist"
xcrun swiftc -whole-module-optimization -module-cache-path "$work/cache" -parse-as-library Sources/LuxDidi/*.swift -o "$work/Didi.app/Contents/MacOS/LuxDidi"
codesign --force --sign - --entitlements Resources/LuxDidi.entitlements "$work/Didi.app"
"$work/Didi.app/Contents/MacOS/LuxDidi" --ui-proof "$proof/native.png"
bash Tests/DidiCompanionTests/check-real-host.sh "$work/Didi.app" "$proof" "$(command -v node)"
