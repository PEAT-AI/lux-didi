#!/bin/bash
# Canonical native producer for the Lux Didi macOS app.
#
# Compiles the native shell and (optionally) composes an accepted asset bundle
# into one .app, then signs nested Mach-O code first and the completed bundle
# last. Tests/DidiMacTests/check-mac.sh and scripts/check-macos-install.sh both
# call this producer; there is no second compile/identity path.
#
# Usage:
#   scripts/build-macos-app.sh <app-dir> [--assets DIR] [--install-id UUID]
#                              [--release-commit SHA] [--cache DIR]
#
# Asset bundle layout (accepted producer output, scripts/build-asset-bundle.sh):
#   DIR/Resources/node/bin/node                                  -> Contents/MacOS/node
#   DIR/server/node_modules/@lux-didi/service                    -> Contents/Resources/server/node_modules/@lux-didi/service
#   DIR/Resources/web/dist                                       -> Contents/Resources/web/dist
# Runtime manifest (Contents/Resources/didi-runtime.json) is written here with
# nodePath "Contents/MacOS/node", serverEntry
# "server/node_modules/@lux-didi/service/dist/host/index.js" and webRoot "web/dist". The native app validates it on every launch.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"

app=""
assets=""
install_id=""
release_commit=""
cache=""
while [ $# -gt 0 ]; do
  case "$1" in
    --assets) assets="${2:?--assets needs a directory}"; shift 2;;
    --install-id) install_id="${2:?--install-id needs a uuid}"; shift 2;;
    --release-commit) release_commit="${2:?--release-commit needs a sha}"; shift 2;;
    --cache) cache="${2:?--cache needs a directory}"; shift 2;;
    -h|--help) sed -n '2,20p' "$0"; exit 0;;
    -*) echo "build-macos-app.sh: unknown option $1" >&2; exit 2;;
    *) app="$1"; shift;;
  esac
done
[ -n "$app" ] || { echo "build-macos-app.sh: an app output path is required" >&2; exit 2; }
cache="${cache:-$(mktemp -d "${TMPDIR:-/tmp}/didi-macos-build.XXXXXX")}"
mkdir -p "$cache"
cd "$root"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp Resources/Info.plist "$app/Contents/Info.plist"

# Canonical native compile identity. Production never defines COMPANION_TEST.
minimum_macos="$(/usr/bin/plutil -extract LSMinimumSystemVersion raw Resources/Info.plist)"
[[ "$minimum_macos" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || { echo 'build-macos-app.sh: macOS minimum must be a numeric version' >&2; exit 2; }
/usr/bin/nice -n 10 xcrun swiftc -j 1 -num-threads 1 -whole-module-optimization \
  -target "arm64-apple-macosx$minimum_macos" \
  -module-cache-path "$cache" -parse-as-library Sources/LuxDidi/*.swift \
  -o "$app/Contents/MacOS/LuxDidi"

if [ -n "$assets" ]; then
  # Accepted asset-bundle layout (scripts/build-asset-bundle.sh @8b548fc).
  [ -f "$assets/Resources/node/bin/node" ] || { echo "build-macos-app.sh: accepted asset node missing" >&2; exit 2; }
  [ -f "$assets/server/node_modules/@lux-didi/service/dist/host/index.js" ] || { echo "build-macos-app.sh: accepted service host entry missing" >&2; exit 2; }
  [ -f "$assets/Resources/web/dist/index.html" ] || { echo "build-macos-app.sh: accepted web shell missing" >&2; exit 2; }

  install -m 0755 "$assets/Resources/node/bin/node" "$app/Contents/MacOS/node"
  rm -rf "$app/Contents/Resources/server" "$app/Contents/Resources/web"
  mkdir -p "$app/Contents/Resources/server/node_modules/@lux-didi" "$app/Contents/Resources/web"
  cp -R "$assets/server/node_modules/@lux-didi/service" "$app/Contents/Resources/server/node_modules/@lux-didi/service"
  cp -R "$assets/Resources/web/dist" "$app/Contents/Resources/web/dist"
  # The official node is self-contained; assert no unresolved non-system dependency.
  python3 - "$app/Contents/MacOS/node" <<'PY'
import subprocess, sys
def deps(p):
    return [l.strip().split(" (")[0] for l in subprocess.run(["otool", "-L", p], capture_output=True, text=True, check=True).stdout.splitlines()[1:] if l.strip()]
bad = [d for d in deps(sys.argv[1]) if not (d.startswith("/usr/lib/") or d.startswith("/System/") or d.startswith("@loader_path/"))]
if bad:
    print("BUILD-MACOS-APP FAIL: bundled node has unresolved deps", bad[:5]); sys.exit(1)
PY

  # Real Node major validation against the bundled binary, never a claim.
  major="$("$app/Contents/MacOS/node" -p 'process.versions.node.split(".")[0]')"
  [ "$major" = "26" ] || { echo "build-macos-app.sh: bundled node major $major is unsupported" >&2; exit 2; }

  install_id="${install_id:-$(uuidgen | tr 'A-Z' 'a-z')}"
  release_commit="${release_commit:-$(git -C "$root" rev-parse HEAD)}"
  case "$release_commit" in
    *[!0-9a-f]*|"") echo "build-macos-app.sh: release commit must be 40 lowercase hex" >&2; exit 2;;
  esac
  [ "${#release_commit}" = "40" ] || { echo "build-macos-app.sh: release commit must be 40 lowercase hex" >&2; exit 2; }
  python3 - "$app/Contents/Resources/didi-runtime.json" "$install_id" "$release_commit" <<'PY'
import json, sys
path, install_id, release_commit = sys.argv[1:]
document = {
    "schemaVersion": 1,
    "installId": install_id,
    "releaseCommit": release_commit,
    "nodePath": "Contents/MacOS/node",
    "nodeMajor": 26,
    "serverEntry": "server/node_modules/@lux-didi/service/dist/host/index.js",
    "webRoot": "web/dist",
}
with open(path, "w") as handle:
    json.dump(document, handle, sort_keys=True)
    handle.write("\n")
PY
  chmod 0644 "$app/Contents/Resources/didi-runtime.json"
fi

# Sign nested Mach-O code first, the completed outer bundle last (TN2206).
while IFS= read -r -d '' candidate; do
  case "$candidate" in
    "$app/Contents/MacOS/LuxDidi") continue;;
  esac
  magic="$(xxd -p -l 4 "$candidate" 2>/dev/null || true)"
  case "$magic" in
    cffaedfe|cefaedfe|cafebabe|bebafeca|feedface|feedfacf)
      codesign --force --sign - "$candidate"
      ;;
  esac
done < <(find "$app" -type f -print0)

codesign --force --sign - --entitlements Resources/LuxDidi.entitlements "$app"
codesign --verify --deep --strict "$app"
printf 'BUILD-MACOS-APP PASS app=%s assets=%s libs=%s\n' "$app" "${assets:-none}" "$(ls "$app/Contents/MacOS"/*.dylib 2>/dev/null | wc -l | tr -d ' ')"
