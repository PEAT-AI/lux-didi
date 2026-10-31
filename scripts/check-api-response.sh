#!/usr/bin/env bash
# Focused real-service/browser request-boundary proof. One unique artifact tree per invocation.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
# The proof root holds this invocation's artifact tree. config/check-map.json names checks without
# arguments and the combined-tree gate runs each one bare, so an omitted root mints a temp one; an
# explicit root stays supported for retained evidence and must be absolute.
proof_root="${1:-}"
if [[ $# -gt 1 || ( -n "$proof_root" && "$proof_root" != /* ) ]]; then
  echo 'Usage: check-api-response.sh [/absolute/proof-root]' >&2; exit 2
fi
if test -z "$proof_root"; then proof_root=$(mktemp -d "${TMPDIR:-/tmp}/didi-api-response.XXXXXX"); fi
# One bounded total budget, including build, renderer admission and browser cleanup.
if [[ "${DIDI_API_RESPONSE_BOUNDED:-}" != 1 ]]; then
  exec timeout 280 env DIDI_API_RESPONSE_BOUNDED=1 bash "$0" "$proof_root"
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
mkdir -p "$proof_root"
export DIDI_API_RESPONSE_ARTIFACTS
DIDI_API_RESPONSE_ARTIFACTS="$(mktemp -d "$proof_root/invocation-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
export DIDI_API_RESPONSE_SHA
DIDI_API_RESPONSE_SHA="$(git rev-parse HEAD)"
printf 'API_RESPONSE_PROOF=%s\n' "$DIDI_API_RESPONSE_ARTIFACTS"
printf '%s\n' "$DIDI_API_RESPONSE_SHA" > "$DIDI_API_RESPONSE_ARTIFACTS/source-sha.txt"
date -u +%FT%TZ > "$DIDI_API_RESPONSE_ARTIFACTS/date.txt"
git diff --check -- web/src/api.ts server/test/api-response-browser.mjs scripts/check-api-response.sh
[[ -x server/node_modules/.bin/tsc && -d web/node_modules ]] || { echo 'Installed server/web dependencies required' >&2; exit 2; }
timeout 60 bash scripts/run-local.sh --build-only | tee "$DIDI_API_RESPONSE_ARTIFACTS/build.log"
test -s server/dist/test/connected-process.js
node --check server/test/api-response-browser.mjs
status=0
# The slot execs CMD as argv, so the runner function has to be reached through a shell.
lux-browser-slot run --priority worker --want 1 --wait 1800 -- \
  bash -c ". $root/scripts/lib/node-test-files.sh; node_test_files \"\$@\"" _ \
  --test-reporter=tap --test-timeout=90000 server/test/api-response-browser.mjs \
  | tee "$DIDI_API_RESPONSE_ARTIFACTS/browser.tap" || status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$DIDI_API_RESPONSE_ARTIFACTS/browser.tap" || { echo 'Zero browser tests' >&2; exit 1; }
[[ "$(grep -c 'CASE_RECORD C[1-8] ' "$DIDI_API_RESPONSE_ARTIFACTS/browser.tap")" -eq 8 ]] || { echo 'Expected exactly eight case records' >&2; exit 1; }
exit "$status"
