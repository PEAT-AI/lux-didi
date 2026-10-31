#!/usr/bin/env bash
# LAT-1022: the latency budget eval. A fake realtime transport and a fake connector carry recorded synthetic
# timings through the real host path, and every host-side segment is judged against config/latency-budgets.json.
# It prints each segment with its budget, and it fails only on a breach, a missing segment or a missing receipt.
# The last step is the gate's own proof: the same replay with every fake slowed must breach.
#
# The eval reads the built host path under dist/ and is itself plain TypeScript run through node's own type
# stripping, so it needs no entry in server/tsconfig.json and no build-time coupling to the suite.
set -euo pipefail
cd "$(dirname "$0")/.."
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-latency-budget.XXXXXX")
trap 'rm -rf "$work"' EXIT

cd server
npm run build >"$work/build.log" 2>&1 || { cat "$work/build.log" >&2; exit 1; }
run() {
  node --test --test-reporter=tap --test-timeout=20000 test/latency-budget.test.ts "$@"
}

echo "latency budget, normal fakes"
LATENCY_BUDGET_SLOW=0 run 2>&1 | tee "$work/fast.log" | grep -E '^(ok|not ok|# (pass|fail))|budget=' || true
grep -Eq '^# fail 0$' "$work/fast.log" || { echo 'the latency budget eval failed on a normal fake' >&2; tail -40 "$work/fast.log" >&2; exit 1; }
grep -Eq 'budget=' "$work/fast.log" || { echo 'the eval printed no segment' >&2; exit 1; }

echo "latency budget, deliberately slowed fakes (must breach)"
if LATENCY_BUDGET_SLOW=1 run >"$work/slow.log" 2>&1; then
  echo 'the slowed fake passed: the budget gate cannot fail, so it proves nothing' >&2
  exit 1
fi
grep -Eq 'BREACH' "$work/slow.log" || { echo 'the slowed fake failed without naming a breached segment' >&2; tail -40 "$work/slow.log" >&2; exit 1; }
grep -E 'BREACH' "$work/slow.log" | head -3
echo 'latency budget: PASS'
