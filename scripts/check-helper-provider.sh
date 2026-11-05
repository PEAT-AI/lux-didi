#!/usr/bin/env bash
# W1 (10.13): the helper's declared tool set must be one the provider accepts.
#
# Release 10.12 shipped read_knowledge.ids with uniqueItems under strict mode, so OpenAI answered
# HTTP 400 for every helper request. This check sends one real request with the FULL declared tool
# set of this build, the owner's installed provider configuration and the real credential resolver,
# and passes only when the provider answers `completed` and asks for a registered tool.
#
# Usage: bash scripts/check-helper-provider.sh [--data-dir DIR] [--module-dir DIR]
#   --data-dir DIR    the configured data directory. Defaults to LUX_DIDI_DATA_DIR, then to the
#                     installed store the app uses. With no provider-config there it prints SKIP and
#                     exits 0: a machine with no provider configured has nothing to prove.
#   --module-dir DIR  the built helper runtime. Defaults to this checkout's server/dist, rebuilt when a
#                     source file is newer than it.
#   [installed-target] an installed check passes the app bundle as its first argument. Installation owns
#                     only the bundle, so the check reads the owner's data directory instead and ignores
#                     this argument (it only has to be a directory).
#
# Exit: 0 PASS or SKIP, 2 the provider rejected the request (its error body is printed, redacted), 1 the
# check could not run. Never prints the key and never prints owner content. Cost is under USD 0.01.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
smoke="$root/scripts/lib/helper-provider-smoke.mjs"
data_dir="${LUX_DIDI_DATA_DIR:-$HOME/Library/Application Support/ai.peat.lux-didi-operator}"
module_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) data_dir="${2:?--data-dir needs a directory}"; shift 2;;
    --module-dir) module_dir="${2:?--module-dir needs a directory}"; shift 2;;
    -h|--help) sed -n '2,21p' "$0"; exit 0;;
    *) [ -d "$1" ] || { echo "check-helper-provider.sh: unknown argument $1" >&2; exit 2; }; shift;;
  esac
done

if [ -z "$module_dir" ]; then
  # The declared tool set under test is this build's, never a stale one.
  if [ ! -f "$root/server/dist/tasks/tools.js" ] || [ -n "$(find "$root/server" -maxdepth 4 -name '*.ts' -newer "$root/server/dist/tasks/tools.js" -not -path '*/node_modules/*' -not -path '*/dist/*' -print -quit)" ]; then
    "$root/server/node_modules/.bin/tsc" -p "$root/server/tsconfig.json"
  fi
  module_dir="$root/server/dist"
fi
[ -f "$module_dir/tasks/tools.js" ] || { echo "check-helper-provider.sh: no helper runtime at $module_dir" >&2; exit 1; }

status=0
node "$smoke" --data-dir "$data_dir" --module-dir "$module_dir" || status=$?
case "$status" in
  0|2|3) exit "$status";;
  *) exit 1;;
esac
