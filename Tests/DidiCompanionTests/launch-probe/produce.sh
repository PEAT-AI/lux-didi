#!/bin/bash
set -euo pipefail
umask 077
src=Tests/DidiCompanionTests/launch-probe
root="$(cd "$(dirname "$0")/../../.." && pwd)"

# Private shell/observer transport only: the installer remains HTTP scenario owner.
if [ "${1:-}" = "--await-stage" ]; then
  python3 - "$2" <<'PY'
import json, os, select, sys, time
root = sys.argv[1]
fd = os.open(root, os.O_RDONLY)
kq = select.kqueue()
kq.control([select.kevent(fd, filter=select.KQ_FILTER_VNODE,
                         flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                         fflags=select.KQ_NOTE_WRITE)], 0, 0)
end = time.monotonic() + 120
while True:
    path = root + '/observation-stage.json'
    if os.path.exists(path):
        d = json.load(open(path)); identity = json.load(open(root + '/identity.json'))
        assert d['nonce'] == identity['nonce'] and d['pid'] == identity['pid'] and d['stage']
        break
    if os.path.exists(root + '/observer.json') or time.monotonic() >= end:
        raise SystemExit('held observation unavailable')
    kq.control(None, 1, max(0, end - time.monotonic()))
kq.close(); os.close(fd)
PY
  exit
fi
if [ "${1:-}" = "--signal-stage" ]; then
  python3 - "$2" "$3" <<'PY'
import json, os, sys, uuid
root, outcome = sys.argv[1:]
assert outcome in ('completed', 'cancel')
d = json.load(open(root + '/observation-stage.json'))
d = {k: d[k] for k in ('nonce', 'pid', 'stage')}
d.update(schemaVersion=1, outcome=outcome)
path = root + '/observation-ack.json'; tmp = path + '.' + str(uuid.uuid4())
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f: json.dump(d, f)
os.rename(tmp, path)
PY
  exit
fi

# The production installer already owns the browser lease, app and observer.
# Exercise the actual running native gate, including the owned real host where
# applicable. Every failure must be observed by kernel exit, never JSON mutation.
if [ "${1:-}" = "--held-cases" ]; then
  observer="$2"; app="$3"; proof="$4"; real_home="$5"
  mkdir -p "$proof"
  for mode in held-premature held-premature-released held-wrong-stage held-stale held-duplicate held-cancel held-eof held-positive; do
    mkdir "$proof/$mode"
    HOME="$real_home" CFFIXED_USER_HOME="$real_home" "$observer" --verification "$app" "$proof/$mode" "$(uuidgen)" "$mode" --installed-proof --proof-state "$proof/$mode/state" --proof-report "$proof/$mode/report.json"
  done
  python3 "$root/$src/verify.py" --held "$proof"
  exit
fi

# Leased run phase. Compilation and bundling already ran outside the browser
# lease below; this phase receives explicit absolute artifact paths.
if [ "${1:-}" = "--leased-run" ]; then
  work="$2"; proof="$3"
  cd "$root"
  app="$work/LaunchProbe.app"
  terminate_launched() {
    local f pid exe
    for f in "$proof"/*/identity.json "$proof"/single-instance/pid-*; do
      [ -f "$f" ] || continue
      case "$f" in
        */identity.json) pid="$(python3 -c 'import json,sys;print(int(json.load(open(sys.argv[1])).get("pid",0)))' "$f" 2>/dev/null || true)" ;;
        *) pid="$(cat "$f" 2>/dev/null || true)" ;;
      esac
      [ -n "$pid" ] && [ "$pid" -gt 0 ] || continue
      exe="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
      case "$exe" in "$app"/*) kill "$pid" 2>/dev/null || true ;; esac
    done
    return 0
  }
  trap terminate_launched EXIT INT TERM
  for case in 0 42 signal; do
    mkdir "$proof/$case"
    mkfifo -m 600 "$proof/$case/release.fifo"
    nonce="$(uuidgen)"
    "$work/observer" "$app" "$proof/$case" "$nonce" "$case"
  done
  # Item 3: two forced same-bundle-id launches leave exactly one native instance.
  # The first holds; the second runs the guard, activates the live instance and
  # exits before writing its launch record. The survivor is then terminated.
  single="$proof/single-instance"
  mkdir -p "$single"
  /usr/bin/open -n "$app" --args --single-instance-hold "$single"
  wait_first=$((SECONDS + 20))
  while [ "$(find "$single" -maxdepth 1 -name 'pid-*' | wc -l | tr -d ' ')" -eq 0 ] && [ "$SECONDS" -lt "$wait_first" ]; do sleep 0.2; done
  /usr/bin/open -n "$app" --args --single-instance-hold "$single"
  # Bounded settle for the second instance to run the guard and exit.
  while [ "$(pgrep -f "$app/Contents/MacOS/LaunchProbe" | wc -l | tr -d ' ')" -ne 1 ] && [ "$SECONDS" -lt "$wait_first" ]; do sleep 0.2; done
  sleep 1
  live="$(pgrep -f "$app/Contents/MacOS/LaunchProbe" | wc -l | tr -d ' ')"
  python3 "$src/verify.py" --single-instance "$single" "$live"
  for pidfile in "$single"/pid-*; do
    [ -f "$pidfile" ] || continue
    kill "$(cat "$pidfile")" 2>/dev/null || true
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
"$root/scripts/with-compile-lock.sh" -- /usr/bin/nice -n 10 xcrun swiftc -j 1 -num-threads 1 -parse-as-library -import-objc-header "$src/Kernel.h" "$src/Identity.swift" Sources/LuxDidi/SingleInstanceGuard.swift "$src/App.swift" "$work/Kernel.o" -o "$app/Contents/MacOS/LaunchProbe"
"$root/scripts/with-compile-lock.sh" -- /usr/bin/nice -n 10 xcrun swiftc -j 1 -num-threads 1 -parse-as-library -import-objc-header "$src/Kernel.h" "$src/Identity.swift" "$src/Observer.swift" "$work/Kernel.o" -o "$work/observer"
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
