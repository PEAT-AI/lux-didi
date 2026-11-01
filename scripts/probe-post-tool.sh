#!/usr/bin/env bash
# C-POSTTOOL wire probe. Synthetic asks through the real adapter, against the fake world, in four variants:
# baseline, a (firstResponseAudio), b (backendBrevityTight), ab (both). The only thing it spends is the
# provider's own tokens, so it prints the estimate first and refuses without --go.
#
#   scripts/probe-post-tool.sh                 # the estimate and the ask count, no session opened
#   scripts/probe-post-tool.sh --go            # the real model, 12 asks per variant
#
# It stores no audio, plays nothing and opens no device: each variant's audio appears as counts only.
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
  echo 'POST-TOOL PROBE BLOCKED: the server dependencies are not installed; run npm ci in server/' >&2
  exit 2
fi
cd "$root/server"
"$deps/typescript/bin/tsc" -p tsconfig.eval.json
exec node dist/eval/post-tool-probe.js "$@"
