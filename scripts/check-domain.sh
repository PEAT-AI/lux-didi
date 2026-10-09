#!/usr/bin/env bash
# Domain build-backed check.
#
# Compiles the exact current service runtime and domain sources from scratch,
# then runs the domain tests against the real compiled runtime and a temporary
# SQLite database. The build step is what keeps a clean checkout from passing
# on stale dist artefacts. Mirrors scripts/check-service.sh; it runs only the
# focused domain/provenance tests and affected HTTP fixture consumers, never a broad suite.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../server"

if [ ! -x node_modules/.bin/tsc ]; then
  echo "check-domain: server/node_modules missing (run npm ci in server/)" >&2
  exit 1
fi

rm -rf dist
npm run build
./node_modules/.bin/tsc -p domain/tsconfig.build.json

for f in dist/runtime/store.js dist/runtime/outbox.js dist/domain/facade.js dist/test/http.test.js; do
  test -s "$f" || { echo "check-domain: missing build output: $f" >&2; exit 1; }
done

log=$(mktemp)
http_log=$(mktemp)
trap 'rm -f "$log" "$http_log"' EXIT
node --test --test-reporter=tap --test-timeout=15000 test/domain.test.ts test/provenance.test.ts | tee "$log"
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'check-domain: zero selected tests' >&2; exit 1; }

# Only the four cases that use the synthetic DomainPort fixture changed for
# required-method compatibility. The package-install test does not use it.
http_pattern='^(one-time pairing, HttpOnly Strict cookies, CSRF denial, session reload and logout|canonical duplicate request replay, conflicting keys, rollback and stale epoch|body boundary refuses unknown fields, identities, wrong types, malformed JSON and oversized payloads|HTTP request keys and browser session survive service and database restart)$'
node --test --test-reporter=tap --test-timeout=15000 --test-name-pattern "$http_pattern" dist/test/http.test.js | tee "$http_log"
grep -Eq '^# pass 4$' "$http_log" || { echo 'check-domain: expected four affected HTTP fixture tests' >&2; exit 1; }
