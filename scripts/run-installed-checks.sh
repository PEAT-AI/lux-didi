#!/bin/bash
# C-CONNECT9: run every installed-release check and fail naming each one that fails.
#
# An installed check answers one question the build could not: is the release that just landed on this
# machine actually working? It is a plain executable script named scripts/check-installed-*.sh, it gets
# the installed target as its only argument, and every one of them runs even when an earlier one failed,
# so an owner learns all of what is broken, not just the first.
#
# Usage: scripts/run-installed-checks.sh <installed-target> [--checks-dir DIR]
#   --checks-dir DIR  read the checks from DIR instead of this script's own directory
set -uo pipefail
target="${1:?run-installed-checks.sh needs the installed target as its first argument}"
shift
script_dir="$(cd "$(dirname "$0")" && pwd)"
checks_dir="$script_dir"
while [ $# -gt 0 ]; do
  case "$1" in
    --checks-dir) checks_dir="${2:?--checks-dir needs a directory}"; shift 2;;
    *) echo "run-installed-checks.sh: unknown argument $1" >&2; exit 2;;
  esac
done

ran=0
failed=0
for check in "$checks_dir"/check-installed-*.sh; do
  [ -f "$check" ] || continue
  name="$(basename "$check")"
  ran=$((ran + 1))
  if bash "$check" "$target"; then
    printf 'INSTALLED-CHECK PASS %s\n' "$name"
  else
    printf 'INSTALLED-CHECK FAIL %s\n' "$name" >&2
    failed=$((failed + 1))
  fi
done
if [ "$failed" -ne 0 ]; then
  printf 'INSTALLED-CHECKS FAIL ran=%d failed=%d\n' "$ran" "$failed" >&2
  exit 1
fi
# F2: a gate that ran nothing proves nothing, so a release that ships no installed check fails its own install.
# The alarm probe starts only an isolated synthetic host from the target package: no app launch or audio.
# --checks-dir replaces the check set for the existing runner fixtures.
if [ "$checks_dir" = "$script_dir" ]; then
  ran=$((ran + 1))
  alarm_node="$target/Contents/MacOS/node"
  [ -x "$alarm_node" ] || alarm_node=node
  if DIDI_ALARM_SERVICE_ROOT="$target/Contents/Resources/server/node_modules/@lux-didi/service" \
     DIDI_ALARM_WEB_ROOT="$target/Contents/Resources/web/dist" \
     "$alarm_node" --test --test-timeout=15000 "$script_dir/../server/test/alarm-host.integration.mjs"; then
    printf 'INSTALLED CHECK PASS: alarm round trip\n'
  else
    printf 'INSTALLED CHECK FAIL: alarm round trip\n' >&2
    failed=$((failed + 1))
  fi
fi

if [ "$ran" -eq 0 ]; then
  echo "INSTALLED-CHECKS FAIL ran=0: no $checks_dir/check-installed-*.sh to prove the installed release" >&2
  exit 1
fi
printf 'INSTALLED-CHECKS PASS ran=%d failed=0\n' "$ran"
