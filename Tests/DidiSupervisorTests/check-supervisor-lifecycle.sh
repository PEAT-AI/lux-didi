#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../.."
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-supervisor-build.XXXXXX")"
proof="${LUX_SUPERVISOR_PROOF_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/didi-supervisor-proof.XXXXXX")}"
mkdir -p "$proof" "$work/base"
chmod 700 "$proof" "$work"
trap 'rm -rf "$work"' EXIT
printf 'Supervisor lifecycle retained proof: %s\n' "$proof"
base=f59c40f18b5eb7be84286b3a9c93dff4c0627895
git archive "$base" Sources/LuxDidi | tar -x -C "$work/base"
# COMPANION_TEST excludes the product @main. Compile production dependencies, but only these
# headless test entry points; none of the companion/UI tests or the product application runs.
compile() {
  local output="$1"; shift
  bash scripts/with-compile-lock.sh -- xcrun swiftc -j 1 -num-threads 1 -whole-module-optimization \
    -D COMPANION_TEST -parse-as-library -module-cache-path "$work/cache" "$@" \
    Tests/DidiCompanionTests/SupervisorGraceProof.swift Tests/DidiSupervisorTests/Main.swift -o "$output"
}
if compile "$work/base-proof" "$work/base/Sources/LuxDidi/"*.swift >"$proof/base-compile.log" 2>&1; then
  echo 'SUPERVISOR-LIFECYCLE BASE FAIL: regression unexpectedly compiles against base' >&2
  exit 1
fi
# Baseline red is specifically the missing production lifecycle policy seam, not a dependency failure.
grep -q "cannot find 'NativeServiceStop' in scope" "$proof/base-compile.log" || {
  echo 'SUPERVISOR-LIFECYCLE BASE BLOCKED: unrelated compile failure' >&2; exit 1;
}
printf 'SUPERVISOR-LIFECYCLE BASE RED ref=%s reason=missing-native-grace-policy\n' "$base"
if ! compile "$work/head-proof" Sources/LuxDidi/*.swift >"$proof/head-compile.log" 2>&1; then
  cat "$proof/head-compile.log" >&2
  exit 1
fi
"$work/head-proof" >"$proof/stdout.log" 2>"$proof/stderr.log"
cat "$proof/stdout.log"
test "$(grep -c '^PASS: C-START10:' "$proof/stdout.log")" -eq 3
grep -q '^SUPERVISOR-LIFECYCLE PASS assertions=3 headless=true$' "$proof/stdout.log"
