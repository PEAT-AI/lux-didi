#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
# --run-built is the second stage of --build-only, used by the focused runtime proof.
if [ "${1:-}" = '--run-built' ]; then
  shift
else
  # Clean only this worktree's generated output; the package and host use one config.
  rm -rf server/dist
  npm --prefix web run build
  server/node_modules/.bin/tsc -p server/tsconfig.json
  if [ "${1:-}" = '--build-only' ]; then
    [ "$#" -eq 1 ] || { echo '--build-only takes no other arguments' >&2; exit 1; }
    exit 0
  fi
fi
exec node server/dist/host/index.js "$@"
