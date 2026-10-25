#!/usr/bin/env bash
# Documentation hygiene, including untracked docs and excluding historical records.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

pattern=$(printf '\342\200\223|\342\200\224|/Users/')
status=0
check_file() {
  local result
  grep -nHE "$pattern" "$1"
  result=$?
  case "$result" in
    0) if [ "$status" -ne 2 ]; then status=1; fi ;;
    1) ;;
    *) status=2 ;;
  esac
}
check_tree() {
  local entry
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$entry" ] || continue
    [ "$entry" != docs/history ] || continue
    if [ -d "$entry" ] && [ ! -L "$entry" ]; then
      check_tree "$entry"
    elif [ -f "$entry" ]; then
      case "$entry" in *.md) check_file "$entry" ;; esac
    fi
  done
}
check_file README.md
check_file CLAUDE.md
check_tree docs
exit "$status"
