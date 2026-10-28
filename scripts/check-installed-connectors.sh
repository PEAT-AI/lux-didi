#!/bin/bash
# C-CONNECT9 (W2-R1): every enabled connector of a release must be connected with reads.
#
#   scripts/check-installed-connectors.sh [<installed-target>] [--data-dir DIR]
#       Read the installed host's own closed surfaces and fail naming every enabled catalog entry that is
#       not connected with tools > 0. The surfaces are provider-config/mcp.json (entry ids and enabled
#       flags) and logs/host.log (the connector receipts after the newest host_started). No credential
#       file, no owner profile, no store: this check reads closed status only and writes nothing.
#       DIR defaults to LUX_DIDI_DATA_DIR, then to the installed store the app uses.
#
#   scripts/check-installed-connectors.sh --ci
#       Run the shipped check against a synthetic 8-entry stdio catalog in a temporary directory: one entry
#       widens inside the reviewed envelope and must connect, one entry publishes only names outside the
#       envelope and must be named by the same check. Also proves the install gate itself (B4): a temp
#       checks dir with one passing and one failing script, the failing one named and the gate non-zero.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
smoke="$root/server/test/smoke/installed-connectors.mjs"
data_dir="${LUX_DIDI_DATA_DIR:-$HOME/Library/Application Support/ai.peat.lux-didi-operator}"
mode="installed"
while [ $# -gt 0 ]; do
  case "$1" in
    --ci) mode="ci"; shift;;
    --data-dir) data_dir="${2:?--data-dir needs a directory}"; shift 2;;
    -h|--help) sed -n '2,18p' "$0"; exit 0;;
    *) [ -d "$1" ] || { echo "check-installed-connectors.sh: installed target $1 is not a directory" >&2; exit 2; }; shift;;
  esac
done

if [ "$mode" = "installed" ]; then
  exec node "$smoke" --from-installed "$data_dir"
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/didi-installed-connectors.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# The synthetic catalog settles the real host from this checkout's compiler output, rebuilt when a source
# file is newer than it, so the check never reads a stale build.
if [ ! -f "$root/server/dist/host/mcp.js" ] || [ -n "$(find "$root/server" -maxdepth 4 -name '*.ts' -newer "$root/server/dist/host/mcp.js" -not -path '*/node_modules/*' -not -path '*/dist/*' -print -quit)" ]; then
  bash "$root/scripts/run-local.sh" --build-only >/dev/null
fi

# 1. An 8-entry catalog whose entries all connect, one of them by a widening inside the envelope.
connected_status=0
node "$smoke" --synthetic connected | tee "$work/connected.log" || connected_status=$?
if [ "$connected_status" -ne 0 ]; then
  echo 'check-installed-connectors.sh: the synthetic catalog left a connector disconnected' >&2
  exit 1
fi
[ "$(grep -c 'state=connected' "$work/connected.log")" = "8" ] || { echo 'check-installed-connectors.sh: expected eight connected entries' >&2; exit 1; }
grep -q 'CHECK-INSTALLED-CONNECTORS PASS enabled=8 connected=8' "$work/connected.log" || { echo 'check-installed-connectors.sh: the check did not assert eight entries' >&2; exit 1; }
grep -q 'RECEIPT connector_envelope_widened endpoint=mattermost-people added=mattermost_conversation_overview,mattermost_resolve_person' "$work/connected.log" \
  || { echo 'check-installed-connectors.sh: the reviewed-envelope widening wrote no receipt' >&2; exit 1; }
if grep -q 'FAIL setup' "$work/connected.log"; then
  echo 'check-installed-connectors.sh: the widening scenario did not settle its older run' >&2
  exit 1
fi

# 2. The same check must fail, named, for a child whose published reads are all outside the envelope.
outside_status=0
node "$smoke" --synthetic outside-envelope > "$work/outside.log" 2>&1 || outside_status=$?
[ "$outside_status" -eq 1 ] || { echo "check-installed-connectors.sh: an out-of-envelope child exited $outside_status, expected 1" >&2; cat "$work/outside.log" >&2; exit 1; }
grep -q 'CHECK-INSTALLED-CONNECTORS FAIL mattermost-outside state=connected tools=0' "$work/outside.log" \
  || { echo 'check-installed-connectors.sh: the failing catalog entry was not named' >&2; cat "$work/outside.log" >&2; exit 1; }
grep -q 'CHECK-INSTALLED-CONNECTORS FAIL enabled=8 connected=7' "$work/outside.log" \
  || { echo 'check-installed-connectors.sh: the failure did not name the count' >&2; cat "$work/outside.log" >&2; exit 1; }

# 3. B4: the install gate runs every installed check and fails, naming it, when one fails.
mkdir -p "$work/checks"
printf '#!/bin/bash\nexit 0\n' > "$work/checks/check-installed-alpha.sh"
printf '#!/bin/bash\necho "beta refused" >&2\nexit 1\n' > "$work/checks/check-installed-beta.sh"
gate_status=0
bash "$root/scripts/run-installed-checks.sh" "$work/target" --checks-dir "$work/checks" > "$work/gate.log" 2>&1 || gate_status=$?
[ "$gate_status" -eq 1 ] || { echo "check-installed-connectors.sh: the install gate exited $gate_status, expected 1" >&2; cat "$work/gate.log" >&2; exit 1; }
grep -q 'INSTALLED-CHECK PASS check-installed-alpha.sh' "$work/gate.log" || { echo 'check-installed-connectors.sh: the gate skipped a passing check' >&2; cat "$work/gate.log" >&2; exit 1; }
grep -q 'INSTALLED-CHECK FAIL check-installed-beta.sh' "$work/gate.log" || { echo 'check-installed-connectors.sh: the gate did not name the failing check' >&2; cat "$work/gate.log" >&2; exit 1; }
grep -q 'INSTALLED-CHECKS FAIL ran=2 failed=1' "$work/gate.log" || { echo 'check-installed-connectors.sh: the gate did not count both checks' >&2; cat "$work/gate.log" >&2; exit 1; }
mkdir -p "$work/checks-pass"
gate_ok=0
bash "$root/scripts/run-installed-checks.sh" "$work/target" --checks-dir "$work/checks-pass" 2>/dev/null || gate_ok=$?
[ "$gate_ok" -eq 0 ] || { echo 'check-installed-connectors.sh: the gate fails with no installed checks' >&2; exit 1; }

# 4. The install path must run the gate after the app is in place, and a red gate must fail the install:
#    the block containing the call restores the prior app and exits non-zero.
installer="$root/scripts/install-macos-app.sh"
bash -n "$installer" || { echo 'check-installed-connectors.sh: install-macos-app.sh does not parse' >&2; exit 1; }
gate_line="$(grep -n 'run-installed-checks.sh' "$installer" | head -1 | cut -d: -f1)"
place_line="$(grep -n '^mv "\$stage" "\$target"' "$installer" | head -1 | cut -d: -f1)"
if [ -z "$gate_line" ] || [ -z "$place_line" ]; then
  echo 'check-installed-connectors.sh: the install script does not run the installed checks' >&2
  exit 1
fi
if [ "$gate_line" -le "$place_line" ]; then
  echo "check-installed-connectors.sh: the gate at line $gate_line runs before the app is in place at line $place_line" >&2
  exit 1
fi
gate_block="$(sed -n "${gate_line},$((gate_line + 5))p" "$installer")"
case "$gate_block" in
  *'mv "$rollback" "$target"'*) ;;
  *) echo 'check-installed-connectors.sh: a red gate does not restore the prior app' >&2; exit 1;;
esac
case "$gate_block" in
  *'exit 1'*) ;;
  *) echo 'check-installed-connectors.sh: a red gate does not fail the install' >&2; exit 1;;
esac
printf 'CHECK-INSTALLED-CONNECTORS PASS install-gate line=%s after=%s\n' "$gate_line" "$place_line"

printf 'CHECK-INSTALLED-CONNECTORS PASS scenario=ci\n'
