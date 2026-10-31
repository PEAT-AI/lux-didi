#!/usr/bin/env bash
# Tier 2 release eval. Three modes, and only the last one can cost anything:
#
#   scripts/eval-release.sh --dry-run     the call plan, the token estimate and the price; opens nothing
#   scripts/eval-release.sh --fake-model  replays the committed synthetic model turns through the real adapter, $0
#   scripts/eval-release.sh --real --confirm-price <usd>   the owner's priced run; refuses without the price
#
# The adapter under test is the production realtime adapter (server/adapters/live-voice/openai.ts); only the
# socket and the world are fake. Nothing here reads a key, and no run makes a paid call in this wagon.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
# EV-R1: dependencies belong to this worktree. A symlink here installs into (and can empty) another checkout.
if [[ -L "$deps" ]]; then
  echo 'BLOCKED: server/node_modules is a symlink; run npm ci in this worktree server/' >&2
  exit 2
fi
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" ]]; then
  echo 'RELEASE EVAL BLOCKED: the server dependencies (typescript, @types/node) are not installed; run npm ci in server/' >&2
  exit 2
fi
cd "$root/server"
"$deps/typescript/bin/tsc" -p tsconfig.eval.json
mkdir -p dist/eval dist/test/eval-release
cp eval/tool-map.json dist/eval/tool-map.json
cp -R test/eval-release/scenarios test/eval-release/recordings dist/test/eval-release/
cp test/eval-release/judge-prompt.md dist/test/eval-release/judge-prompt.md
exec node dist/test/eval-release/cli.js "$@"
