#!/usr/bin/env bash
# Honesty probe (a): the eval suites have to notice when a guard is removed. This applies one known no-op
# mutation at a time to the compiled harness in a temp copy and asserts a suite FAILS for each.
#
#   scripts/eval-mutation-probe.sh                 # every mutation in server/test/eval-release/mutations.json
#   scripts/eval-mutation-probe.sh --only <name>   # one mutation
#   scripts/eval-mutation-probe.sh --no-build      # reuse the dist this tree already has (check-evals.sh does)
#
# A mutation whose anchor no longer matches is a probe FAILURE, not a pass: the probe must never go green because
# the code it guards moved underneath it. Nothing here costs money and nothing touches the real provider.
#
# Two suites run on each mutated copy: the eval self-test (`dist/eval/selftest.js`, the scripted harness) and the
# release-tier tests (`dist/test/eval-release/*.test.js`, tier 2 and tier 3). A mutation is caught when either one
# fails, so a guard is only unguarded when both miss it.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
only=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) only="${2:-}"; shift 2 ;;
    --no-build) no_build=1; shift ;;
    *) echo "eval-mutation-probe: unknown argument $1" >&2; exit 2 ;;
  esac
done
if [[ ! -f "$deps/typescript/bin/tsc" ]]; then
  echo 'MUTATION PROBE BLOCKED: the server dependencies are not installed; run npm ci in server/' >&2
  exit 2
fi
cd "$root/server"
if [[ "${no_build:-0}" != "1" || ! -f dist/eval/selftest.js ]]; then
  "$deps/typescript/bin/tsc" -p tsconfig.eval.json
fi

tmp="$(mktemp -d)"
# The copied build runs inside a git-ignored folder of the repository, so the tests still find the source
# scenarios, recordings and regression fixtures they read, and no untracked file appears in git status.
probe_root="$root/server/eval-out/mutation-probe"
rm -rf "$probe_root"
mkdir -p "$probe_root"
trap 'rm -rf "$tmp" "$probe_root"' EXIT

# The unmutated suites must pass first: a suite that is already red proves nothing about a mutation.
baseline_status=0
node dist/eval/selftest.js "$root" >"$tmp/baseline-selftest.log" 2>&1 || baseline_status=$?
DIDI_EVAL_SOURCE_ROOT="$root/server" \
  node --test --test-timeout=30000 dist/test/eval-release/*.test.js >"$tmp/baseline-release.log" 2>&1 || baseline_status=1
if [[ $baseline_status -ne 0 ]]; then
  echo 'MUTATION PROBE FAILED: the unmutated suites are red, so no mutation could be told apart from them' >&2
  tail -5 "$tmp/baseline-selftest.log" "$tmp/baseline-release.log" >&2
  exit 1
fi
echo 'baseline: eval self-test PASS, release-tier tests PASS'

names="$(node -e '
const fs = require("node:fs");
const all = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const only = process.argv[2];
process.stdout.write(all.filter(m => !only || m.name === only).map(m => m.name).join("\n"));
' "$root/server/test/eval-release/mutations.json" "$only")"
if [[ -z "$names" ]]; then
  echo "MUTATION PROBE FAILED: --only $only matched no mutation" >&2
  exit 2
fi

failures=0
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  rm -rf "$probe_root/dist"
  cp -R dist "$probe_root/dist"
  if ! node -e '
const fs = require("node:fs");
const [file, name, table] = [process.argv[1], process.argv[2], process.argv[3]];
const all = JSON.parse(fs.readFileSync(table, "utf8"));
const mutation = all.find(entry => entry.name === name);
if (!mutation) { console.error(`no mutation ${name}`); process.exit(2); }
const path = `${file}/${mutation.file}`;
const before = fs.readFileSync(path, "utf8");
if (!before.includes(mutation.find)) { console.error(`anchor no longer applies: ${name}`); process.exit(3); }
fs.writeFileSync(path, before.replace(mutation.find, mutation.replace));
' "$probe_root/dist" "$name" "$root/server/test/eval-release/mutations.json"; then
    echo "MUTATION PROBE FAILED: $name did not apply (the guarded code moved)" >&2
    failures=$((failures + 1))
    continue
  fi
  status=0
  caught_by='self-test'
  node "$probe_root/dist/eval/selftest.js" "$root" >"$tmp/$name-selftest.log" 2>&1 || status=$?
  if [[ $status -eq 0 ]]; then
    caught_by='release tests'
    DIDI_EVAL_SOURCE_ROOT="$root/server" \
      node --test --test-timeout=30000 "$probe_root"/dist/test/eval-release/*.test.js \
      >"$tmp/$name-release.log" 2>&1 || status=$?
  fi
  if [[ $status -eq 0 ]]; then
    echo "MUTATION SURVIVED: $name, both suites still pass" >&2
    failures=$((failures + 1))
  else
    summary="$(grep -m1 -oE 'cases [0-9]+: .*|# fail [0-9]+' "$tmp/$name-selftest.log" "$tmp/$name-release.log" 2>/dev/null | head -1 || true)"
    echo "CAUGHT: $name ($caught_by exit $status: ${summary:-no summary line})"
  fi
  rm -rf "$probe_root/dist"
done <<< "$names"

if [[ $failures -ne 0 ]]; then
  echo "MUTATION PROBE FAILED: $failures mutation(s) not caught" >&2
  exit 1
fi
echo 'MUTATION PROBE PASS: every mutation makes at least one eval suite fail'
