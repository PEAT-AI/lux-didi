#!/usr/bin/env bash
# The release gate, run in one place so CI and a local run execute the same checks in the same
# order (docs/checks.md, "The release gate").
#
# Usage: bash scripts/ci-gauntlet.sh [--ci]
#
# No flag runs all thirteen: the twelve gate checks of docs/checks.md in the order it lists
# them, then check-package, one at a time. --ci runs the ten that need no macOS, which is
# exactly what .github/workflows/ci.yml runs on ubuntu; the other three need the Swift toolchain
# or the managed-host browser lease and stay local (the reason per check is in docs/checks.md).
#
# The scripts keep their own boundaries: each one installs and compiles what it asserts, so
# there is no shared compile to hoist (PEAT-AI/lux-didi#678). What is shared here is the
# dependency install, done once up front, so the ten checks find server/node_modules and
# web/node_modules already in place instead of each paying for a fresh install. A failing check
# stops the run: the gate is read at one head, not summed up.
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-}"
case "$mode" in
  ''|--ci) ;;
  *) echo 'usage: bash scripts/ci-gauntlet.sh [--ci]' >&2; exit 2 ;;
esac

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

script_path() {
  case "$1" in
    Tests/*) printf '%s\n' "$1" ;;
    *) printf 'scripts/%s.sh\n' "$1" ;;
  esac
}

echo "== install: server and web, once for the whole gate"
bash scripts/npm-ci-offline.sh server
bash scripts/npm-ci-offline.sh web

ran=0
started=$SECONDS
for entry in "${gate[@]}"; do
  placement=ci
  check="${entry%:local}"
  [ "$check" = "$entry" ] || placement=local
  if [ "$mode" = '--ci' ] && [ "$placement" = 'local' ]; then
    echo "== skip: $check (needs macOS, see docs/checks.md)"
    continue
  fi
  path="$(script_path "$check")"
  echo "== run: $check"
  check_started=$SECONDS
  if bash "$path"; then
    echo "== pass: $check ($((SECONDS - check_started))s)"
  else
    status=$?
    echo "== FAIL: $check (exit $status, $((SECONDS - check_started))s)" >&2
    exit "$status"
  fi
  ran=$((ran + 1))
done

echo "== gate passed: $ran checks in $((SECONDS - started))s${mode:+ (--ci)}"
