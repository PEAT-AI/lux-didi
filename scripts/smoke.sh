#!/usr/bin/env bash
# Real-path smoke test. One command, exit 0 or 1, in at most the probes' own declared budget plus the
# margin below. Each probe prints its own PASS/FAIL line the moment it finishes, so a capped or killed run
# still shows what it proved and names the probes that never reported (#364).
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
# judge old code (#258). Build when the entry is missing, older than the newest source file under server/, or
# older than the newest commit that touched server/ (R4-R2: a build from before a merged server change refused
# a valid voice and looked like a product failure).
dist_entry="server/dist/host/index.js"
if [[ ! -f "$dist_entry" ]] || [[ -n "$(find server \( -path server/dist -o -name node_modules \) -prune -o -type f -newer "$dist_entry" -print -quit)" ]]; then
  if ! npm --prefix server run build; then
    echo 'FAIL probe0-build server/dist is missing or stale and npm --prefix server run build failed'
    exit 1
  fi
fi
node_bin="${NODE:-$(command -v node)}"
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then echo 'FAIL probe0-runtime node executable not found' >&2; exit 1; fi
# The commit-based freshness guard, shared with probes.mjs so both surfaces name the same fact. Builds are not a
# licence to judge old code: after a rebuild the guard runs again, and a still-stale build fails loudly here.
stale_dist() {
  "$node_bin" --input-type=module -e "const m = await import('file://$(pwd)/server/test/smoke/probes.mjs'); const s = m.staleServerDist('$(pwd)/$dist_entry'); if (s) process.stdout.write('STALE ' + s);"
}
# Only a line this guard wrote counts, so no other output of the same interpreter can be read as a verdict.
stale_verdict() {
  case "$1" in STALE\ *) printf '%s' "${1#STALE }" ;; *) printf '' ;; esac
}
stale="$(stale_verdict "$(stale_dist)")"
if [[ -n "$stale" ]]; then
  npm --prefix server run build || { echo "FAIL probe0-build $stale; the rebuild failed" >&2; exit 1; }
  stale="$(stale_verdict "$(stale_dist)")"
  if [[ -n "$stale" ]]; then echo "FAIL probe0-build $stale" >&2; exit 1; fi
fi
# The cap is the probes' own declared deadlines summed, plus this margin, never a fixed guess (#364): a slow
# host extends the cap, and a run still inside its probes' deadlines is never truncated.
SMOKE_MARGIN_SECONDS=60
smoke_plan="$(mktemp "${TMPDIR:-/tmp}/didi-smoke-plan.XXXXXX")"
smoke_progress="$(mktemp "${TMPDIR:-/tmp}/didi-smoke-progress.XXXXXX")"
trap 'rm -f "$smoke_plan" "$smoke_progress"' EXIT
# One read of the probes' module for both facts: the summed budget, then every id the run must report.
if ! "$node_bin" --input-type=module -e "const m = await import('file://$(pwd)/server/test/smoke/probes.mjs'); console.log(m.PROBE_BUDGET_MS); for (const id of m.PROBE_IDS) console.log(id);" >"$smoke_plan"; then
  echo 'FAIL probe0-plan smoke plan import printed no budget' >&2
  exit 1
fi
smoke_budget_ms="$(head -1 "$smoke_plan")"
case "$smoke_budget_ms" in
  ''|*[!0-9]*) echo 'FAIL probe0-plan smoke plan import printed no budget' >&2; exit 1 ;;
esac
smoke_budget_s=$(( smoke_budget_ms / 1000 ))
smoke_cap=$(( smoke_budget_s + SMOKE_MARGIN_SECONDS ))
export LUX_SMOKE_PROGRESS="$smoke_progress"
# The harness self-check proves the probes' pure helpers (the driver gate and the failure note) before the
# real run: it starts no host and makes no model turn. The file exists only in the full checkout.
if [[ -f server/test/smoke/smoke-harness.test.mjs ]]; then
  "$node_bin" --test server/test/smoke/smoke-harness.test.mjs || { echo 'FAIL probe0-harness the smoke harness self-check failed' >&2; exit 1; }
fi
run_probes() {
  smoke_status=0
  if command -v timeout >/dev/null 2>&1; then
    timeout "$smoke_cap" "$node_bin" server/test/smoke/probes.mjs "$@" || smoke_status=$?
  else
    "$node_bin" server/test/smoke/probes.mjs "$@" || smoke_status=$?
  fi
  if [ "$smoke_status" -eq 124 ]; then
    # The cap expired. Every probe names itself in the progress file as it finishes, and the plan lists the
    # ones the run owed, so the missing lines are exactly the probes that never reported.
    echo "FAIL smoke-cap the run reached the ${smoke_cap}s cap (declared budget ${smoke_budget_s}s + ${SMOKE_MARGIN_SECONDS}s margin)" >&2
    tail -n +2 "$smoke_plan" | while IFS= read -r probe; do
      grep -qxF "$probe" "$smoke_progress" || echo "never reported: $probe" >&2
    done
  fi
  return "$smoke_status"
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
