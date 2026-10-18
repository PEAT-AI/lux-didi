#!/usr/bin/env bash
# Real-path smoke test. One command, exit 0 or 1, at most 300 s of wall clock.
#
# It runs the host exactly as the native app does (--supervised, the app's environment and a copy of its config
# source: the probes stage that copy and remove it, so no probe host ever writes beside the installed config),
# holds its stdout to the native rule (the ready frame, then any further byte is a failure), and then drives
# the path the operator uses: every configured connector, one text turn that must call tools, one Live
# turn that must call a tool and keep the session open, and one Live voice turn that must run the research
# loop (one research call, a run line with a source read, output after the response). Run it after every
# install and before every release
# merge. Use --dev to run against the platform default data directory instead of the installed config source.
#
# The probes never print a credential, a transcript or a connector payload: only event names, counts, byte
# sizes and latencies. A failed run keeps its host log and a metadata-only journal export under a dated
# directory in the smoke data dir and prints that path; a green run keeps nothing new. Never run it in a
# loop: one run makes at most three model turns.
set -uo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
# Prove server/dist matches the checked-out source before any probe runs: a stale dist makes every probe
# judge old code (#258). Build when the entry is missing or older than the newest source file under server/.
dist_entry="server/dist/host/index.js"
if [[ ! -f "$dist_entry" ]] || [[ -n "$(find server \( -path server/dist -o -name node_modules \) -prune -o -type f -newer "$dist_entry" -print -quit)" ]]; then
  if ! npm --prefix server run build; then
    echo 'FAIL probe0-build server/dist is missing or stale and npm --prefix server run build failed'
    exit 1
  fi
fi
node_bin="${NODE:-$(command -v node)}"
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then echo 'FAIL probe0-runtime node executable not found' >&2; exit 1; fi
# The harness self-check proves the probes' pure helpers (the driver gate and the failure note) before the
# real run: it starts no host and makes no model turn. The file exists only in the full checkout.
if [[ -f server/test/smoke/smoke-harness.test.mjs ]]; then
  "$node_bin" --test server/test/smoke/smoke-harness.test.mjs || { echo 'FAIL probe0-harness the smoke harness self-check failed' >&2; exit 1; }
fi
run_probes() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 300 "$node_bin" server/test/smoke/probes.mjs "$@"
  else
    "$node_bin" server/test/smoke/probes.mjs "$@"
  fi
}
# --dev uses the platform data directory, so no smoke data dir is created. Otherwise the smoke data dir
# holds this run's state: a failure keeps it, with the probes' dated evidence directory inside, and prints
# the path; a green run keeps nothing new.
if [[ " $* " == *" --dev "* ]]; then
  run_probes "$@"
  exit $?
fi
# The config-copy step: the probes copy the installed provider config into a private temp dir, hand the host
# that copy and remove it on exit, so this run never makes a host write into the installed app's own folder.
smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/didi-smoke.XXXXXX")"
run_probes --data-dir "$smoke_dir" "$@"
status=$?
if [ "$status" -ne 0 ]; then
  echo "KEEP $smoke_dir"
else
  rm -rf "$smoke_dir"
fi
exit "$status"
