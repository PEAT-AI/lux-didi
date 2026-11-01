#!/usr/bin/env bash
# #805: prove that scripts/lib/check-groups.sh reports every failing group, so a red in group 1 never
# hides a red in group 3, and that the all-green path stays a pass. No build, no network, no fixtures
# beyond three shell functions in a temporary script.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-group-selftest.XXXXXX")"
trap 'rm -rf "$work"' EXIT

red="$work/red.sh"
cat > "$red" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
. "$root/scripts/lib/check-groups.sh"
one() { return 1; }
two() { return 0; }
three() { return 1; }
group group-1 one
group group-2 two
group group-3 three
group_report
SCRIPT

green="$work/green.sh"
cat > "$green" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
. "$root/scripts/lib/check-groups.sh"
ok() { return 0; }
group alpha ok
group beta ok
group_report
SCRIPT

status=0
bash "$red" > "$work/red.out" 2> "$work/red.err" || status=$?
[ "$status" -ne 0 ] || { echo 'GROUP-RUNNER SELFTEST FAIL: a failing group did not fail the script' >&2; exit 1; }
grep -qx 'GROUP FAIL group-1' "$work/red.err" \
  || { echo 'GROUP-RUNNER SELFTEST FAIL: group 1 was not reported' >&2; cat "$work/red.err" >&2; exit 1; }
grep -qx 'GROUP PASS group-2' "$work/red.out" \
  || { echo 'GROUP-RUNNER SELFTEST FAIL: group 2 did not run after group 1 failed' >&2; exit 1; }
grep -qx 'GROUP FAIL group-3' "$work/red.err" \
  || { echo 'GROUP-RUNNER SELFTEST FAIL: group 3 was hidden behind group 1' >&2; cat "$work/red.err" >&2; exit 1; }
grep -qx 'GROUPS FAIL ran=3 failed=2' "$work/red.err" \
  || { echo 'GROUP-RUNNER SELFTEST FAIL: the complete fail list is missing' >&2; cat "$work/red.err" >&2; exit 1; }
grep -qx 'GROUPS FAILED group-3' "$work/red.err" \
  || { echo 'GROUP-RUNNER SELFTEST FAIL: the fail list does not name group 3' >&2; exit 1; }

bash "$green" > "$work/green.out" 2> "$work/green.err"
grep -qx 'GROUPS PASS ran=2 failed=0' "$work/green.out" \
  || { echo 'GROUP-RUNNER SELFTEST FAIL: an all-green run is not a pass' >&2; cat "$work/green.out" "$work/green.err" >&2; exit 1; }
echo 'GROUP-RUNNER SELFTEST PASS: a red in group 1 did not hide group 3'
