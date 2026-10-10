#!/usr/bin/env bash
# Produce an asset-only Didi bundle in scratch.
#
# Stages, in one bundle directory: the official Node.js Darwin-arm64 runtime
# archive (checksum-verified against that release's published SHASUMS256.txt),
# the accepted server package packed and installed offline into the prefix's own
# node_modules, and the built interface shell. It never signs and never claims
# the app: no codesign, no Info.plist, no .app/.framework label.
#
# Usage: bash scripts/build-asset-bundle.sh [OUTDIR]
# Prints ASSET_BUNDLE=<dir> plus the recorded Node version and archive digest.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
if test -n "$(git status --porcelain -- server web scripts/build-asset-bundle.sh scripts/check-asset-bundle.sh)"; then
  echo 'Asset bundle requires clean, committed server and web source' >&2
  exit 1
fi

out="${1:-}"
if test -z "$out"; then out=$(mktemp -d "${TMPDIR:-/tmp}/didi-asset-bundle.XXXXXX"); fi
mkdir -p "$out/Resources/node" "$out/Resources/web" "$out/server"
out=$(cd "$out" && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-asset-build.XXXXXX")
trap 'rm -rf "$work"' EXIT

node_version="${ASSET_BUNDLE_NODE_VERSION:-26.8.2}"
fetch_base="${ASSET_BUNDLE_FETCH_BASE:-https://nodejs.org/dist}"
bundled_node="$out/Resources/node/bin/node"

# 1. Official Node.js Darwin-arm64 runtime, verified against the release SHASUMS256.txt.
archive="node-v${node_version}-darwin-arm64.tar.gz"
curl -fsSL "$fetch_base/v${node_version}/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
grep -E "^[0-9a-f]{64}  ${archive}\$" "$work/SHASUMS256.txt" > "$work/${archive}.sha256"
test -s "$work/${archive}.sha256" || { echo "Node release v${node_version} does not publish ${archive}" >&2; exit 1; }
curl -fsSL "$fetch_base/v${node_version}/${archive}" -o "$work/$archive"
(cd "$work" && shasum -a 256 -c "${archive}.sha256")
tar -xzf "$work/$archive" -C "$out/Resources/node" --strip-components=1
test -x "$bundled_node" || { echo 'Bundled node binary is not executable' >&2; exit 1; }
test "$("$bundled_node" -p 'process.version')" = "v${node_version}" || { echo 'Bundled node version mismatch' >&2; exit 1; }
node_sha=$(cut -d' ' -f1 "$work/${archive}.sha256")

# 2. Accepted server package: packed offline, then installed offline into a private prefix.
mkdir -p "$work/source"
git archive HEAD server | tar -xf - -C "$work/source"
builder="$work/source/server"
export npm_config_cache="$work/cache"
(cd "$builder" && npm ci --ignore-scripts --no-audit --no-fund && npm run typecheck && npm run build)
pack_json=$(cd "$builder" && npm pack --json --offline --ignore-scripts)
tarball=$(printf '%s' "$pack_json" | "$bundled_node" -e 'const chunks=[];process.stdin.on("data",c=>chunks.push(c)).on("end",()=>{const parsed=JSON.parse(chunks.join(""));const first=(Array.isArray(parsed)?parsed:Object.values(parsed))[0];process.stdout.write(String(first.filename));});')
test -n "$tarball" || { echo 'npm pack produced no tarball name' >&2; exit 1; }
cp "$builder/$tarball" "$out/$tarball"
(cd "$out/server" && npm install --offline --omit=dev --ignore-scripts --no-audit --no-fund "$out/$tarball")
installed="$out/server/node_modules/@lux-didi/service"
test -d "$installed/dist/tools" || { echo 'Offline install is missing the compiled tools tree' >&2; exit 1; }
test -f "$installed/dist/host/index.js" || { echo 'Offline install is missing the host entry' >&2; exit 1; }

# 3. Built interface shell, served by the host entry with an explicit web root.
git archive HEAD web | tar -xf - -C "$work/source"
web="$work/source/web"
(cd "$web" && npm ci --ignore-scripts --no-audit --no-fund && npm run build)
cp -R "$web/dist" "$out/Resources/web/dist"
test -f "$out/Resources/web/dist/index.html" || { echo 'Built web shell is missing its index' >&2; exit 1; }

# 4. Asset-only: never sign and never claim the app.
if /usr/bin/find "$out" \( -name Info.plist -o -name _CodeSignature -o -name '*.app' -o -name '*.framework' \) -print -quit | grep -q .; then
  echo 'Asset bundle must not contain a signing or app claim' >&2
  exit 1
fi
cat > "$out/ASSET-BUNDLE.txt" <<EOF
node=v${node_version}
node_sha256=$node_sha
service=@lux-didi/service
tarball=$tarball
web=Resources/web/dist
host_entry=server/node_modules/@lux-didi/service/dist/host/index.js
asset_only=unsigned
EOF

printf 'ASSET_BUNDLE=%s\n' "$out"
printf 'ASSET_BUNDLE_NODE=v%s\n' "$node_version"
printf 'ASSET_BUNDLE_NODE_SHA256=%s\n' "$node_sha"
