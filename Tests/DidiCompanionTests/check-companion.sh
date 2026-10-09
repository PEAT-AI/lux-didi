#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../.."
# Admit before temporary state, native compilation or any browser-producing work.
# Helper validates descendant re-entry; no environment/argv bypass or local lock.
if ! command -v lux-browser-slot >/dev/null; then echo 'CHECK BLOCKED: lux-browser-slot missing' >&2; exit 75; fi
exec lux-browser-slot run --wait 120 -- bash Tests/DidiCompanionTests/produce-companion.sh
