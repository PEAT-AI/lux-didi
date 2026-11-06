#!/usr/bin/env bash
# The eval harness self-test: scripted provider only. No model call, no network, no audio device, no owner
# data. Cheap enough for a release PR; the full private suite runs locally and is never in CI.
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
  echo 'EVAL CHECK BLOCKED: the server dependencies (typescript, @types/node) are not installed; run npm ci in server/' >&2
  exit 2
fi
if ! command -v timeout >/dev/null; then
  echo 'EVAL CHECK BLOCKED: timeout(1) is required, because every step is walled so a hang fails instead of stalling' >&2
  exit 2
fi
cd "$root/server"
# C-EVALS: every step is walled. A step that hangs names itself and fails the check instead of stalling a release
# for an hour (issue #884); each wall is a generous multiple of the measured runtime, never a target.
bounded() {
  local seconds="$1" name="$2"; shift 2
  local status=0
  timeout "$seconds" "$@" || status=$?
  if (( status == 124 )); then
    echo "EVAL CHECK FAILED: $name did not finish within ${seconds}s; it hung instead of failing" >&2
    exit 124
  fi
  return "$status"
}
bounded 180 'the eval build (tsc -p tsconfig.eval.json)' "$deps/typescript/bin/tsc" -p tsconfig.eval.json
# C-EVALS2: the release-tier suite reads its scenarios, recordings, judge prompt and mutation table from beside
# the compiled entry, so they are copied next to it exactly as scripts/eval-release.sh does.
mkdir -p dist/eval dist/test/eval-release
cp eval/tool-map.json dist/eval/tool-map.json
cp -R test/eval-release/scenarios test/eval-release/recordings dist/test/eval-release/
cp test/eval-release/judge-prompt.md test/eval-release/mutations.json dist/test/eval-release/
bounded 240 'the scripted self-test' node dist/eval/selftest.js "$root"
# C-EVALS2 tier 2 and tier 3: the release runner in fake-model mode, the post-call review, the fixture provenance.
bounded 240 'the release-tier tests' node --test --test-timeout=30000 dist/test/eval-release/*.test.js
# FR3: the voice metrics reader is graded on a synthetic store and log built in the worktree; it never opens a
# real data directory, so this step is cheap and stays in the release PR.
bounded 120 'the voice metrics test' node --test --test-timeout=30000 dist/test/voice-metrics.test.js
# C-EVALS2 honesty probe (a): every known mutation must make the suite it guards fail. --no-build: tsc just ran.
bounded 600 'the mutation probe' bash "$root/scripts/eval-mutation-probe.sh" --no-build
# C-EVALS3: the combined-tree gate and the sensitivity runner test their own fixtures here, so a gate
# that cannot see a break is caught in the eval self-test rather than at a release.
bounded 300 'the combined-tree selftest' bash "$root/scripts/check-combined-tree.sh" --selftest
bounded 300 'the sensitivity selftest' bash "$root/scripts/check-test-sensitivity.sh" --selftest
