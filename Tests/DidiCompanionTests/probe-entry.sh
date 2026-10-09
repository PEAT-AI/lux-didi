#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../.."
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-entry-probe.XXXXXX")"
readarray_not_used=1
original='/private/tmp/pi-worker-pi-1fea5a67429f/didi-mac-check.vTbKNP'
[ ! -e "$original" ] || { echo 'original staging path reused; refusing'; exit 1; }
mkdir -p "$original/Lux Didi.app/Contents/Resources" "$work/source"
trap 'rm -rf "$work" "$original"' EXIT
export npm_config_userconfig=/dev/null npm_config_globalconfig="$work/absent-global-config"
cache="${LUX_COMPANION_NPM_CACHE:-$HOME/.npm}"
git archive HEAD server | tar -x -C "$work/source"
npm --prefix "$work/source/server" ci --offline --ignore-scripts --no-audit --no-fund --cache "$cache" >/dev/null
node="/opt/homebrew/Cellar/node/26.8.2/bin/node"
"$node" "$work/source/server/node_modules/typescript/bin/tsc" -p "$work/source/server/tsconfig.json"
cp -R "$work/source/server" "$original/Lux Didi.app/Contents/Resources/server"
entry="$original/Lux Didi.app/Contents/Resources/server/dist/host/index.js"
[ "$(shasum -a 256 "$entry" | cut -d' ' -f1)" = b4b8864af24e1f52fba758b744e1ae93483d24e3d0660ae1fe532c8f76d7200a ]
cat > "$work/path.swift" <<'SWIFT'
import Foundation
let resource = URL(fileURLWithPath:CommandLine.arguments[1]).resolvingSymlinksInPath().standardizedFileURL
print(resource.appendingPathComponent("server/dist/host/index.js").resolvingSymlinksInPath().standardizedFileURL.path)
SWIFT
xcrun swiftc -module-cache-path "$work/cache" "$work/path.swift" -o "$work/path"
argvEntry="$("$work/path" "$original/Lux Didi.app/Contents/Resources")"
realEntry="$("$node" -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$argvEntry")"
printf 'EXACT-NODE=%s\nACTUAL-RESOURCE-PIPELINE-ARGV=%s\nMODULE-REALPATH=%s\nMATCHED-0.17-ENTRY-SHA256=b4b8864af24e1f52fba758b744e1ae93483d24e3d0660ae1fe532c8f76d7200a\n' "$node" "$argvEntry" "$realEntry"
for label in original realpath; do
 candidate="$argvEntry"; [ "$label" != realpath ] || candidate="$realEntry"
 set +e
 "$node" "$candidate" --help > "$work/$label.out" 2>/dev/null
 status=$?
 set -e
 printf 'HELP-%s exit=%s bytes=%s usage=' "$label" "$status" "$(wc -c < "$work/$label.out" | tr -d ' ')"
 grep -q '^Usage: node server/dist/host/index.js' "$work/$label.out" && echo true || echo false
 done
