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
  work="$2"; proof="$3"; node="$4"; app="$5"; fixture="$6"; payload_sha="$7"
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
  [ "$("$app/Contents/MacOS/node" -p 'typeof require("node:module").registerHooks')" = "function" ] || { echo 'MACOS-INSTALL FAIL: bundled node lacks module.registerHooks' >&2; exit 1; }
  echo "MACOS-INSTALL: bundled node supports module.registerHooks"

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
  # Fixture P0/P1/P2: the test-only host entry injects a recording synthetic
  # transport so the per-run immutable snapshot is actually produced.
  fstate="$proof/fixture-state"; fconfig="$HOME/fixture-provider-config"
  mkdir -p "$fconfig"; chmod 0700 "$fconfig"
  mkdir -p "$proof/fx-p0"
  "$work/observer" --verification "$fixture" "$proof/fx-p0" "$(uuidgen)" run --installed-proof --proof-state "$fstate" --proof-report "$proof/fx-p0.json"
  fx_assistant="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["service"]["assistantId"])' "$proof/fx-p0.json")"
  pin="$work/profile-input.json"; senv="$work/source.env"
  printf '{"schemaVersion":1,"enabled":true,"provider":"gemini","modelId":"synthetic-model","keyReference":"gemini-primary"}\n' > "$pin"
  printf 'GEMINI_API_KEY=synthetic-NEVER-REAL\n' > "$senv"; chmod 0600 "$pin" "$senv"
  svc_dist="$fixture/Contents/Resources/server/node_modules/@lux-didi/service/dist"
  "$fixture/Contents/MacOS/node" --input-type=module -e 'import { initializeProviderConfig } from process.argv[1]; initializeProviderConfig({ configDir: process.argv[2], ownerId: process.argv[3], profileInputPath: process.argv[4], sourceEnvPath: process.argv[5] });' "file://$svc_dist/config/index.js" "$fconfig" "$fx_assistant" "$pin" "$senv"
  "$fixture/Contents/MacOS/LuxDidi" --configure --config-dir "$fconfig" --owner-profile "$profileDir/owner-profile.json"
  run_fixture() {
    local label="$1" report="$2"
    mkdir -p "$proof/fx-$label"
    "$work/observer" --verification "$fixture" "$proof/fx-$label" "$(uuidgen)" run --installed-proof --proof-state "$fstate" --proof-report "$report"
  }
  # P1: launch the fixture host and drive one chat run through the protected API
  # so the recording synthetic transport is invoked and the snapshot persists.
  rm -f "$proof/fx-p1.json"
  "$work/observer" --verification "$fixture" "$proof/fx-p1" "$(uuidgen)" run --installed-proof --proof-state "$fstate" --proof-report "$proof/fx-p1.json" &
  fx_pid=$!
  fx_origin=""
  for _ in $(seq 1 200); do
    fx_origin="$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("service",{}).get("origin",""))
except Exception: print("")' "$proof/fx-p1.json" 2>/dev/null)"
    [ -n "$fx_origin" ] && break
    sleep 0.25
  done
  [ -n "$fx_origin" ] || { kill "$fx_pid" 2>/dev/null || true; echo 'MACOS-INSTALL FAIL: fixture host did not become ready' >&2; exit 1; }
  fx_epoch="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["service"]["authorityEpoch"])' "$proof/fx-p1.json")"
  fxtoken="$(tr -d '\n' < "$fstate/admin-credential")"
  sid="$(curl -fsS -X POST "$fx_origin/api/v1/sessions" -H "Authorization: Bearer $fxtoken" -H "Origin: $fx_origin" -H "Content-Type: application/json" -H "X-Didi-Authority-Epoch: $fx_epoch" -H "Idempotency-Key: $(uuidgen)" --data '{"title":"synthetic fixture","timeZone":"UTC"}' | python3 -c 'import json,sys;d=json.load(sys.stdin).get("data") or {};print(d.get("sessionId") or d.get("id") or "")')"
  [ -n "$sid" ] || sid="$(uuidgen)"
  fkey="$(uuidgen)"
  chat() { curl -fsS -X POST "$fx_origin/api/v1/chat" -H "Authorization: Bearer $fxtoken" -H "Origin: $fx_origin" -H "Content-Type: application/json" -H "X-Didi-Authority-Epoch: $fx_epoch" -H "Idempotency-Key: $1" --data "{\"sessionId\":\"$sid\",\"text\":\"synthetic fixture note\",\"timeZone\":\"UTC\"}"; }
  callcount() { python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))))' "$fstate/fixture-calls.json" 2>/dev/null || echo 0; }
  chat "$fkey" > "$proof/fx-chat-1.json"
  calls1="$(callcount)"
  chat "$fkey" > "$proof/fx-chat-replay.json"
  calls2="$(callcount)"
  wait "$fx_pid"
  [ "$calls1" -ge 1 ] || { echo 'MACOS-INSTALL FAIL: synthetic transport was not invoked' >&2; exit 1; }
  [ "$calls1" = "$calls2" ] || { echo 'MACOS-INSTALL FAIL: idempotent replay made extra transport calls' >&2; exit 1; }
  python3 - "$fstate/state.sqlite" "$proof/fx-triple.json" "$fstate/fixture-calls.json" <<'PY'
import hashlib, json, sqlite3, sys
db = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
rows = db.execute("SELECT run_id, snapshot_json FROM chat_run_owner_profile ORDER BY rowid").fetchall()
assert rows, "no chat_run_owner_profile row produced by the fixture"
run_id, snapshot = rows[-1]
snap = json.loads(snapshot)
assert snap.get("kind") == "profile" and snap.get("displayName") == "Synthetic Operator", snap
calls = json.load(open(sys.argv[3]))
assert calls and "synthetic fixture note" in json.dumps(calls[-1]["body"]), calls[-1] if calls else None
json.dump({"run_id": run_id, "sha256": hashlib.sha256(snapshot.encode()).hexdigest(), "snapshot": snap}, open(sys.argv[2], "w"))
print("FIXTURE-P1 run=%s sha256=%s calls=%d" % (run_id, hashlib.sha256(snapshot.encode()).hexdigest(), len(calls)))
PY
  # P2: change only a non-label profile field, restart, and prove the persisted
  # P1 run/hash is preserved.
  python3 - "$profileDir/owner-profile.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["profileVersion"] = "synthetic-2"
json.dump(d, open(sys.argv[1], "w"))
PY
  "$fixture/Contents/MacOS/LuxDidi" --configure --owner-profile "$profileDir/owner-profile.json" > /dev/null
  run_fixture p2 "$proof/fx-p2.json"
  python3 - "$fstate/state.sqlite" "$proof/fx-triple.json" <<'PY'
import hashlib, json, sqlite3, sys
db = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
rows = db.execute("SELECT run_id, snapshot_json FROM chat_run_owner_profile ORDER BY rowid").fetchall()
recorded = json.load(open(sys.argv[2]))
assert recorded["run_id"] in [r[0] for r in rows], "P1 run lost after the P2 restart"
p1 = json.loads([r[1] for r in rows if r[0] == recorded["run_id"]][0])
assert p1.get("displayName") == "Synthetic Operator", p1
print("FIXTURE-P2 preserved run=%s displayName=%s" % (recorded["run_id"], p1["displayName"]))
PY
  echo 'MACOS-INSTALL: fixture snapshot transport pass'
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
# Compose the real accepted asset bundle (official Node + built service/web) via
# its canonical producer; network is authorized for that producer only.
assets="${LUX_ASSET_BUNDLE:-}"
if [ -z "$assets" ]; then
  assets="$work/assets"
  bash scripts/build-asset-bundle.sh "$assets"
fi
app="$work/Lux Didi.app"
bash scripts/build-macos-app.sh "$app" --assets "$assets" --release-commit "$(git rev-parse HEAD)"

# Separately composed signed fixture app: the SAME compiled native payload with the
# accepted service host entry replaced by the test-only fixture entry (R8/R10).
# Record the pre-sign native payload identity; re-signing may alter signature bytes.
fixture="$work/Fixture Didi.app"
ditto "$app" "$fixture"
payload_sha="$(shasum -a 256 "$fixture/Contents/MacOS/LuxDidi" | awk '{print $1}')"
host_dir="$fixture/Contents/Resources/server/node_modules/@lux-didi/service/dist/host"
cp "$host_dir/index.js" "$host_dir/canonical.js"
cp Tests/DidiCompanionTests/fixture-host-entry.mjs "$host_dir/index.js"
cp Tests/DidiCompanionTests/fixture-host-runtime.mjs "$host_dir/fixture-host-runtime.mjs"
codesign --force --sign - --entitlements Resources/LuxDidi.entitlements "$fixture"
codesign --verify --deep --strict "$fixture"
printf 'FIXTURE-APP payload_sha256=%s\n' "$payload_sha"

# External LaunchServices observer (the existing verification driver), built here
# so no compile happens inside the lease.
src=Tests/DidiCompanionTests/launch-probe
/usr/bin/nice -n 10 xcrun clang -c "$src/Kernel.c" -o "$work/Kernel.o"
/usr/bin/nice -n 10 xcrun swiftc -j 1 -num-threads 1 -parse-as-library -import-objc-header "$src/Kernel.h" "$src/Identity.swift" "$src/Observer.swift" "$work/Kernel.o" -o "$work/observer"

lux-browser-slot run --wait 120 -- bash "$0" --leased-run "$work" "$proof" "$node" "$app" "$fixture" "$payload_sha"
