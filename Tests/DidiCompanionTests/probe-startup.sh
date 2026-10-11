#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../.."
exec lux-browser-slot run --wait 120 -- bash Tests/DidiCompanionTests/produce-startup-probe.sh "$@"
