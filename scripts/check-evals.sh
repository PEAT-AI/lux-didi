#!/usr/bin/env bash
# The eval harness self-test: scripted provider only. No model call, no network, no audio device, no owner
# data. Cheap enough for a release PR; the full private suite runs locally and is never in CI.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" ]]; then
  echo 'EVAL CHECK BLOCKED: the server dependencies (typescript, @types/node) are not installed; run npm ci in server/' >&2
  exit 2
fi
cd "$root/server"
"$deps/typescript/bin/tsc" -p tsconfig.json
node dist/eval/selftest.js "$root"
