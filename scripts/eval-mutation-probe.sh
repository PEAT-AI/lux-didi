#!/usr/bin/env bash
# Honesty probe (a): the eval suites have to notice when a guard is removed. This applies one known no-op
# mutation at a time to the compiled harness in a temp copy and asserts the eval self-test FAILS for each.
#
#   scripts/eval-mutation-probe.sh                 # every mutation in server/test/eval-release/mutations.json
#   scripts/eval-mutation-probe.sh --only <name>   # one mutation
#
# A mutation whose anchor no longer matches is a probe FAILURE, not a pass: the probe must never go green because
# the code it guards moved underneath it. Nothing here costs money and nothing touches the real provider.
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
trap 'rm -rf "$tmp"' EXIT

# The unmutated harness must pass first: a suite that is already red proves nothing about a mutation.
baseline_status=0
node dist/eval/selftest.js "$root" >"$tmp/baseline.log" 2>&1 || baseline_status=$?
if [[ $baseline_status -ne 0 ]]; then
  echo "MUTATION PROBE FAILED: the unmutated eval self-test is red, so no mutation could be told apart from it" >&2
  tail -5 "$tmp/baseline.log" >&2
  exit 1
fi
echo "baseline: eval self-test PASS"

failures=0
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

while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  cp -R dist "$tmp/dist"
  if ! node -e '
const fs = require("node:fs");
const [file, name] = [process.argv[1], process.argv[2]];
const all = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const mutation = all.find(entry => entry.name === name);
if (!mutation) { console.error(`no mutation ${name}`); process.exit(2); }
const path = `${file}/${mutation.file}`;
const before = fs.readFileSync(path, "utf8");
if (!before.includes(mutation.find)) { console.error(`anchor no longer applies: ${name}`); process.exit(3); }
fs.writeFileSync(path, before.replace(mutation.find, mutation.replace));
' "$tmp/dist" "$name" "$root/server/test/eval-release/mutations.json"; then
    echo "MUTATION PROBE FAILED: $name did not apply (the guarded code moved)" >&2
    rm -rf "$tmp/dist"
    failures=$((failures + 1))
    continue
  fi
  status=0
  node "$tmp/dist/eval/selftest.js" "$root" >"$tmp/$name.log" 2>&1 || status=$?
  if [[ $status -eq 0 ]]; then
    echo "MUTATION SURVIVED: $name, the eval suites still pass" >&2
    failures=$((failures + 1))
  else
    echo "CAUGHT: $name (self-test exit $status: $(grep -m1 -o 'cases [0-9]*: .*' "$tmp/$name.log" || echo 'no summary line'))"
  fi
  rm -rf "$tmp/dist"
done <<< "$names"

if [[ $failures -ne 0 ]]; then
  echo "MUTATION PROBE FAILED: $failures mutation(s) not caught" >&2
  exit 1
fi
echo 'MUTATION PROBE PASS: every mutation makes the eval suites fail'
