#!/usr/bin/env bash
# The release gate, run in one place so CI and a local run execute the same checks in the same
# order (docs/checks.md, "The release gate").
#
# Usage: bash scripts/ci-gauntlet.sh [--ci] [--group <name>]
#        bash scripts/ci-gauntlet.sh --ci --list-groups
#
# No flag runs all thirteen: the twelve gate checks of docs/checks.md in the order it lists
# them, then check-package, one at a time. --ci runs the ten that need no macOS, which is
# exactly what .github/workflows/ci.yml runs on ubuntu; the other three need the Swift toolchain
# or the managed-host browser lease and stay local (the reason per check is in docs/checks.md).
#
# --group <name> runs only the checks of one of the three parallel CI groups (docs/checks.md,
# "Check inventory"). The three groups partition the ten --ci checks: every one runs in exactly
# one group, so a full CI run still runs each check exactly once.
#
# A group run continues past a red and reports every failure in that group, so one CI run shows
# all of them; it exits non-zero if any check failed or was blocked. A run with no --group keeps
# the release-gate behaviour: the gate is read at one head, so the first red stops the run.
#
# The scripts keep their own boundaries: each one installs and compiles what it asserts, so
# there is no shared compile to hoist (PEAT-AI/lux-didi#678). What is shared here is the
# dependency install, done once up front, so the checks find server/node_modules and
# web/node_modules already in place instead of each paying for a fresh install.
set -euo pipefail
cd "$(dirname "$0")/.."

mode=''
group=''
list_groups=''
while [ $# -gt 0 ]; do
  case "$1" in
    ''|--ci) mode="$1" ;;
    --group) group="${2:-}"; shift ;;
    --list-groups) list_groups=1 ;;
    *) echo 'usage: bash scripts/ci-gauntlet.sh [--ci] [--group <name>|--list-groups]' >&2; exit 2 ;;
  esac
  shift
done
if [ -n "$group" ] && [ "$list_groups" = 1 ]; then
  echo 'usage: bash scripts/ci-gauntlet.sh [--ci] [--group <name>|--list-groups]' >&2; exit 2
fi

export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1

# docs/checks.md order, then check-package: it packs and reinstalls the built service, so it
# runs last. The three that need macOS are marked, and --ci skips them.
gate=(
  check-live-voice
  check-live-session
  check-prompt
  check-live-gateway
  check-tool-owner
  check-google-connector
  check-company-connectors
  check-native-live:local
  check-web-unit
  Tests/DidiMacTests/check-mac.sh:local
  check-host:local
  check-install-smoke
  check-package
)

# The three parallel CI groups. Every --ci check is in exactly one of them (--list-groups prints
# the partition, and server/test/ci-gate-groups.mjs proves it covers the ten and only the ten).
# The split puts the three live checks on two machines and everything else on a third, because
# the live checks are the four longest steps of the gate.
group_of() {
  case "$1" in
    check-live-gateway) printf 'gateway\n' ;;
    check-live-session|check-live-voice) printf 'session\n' ;;
    check-prompt|check-tool-owner|check-google-connector|check-company-connectors|check-web-unit|check-install-smoke|check-package) printf 'other\n' ;;
    *) return 1 ;;
  esac
}

script_path() {
  case "$1" in
    Tests/*) printf '%s\n' "$1" ;;
    *) printf 'scripts/%s.sh\n' "$1" ;;
  esac
}

if [ -n "$list_groups" ]; then
  for entry in "${gate[@]}"; do
    check="${entry%:local}"
    [ "$check" = "$entry" ] || continue
    printf '%s\t%s\n' "$(group_of "$check")" "$check"
  done
  exit 0
fi

selected=()
for entry in "${gate[@]}"; do
  placement=ci
  check="${entry%:local}"
  [ "$check" = "$entry" ] || placement=local
  if [ "$mode" = '--ci' ] && [ "$placement" = 'local' ]; then
    echo "== skip: $check (needs macOS, see docs/checks.md)"
    continue
  fi
  if [ -n "$group" ]; then
    entry_group="$(group_of "$check" || true)"
    [ "$entry_group" = "$group" ] || continue
  fi
  selected+=("$check")
done

if [ -n "$group" ] && [ ${#selected[@]} -eq 0 ]; then
  echo "== no such group: $group (groups: gateway, session, other)" >&2
  exit 2
fi

echo "== install: server and web, once for the whole gate"
bash scripts/npm-ci-offline.sh server
bash scripts/npm-ci-offline.sh web

ran=0
failed=0
blocked=0
started=$SECONDS
# Per-check and per-run seconds, printable and machine readable: the release timing record
# (docs/checks.md, "Timing"). CI points DIDI_TIMING_FILE at the runner's temp directory so the
# log step keeps it; a local run gets one in the temp directory and prints the path.
timing_file() {
  # BSD mktemp wants the X run last, so the record keeps a .tsv name through a directory instead.
  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/didi-gate-timing.XXXXXX")" || return 1
  printf '%s/gate.tsv' "$dir"
}
timing="${DIDI_TIMING_FILE:-$(timing_file)}"
logdir="$(mktemp -d "${TMPDIR:-/tmp}/didi-gauntlet.XXXXXX")"
trap 'rm -rf "$logdir"' EXIT
record() {
  printf 'GATE_CHECK\t%s\t%s\t%s\n' "$1" "$2" "$3" >> "$timing"
}
for check in "${selected[@]}"; do
  path="$(script_path "$check")"
  echo "== run: $check"
  check_started=$SECONDS
  log="$logdir/$(printf '%s' "$check" | tr '/.' '__').log"
  status=0
  bash "$path" > "$log" 2>&1 || status=$?
  elapsed=$((SECONDS - check_started))
  cat "$log"
  verdict=pass
  if [ "$status" -eq 0 ]; then
    echo "== pass: $check (${elapsed}s)"
  elif grep -q 'CHECK BLOCKED' "$log"; then
    verdict=blocked
    blocked=$((blocked + 1))
    echo "== blocked: $check (exit $status, ${elapsed}s)" >&2
    if [ -z "$group" ]; then
      echo "== gate blocked: $check" >&2
      exit "$status"
    fi
  else
    verdict=failed
    failed=$((failed + 1))
    echo "== FAIL: $check (exit $status, ${elapsed}s)" >&2
    # Repeat structured diagnostics after long passing output so the receipt ends with its cause.
    echo "== failure diagnostics: $check (exit $status)" >&2
    if ! grep -n -E -A 16 '^not ok |^[[:space:]]*[✖×]|error TS[0-9]+|^Error:|^AssertionError|^.*CHECK (FAIL|BLOCKED)|^.*FAIL:' "$log" >&2; then
      echo "== no structured failure line was emitted; final check output follows" >&2
      tail -n 80 "$log" >&2
    fi
    if [ -z "$group" ]; then
      exit "$status"
    fi
  fi
  record "$check" "$verdict" "$elapsed"
  ran=$((ran + 1))
done

printf 'GATE_TOTAL\tall\t%s\n' "$((SECONDS - started))" >> "$timing"

if [ "$failed" -ne 0 ] || [ "$blocked" -ne 0 ]; then
  printf '== gate FAILED: %d ran, %d failed, %d blocked in %ss%s\n' \
    "$ran" "$failed" "$blocked" "$((SECONDS - started))" "${group:+ (group $group)}" >&2
  printf '== timing: %s\n' "$timing" >&2
  exit 1
fi

echo "== gate passed: $ran checks in $((SECONDS - started))s${mode:+ (--ci)}${group:+ (group $group)}"
printf '== timing: %s\n' "$timing"
