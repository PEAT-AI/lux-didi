#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
# No duplicate runtime: extend the accepted service compiler in its existing layout.
config=$(mktemp "$PWD/server/.host-check-XXXXXX.json")
log=$(mktemp)
trap 'rm -f "$config" "$log"' EXIT
printf '%s\n' '{"extends":"./tsconfig.json","include":["index.ts","host/**/*.ts","http/**/*.ts","test/host.test.ts","test/http.test.ts"]}' > "$config"
npm --prefix web run build
server/node_modules/.bin/tsc -p "$config"
for file in server/dist/test/host.test.js server/dist/test/http.test.js; do
  test -s "$file" || { echo "Missing selected test: $file" >&2; exit 1; }
done
node --test --test-reporter=tap --test-timeout=15000 server/dist/test/host.test.js server/dist/test/http.test.js | tee "$log"
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'Zero selected tests' >&2; exit 1; }
# Deliberately not the web fixture producer: this drives the shipped UI on the real host.
lux-browser-slot run --priority worker --want 1 --wait 240 -- node server/test/host-browser.mjs
