#!/bin/bash
set -euo pipefail
export CI=1
cd "$(dirname "$0")/../.."
# The browser lease is taken inside the producer by its single leased run phase;
# probe compilation and bundling stay outside it.
if ! command -v lux-browser-slot >/dev/null; then echo 'CHECK BLOCKED: lux-browser-slot missing' >&2; exit 75; fi
exec bash Tests/DidiCompanionTests/launch-probe/produce.sh
