#!/usr/bin/env bash
# The memory test on the synthetic fixture (issue #912 part B).
#
# Builds the real service and runs the memory-eval test only: the planted fixture
# must close the gate and name both defects, the clean variant must pass, and the
# store copy must come back unchanged. The synthetic fixture is the whole input,
# so this check never reads the owner's store, never starts the app and never
# calls a model. Under 60 seconds.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# The lane worktree carries no installed deps. Materialize ignored node_modules
# DIRECTORY trees that symlink each entry of an accepted sibling's installed deps
# read-only. `node_modules/` is already gitignored by server/.gitignore and
# web/.gitignore, so this pollutes no tracked file, adds no shared exclude rule,
# and touches no other worktree.
if [[ ! -x "$root/server/node_modules/.bin/tsc" ]]; then
  for cand in "$root/../lux-didi-connected" "$root/../lux-didi-service"; do
    if [[ -x "$cand/server/node_modules/.bin/tsc" && -d "$cand/web/node_modules" ]]; then
      for pkg in server web; do
        mkdir -p "$root/$pkg/node_modules"
        for entry in "$cand/$pkg/node_modules"/* "$cand/$pkg/node_modules"/.[!.]*; do
          [[ -e "$entry" ]] || continue
          ln -sfn "$entry" "$root/$pkg/node_modules/$(basename "$entry")"
        done
      done
      break
    fi
  done
fi
if [[ ! -x "$root/server/node_modules/.bin/tsc" ]]; then
  echo 'check-memory-eval BLOCKED: installed SERVICE TypeScript required' >&2; exit 2
fi

git diff --check
bash scripts/run-local.sh --build-only

for f in server/dist/memory/eval-runner.js server/dist/test/memory-eval.test.js \
         server/dist/test/fixtures/memory-eval/build.js; do
  test -s "$f" || { echo "check-memory-eval: missing build output: $f" >&2; exit 1; }
done

log=$(mktemp)
trap 'rm -f "$log"' EXIT
status=0
node_test_files_bounded 60 --test-reporter=tap --test-timeout=45000 \
  server/dist/test/memory-eval.test.js \
  | tee "$log" || status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'check-memory-eval: zero selected tests' >&2; exit 1; }
grep -Eq '^# fail 0$' "$log" || { echo 'check-memory-eval: a selected test failed' >&2; exit 1; }
exit "$status"
