#!/usr/bin/env bash
# Fill the npm cache with every tarball locked in server/ and web/ so the offline
# installs can succeed.
#
# Online and idempotent. It installs each package into a throwaway copy of its
# package.json and lockfile and deletes that copy, so it never touches any
# node_modules in the repository. It writes to the cache npm_config_cache points
# at, or the user cache when that is unset, and prints how many cache entries it
# added.
set -euo pipefail
cd "$(dirname "$0")/.."

cache="${npm_config_cache:-$HOME/.npm}"
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-warm-npm.XXXXXX")
trap 'rm -rf "$work"' EXIT

content="$cache/_cacache/content-v2"
count() {
  { find "$content" -type f 2>/dev/null || true; } | wc -l | tr -d ' '
}

before=$(count)
for pkg in server web; do
  mkdir -p "$work/$pkg"
  cp "$pkg/package.json" "$pkg/package-lock.json" "$work/$pkg/"
  (cd "$work/$pkg" && npm ci --ignore-scripts --no-audit --no-fund --cache "$cache" >/dev/null)
done
after=$(count)

printf 'warm-npm-cache: added %s tarballs to %s\n' "$((after - before))" "$cache"
