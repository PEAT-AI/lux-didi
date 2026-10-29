#!/usr/bin/env bash
# Compile production sources; run only policy/content checks, never a window or audio output.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../.."
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-alarm-shell.XXXXXX")
trap 'rm -rf "$work"' EXIT
bash scripts/with-compile-lock.sh -- xcrun swiftc -j 1 -num-threads 1 -whole-module-optimization \
  -D COMPANION_TEST -parse-as-library -module-cache-path "$work/cache" \
  Sources/LuxDidi/*.swift Tests/DidiAlarmTests/Main.swift -o "$work/alarm-proof"
"$work/alarm-proof"
