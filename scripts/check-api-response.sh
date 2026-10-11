#!/usr/bin/env bash
# Focused real-service/browser request-boundary proof. One unique artifact tree per invocation.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
[[ $# -eq 1 && "$1" = /* ]] || { echo 'Usage: check-api-response.sh /absolute/proof-root' >&2; exit 2; }
# One bounded total budget, including build, renderer admission and browser cleanup.
if [[ "${DIDI_API_RESPONSE_BOUNDED:-}" != 1 ]]; then
  exec timeout 280 env DIDI_API_RESPONSE_BOUNDED=1 bash "$0" "$1"
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
mkdir -p "$1"
export DIDI_API_RESPONSE_ARTIFACTS
DIDI_API_RESPONSE_ARTIFACTS="$(mktemp -d "$1/invocation-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
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
lux-browser-slot run --priority worker --want 1 --wait 120 -- \
  node --test --test-reporter=tap --test-timeout=90000 server/test/api-response-browser.mjs \
  | tee "$DIDI_API_RESPONSE_ARTIFACTS/browser.tap" || status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$DIDI_API_RESPONSE_ARTIFACTS/browser.tap" || { echo 'Zero browser tests' >&2; exit 1; }
[[ "$(grep -c 'CASE_RECORD C[1-8] ' "$DIDI_API_RESPONSE_ARTIFACTS/browser.tap")" -eq 8 ]] || { echo 'Expected exactly eight case records' >&2; exit 1; }
exit "$status"
