#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../.."
# The browser lease is taken inside the producer by its single leased run phase;
# compilation and bundling stay outside it. Helper validates descendant re-entry;
# no environment/argv bypass or local lock.
if ! command -v lux-browser-slot >/dev/null; then echo 'CHECK BLOCKED: lux-browser-slot missing' >&2; exit 75; fi
# The producer runs every leased-run phase even when one fails and reports each
# result to this file; report the phase table and exit non-zero if any failed.
phase_file="${LUX_COMPANION_PHASE_FILE:-$(mktemp "${TMPDIR:-/tmp}/didi-companion-phases.XXXXXX")}"
export LUX_COMPANION_PHASE_FILE="$phase_file"
log="$(mktemp "${TMPDIR:-/tmp}/didi-companion-run.XXXXXX")"
if bash Tests/DidiCompanionTests/produce-companion.sh >"$log" 2>&1; then status=0; else status=$?; fi
cat "$log"
echo 'COMPANION PHASES (name result [reason]):'
if [ -s "$phase_file" ]; then
  cat "$phase_file"
elif grep -q '^PHASE ' "$log"; then
  grep '^PHASE ' "$log"
else
  echo 'COMPANION PHASES: none reported'
fi
rm -f "$log"
exit "$status"
