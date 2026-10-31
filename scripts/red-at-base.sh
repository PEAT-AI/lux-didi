#!/usr/bin/env bash
# Honesty probe (b): a named new test has to fail at the base commit, or it proves nothing about this wagon.
#
#   scripts/red-at-base.sh --base <sha> --test server/test/eval-release/postcall.test.ts \
#     --paths server/trace/postcall.ts,server/test/fixtures/regressions
#
# It makes a detached worktree at --base, copies the given paths and the test into it, symlinks this worktree's
# server/node_modules (so no install is needed), compiles with the base tree's own tsconfig and runs only the
# named test. Green there is a failure: the test is not evidence. For a wagon of new modules the red is usually
# "the module does not exist at base", which this prints as the reason rather than hiding it.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
base='' test_file='' paths='' pattern=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) base="${2:-}"; shift 2 ;;
    --test) test_file="${2:-}"; shift 2 ;;
    --paths) paths="${2:-}"; shift 2 ;;
    --name) pattern="${2:-}"; shift 2 ;;
    *) echo "red-at-base: unknown argument $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$base" || -z "$test_file" ]]; then
  echo 'red-at-base: --base <sha> and --test <repo-relative test file> are required' >&2
  exit 2
fi
if [[ ! -f "$deps/typescript/bin/tsc" ]]; then
  echo 'RED-AT-BASE BLOCKED: the server dependencies are not installed; run npm ci in server/' >&2
  exit 2
fi
if ! git -C "$root" cat-file -e "$base^{commit}" 2>/dev/null; then
  echo "red-at-base: $base is not a commit in this repository" >&2
  exit 2
fi

tmp="$(mktemp -d)"
worktree="$tmp/base"
cleanup() {
  rm -f "$worktree/server/node_modules" 2>/dev/null || true
  git -C "$root" worktree remove --force "$worktree" >/dev/null 2>&1 || rm -rf "$worktree"
  rm -rf "$tmp"
}
trap cleanup EXIT

git -C "$root" worktree add --detach "$worktree" "$base" >/dev/null

copied=()
if [[ -n "$paths" ]]; then
  IFS=',' read -r -a entries <<< "$paths"
  for entry in "${entries[@]}"; do
    [[ -z "$entry" ]] && continue
    mkdir -p "$worktree/$(dirname "$entry")"
    cp -R "$root/$entry" "$worktree/$entry"
    copied+=("$entry")
  done
fi
mkdir -p "$worktree/$(dirname "$test_file")"
cp "$root/$test_file" "$worktree/$test_file"
copied+=("$test_file")

# No install at base: the same dependencies this worktree already has, symlinked for the probe only.
ln -s "$deps" "$worktree/server/node_modules"

includes=''
for entry in "${copied[@]}"; do
  rel="${entry#server/}"
  if [[ "$rel" == *.ts || -d "$root/$entry" ]]; then
    includes+="\"$rel\","
  fi
done
cat >"$worktree/server/tsconfig.red-at-base.json" <<JSON
{
  "extends": "./tsconfig.json",
  "include": [${includes%,}]
}
JSON

compiled=0
if (cd "$worktree/server" && node "$deps/typescript/bin/tsc" -p tsconfig.red-at-base.json >"$tmp/tsc.log" 2>&1); then
  compiled=1
fi

dist_test="dist/$(printf '%s' "${test_file#server/}" | sed 's/\.ts$/.js/')"
status=0
if [[ $compiled -eq 1 ]]; then
  (cd "$worktree/server" && node --test --test-timeout=20000 \
    ${pattern:+--test-name-pattern "$pattern"} "$dist_test") >"$tmp/test.log" 2>&1 || status=$?
  if [[ $status -eq 0 ]]; then
    echo "NOT RED AT BASE: $test_file${pattern:+ (pattern $pattern)} passes at $base, so it is not evidence for this wagon" >&2
    exit 1
  fi
  echo "RED AT BASE: $test_file${pattern:+ (pattern $pattern)} fails at $base (test exit $status)"
else
  echo "RED AT BASE: $test_file does not compile at $base, so the named behaviour is absent there"
  grep -m2 'error TS' "$tmp/tsc.log" | sed 's/^/  /' || true
fi
echo 'RED-AT-BASE PASS'
