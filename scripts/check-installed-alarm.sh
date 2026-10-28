#!/usr/bin/env bash
# Synthetic host, stub clock and fake shell only. Never launch the app or use audio/accounts.
# An explicit app target checks that package; default stages an offline service package.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
repo="$PWD"
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-installed-alarm.XXXXXX")
trap 'rm -rf "$work"' EXIT
if [ "$#" -gt 1 ]; then
  echo 'ALARM CHECK FAIL: expected at most one installed app target' >&2; exit 2
fi
alarm_node=node
if [ "$#" -eq 1 ]; then
  resources="$1/Contents/Resources"
  [ ! -x "$1/Contents/MacOS/node" ] || alarm_node="$1/Contents/MacOS/node"
else
  resources="${DIDI_ALARM_RESOURCES:-$work/Resources}"
fi
if [ "$#" -eq 0 ] && [ -z "${DIDI_ALARM_RESOURCES:-}" ]; then
  (cd server && npm run build)
  mkdir -p "$resources/server/node_modules/@lux-didi/service" "$resources/web"
  (cd server && npm pack --offline --loglevel=error --ignore-scripts --pack-destination "$work" >/dev/null)
  tar -xzf "$work"/*.tgz --strip-components=1 -C "$resources/server/node_modules/@lux-didi/service"
  ln -s "$repo/server/node_modules" "$resources/server/node_modules/@lux-didi/service/node_modules"
  cp -R web/dist "$resources/web/dist"
  echo 'ALARM CHECK STAGED: offline service package in Resources layout'
fi
service="$resources/server/node_modules/@lux-didi/service"
test -f "$service/dist/host/runtime.js" || { echo 'ALARM CHECK FAIL: installed host runtime missing' >&2; exit 1; }
DIDI_ALARM_SERVICE_ROOT="$service" DIDI_ALARM_WEB_ROOT="$resources/web/dist" \
  "$alarm_node" --test --test-timeout=15000 server/test/alarm-host.integration.mjs
