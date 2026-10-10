#!/bin/bash
# New production check: compose the real app from the canonical producer, then
# exercise it as a real LaunchServices bundle with no external descriptor and
# bundled Node only. Synthetic fixtures only; no real account, provider or voice.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."

# Isolated before-state proof: compile the pre-change native parser with the new
# contract probe and show the OLD behavior fails the new assertion (red). One
# low-priority single-job compile; run only when no other native producer runs.
if [ "${1:-}" = "--before-state" ]; then
  base="${2:-5c8bb463d877311e122f077ab7c01a1f221a0edb}"
  work="$(mktemp -d "${TMPDIR:-/tmp}/didi-before-state.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  git archive "$base" Sources/LuxDidi | tar -x -C "$work"
  bundle="$work/bundle"
  mkdir -p "$bundle/Contents/Resources/server/dist/host" "$bundle/Contents/Resources/web/dist"
  : > "$bundle/Contents/Resources/server/dist/host/index.js"
  python3 - "$bundle/Contents/Resources/didi-runtime.json" <<'PY'
import json, sys
with open(sys.argv[1], 'w') as f:
    json.dump({"schemaVersion": 1, "installId": "11111111-1111-1111-1111-111111111111",
               "releaseCommit": "a" * 40, "nodePath": "/bin/ls", "nodeMajor": 26,
               "serverEntry": "server/dist/host/index.js", "webRoot": "web/dist"}, f)
PY
  cat > "$work/probe.swift" <<'SWIFT'
import Foundation
// New contract: an absolute nodePath must be refused. Pre-change source accepts it.
@main struct BeforeStateProbe {
    static func main() {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("Contents/Resources")
        do {
            if try InstalledRuntime.load(resources: root) != nil { exit(1) }
            exit(1)
        } catch { exit(0) }
    }
}
SWIFT
  cd "$work"
  /usr/bin/nice -n 10 xcrun swiftc -j 1 -num-threads 1 -parse-as-library \
    Sources/LuxDidi/InstalledRuntime.swift Sources/LuxDidi/NativeKeychainPolicy.swift probe.swift -o "$work/probe"
  cd - >/dev/null
  set +e
  "$work/probe" "$bundle"
  status=$?
  set -e
  if [ "$status" -eq 1 ]; then
    printf 'BEFORE-STATE PASS base=%s pre-change parser accepted an absolute nodePath (red)\n' "$base"
    exit 0
  fi
  echo "BEFORE-STATE FAIL: probe exited $status; pre-change source did not show the expected red" >&2
  exit 1
fi

if ! command -v lux-browser-slot >/dev/null; then echo 'CHECK BLOCKED: lux-browser-slot missing' >&2; exit 75; fi

if [ "${1:-}" = "--leased-run" ]; then
  work="$2"; proof="$3"; node="$4"; app="$5"
  export LUX_VERIFICATION_DRIVER="$work/observer"
  export LUX_COMPANION_SOURCE_ROOT="$(pwd)"
  real_home="$HOME"
  real_store="$real_home/Library/Application Support/ai.peat.lux-didi-operator/settings.json"
  real_before="$(stat -f '%m' "$real_store" 2>/dev/null || echo absent)"
  export HOME="$work/home" CFFIXED_USER_HOME="$work/home"
  mkdir -p "$HOME"
  state="$proof/state"
  mkdir -p "$proof"

  # Completed-bundle signatures and public-artifact hygiene.
  codesign --verify --deep --strict "$app"
  node Tests/DidiMacTests/staged-app-proof.mjs "$app" --forbid "$HOME" --forbid "$(pwd)" --forbid "$work"
  echo 'MACOS-INSTALL: signatures and artifact hygiene pass'

  # Synthetic protected settings matrix on the existing native executable.
  configDir="$HOME/provider-config"
  mkdir -p "$configDir"
  chmod 0700 "$configDir"
  binary="$app/Contents/MacOS/LuxDidi"

  if "$binary" --configure --config-dir relative 2>"$proof/configure-invalid.log"; then
    echo 'MACOS-INSTALL FAIL: relative configure target accepted' >&2; exit 1
  fi
  if "$binary" --configure --config-dir "$app/Contents/Resources" 2>>"$proof/configure-invalid.log"; then
    echo 'MACOS-INSTALL FAIL: in-bundle configure target accepted' >&2; exit 1
  fi
  grep -qx 'DIDI CONFIGURE: invalid target' "$proof/configure-invalid.log"
  if grep -q "$configDir" "$proof/configure-invalid.log"; then
    echo 'MACOS-INSTALL FAIL: safe configure error leaked a private path' >&2; exit 1
  fi
  "$binary" --configure --config-dir "$configDir" > "$proof/configure-valid.log" 2>&1
  grep -q 'DIDI CONFIGURE: saved' "$proof/configure-valid.log"
  settings="$HOME/Library/Application Support/ai.peat.lux-didi-operator/settings.json"
  [ -f "$settings" ] || { echo 'MACOS-INSTALL FAIL: configure wrote no store' >&2; exit 1; }
  [ "$(stat -f '%Lp' "$settings")" = "600" ] || { echo 'MACOS-INSTALL FAIL: store is not 0600' >&2; exit 1; }
  [ "$(stat -f '%Lp' "$HOME/Library/Application Support/ai.peat.lux-didi-operator")" = "700" ] || { echo 'MACOS-INSTALL FAIL: store dir is not 0700' >&2; exit 1; }
  # Isolation proof: the synthetic store must never have touched the real one.
  real_after="$(stat -f '%m' "$real_store" 2>/dev/null || echo absent)"
  [ "$real_before" = "$real_after" ] || { echo 'MACOS-INSTALL FAIL: real operator store was modified' >&2; exit 1; }
  echo 'MACOS-INSTALL: configure matrix and store isolation pass'

  # A present but invalid store fails closed with a safe error: configure refuses
  # and the message carries neither the store path nor the settings value.
  printf '{"schemaVersion":1,"configDir":"%s","extra":true}\n' "$configDir" > "$settings"
  chmod 0600 "$settings"
  if "$binary" --configure --config-dir "$configDir" >"$proof/invalid-store.log" 2>&1; then
    echo 'MACOS-INSTALL FAIL: invalid operator store accepted' >&2; exit 1
  fi
  grep -qx 'DIDI CONFIGURE: invalid target' "$proof/invalid-store.log"
  if grep -q "$configDir" "$proof/invalid-store.log"; then
    echo 'MACOS-INSTALL FAIL: invalid-store error leaked a private path' >&2; exit 1
  fi
  printf '{"schemaVersion":1,"configDir":"%s"}\n' "$configDir" > "$settings"
  chmod 0600 "$settings"
  echo 'MACOS-INSTALL: invalid store fails closed with a safe error'

  # Real LaunchServices launch, restart, relocate and pre-move recall.
  export LUX_VERIFICATION_DRIVER
  mkdir -p "$proof/launch-1"
  "$work/observer" --verification "$app" "$proof/launch-1" "$(uuidgen)" run --installed-proof --proof-state "$state" --proof-report "$proof/run-1.json"
  assistant="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["service"]["assistantId"])' "$proof/run-1.json")"
  [ -n "$assistant" ] || { echo 'MACOS-INSTALL FAIL: no assistant identity in the proof report' >&2; exit 1; }

  # Synthetic protected owner profile for the real, native-obtained identity.
  profileDir="$HOME/private"
  mkdir -p "$profileDir"; chmod 0700 "$profileDir"
  python3 - "$profileDir/owner-profile.json" "$assistant" <<'PY'
import json, sys
path, owner = sys.argv[1:]
with open(path, 'w') as f:
    json.dump({"schemaVersion": 1, "kind": "profile", "ownerId": owner,
               "profileVersion": "synthetic-1", "displayName": "Synthetic Operator",
               "style": {"text": "concise", "dataClass": "ordinary"},
               "lore": {"text": "local only", "dataClass": "private"}}, f)
PY
  chmod 0600 "$profileDir/owner-profile.json"
  "$binary" --configure --owner-profile "$profileDir/owner-profile.json" > "$proof/configure-profile.log" 2>&1
  grep -q 'DIDI CONFIGURE: saved' "$proof/configure-profile.log"
  # The configDir from the earlier update must survive: update, not replacement.
  python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));assert d.get("configDir"), d' "$settings"

  # Restart: the native-launched host must accept the label and the immutable
  # prompt/session snapshot for the actual identity, then still recall the
  # pre-move content after relocation.
  mkdir -p "$proof/launch-2"
  rm -f "$proof/run-2.json"
  "$work/observer" --verification "$app" "$proof/launch-2" "$(uuidgen)" run --installed-proof --proof-state "$state" --proof-report "$proof/run-2.json" &
  observer_pid=$!
  # Observe the accepted label over the existing protected loopback API while the
  # native-launched host is up (one bounded poll, no idle loop).
  origin=""
  for _ in $(seq 1 120); do
    origin="$(python3 - "$proof/run-2.json" <<'PY'
import json, sys
try: print(json.load(open(sys.argv[1])).get("service", {}).get("origin", ""))
except Exception: print("")
PY
)"
    [ -n "$origin" ] && break
    sleep 0.25
  done
  if [ -z "$origin" ]; then
    kill "$observer_pid" 2>/dev/null || true
    echo 'MACOS-INSTALL FAIL: no host origin observed during the native launch' >&2; exit 1
  fi
  token="$(tr -d '\n' < "$state/admin-credential")"
  status_json="$(curl -fsS -H "Authorization: Bearer $token" "$origin/api/v1/status")"
  wait "$observer_pid"
  python3 - "$status_json" "$assistant" <<'PY'
import json, sys
data = json.loads(sys.argv[1])["data"]
profile = data["ownerProfile"]
assert profile["status"] == "configured" and profile["displayName"] == "Synthetic Operator", profile
assert data["assistantId"] == sys.argv[2], data["assistantId"]
print("MACOS-INSTALL: protected API accepted label", profile["displayName"])
PY
  python3 -c 'import json,sys;r=json.load(open(sys.argv[1]));assert r.get("success") is True and (r.get("error") in (None, {})), r.get("error")' "$proof/run-2.json"
  # Read-only store seam: the immutable owner-profile snapshot persisted per run.
  snapshot="$(python3 - "$state/state.sqlite" <<'PY'
import sqlite3, sys
try:
    db = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
    rows = db.execute("SELECT snapshot_json FROM chat_run_owner_profile").fetchall()
    print(rows[-1][0] if rows else "")
except Exception:
    print("")
PY
)"
  if [ -z "$snapshot" ]; then
    echo 'MACOS-INSTALL FAIL: no immutable chat_run_owner_profile snapshot (needs the inert-run proof seam from R5/R6)' >&2; exit 1
  fi
  python3 -c 'import json,sys;d=json.loads(sys.argv[1]);assert d["kind"]=="profile" and d["displayName"]=="Synthetic Operator", d' "$snapshot"
  # A profile for a foreign identity must fail closed at the actual host.
  python3 - "$profileDir/other.json" <<'PY'
import json, sys
with open(sys.argv[1], 'w') as f:
    json.dump({"schemaVersion": 1, "kind": "profile", "ownerId": "99999999-9999-9999-9999-999999999999",
               "profileVersion": "synthetic-1", "displayName": "Other",
               "style": {"text": "concise", "dataClass": "ordinary"},
               "lore": {"text": "local only", "dataClass": "private"}}, f)
PY
  chmod 0600 "$profileDir/other.json"
  "$binary" --configure --owner-profile "$profileDir/other.json" > /dev/null 2>&1
  if "$work/observer" --verification "$app" "$proof/launch-reject" "$(uuidgen)" run --installed-proof --proof-state "$state" --proof-report "$proof/run-reject.json" 2>/dev/null; then
    echo 'MACOS-INSTALL FAIL: host accepted a profile for a foreign identity' >&2; exit 1
  fi
  "$binary" --configure --owner-profile "$profileDir/owner-profile.json" > /dev/null 2>&1

  mv "$app" "$work/Moved Didi.app"
  mkdir -p "$proof/launch-3"
  "$work/observer" --verification "$work/Moved Didi.app" "$proof/launch-3" "$(uuidgen)" run --installed-proof --proof-state "$state" --proof-report "$proof/run-3.json"
  app="$work/Moved Didi.app"
  echo 'MACOS-INSTALL: launch/profile/restart/relocate pass'

  # Install and rollback: replace the prior app and prove the rollback is kept.
  apps="$work/Applications"
  mkdir -p "$apps"
  bash scripts/install-macos-app.sh "$app" --to "$apps" > "$proof/install-1.log"
  grep -q 'INSTALL-MACOS-APP PASS' "$proof/install-1.log"
  bash scripts/install-macos-app.sh "$app" --to "$apps" > "$proof/install-2.log"
  rollback="$(find "$apps" -maxdepth 1 -name 'Lux Didi.app.rollback-*' | head -1)"
  [ -n "$rollback" ] || { echo 'MACOS-INSTALL FAIL: no rollback preserved' >&2; exit 1; }
  codesign --verify --deep --strict "$apps/Lux Didi.app"
  node Tests/DidiMacTests/staged-app-proof.mjs "$apps/Lux Didi.app" --forbid "$HOME"
  echo "MACOS-INSTALL: install and rollback pass rollback=$(basename "$rollback")"
  printf 'MACOS-INSTALL PASS proof=%s\n' "$proof"
  exit
fi

# Prepare: build synthetic accepted assets and compose the production app. Native
# compilation and bundling stay outside the browser lease.
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-macos-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT
parent="${LUX_DIDI_PROOF_DIR:-${TMPDIR:-/tmp}}"
mkdir -p "$parent"
proof="$(mktemp -d "$parent/macos-install-proof-${LUX_WORKER_RUN_ID:-$$}.XXXXXX")"
printf 'PROOF-DIR=%s\n' "$proof"
node="$(command -v node)"
mkdir "$work/source"
git archive HEAD server web | tar -x -C "$work/source"
export npm_config_userconfig=/dev/null npm_config_globalconfig="$work/absent-global-config"
cache="${LUX_COMPANION_NPM_CACHE:-$HOME/.npm}"
npm --prefix "$work/source/server" ci --offline --ignore-scripts --no-audit --no-fund --cache "$cache"
npm --prefix "$work/source/web" ci --offline --ignore-scripts --no-audit --no-fund --cache "$cache"
"$node" "$work/source/server/node_modules/typescript/bin/tsc" -p "$work/source/server/tsconfig.json"
npm --prefix "$work/source/web" run build
assets="$work/assets"
mkdir -p "$assets/server" "$assets/web"
cp -R "$work/source/server/dist" "$work/source/server/node_modules" "$assets/server/"
cp "$work/source/server/package.json" "$assets/server/"
cp -R "$work/source/web/dist" "$assets/web/"
# Self-contained node: node plus its non-system dylib closure, each rewritten to
# @loader_path. @rpath is resolved against the ORIGINAL binary (the Homebrew
# Cellar), never the copy, so libnode.147.dylib and friends are bundled.
python3 - "$node" "$assets" <<'PY'
import os, shutil, subprocess, sys
src, assets = sys.argv[1:]
libdir = os.path.join(assets, "lib")
os.makedirs(libdir, exist_ok=True)
system = ("/usr/lib/", "/System/")
def run(*a): return subprocess.run(a, capture_output=True, text=True, check=True).stdout
def deps(path):
    return [l.strip().split(" (")[0] for l in run("otool", "-L", path).splitlines()[1:] if l.strip()]
def rpaths(path):
    lines = run("otool", "-l", path).splitlines(); out = []
    for i, l in enumerate(lines):
        if l.strip().startswith("cmd LC_RPATH"):
            for j in range(i + 1, min(i + 4, len(lines))):
                s = lines[j].strip()
                if s.startswith("path "):
                    out.append(s[len("path "):].split(" ")[0]); break
    return out
def resolve(lib, base_dir, rps):
    if lib.startswith("@rpath/"):
        tail = lib[len("@rpath/"):]
        for rp in rps:
            cand = os.path.join(rp, tail)
            if os.path.exists(cand): return os.path.realpath(cand)
        return None
    if lib.startswith("@loader_path/"):
        cand = os.path.join(base_dir, lib[len("@loader_path/"):])
        return os.path.realpath(cand) if os.path.exists(cand) else None
    return os.path.realpath(lib) if os.path.exists(lib) else None
def process(original, copy):
    base_dir = os.path.dirname(original)
    rps = [rp.replace("@loader_path", base_dir) for rp in rpaths(original)]
    for lib in deps(original):
        if lib.startswith(system): continue
        real = resolve(lib, base_dir, rps)
        if real is None: continue
        base = os.path.basename(real)
        dest = os.path.join(libdir, base)
        if not os.path.exists(dest):
            shutil.copy2(real, dest); os.chmod(dest, 0o755)
            subprocess.run(["install_name_tool", "-id", "@loader_path/" + base, dest], check=True)
            process(real, dest)
        subprocess.run(["install_name_tool", "-change", lib, "@loader_path/" + base, copy], check=True)
real_src = os.path.realpath(src)
nodecopy = os.path.join(assets, "node")
shutil.copy2(real_src, nodecopy); os.chmod(nodecopy, 0o755)
process(real_src, nodecopy)
unresolved = []
def check(path):
    for lib in deps(path):
        if lib.startswith(system) or lib.startswith("@loader_path/"): continue
        unresolved.append((path, lib))
check(nodecopy)
for name in os.listdir(libdir): check(os.path.join(libdir, name))
if unresolved:
    print("NODE-BUNDLE-UNRESOLVED %s" % unresolved[:5]); sys.exit(1)
print("NODE-BUNDLE libs=%d" % len(os.listdir(libdir)))
PY
test -x "$assets/node" || { echo 'MACOS-INSTALL FAIL: bundled node missing' >&2; exit 1; }
app="$work/Lux Didi.app"
bash scripts/build-macos-app.sh "$app" --assets "$assets" --release-commit "$(git rev-parse HEAD)"

# External LaunchServices observer (the existing verification driver), built here
# so no compile happens inside the lease.
src=Tests/DidiCompanionTests/launch-probe
/usr/bin/nice -n 10 xcrun clang -c "$src/Kernel.c" -o "$work/Kernel.o"
/usr/bin/nice -n 10 xcrun swiftc -j 1 -num-threads 1 -parse-as-library -import-objc-header "$src/Kernel.h" "$src/Identity.swift" "$src/Observer.swift" "$work/Kernel.o" -o "$work/observer"

lux-browser-slot run --wait 120 -- bash "$0" --leased-run "$work" "$proof" "$node" "$app"
