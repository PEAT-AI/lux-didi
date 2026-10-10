#!/bin/bash
set -euo pipefail
export CI=1
cd "$(dirname "$0")/../.."
if ! command -v lux-browser-slot >/dev/null; then echo 'CHECK BLOCKED: lux-browser-slot missing' >&2; exit 75; fi
exec lux-browser-slot run --wait 120 -- bash Tests/DidiCompanionTests/launch-probe/produce.sh
