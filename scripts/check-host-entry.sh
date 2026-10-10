#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
if test -n "$(git status --porcelain -- server scripts/check-host-entry.sh)"; then
  echo 'Host entry check requires clean, committed source' >&2
  exit 1
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-host-entry.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/source" "$work/runtime/test"
git archive HEAD server | tar -xf - -C "$work/source"
builder="$work/source/server"
# Never read a developer's npm profile or write to the shared dependency cache.
> "$work/npm-userconfig"
: > "$work/npm-globalconfig"
export npm_config_userconfig="$work/npm-userconfig" npm_config_globalconfig="$work/npm-globalconfig"
export npm_config_cache="$work/builder-cache"
printf 'HOST_ENTRY_SOURCE=%s NODE=%s NPM=%s PLATFORM=%s\n' "$(git rev-parse HEAD)" "$(node --version)" "$(npm --version)" "$(node -p 'process.platform+"/"+process.arch')"
(cd "$builder" && npm ci --ignore-scripts --no-audit --no-fund && npm run typecheck && npm run build)
cp -R "$builder/dist" "$work/runtime/dist"
cp "$builder/package.json" "$builder/package-lock.json" "$work/runtime/"
cp "$builder/test/host-entry.test.mjs" "$work/runtime/test/"
(cd "$work/runtime" && npm ci --offline --omit=dev --ignore-scripts --no-audit --no-fund)
node --test --test-reporter=tap --test-timeout=15000 "$work/runtime/test/host-entry.test.mjs" | tee "$work/test.log"
grep -Eq '^# tests [1-9][0-9]*$' "$work/test.log" || { echo 'Zero selected host entry tests' >&2; exit 1; }
