#!/usr/bin/env bash
# The deleted research installer probe is replaced by synthetic host-helper contracts.
# No installed app, provider account or network is used.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec bash "$root/scripts/check-tasks.sh"
