#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../.."
# The browser lease is taken inside the producer by its single leased run phase;
# compilation and bundling stay outside it. Helper validates descendant re-entry;
# no environment/argv bypass or local lock.
if ! command -v lux-browser-slot >/dev/null; then echo 'CHECK BLOCKED: lux-browser-slot missing' >&2; exit 75; fi
exec bash Tests/DidiCompanionTests/produce-companion.sh
