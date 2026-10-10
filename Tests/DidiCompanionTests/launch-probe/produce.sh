#!/bin/bash
set -euo pipefail
umask 077
src=Tests/DidiCompanionTests/launch-probe
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-launch-probe.XXXXXX")"
trap 'rm -rf "$work"' EXIT
parent="${LUX_DIDI_PROOF_DIR:-${TMPDIR:-/tmp}}"
mkdir -p "$parent"
proof="$(mktemp -d "$parent/launch-services-probe-${LUX_WORKER_RUN_ID:-$$}.XXXXXX")"
printf 'PROBE-DIR=%s\n' "$proof"
app="$work/LaunchProbe.app"
mkdir -p "$app/Contents/MacOS"
xcrun clang -c "$src/Kernel.c" -o "$work/Kernel.o"
xcrun swiftc -parse-as-library -import-objc-header "$src/Kernel.h" "$src/Identity.swift" "$src/App.swift" "$work/Kernel.o" -o "$app/Contents/MacOS/LaunchProbe"
xcrun swiftc -parse-as-library -import-objc-header "$src/Kernel.h" "$src/Identity.swift" "$src/Observer.swift" "$work/Kernel.o" -o "$work/observer"
python3 - "$app" <<'PY'
import plistlib,sys,uuid
with open(sys.argv[1]+'/Contents/Info.plist','wb') as f:
 plistlib.dump({'CFBundleIdentifier':'com.luxdidi.launchprobe.'+uuid.uuid4().hex,'CFBundleExecutable':'LaunchProbe','CFBundleName':'LaunchProbe','CFBundlePackageType':'APPL','LSMinimumSystemVersion':'10.15'},f)
PY
codesign --force --sign - "$app"
codesign --verify --strict "$app"
for case in 0 42 signal; do
 mkdir "$proof/$case"
 mkfifo -m 600 "$proof/$case/release.fifo"
 nonce="$(uuidgen)"
 "$work/observer" "$app" "$proof/$case" "$nonce" "$case"
done
python3 "$src/verify.py" "$proof"
printf 'PASS: isolated probe only; product launch and full gates unchanged\n'
