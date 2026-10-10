#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
root="$(pwd)"
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-native-live.XXXXXX")
cleanup() {
  status=$?
  if [ "$status" -eq 0 ]; then rm -rf "$work"; else printf 'FAILED ARTIFACTS: %s\n' "$work" >&2; fi
}
trap cleanup EXIT
printf '# isolated synthetic test user config\n' > "$work/npm-user"
printf '# isolated synthetic test global config\n' > "$work/npm-global"
export npm_config_userconfig="$work/npm-user" npm_config_globalconfig="$work/npm-global"
printf 'NATIVE-LIVE source=%s UTC=%s\n' "$(git rev-parse HEAD)" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
# Committed locks, offline only; canonical web/dist is intentionally separate from all fixture state.
npm --prefix server ci --offline --ignore-scripts --no-audit --no-fund
npm --prefix server run build
npm --prefix web ci --offline --ignore-scripts --no-audit --no-fund
npm --prefix web run build
swiftc -swift-version 6 -warnings-as-errors -parse-as-library \
  Tests/DidiLiveTests/Stage0.swift -o "$work/stage0"
node Tests/DidiLiveTests/gateway.mjs "$work/stage0" "$work"
echo 'NATIVE-LIVE CHECK PASS'
