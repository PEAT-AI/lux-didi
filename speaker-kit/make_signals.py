#!/usr/bin/env python3
"""Build the speaker-kit stimulus set: 48 kHz 24 bit stereo WAV, exact peak levels.

Every level is a peak sample level: the written file's largest absolute sample
sits at 10 ** (level_db / 20) of full scale.  `signals.json` next to the WAVs
records the level and the level measured back from the written file.

Signal set (playback 48 s of audio, 10 s of 1 s gaps, 59 s including the pre-roll):
  sweep   100 Hz to 12 kHz exponential, 5 s, left only and right only,
          peaks -18, -9, -3 dBFS (6 files)
  multi   music-like multitone, crest about 12 dB, 4 s, both channels,
          peaks -13, -7, -1 dBFS (3 files)
  twin    60 Hz plus 7 kHz, 3 s, left only and right only, peak -9 dBFS (2 files)

Playback order is the order of `signals.json["files"]`, interleaving nothing:
all sweeps, then all multitone, then both twin tones.

Usage:
  .venv/bin/python make_signals.py [--out DIR] [--quiet]
"""

import argparse
import json
import math
import os
import sys

import numpy as np
import soundfile as sf

FS = 48000
SWEEP_F1, SWEEP_F2, SWEEP_DUR = 100.0, 12000.0, 5.0
SWEEP_LEVELS = (-18.0, -9.0, -3.0)
MULTI_DUR = 4.0
MULTI_LEVELS = (-13.0, -7.0, -1.0)
MULTI_CREST_DB = 12.0
MULTI_TONES = 14
MULTI_F1, MULTI_F2 = 120.0, 9000.0
TWIN_FREQS = (60.0, 7000.0)
TWIN_DUR, TWIN_LEVEL = 3.0, -9.0
GAP_S = 1.0
PRE_ROLL_S = 1.0
FADE_S = 0.02
FULL = 2.0 ** 23 - 1.0

DEFAULT_OUT = os.path.join(
    os.environ.get(
        "SPEAKERKIT_RUNS", "/Users/rob/.lux/reports/didi-call-1101b/speaker-kit-runs"
    ),
    "signals",
)


def _fade(x, fs=FS, fade_s=FADE_S):
    """Raised-cosine fades so playback starts and ends without a click."""
    n = min(int(fade_s * fs), len(x) // 2)
    if n <= 0:
        return x
    ramp = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
    x = x.copy()
    x[:n] *= ramp
    x[-n:] *= ramp[::-1]
    return x


def sweep(f1=SWEEP_F1, f2=SWEEP_F2, dur=SWEEP_DUR, fs=FS):
    """Farina exponential sweep, unit peak, 20 ms fades."""
    t = np.arange(int(round(dur * fs))) / fs
    k = math.log(f2 / f1)
    phase = 2.0 * math.pi * f1 * dur / k * (np.exp(t * k / dur) - 1.0)
    return _fade(np.sin(phase), fs)


def multitone(dur=MULTI_DUR, fs=FS, crest_db=MULTI_CREST_DB,
              n_tones=MULTI_TONES, f1=MULTI_F1, f2=MULTI_F2, seed=20240501):
    """Sum of log-spaced tones whose crest factor lands near `crest_db`.

    Phase sets are searched against the final duration, because crest factor
    grows with the chance of a peak landing in the window.  The returned
    waveform has unit peak; the achieved crest is returned alongside.
    """
    n = int(round(dur * fs))
    t = np.arange(n) / fs
    freqs = np.geomspace(f1, f2, n_tones)
    target = 10.0 ** (crest_db / 20.0)
    rng = np.random.default_rng(seed)
    best = None
    for _ in range(80):
        phases = rng.uniform(0.0, 2.0 * math.pi, n_tones)
        x = np.zeros(n)
        for f, p in zip(freqs, phases):
            x += np.sin(2.0 * math.pi * f * t + p)
        crest = np.max(np.abs(x)) / np.sqrt(np.mean(x * x))
        score = abs(20.0 * math.log10(crest) - crest_db)
        if best is None or score < best[0]:
            best = (score, x, crest, phases)
    _, x, crest, phases = best
    x = x / np.max(np.abs(x))
    return _fade(x, fs), float(crest), [float(f) for f in freqs], [float(p) for p in phases]


def twintone(fs=FS, dur=TWIN_DUR, freqs=TWIN_FREQS):
    t = np.arange(int(round(dur * fs))) / fs
    x = np.zeros(len(t))
    for f in freqs:
        x += np.sin(2.0 * math.pi * f * t)
    return _fade(x / np.max(np.abs(x)), fs)


def _quantise(x, level_db):
    """Scale so the peak sample equals the requested level, quantise to 24 bit."""
    target = 10.0 ** (level_db / 20.0)
    peak = float(np.max(np.abs(x)))
    x = x * (target / peak)
    q = np.round(x * FULL) / FULL
    return q, float(np.max(np.abs(q)))


def signals():
    """The stimulus set as in-memory mono waveforms, in playback order."""
    sweepsig = sweep()
    multisig, crest, freqs, phases = multitone()
    twinsig = twintone()
    entries = []

    def add(name, kind, level_db, channel, mono, extra=None):
        entry = {
            "file": name,
            "kind": kind,
            "channel": channel,
            "level_db_peak": level_db,
            "duration_s": round(len(mono) / FS, 6),
            "sample_rate": FS,
            "bits": 24,
            "mono": mono,
        }
        if extra:
            entry.update(extra)
        entries.append(entry)

    for ch in ("L", "R"):
        for lv in SWEEP_LEVELS:
            add("sweep_%s_m%02d.wav" % (ch, -lv), "sweep", lv, ch, sweepsig, {
                "sweep_f1_hz": SWEEP_F1, "sweep_f2_hz": SWEEP_F2, "farina": True,
            })
    for lv in MULTI_LEVELS:
        add("multi_both_m%02d.wav" % (-lv), "multitone", lv, "both", multisig, {
            "crest_db": round(20.0 * math.log10(crest), 3),
            "crest_db_target": MULTI_CREST_DB,
            "tones_hz": [round(f, 3) for f in freqs],
            "phases_rad": [round(p, 6) for p in phases],
        })
    for ch in ("L", "R"):
        add("twin_%s_m%02d.wav" % (ch, -TWIN_LEVEL), "twintone", TWIN_LEVEL, ch, twinsig, {
            "tones_hz": list(TWIN_FREQS),
        })
    return entries


def build(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    files = []

    def emit(name, kind, level_db, channel, mono, extra=None):
        left = mono if channel in ("L", "both") else np.zeros_like(mono)
        right = mono if channel in ("R", "both") else np.zeros_like(mono)
        q, achieved = _quantise(np.stack([left, right], axis=1), level_db)
        path = os.path.join(out_dir, name)
        sf.write(path, q, FS, subtype="PCM_24")
        entry = {
            "file": name,
            "path": path,
            "kind": kind,
            "channel": channel,
            "level_db_peak": level_db,
            "level_db_peak_written": round(20.0 * math.log10(achieved), 6),
            "duration_s": round(len(mono) / FS, 6),
            "sample_rate": FS,
            "bits": 24,
        }
        if extra:
            entry.update(extra)
        files.append(entry)

    for entry in signals():
        extra = {k: v for k, v in entry.items()
                 if k not in ("file", "kind", "channel", "level_db_peak",
                              "duration_s", "sample_rate", "bits", "mono")}
        emit(entry["file"], entry["kind"], entry["level_db_peak"],
             entry["channel"], entry["mono"], extra)

    audio_s = sum(f["duration_s"] for f in files)
    gaps_s = GAP_S * (len(files) - 1)
    manifest = {
        "fs": FS,
        "bits": 24,
        "level_definition": "peak sample level in dBFS, 0 dBFS = full scale",
        "audio_s": round(audio_s, 3),
        "gaps_s": round(gaps_s, 3),
        "pre_roll_s": PRE_ROLL_S,
        "total_s": round(PRE_ROLL_S + audio_s + gaps_s, 3),
        "gap_s": GAP_S,
        "files": files,
    }
    path = os.path.join(out_dir, "signals.json")
    with open(path, "w") as fh:
        json.dump(manifest, fh, indent=1)
    return manifest, path


def verify(out_dir, manifest):
    """Read the written files back and check the peak level of each."""
    bad = []
    for entry in manifest["files"]:
        data, fs = sf.read(entry["path"], dtype="float64", always_2d=True)
        if fs != FS:
            bad.append((entry["file"], "sample rate %d" % fs))
            continue
        peak = float(np.max(np.abs(data)))
        got = 20.0 * math.log10(peak)
        want = entry["level_db_peak"]
        if abs(got - want) > 1e-4:
            bad.append((entry["file"], "peak %.6f dBFS, wanted %.6f" % (got, want)))
    return bad


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=DEFAULT_OUT, help="output directory (default %(default)s)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    manifest, path = build(args.out)
    bad = verify(args.out, manifest)
    if not args.quiet:
        for entry in manifest["files"]:
            print("%-22s %-9s %-4s %5.1f dBFS %4.1f s" % (
                entry["file"], entry["kind"], entry["channel"],
                entry["level_db_peak_written"], entry["duration_s"]))
        print("audio %.1f s + gaps %.1f s = %.1f s total" % (
            manifest["audio_s"], manifest["gaps_s"], manifest["total_s"]))
        print("wrote %s" % path)
    if bad:
        for name, why in bad:
            print("LEVEL MISMATCH %s: %s" % (name, why), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
