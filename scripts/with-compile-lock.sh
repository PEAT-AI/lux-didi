#!/usr/bin/env bash
# One exclusive machine-wide compile lock per user, so parallel lanes never run two
# compilers at once. The lock lives exactly as long as the wrapped command and dies with it.
set -euo pipefail
if [ "${1:-}" = "--" ]; then shift; fi
[ "$#" -gt 0 ] || { echo 'usage: scripts/with-compile-lock.sh -- <command...>' >&2; exit 2; }
exec python3 -c '
import fcntl
import os
import sys
import time

path = os.environ.get("LUX_COMPILE_LOCK") or os.path.join(os.path.expanduser("~"), ".lux", "state", "compile.lock")
os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
fd = os.open(path, os.O_CREAT | os.O_WRONLY, 0o644)
start = time.monotonic()
fcntl.flock(fd, fcntl.LOCK_EX)
waited = time.monotonic() - start
if waited > 5:
    print("compile lock: waited %d s" % int(waited), file=sys.stderr, flush=True)
os.set_inheritable(fd, True)
os.execvp(sys.argv[1], sys.argv[1:])
' "$@"
