#!/usr/bin/env bash
# Report every failing group of a multi-group check, not only the first (#805).
#
# A check script that runs several groups sources this file and calls
#   group <name> <command...>
# once per group, then calls group_report. Every group runs even when an earlier one failed, each
# result is printed as it happens, and group_report prints the complete fail list and exits non-zero
# when any group failed, so a red group never hides the reds behind it.
#
# A group command must carry its own failure across every step of the group, for example by chaining
# with && or by being a single pipeline: this file reports the status it is given and adds none.
groups_ran=0
groups_failed=()
group() {
  local name="$1"
  shift
  groups_ran=$((groups_ran + 1))
  if "$@"; then
    printf 'GROUP PASS %s\n' "$name"
  else
    printf 'GROUP FAIL %s\n' "$name" >&2
    groups_failed+=("$name")
  fi
}
group_report() {
  if [ "${#groups_failed[@]}" -ne 0 ]; then
    printf 'GROUPS FAIL ran=%d failed=%d\n' "$groups_ran" "${#groups_failed[@]}" >&2
    local name
    for name in "${groups_failed[@]}"; do printf 'GROUPS FAILED %s\n' "$name" >&2; done
    exit 1
  fi
  printf 'GROUPS PASS ran=%d failed=0\n' "$groups_ran"
}
