#!/usr/bin/env bash
# speaker-kit: play the stimulus set through the built-in speakers and record
# the built-in mic, without touching any device setting.
#
#   bash run_kit.sh LABEL            print the plan and the seconds, play nothing
#   bash run_kit.sh LABEL --go       record one run
#   bash run_kit.sh LABEL --bass     print the 48 second bass plan
#
# --go refuses unless the default output is the built-in speaker, the slider
# reading works, a built-in microphone is present by name, and the operator has
# confirmed that no call is live.  It reads the slider and never writes it, and
# it sets no other device property either.  The microphone is opened by ffmpeg
# avfoundation with no filters at all.
set -euo pipefail

KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUNS_ROOT=${SPEAKERKIT_RUNS:-/Users/rob/.lux/reports/didi-call-1101b/speaker-kit-runs}
SIGNALS_DIR=${SPEAKERKIT_SIGNALS:-$RUNS_ROOT/signals}
VENV=${SPEAKERKIT_VENV:-$KIT_DIR/.venv}
PY=$VENV/bin/python

# Stimulus plan, kept in step with make_signals.py; the check compares them.
SWEEP_FILES=6;   SWEEP_S=5;   MULTI_FILES=3; MULTI_S=4; TWIN_FILES=2; TWIN_S=3
GAP_S=1; PRE_ROLL_S=1
N_FILES=$((SWEEP_FILES + MULTI_FILES + TWIN_FILES))
AUDIO_S=$((SWEEP_FILES * SWEEP_S + MULTI_FILES * MULTI_S + TWIN_FILES * TWIN_S))
GAPS_S=$((GAP_S * (N_FILES - 1)))
TOTAL_S=$((PRE_ROLL_S + AUDIO_S + GAPS_S))

usage() {
    sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

label=""
go=0
bass=0
confirm_flag=0
for arg in "$@"; do
    case "$arg" in
        --go) go=1 ;;
        --bass) bass=1 ;;
        --confirm-no-call) confirm_flag=1 ;;
        -h|--help) usage 0 ;;
        --*) echo "unknown option: $arg" >&2; usage 2 ;;
        *) if [ -z "$label" ]; then label=$arg; else echo "one label only" >&2; exit 2; fi ;;
    esac
done
[ -n "$label" ] || usage 2
case "$label" in
    *[!A-Za-z0-9._-]*) echo "label may only hold letters, digits, dot, underscore, hyphen" >&2; exit 2 ;;
esac

signal_args=()
if [ "$bass" -eq 1 ]; then
    signal_args=(--bass)
    SIGNALS_DIR=${SPEAKERKIT_SIGNALS:-$RUNS_ROOT/signals-bass}
    N_FILES=21
    AUDIO_S=48
    GAPS_S=20
    TOTAL_S=69
fi

print_plan() {
    if [ "$bass" -eq 1 ]; then
        cat <<EOF
speaker-kit bass plan for label "$label"
  sustained stereo: 60, 80, 100, 150, 200, 300 Hz; 2 s each at -12, -6, -3 dBFS
  kicks: decaying 100 to 60 Hz, -1 dBFS peak, 4/s for 4 s
  voice alone and 100 Hz bass (-6) plus voice (-18): 4 s each
  all fades: 20 ms; no sustained -1 dBFS sine
  audio ${AUDIO_S}s + gaps ${GAPS_S}s + pre-roll ${PRE_ROLL_S}s = ${TOTAL_S}s
  signals: $SIGNALS_DIR
  Without --go: no playback, mic, device query or file creation.
  With --go: identical speaker, microphone, slider and no-live-call safeguards.
EOF
        return
    fi
    local total_json=""
    if [ -f "$SIGNALS_DIR/signals.json" ]; then
        total_json=$(sed -n 's/.*"total_s": *\([0-9.]*\).*/\1/p' "$SIGNALS_DIR/signals.json" | head -1)
    fi
    cat <<EOF
speaker-kit plan for label "$label"

  sweeps      $SWEEP_FILES files, ${SWEEP_S}s each, 100 Hz to 12 kHz exponential,
              left only and right only, peaks -18, -9, -3 dBFS
  multitone   $MULTI_FILES files, ${MULTI_S}s each, 14 tones, crest about 12 dB,
              both channels, peaks -13, -7, -1 dBFS
  twin tone   $TWIN_FILES files, ${TWIN_S}s each, 60 Hz plus 7 kHz,
              left only and right only, peak -9 dBFS
  gaps        ${GAP_S}s of silence between plays
  pre-roll    ${PRE_ROLL_S}s of recording before the first play

  audio       ${AUDIO_S}s
  gaps        ${GAPS_S}s
  playback    ${TOTAL_S}s of recording, one pass, no repeats
EOF
    if [ -n "$total_json" ]; then
        echo "  signals     $SIGNALS_DIR (signals.json says ${total_json}s, plan says ${TOTAL_S}s)"
        if [ "${total_json%.*}" != "$TOTAL_S" ] && [ "$total_json" != "$TOTAL_S" ]; then
            echo "  WARNING     plan and signals.json disagree, regenerate the signals"
        fi
    else
        echo "  signals     not generated yet; --go generates them into $SIGNALS_DIR"
    fi
    cat <<EOF

  with --go  record 48 kHz mono s16 from the built-in microphone with ffmpeg
            avfoundation, no filters, and play each file with afplay
  output     $RUNS_ROOT/${label}-<slider>-<timestamp>/ (mode 700) with a manifest
  never      sets volume, balance, sample rate, default device or any property;
             the slider is only read

  nothing is played and no directory is created: this is the plan only.
EOF
}

if [ "$go" -eq 0 ]; then
    print_plan
    exit 0
fi

log() { echo "run_kit: $*" >&2; }
die() { echo "run_kit: $*" >&2; exit 2; }

[ -x "$PY" ] || die "no venv at $VENV; run the generator once (bash selftest.sh) to build it"
for tool in ffmpeg afplay osascript system_profiler; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found"
done

# 1. the default output must be the built-in speaker, read only
default_out=$(system_profiler SPAudioDataType 2>/dev/null | awk '
    /^[[:space:]]+[^[:space:]].*:[[:space:]]*$/ { name = $0; sub(/^[[:space:]]+/, "", name); sub(/:[[:space:]]*$/, "", name) }
    /Default Output Device: Yes/ { print name; exit }
')
[ -n "$default_out" ] || die "cannot read the default output device"
case "$default_out" in
    *AirPods*|*Bluetooth*|*USB*|*HDMI*|*Display*|*BlackHole*|*Aggregate*|*Loopback*)
        die "default output is \"$default_out\", not the built-in speaker; \
switch it in System Settings > Sound and run again (the kit never changes it)" ;;
    *MacBook*Speaker*|*Built-in*Speaker*|*Internal*Speaker*) : ;;
    *) die "default output is \"$default_out\", which does not look like the built-in \
speaker; switch it in System Settings > Sound and run again" ;;
esac

# 2. the slider, read only
slider=$(osascript -e 'output volume of (get volume settings)' 2>/dev/null) \
    || die "cannot read the output volume with osascript; no run recorded"
case "$slider" in
    ''|*[!0-9]*) die "unexpected volume reading \"$slider\"" ;;
esac

# 3. the built-in microphone, found by name at run time
mic_name=""
mic_index=""
while IFS= read -r line; do
    case "$line" in
        *"["*"] "*)
            idx=$(printf '%s' "$line" | sed -n 's/.*\[\([0-9][0-9]*\)\] .*/\1/p')
            dev=$(printf '%s' "$line" | sed -n 's/.*\[[0-9][0-9]*\] \(.*\)$/\1/p')
            [ -n "$idx" ] && [ -n "$dev" ] || continue
            case "$dev" in
                *BlackHole*|*Aggregate*|*Loopback*|*iPhone*|*AirPods*|*Continuity*) continue ;;
                *Microphone*|*Mic*)
                    if [ -z "$mic_index" ]; then mic_index=$idx; mic_name=$dev; fi
                    ;;
            esac
            ;;
    esac
done < <(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 || true)
[ -n "$mic_index" ] || die "no built-in microphone found by name in avfoundation"

# 4. the operator confirms that no call is live
cat <<EOF
run_kit: about to record with the built-in microphone and play through the
run_kit: built-in speaker for ${TOTAL_S}s.
run_kit:
run_kit:   CONFIRM THAT NO DIDI CALL IS LIVE.
run_kit:   The mic will hear the room; the call would be recorded and heard.
run_kit:
run_kit:   default output : $default_out
run_kit:   slider (read)  : $slider
run_kit:   microphone     : $mic_name (index $mic_index)
EOF
if [ -t 0 ] && [ "$confirm_flag" -eq 0 ]; then
    printf 'run_kit: type yes to continue: '
    read -r answer
    [ "$answer" = "yes" ] || die "not confirmed, nothing recorded"
else
    [ "$confirm_flag" -eq 1 ] || die "no terminal to confirm on; pass --confirm-no-call \
only when you have checked that no call is live"
fi

# 5. signals, then the run directory
mkdir -p "$SIGNALS_DIR"
if [ ! -f "$SIGNALS_DIR/signals.json" ]; then
    log "generating the stimulus set in $SIGNALS_DIR"
    "$PY" "$KIT_DIR/make_signals.py" --out "$SIGNALS_DIR" "${signal_args[@]}" --quiet
fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
run_dir=$RUNS_ROOT/${label}-${slider}-${timestamp}
umask 077
mkdir -p "$run_dir"
chmod 700 "$run_dir"
recording=mic_raw.wav

cleanup() {
    if [ -n "${rec_pid:-}" ] && kill -0 "$rec_pid" 2>/dev/null; then
        kill -INT "$rec_pid" 2>/dev/null || true
        wait "$rec_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

log "recording $recording from $mic_name at 48 kHz mono s16, no filters"
recording_start_utc=$("$PY" -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat())')
ffmpeg -hide_banner -loglevel error -nostdin \
    -f avfoundation -i ":$mic_index" \
    -ac 1 -ar 48000 -sample_fmt s16 -c:a pcm_s16le \
    "$run_dir/$recording" &
rec_pid=$!
sleep "$PRE_ROLL_S"

files=()
while IFS= read -r f; do files+=("$f"); done \
    < <(sed -n 's/.*"file": "\([^"]*\)".*/\1/p' "$SIGNALS_DIR/signals.json")
[ "${#files[@]}" -eq "$N_FILES" ] || die "expected $N_FILES signals, signals.json lists ${#files[@]}"

# Wall-clock brackets include afplay launch/return overhead, not DAC timestamps.
# Kept beside the private recording, never in the source tree.
timing_file="$run_dir/playback-times.tsv"
: > "$timing_file"
first=1
for f in "${files[@]}"; do
    if [ "$first" -eq 0 ]; then sleep "$GAP_S"; fi
    first=0
    log "playing $f"
    start_utc=$("$PY" -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat())')
    afplay "$SIGNALS_DIR/$f"
    end_utc=$("$PY" -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat())')
    printf '%s\t%s\t%s\n' "$f" "$start_utc" "$end_utc" >> "$timing_file"
done
sleep "$PRE_ROLL_S"
cleanup
rec_pid=""
trap - EXIT INT TERM

"$PY" - "$SIGNALS_DIR/signals.json" "$run_dir" "$recording" "$label" "$slider" \
    "$default_out" "$mic_name" "$mic_index" "$GAP_S" "$PRE_ROLL_S" "$recording_start_utc" <<'PY'
import json, os, socket, subprocess, sys, time

(signals_path, run_dir, recording, label, slider, default_out, mic_name,
 mic_index, gap_s, pre_roll_s, recording_start_utc) = sys.argv[1:]
manifest = json.load(open(signals_path))
with open(os.path.join(run_dir, "playback-times.tsv")) as timing:
    stamps = {name: (start, end) for name, start, end in
              (line.rstrip().split("\t") for line in timing)}
files = []
for entry in manifest["files"]:
    item = dict(entry)
    item["playback_start_utc"], item["playback_end_utc"] = stamps[entry["file"]]
    item["path"] = os.path.join(os.path.dirname(signals_path), entry["file"])
    files.append(item)
try:
    product = subprocess.run(["sw_vers", "-productVersion"], capture_output=True,
                             text=True, timeout=10).stdout.strip()
except Exception:
    product = None
out = {
    "label": label,
    "recording_start_utc": recording_start_utc,
    "slider": int(slider),
    "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "fs": manifest["fs"],
    "gap_s": float(gap_s),
    "pre_roll_s": float(pre_roll_s),
    "run_dir": os.path.abspath(run_dir),
    "signals_dir": os.path.abspath(os.path.dirname(signals_path)),
    "recording": {"file": recording, "fs": manifest["fs"], "channels": 1,
                  "format": "s16", "filters": "none", "duration_s": None,
                  "frames": None},
    "devices": {"default_output": default_out, "microphone": mic_name,
                "microphone_index": int(mic_index), "device_properties_set": "none"},
    "host": {"hostname": socket.gethostname(), "macos": product},
    "files": files,
}
try:
    import soundfile as sf
    info = sf.info(os.path.join(run_dir, recording))
    out["recording"]["fs"] = info.samplerate
    out["recording"]["channels"] = info.channels
    out["recording"]["frames"] = int(info.frames)
    out["recording"]["duration_s"] = round(info.frames / float(info.samplerate), 3)
except Exception as exc:                      # keep the manifest even if the probe fails
    out["recording"]["probe_error"] = str(exc)
with open(os.path.join(run_dir, "manifest.json"), "w") as fh:
    json.dump(out, fh, indent=1)
print("wrote manifest.json", file=sys.stderr)
PY

log "run written to $run_dir"
log "analyse with: $PY $KIT_DIR/analyze.py \"$run_dir\""
