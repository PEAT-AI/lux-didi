#!/usr/bin/env bash
# The shared elapsed-time recorder for the release producers (#841 item 5).
#
# Release time is otherwise unmeasurable: the gate reported one total and the three build
# producers reported nothing, so nobody could say which step of a 10 minute release was the
# expensive one. A producer sources this file, calls `timing_step <label> <seconds>` after each
# step, and `timing_total` once at the end.
#
# Every call prints one human line, `TIME <label> <seconds>s`. Every call also appends one TSV row
# to $DIDI_TIMING_FILE, whose three columns are kind (STEP or TOTAL), label and seconds, so a
# later run can be summed per step. Without DIDI_TIMING_FILE the record is print-only and nothing
# is written to disk.

timing_step() {
  printf 'TIME %s %ss\n' "$1" "$2"
  if [ -n "${DIDI_TIMING_FILE:-}" ]; then
    printf 'STEP\t%s\t%s\n' "$1" "$2" >> "$DIDI_TIMING_FILE"
  fi
}

timing_total() {
  printf 'TIME total %ss\n' "$1"
  if [ -n "${DIDI_TIMING_FILE:-}" ]; then
    printf 'TOTAL\t%s\t%s\n' "${2:-total}" "$1" >> "$DIDI_TIMING_FILE"
  fi
}
