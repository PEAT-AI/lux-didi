#!/usr/bin/env bash
# Opt-in paid check. The already-running installed shell claims a private request.
# Never launch/relaunch the app, substitute a provider, or impersonate its native socket.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/scripts/lib/check-installed-canary.mjs" "$@"
