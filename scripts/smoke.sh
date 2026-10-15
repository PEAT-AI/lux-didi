#!/usr/bin/env bash
# Real-path smoke test. One command, exit 0 or 1, at most 120 s of wall clock.
#
# It runs the host exactly as the native app does (--supervised, the app's environment and its config source),
# holds its stdout to the native rule (the ready frame, then any further byte is a failure), and then drives
# the path the operator uses: every configured connector, one text turn that must call tools, and one Live
# turn that must call a tool and keep the session open. Run it after every install and before every release
# merge. Use --dev to run against the platform default data directory instead of the installed config source.
#
# The probes never print a credential, a transcript or a connector payload: only event names, counts, byte
# sizes and latencies. Never run it in a loop: one run makes at most two model turns.
set -uo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
node_bin="${NODE:-$(command -v node)}"
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then echo 'FAIL probe0-runtime node executable not found' >&2; exit 1; fi
if command -v timeout >/dev/null 2>&1; then
  timeout 120 "$node_bin" server/test/smoke/probes.mjs "$@"
else
  "$node_bin" server/test/smoke/probes.mjs "$@"
fi
