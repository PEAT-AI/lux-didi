#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../.."
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-entry-probe.XXXXXX")"
report="${1:?private preserved installed-proof report required}"
python3 - "$report" "$work/paths" <<'PYTHON'
import json, pathlib, os, re
source=json.loads(pathlib.Path(__import__('sys').argv[1]).read_text())["source"]
bundle=pathlib.Path(source["bundlePath"])
assert not bundle.exists(), "original staging path reused; refusing"
assert os.path.realpath(bundle).startswith(os.path.realpath(os.environ["TMPDIR"])+"/"), "outside private worker temp"
assert source["serverEntry"] == "server/dist/host/index.js"
assert re.fullmatch("[0-9a-f]{64}",source["serverEntrySHA256"])
pathlib.Path(__import__('sys').argv[2]).write_text("\n".join([str(bundle),source["nodePath"],source["serverEntrySHA256"]])+"\n")
PYTHON
bundle="$(sed -n '1p' "$work/paths")"
node="$(sed -n '2p' "$work/paths")"
expected="$(sed -n '3p' "$work/paths")"
mkdir -p "$bundle/Contents/Resources" "$work/source"
trap 'rm -rf "$work" "$bundle"' EXIT
export npm_config_userconfig=/dev/null npm_config_globalconfig="$work/absent-global-config"
cache="${LUX_COMPANION_NPM_CACHE:-$HOME/.npm}"
git archive HEAD server | tar -x -C "$work/source"
npm --prefix "$work/source/server" ci --offline --ignore-scripts --no-audit --no-fund --cache "$cache" >/dev/null
"$node" "$work/source/server/node_modules/typescript/bin/tsc" -p "$work/source/server/tsconfig.json"
cp -R "$work/source/server" "$bundle/Contents/Resources/server"
entry="$bundle/Contents/Resources/server/dist/host/index.js"
[ "$(shasum -a 256 "$entry" | cut -d' ' -f1)" = "$expected" ]
cat > "$work/path.swift" <<'SWIFT'
import Foundation
let resource = URL(fileURLWithPath:CommandLine.arguments[1]).resolvingSymlinksInPath().standardizedFileURL
print(resource.appendingPathComponent("server/dist/host/index.js").resolvingSymlinksInPath().standardizedFileURL.path)
SWIFT
xcrun swiftc -module-cache-path "$work/cache" "$work/path.swift" -o "$work/path"
argvEntry="$("$work/path" "$bundle/Contents/Resources")"
realEntry="$("$node" -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$argvEntry")"
printf 'EXACT-NODE=%s\nACTUAL-RESOURCE-PIPELINE-ARGV=%s\nMODULE-REALPATH=%s\nMATCHED-PRESERVED-ENTRY-SHA256=%s\n' "$node" "$argvEntry" "$realEntry" "$expected"
for label in original realpath; do
 candidate="$argvEntry"; [ "$label" != realpath ] || candidate="$realEntry"
 set +e
 "$node" "$candidate" --help > "$work/$label.out" 2>/dev/null
 status=$?
 set -e
 printf 'HELP-%s exit=%s bytes=%s usage=' "$label" "$status" "$(wc -c < "$work/$label.out" | tr -d ' ')"
 grep -q '^Usage: node server/dist/host/index.js' "$work/$label.out" && echo true || echo false
 done
