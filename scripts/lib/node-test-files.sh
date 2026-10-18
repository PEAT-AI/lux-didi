#!/usr/bin/env bash
# The shared runner for every check that names compiled test files (#340).
#
# A check that lists its files by path is asserting that the build emitted them. `node --test`
# on a file the TypeScript build never emitted used to pass silently, so a green check could
# hide a suite that never ran (the warm-context test missing from server/tsconfig.json hid five
# green checks). Every such check sources this file and calls `node_test_files` with the argv it
# used to pass to `node --test`: a named file that does not exist is a named failure, and every
# other invocation runs exactly as before, same node, same cwd, same flags.
#
#   node_test_files --test-timeout=15000 dist/test/chat.test.js dist/test/model.test.js
#
# Flags (any argument starting with `-`) are passed through untouched; every other argument is a
# test file path and is checked before node starts. A directory or a glob that matched nothing is
# not a file, so it fails here too instead of shrinking the suite.
#
# The fixture-list self-test (no build, one tiny node run):
#   bash scripts/lib/node-test-files.sh --self-test

node_test_files() {
  local missing=0 arg
  for arg in "$@"; do
    case "$arg" in -*) continue ;; esac
    if [ ! -f "$arg" ]; then printf 'missing test file: %s\n' "$arg" >&2; missing=1; fi
  done
  if [ "$missing" -ne 0 ]; then
    printf 'refusing to run: a named test file does not exist\n' >&2
    return 1
  fi
  node --test "$@"
}

# A bounded call: `timeout` runs a program and never a shell function, so the helper goes back
# through bash, which sources itself in the child before running the same check.
node_test_files_bounded() {
  local secs="$1" lib="${BASH_SOURCE[0]}"; shift
  timeout "$secs" bash -c 'source "$1"; shift; node_test_files "$@"' _ "$lib" "$@"
}

# The helper's own proof: a tiny fixture list proves the missing branch names the file and starts
# no runner, and that a present file still runs through node --test unchanged.
node_test_files_self_test() {
  local work status=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/didi-node-test-files.XXXXXX")" || return 1
  # A missing file is named, and node never starts.
  if node_test_files "$work/absent.test.mjs" 2>"$work/err" >/dev/null; then
    printf 'FAIL missing fixture: node ran over an absent file\n' >&2; status=1
  elif ! grep -qx "missing test file: $work/absent.test.mjs" "$work/err"; then
    printf 'FAIL missing fixture: expected a named missing-file line, got: %s\n' "$(cat "$work/err")" >&2; status=1
  fi
  # A present file runs exactly as before.
  printf 'import test from "node:test";\ntest("fixture", () => {});\n' >"$work/present.test.mjs"
  if ! node_test_files "$work/present.test.mjs" >/dev/null 2>&1; then
    printf 'FAIL present fixture: node_test_files refused a file that exists\n' >&2; status=1
  fi
  rm -rf "$work"
  [ "$status" -eq 0 ] && printf 'node-test-files self-test: PASS\n'
  return "$status"
}

if [ "${BASH_SOURCE[0]}" = "$0" ] && [ "${1:-}" = "--self-test" ]; then node_test_files_self_test; exit $?; fi
