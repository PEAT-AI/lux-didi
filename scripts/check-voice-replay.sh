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
# A parked scenario is a scenario the current code fails. It is declared here, with the wagon that owes the
# fix, and a `todo` test quotes the assertion it falsifies. The gate checks the two in both directions: an
# undeclared park fails, and so does a declaration whose scenario has started passing, because a stale park
# hides a recovered invariant. Every line names the wagon in the report.
cat > "$work/parked-declared.log" <<'PARKED'
scenario-3 S4a
scenario-4 S4a
scenario-6 S4a
scenario-9 S4a
PARKED
grep -Eo '^(not ok|ok) [0-9]+ - scenario [0-9]+:[^#]*# TODO' "$work/test.log" | grep -Eo 'scenario [0-9]+' | sed 's/ /-/' | sort -u > "$work/parked-now.log"
cut -d' ' -f1 "$work/parked-declared.log" | sort -u > "$work/parked-names.log"
if ! diff -u "$work/parked-names.log" "$work/parked-now.log" > "$work/parked-diff.log"; then
  echo 'Voice replay: the parked scenarios differ from the declarations in this script' >&2
  cat "$work/parked-diff.log" >&2
  exit 1
fi
if [ -s "$work/parked-now.log" ]; then
  echo 'Voice replay gate: PASS, with parked scenarios:' >&2
  cat "$work/parked-declared.log" >&2
  exit 0
fi
echo 'Voice replay gate: PASS'
