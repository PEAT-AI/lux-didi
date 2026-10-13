#!/usr/bin/env bash
# Run an offline npm install and fail loud when the cache lacks a locked tarball.
#
# A bare `npm ci --offline` that cannot find a tarball exits with an opaque npm
# error and never names the missing package or the fix. This helper runs the exact
# npm arguments supplied by a call site from its target directory, keeps npm's own output, and on failure adds one
# clear stderr line naming the directory, npm's error code, the missing
# package@version when npm names it, and the warm-cache command. It never falls
# back to the network.
#
# Usage: bash scripts/npm-ci-offline.sh <dir> [npm args...]
#   With no npm args it runs the canonical clean install:
#     (cd <dir> && npm ci --offline --ignore-scripts --no-audit --no-fund)
#   A call site that needs extra flags or another subcommand (for example the
#   offline tarball installs) passes its exact npm arguments after <dir>, so the
#   helper runs those arguments with <dir> as its working directory.
set -uo pipefail

dir=${1:-}
if [ -z "$dir" ]; then
  echo 'usage: bash scripts/npm-ci-offline.sh <dir> [npm args...]' >&2
  exit 2
fi
shift
if [ "$#" -eq 0 ]; then
  set -- ci --offline --ignore-scripts --no-audit --no-fund
fi

log=$(mktemp "${TMPDIR:-/tmp}/npm-ci-offline.XXXXXX")
trap 'rm -f "$log"' EXIT

(cd "$dir" && npm "$@") 2>"$log"
status=$?
cat "$log" >&2

if [ "$status" -ne 0 ]; then
  code=$(sed -n 's/^npm error code //p' "$log" | head -n1)
  [ -n "$code" ] || code=unknown
  name=$(sed -n 's#^npm error request to .*\(@[^/]*/[^/]*\)/-/.*#\1#p' "$log" | head -n1)
  if [ -z "$name" ]; then
    name=$(sed -n 's#^npm error request to .*/\([^/]*\)/-/.*#\1#p' "$log" | head -n1)
  fi
  version=$(sed -n 's#^npm error request to .*/-/[^[:space:]]*-\([0-9][0-9A-Za-z.+-]*\)\.tgz.*#\1#p' "$log" | head -n1)
  missing=''
  if [ -n "$name" ] && [ -n "$version" ]; then
    missing=" missing $name@$version"
  fi
  printf 'npm-ci-offline: offline install failed in %s (npm code %s)%s; run "bash scripts/warm-npm-cache.sh" to add the locked tarballs to the npm cache\n' \
    "$dir" "$code" "$missing" >&2
  exit "$status"
fi
