#!/usr/bin/env bash
# speaker-kit check: build the venv if needed, run the offline selftest, then
# prove that the plan mode of run_kit.sh prints a plan and creates nothing.
#
#   bash speaker-kit/selftest.sh
#
# No audio device, no playback and no microphone is touched.  The venv lives in
# speaker-kit/.venv and is never committed.
set -euo pipefail

KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VENV=${SPEAKERKIT_VENV:-$KIT_DIR/.venv}
PY=$VENV/bin/python

export OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1 CI=1

if [ ! -x "$PY" ]; then
    base=${SPEAKERKIT_PYTHON:-/opt/homebrew/opt/python@3.14/bin/python3.14}
    if [ ! -x "$base" ]; then
        base=$(command -v python3)
    fi
    echo "check: creating venv at $VENV from $base"
    "$base" -m venv "$VENV"
    "$VENV/bin/pip" install --disable-pip-version-check -q numpy soundfile
fi

"$PY" -c 'import sys, numpy, soundfile; print("check: python %s numpy %s soundfile %s"
          % (sys.version.split()[0], numpy.__version__, soundfile.__version__))'

echo "check: offline selftest"
"$PY" "$KIT_DIR/selftest.py"

echo "check: signals, then the file path of analyze.py on a synthetic recording"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/speakerkit-check.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

"$PY" "$KIT_DIR/make_signals.py" --out "$tmp/signals" --quiet
"$PY" "$KIT_DIR/selftest.py" --run-dir "$tmp/signals"

echo "check: plan mode of run_kit.sh"
SPEAKERKIT_RUNS="$tmp/runs" SPEAKERKIT_SIGNALS="$tmp/signals" \
    bash "$KIT_DIR/run_kit.sh" plancheck > "$tmp/plan.txt"

grep -q "nothing is played" "$tmp/plan.txt" \
    || { echo "check: plan does not state that nothing is played" >&2; exit 1; }
grep -q "signals.json says 59.0s, plan says 59s" "$tmp/plan.txt" \
    || { echo "check: plan seconds and generated signals disagree" >&2
         cat "$tmp/plan.txt" >&2; exit 1; }
grep -q "WARNING" "$tmp/plan.txt" \
    && { echo "check: plan warns about the signal set" >&2; exit 1; }
if [ -e "$tmp/runs" ]; then
    echo "check: plan mode created a run directory, it must not" >&2
    exit 1
fi
sed -n '1,14p' "$tmp/plan.txt"

echo "SELFTEST SH: PASS"
