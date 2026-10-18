#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-voice-replay.XXXXXX")
trap 'rm -rf "$work"' EXIT
# Distinct isolated configuration files; never inherit account npm configuration.
printf '# isolated user config\n' > "$work/npm-user"
printf '# isolated global config\n' > "$work/npm-global"
export npm_config_userconfig="$work/npm-user" npm_config_globalconfig="$work/npm-global"
cd server
# Build first: the replay driver imports the compiled adapter, host and tool modules, never a source tree.
npm run build
# The fault-replay gate: the twelve council scenarios, driving the real OpenAI adapter and the real host live
# session together over a virtual clock against a scriptable fake provider.
node_test_files --test-reporter=tap --test-timeout=60000 dist/test/voice-replay.test.js | tee "$work/test.log"

grep -Eq '^# tests [1-9][0-9]*$' "$work/test.log" || { echo 'Zero selected voice replay tests' >&2; exit 1; }
grep -Eq '^# fail 0$' "$work/test.log" || { echo 'Selected voice replay tests failed' >&2; exit 1; }
# A parked scenario is a scenario the current code fails. It must be declared, with the wagon that owes the fix,
# in voice-replay/parked.txt: an undeclared park fails the gate, and so does a declaration whose scenario has
# started passing, because a stale park hides a recovered invariant.
parked="$(cd .. && pwd)/server/test/voice-replay/parked.txt"
grep -Eo '^(not ok|ok) [0-9]+ - scenario [0-9]+:[^#]*# TODO' "$work/test.log" | grep -Eo 'scenario [0-9]+' | sed 's/ /-/' | sort -u > "$work/parked-now.log"
grep -Ev '^[[:space:]]*(#|$)' "$parked" | cut -d' ' -f1 | sort -u > "$work/parked-declared.log"
if ! diff -u "$work/parked-declared.log" "$work/parked-now.log" > "$work/parked-diff.log"; then
  echo 'Voice replay: the parked scenarios differ from voice-replay/parked.txt' >&2
  cat "$work/parked-diff.log" >&2
  exit 1
fi
if [ -s "$work/parked-now.log" ]; then
  echo 'Voice replay gate: PASS, with parked scenarios:' >&2
  grep -Ev '^[[:space:]]*(#|$)' "$parked" >&2
  exit 0
fi
echo 'Voice replay gate: PASS'
