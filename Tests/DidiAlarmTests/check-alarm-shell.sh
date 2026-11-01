#!/usr/bin/env bash
# Compile production sources; run only policy/content checks, never a window or audio output.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../.."
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-alarm-shell.XXXXXX")
trap 'rm -rf "$work"' EXIT
# The AVFAudio boundary guard is Objective-C: only it can catch what AVFAudio raises.
bash scripts/with-compile-lock.sh -- xcrun clang -fobjc-arc -c Sources/LuxDidi/AVFAudioGuard.m -o "$work/AVFAudioGuard.o"
bash scripts/with-compile-lock.sh -- xcrun swiftc -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -j 1 -num-threads 1 -whole-module-optimization \
  -D COMPANION_TEST -parse-as-library -module-cache-path "$work/cache" \
  Sources/LuxDidi/*.swift Tests/DidiAlarmTests/Main.swift "$work/AVFAudioGuard.o" -o "$work/alarm-proof"
"$work/alarm-proof"
