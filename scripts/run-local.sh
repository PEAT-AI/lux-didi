#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
config=$(mktemp "$PWD/server/.host-build-XXXXXX.json")
trap 'rm -f "$config"' EXIT
printf '%s\n' '{"extends":"./tsconfig.json","include":["index.ts","host/**/*.ts","http/**/*.ts","test/host.test.ts","test/http.test.ts"]}' > "$config"
# Clean only this worktree's generated compiler output; never substitute a fixture/runtime copy.
rm -rf server/dist
npm --prefix web run build
server/node_modules/.bin/tsc -p "$config"
rm -f "$config"
trap - EXIT
if [ "${1:-}" = '--build-only' ]; then
  [ "$#" -eq 1 ] || { echo '--build-only takes no other arguments' >&2; exit 1; }
  exit 0
fi
exec node server/dist/host/index.js "$@"
