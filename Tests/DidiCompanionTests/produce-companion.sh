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
  # Every leased-run phase runs to completion; a later phase is never skipped
  # because an earlier one failed. Each result is recorded to the phase file and
  # echoed as "PHASE <name> <result> [reason]"; the phase exits non-zero if any
  # phase failed, so check-companion.sh reports every phase and never excuses one.
  phase_file="${LUX_COMPANION_PHASE_FILE:-$proof/phases.txt}"
  : > "$phase_file"
  phase_failed=0
  record() { printf 'PHASE %s %s %s\n' "$1" "$2" "${3:-}" | tee -a "$phase_file"; }
  # Phase 1: real SDK keychain discriminator; bounded fast-fail on a blocked legacy path.
  if python3 Tests/DidiCompanionTests/keychain-sdk.py "$app/Contents/MacOS/LuxDidi" "$proof"; then
    record keychain pass
  else
    record keychain fail "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("reason") or "failed")' "$proof/keychain-sdk/summary.json" 2>/dev/null || echo failed)"
    phase_failed=1
  fi
  # Phase 2: fixture launch; readiness is the fixture's own atomic port file.
  python3 Tests/DidiCompanionTests/fixture.py "$work/port" &
  fixture_pid=$!
  if python3 - "$work/port" <<'PY'
import os, sys, time
path = sys.argv[1]
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    if os.path.exists(path):
        sys.exit(0)
    time.sleep(0.05)
sys.exit(1)
PY
  then
    record fixture-launch pass
  else
    record fixture-launch fail fixture_port_timeout
    phase_failed=1
  fi
  # Phase 3: single external kernel/LaunchServices observer under renderer admission.
  export LUX_VERIFICATION_DRIVER="$work/verification-observer"
  mkdir -p "$proof/fixture-launch"
  if "$LUX_VERIFICATION_DRIVER" --verification "$app" "$proof/fixture-launch" "$(uuidgen)" run "$work/port" "$proof" "$node"; then
    record verification-observer pass
  else
    record verification-observer fail
    phase_failed=1
  fi
  # Phase 4: full nested real-app check.
  export LUX_REAL_HOST_PROOF_DIR="$proof" LUX_REAL_HOST_NODE="$node"
  if bash Tests/DidiMacTests/check-mac.sh; then
    record mac pass
  else
    record mac fail
    phase_failed=1
  fi
  exit "$phase_failed"
fi

# Prepare phase: compilation and bundling only, with no browser lease and no
# LaunchServices registration, native launch or capture. One outer tempdir and
# one trap own all prepared state for both phases.
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-companion-check.XXXXXX")"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    chmod 700 "$work"
    printf 'COMPANION FAILURE status=%s retained-work=%s proof=%s\n' "$status" "$work" "${proof:-not-created}" >&2
  else
    rm -rf "$work"
  fi
  exit "$status"
}
trap cleanup EXIT
cd "$root"
mkdir -p "$work/cache"
# Use the same accepted asset source as scripts/check-macos-install.sh and
# scripts/build-macos-app.sh, never a relocatable PATH/Homebrew executable.
assets="${LUX_ASSET_BUNDLE:-}"
if [ -z "$assets" ]; then
  assets="$work/assets"
  npm_config_userconfig=/dev/null npm_config_globalconfig="$work/absent-npm-config" bash scripts/build-asset-bundle.sh "$assets"
fi
assets="$(cd "$assets" && pwd)"
node="$assets/Resources/node/bin/node"
printf 'COMPANION-NODE source=%s\n' "$node"
[ -x "$node" ] || { echo "COMPANION FAIL: accepted asset Node missing: $node" >&2; exit 1; }
# The fixture must exercise the same self-contained runtime policy as the native build.
python3 - "$node" <<'PY'
import subprocess, sys
deps = [line.strip().split(' (')[0] for line in subprocess.run(
    ['otool', '-L', sys.argv[1]], capture_output=True, text=True, check=True
).stdout.splitlines()[1:] if line.strip()]
bad = [dep for dep in deps if not dep.startswith(('/usr/lib/', '/System/', '@loader_path/'))]
assert not bad, f'COMPANION FAIL: staged Node violates installed dependency policy: {bad[:5]}'
print('PASS companion Node matches installed dependency policy')
PY
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
# A trailing slash in TMPDIR otherwise survives into PROOF-DIR and every child
# log path; canonicalize so the observer's recorded paths match pathlib's.
proof_parent="$(cd "$proof_parent" && pwd -P)"
proof="$(mktemp -d "$proof_parent/didi-companion-proof-${LUX_WORKER_RUN_ID:-$$}.XXXXXX")"
printf 'PROOF-DIR=%s\n' "$proof"
mkdir -p "$proof"
# Retain actual built-binary Keychain imports before disposable bundle cleanup.
otool -Iv "$app/Contents/MacOS/LuxDidi" | grep -E 'SecItem(Add|CopyMatching|Delete)|SecKeychain(Set|Get)UserInteractionAllowed' > "$proof/keychain-binary-imports.txt"
/usr/bin/nice -n 10 xcrun clang -Wall -Wextra -Werror -c Tests/DidiCompanionTests/launch-probe/Kernel.c -o "$work/VerificationKernel.o"
/usr/bin/nice -n 10 xcrun swiftc -j 1 -num-threads 1 -parse-as-library -import-objc-header Tests/DidiCompanionTests/launch-probe/Kernel.h Tests/DidiCompanionTests/launch-probe/Identity.swift Tests/DidiCompanionTests/launch-probe/Observer.swift "$work/VerificationKernel.o" -o "$work/verification-observer"
# Exercise diagnostics without launching a bundle or touching user state.
forced_proof="$proof/forced-observer-failure"
mkdir -m 700 "$forced_proof"
forced_status=0
LUX_OBSERVER_FORCE_FAILURE=1 "$work/verification-observer" --verification "$app" "$forced_proof" diagnostic-nonce run >"$forced_proof/stdout.log" 2>"$forced_proof/stderr.log" || forced_status=$?
python3 - "$forced_proof" "$forced_status" <<'PY'
import json, os, pathlib, sys
proof = pathlib.Path(sys.argv[1])
assert sys.argv[2] == '1', sys.argv[2]
assert 'forced observer failure' in (proof / 'stderr.log').read_text()
record = json.loads((proof / 'observer.json').read_text())
assert record['pass'] is False and record['reason'] == 'forced observer failure'
assert all((proof / name).is_file() for name in ('stdout.log', 'stderr.log'))
assert {os.path.realpath(path) for path in record['childLogs']} == {os.path.realpath(str(proof / name)) for name in ('stdout.log', 'stderr.log')}
print('PASS forced observer failure: reason, exit status and retained evidence')
PY
# The nested real-app compilation also runs outside the lease, into prepared artifacts.
export LUX_MAC_ARTIFACTS="$work/mac"
bash Tests/DidiMacTests/check-mac.sh --prepare "$LUX_MAC_ARTIFACTS"
# One leased run phase. Every LaunchServices registration, native launch, UI/AX
# capture and browser stays inside the existing slot and its acquisition deadline.
lux-browser-slot run --wait 120 -- bash "$root/Tests/DidiCompanionTests/produce-companion.sh" --leased-run "$work" "$proof" "$node"
