#!/bin/bash
set -euo pipefail
umask 077
src=Tests/DidiCompanionTests/launch-probe
root="$(cd "$(dirname "$0")/../../.." && pwd)"

# Leased run phase. Compilation and bundling already ran outside the browser
# lease below; this phase receives explicit absolute artifact paths.
if [ "${1:-}" = "--leased-run" ]; then
  work="$2"; proof="$3"
  cd "$root"
  app="$work/LaunchProbe.app"
  for case in 0 42 signal; do
    mkdir "$proof/$case"
    mkfifo -m 600 "$proof/$case/release.fifo"
    nonce="$(uuidgen)"
    "$work/observer" "$app" "$proof/$case" "$nonce" "$case"
  done
  python3 "$src/verify.py" "$proof"
  printf 'PASS: isolated probe only; product launch and full gates unchanged\n'
  exit
fi

# Prepare: compilation and bundling only, outside the browser lease. One outer
# tempdir and trap own the prepared state; the proof dir is retained evidence.
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-launch-probe.XXXXXX")"
trap 'rm -rf "$work"' EXIT
parent="${LUX_DIDI_PROOF_DIR:-${TMPDIR:-/tmp}}"
mkdir -p "$parent"
proof="$(mktemp -d "$parent/launch-services-probe-${LUX_WORKER_RUN_ID:-$$}.XXXXXX")"
printf 'PROBE-DIR=%s\n' "$proof"
app="$work/LaunchProbe.app"
mkdir -p "$app/Contents/MacOS"
cd "$root"
/usr/bin/nice -n 10 xcrun clang -c "$src/Kernel.c" -o "$work/Kernel.o"
/usr/bin/nice -n 10 xcrun swiftc -j 1 -num-threads 1 -parse-as-library -import-objc-header "$src/Kernel.h" "$src/Identity.swift" "$src/App.swift" "$work/Kernel.o" -o "$app/Contents/MacOS/LaunchProbe"
/usr/bin/nice -n 10 xcrun swiftc -j 1 -num-threads 1 -parse-as-library -import-objc-header "$src/Kernel.h" "$src/Identity.swift" "$src/Observer.swift" "$work/Kernel.o" -o "$work/observer"
python3 - "$app" <<'PY'
import plistlib,sys,uuid
with open(sys.argv[1]+'/Contents/Info.plist','wb') as f:
 plistlib.dump({'CFBundleIdentifier':'com.luxdidi.launchprobe.'+uuid.uuid4().hex,'CFBundleExecutable':'LaunchProbe','CFBundleName':'LaunchProbe','CFBundlePackageType':'APPL','LSMinimumSystemVersion':'10.15'},f)
PY
codesign --force --sign - "$app"
codesign --verify --strict "$app"
# One leased run phase; the observer registers and launches the probe via
# LaunchServices inside the existing slot and acquisition deadline.
lux-browser-slot run --wait 120 -- bash "$root/$src/produce.sh" --leased-run "$work" "$proof"
