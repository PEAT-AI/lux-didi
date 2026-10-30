#!/usr/bin/env bash
# The owner's own eval run. Scripted mode is free and proves the harness; --live spends money on the real
# model, so it prints the model-call count and the estimate and refuses without --yes.
#
#   scripts/run-local-evals.sh                              # scripted, every public case
#   scripts/run-local-evals.sh --category calendar           # one category
#   scripts/run-local-evals.sh --id email-01                 # one case
#   scripts/run-local-evals.sh --live --yes --category wake  # the real model, one category
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
# EV-R1: dependencies belong to this worktree. A symlink here installs into (and can empty) another
# checkout, so it is refused outright; run `npm ci` inside this worktree's server/ instead.
if [[ -L "$deps" ]]; then
  echo 'BLOCKED: server/node_modules is a symlink; run npm ci in this worktree instead of pointing at another checkout' >&2
  exit 2
fi
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" ]]; then
  echo 'LOCAL EVALS BLOCKED: the server dependencies are not installed; run npm ci in server/' >&2
  exit 2
fi
cd "$root/server"
"$deps/typescript/bin/tsc" -p tsconfig.eval.json
exec node dist/eval/cli.js "$@"
