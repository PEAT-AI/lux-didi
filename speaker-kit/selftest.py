#!/usr/bin/env python3
"""Offline selftest for the speaker-kit analyser: no audio device, no files.

Six simulated channels are pushed through the same stimulus set that
make_signals.py writes and through the same analyser that analyze.py runs on a
real recording:

  clean              linear speaker, room noise, mic gain
  hard clip          waveform clamped at -6 dBFS (the -3 dBFS plays clip,
                     the -9 and -18 dBFS plays do not)
  tanh               soft saturation, odd harmonics at every level
  compressor         4:1 above -12 dBFS with a 20 ms envelope
  rattle             left speaker only: band limited noise 3 to 12 kHz,
                     gated by low-frequency amplitude
  mic clip           clean speaker, mic gain that clips the capture, which
                     must be refused rather than classified

Every case is analysed and the printed verdict must match the expected one.
Exit status is non-zero if any verdict or any stimulus spec check fails.
"""

import math
import sys

import numpy as np

import analyze
import make_signals as ms

FS = ms.FS
MIC_GAIN = 0.4
ROOM_NOISE_RMS = 0.0018          # about -55 dBFS of room noise at the mic
EXPECTED_TOTAL_S = 80.0


def _stereo(entry):
    mono = entry["mono"]
    z = np.zeros_like(mono)
    if entry["channel"] == "L":
        return np.stack([mono, z], axis=1)
    if entry["channel"] == "R":
        return np.stack([z, mono], axis=1)
    return np.stack([mono, mono], axis=1)


def _block_env(x, fs, block_ms=1.0, smooth_ms=20.0):
    """Envelope of |x| on a 1 ms grid, smoothed; returned on the sample grid."""
    b = max(1, int(block_ms * fs / 1000.0))
    n = len(x)
    nb = max(1, n // b)
    pooled = np.max(np.abs(x[: nb * b]).reshape(nb, b), axis=1)
    sm = max(1, int(smooth_ms / block_ms))
    kernel = np.ones(sm) / sm
    env = np.convolve(np.pad(pooled, (sm // 2, sm - 1 - sm // 2), mode="edge"),
                      kernel, mode="valid")
    return np.interp(np.arange(n) / b, np.arange(nb), env)


def model_clean(x, fs, rng):
    return x.copy()


def model_hardclip(x, fs, rng, clip_db=-6.0):
    limit = 10.0 ** (clip_db / 20.0)
    return np.clip(x, -limit, limit)


def model_tanh(x, fs, rng, drive=2.0):
    return np.tanh(drive * x) / drive


def model_compressor(x, fs, rng, threshold_db=-12.0, ratio=4.0):
    threshold = 10.0 ** (threshold_db / 20.0)
    out = x.copy()
    for ch in range(x.shape[1]):
        env = _block_env(x[:, ch], fs)
        gain = np.ones_like(env)
        over = env > threshold
        gain[over] = (threshold / env[over]) ** (1.0 - 1.0 / ratio)
        out[:, ch] = x[:, ch] * gain
    return out


def model_rattle(x, fs, rng, threshold=0.10, level=0.30, lo=1500.0, hi=8000.0):
    """High-frequency rattle on the left speaker, gated by low-frequency level."""
    out = x.copy()
    env = _block_env(_lowpass(x[:, 0], fs, 300.0), fs, smooth_ms=30.0)
    gate = np.clip((env - threshold) / threshold, 0.0, 1.0) ** 4
    if not np.any(gate > 0):
        return out
    noise = rng.standard_normal(len(gate))
    spec = np.fft.rfft(noise)
    freqs = np.fft.rfftfreq(len(noise), 1.0 / fs)
    spec[(freqs < lo) | (freqs > hi)] = 0.0
    burst = np.fft.irfft(spec, len(noise))
    burst /= max(np.max(np.abs(burst)), 1e-12)
    out[:, 0] = x[:, 0] + level * gate * burst
    return out


def _lowpass(x, fs, fc, taps_ms=5.0):
    n = max(3, int(taps_ms * fs / 1000.0))
    kernel = np.ones(n) / n
    return np.convolve(x, kernel, mode="same")


def _split_bass(x, fs):
    spectrum = np.fft.rfft(x, axis=0)
    spectrum[np.fft.rfftfreq(len(x), 1/fs) >= 300] = 0
    return np.fft.irfft(spectrum, n=len(x), axis=0)


def model_chain(x, fs, rng):
    """A deliberately non-flat, crossfed DSP chain, not an Apple graph replica."""
    low = _split_bass(x, fs)
    scale = max(float(np.max(np.abs(low))), 1e-12)
    synthetic = .6*(low*low/scale - np.mean(low*low/scale, axis=0)) + .3*low**3/scale**2
    y = x + synthetic
    y = y - .97*_split_bass(y, fs)  # poor fundamental radiation below 300 Hz
    y = y + .22*y[:, ::-1]  # left-only input radiates from both sides
    env = np.maximum(_block_env(y[:, 0], fs), _block_env(y[:, 1], fs))
    # Mild broadband compressor and fixed normalization, not speaker damage.
    gain = np.minimum(1., (.2/np.maximum(env, 1e-12))**.15)
    return .8*y*gain[:, None]


def model_chain_rattle(x, fs, rng):
    return model_chain(model_rattle(x, fs, rng), fs, rng)


def model_excursion(x, fs, rng):
    low = _split_bass(x, fs)
    limited = .12*np.tanh(low/.12)
    return model_chain(x-low+limited, fs, rng)


def check_physical_chain(entries):
    failures = []
    for name, model in (("healthy DSP chain", model_chain), ("one-sided rattle with DSP", model_chain_rattle)):
        report = analyze.analyse_segments(entries, record(entries, model), FS)
        verdicts = {c: v["verdict"] for c, v in report["channels"].items()}
        print(name + ": " + str(verdicts))
        if name.startswith("one-sided"):
            print("chain controls: " + str([v for v in report["comparison"] if v.get("asymmetry_growth_db", 0) > 10]))
        if name.startswith("healthy") and any("RATTLE" in v or "CLIPPING" in v for v in verdicts.values()):
            failures.append("healthy chain false fault verdict")
        if name.startswith("one-sided") and "RATTLE" not in verdicts.get("L", ""):
            failures.append("chain hides one-sided rattle")
    bass = ms.bass_signals()
    if sum(e["duration_s"] for e in bass) != 48 or len(bass) != 21:
        failures.append("bass stimulus duration or file count")
    for e in bass:
        if e["kind"] == "bass-tone" and e["level_db_peak"] > -3:
            failures.append("unsafe sustained tone level")
    for name, model in (("healthy", model_chain), ("excursion", model_excursion)):
        report = analyze.analyse_segments(bass, record(bass, model), FS)
        verdict = report["bass"]["verdict"]
        print("bass " + name + ": " + verdict)
        if (name == "healthy" and "LEVEL DEPENDENCE" in verdict) or (name == "excursion" and "LEVEL DEPENDENCE" not in verdict):
            failures.append("bass limiter discrimination: " + name)
        if len(report["bass"]["tones"]) != 18 or not report["bass"]["voice"]:
            failures.append("bass tone or voice comparisons missing")
    # A missing file must not produce a plausible timing or healthy verdict.
    try:
        analyze.align_offset(np.zeros(FS), np.ones(FS//4), FS)
    except ValueError:
        pass
    else:
        failures.append("silence accepted as a reference")
    # Delete 40 ms every 500 ms, preserving local pitch but corrupting sweep
    # timing, like a lossy capture. A whole-file offset cannot repair this.
    ref = entries[1]["mono"] * 10**(entries[1]["level_db_peak"]/20)
    keep = np.arange(len(ref)) % (FS//2) >= int(.04*FS)
    broken = np.concatenate([np.zeros(FS), ref[keep], np.zeros(FS)])
    points = analyze.alignment_landmarks(broken, ref, FS, FS)
    spread = np.ptp([p["offset_s"] for p in points]) if len(points) >= 3 else 0
    if spread < .1:
        failures.append("within-file sample loss not exposed by landmarks")
    print("capture-loss control: landmark spread %.1f ms" % (1000*spread))
    return failures


MODELS = {
    "clean": (model_clean, {"L": "CLEAN", "R": "CLEAN"}),
    "hard clip at -6 dBFS": (model_hardclip, {"L": "HARD CLIPPING", "R": "HARD CLIPPING"}),
    "tanh saturation": (model_tanh, {"L": "LIMITER OR COMPRESSOR",
                                     "R": "LIMITER OR COMPRESSOR"}),
    "4:1 compressor": (model_compressor, {"L": "LIMITER OR COMPRESSOR",
                                          "R": "LIMITER OR COMPRESSOR"}),
    "left-only gated rattle": (model_rattle, {"L": "RATTLE OR BUZZ", "R": "CLEAN"}),
}


def record(entries, model, gain=MIC_GAIN, seed=7):
    """Run the stimulus set through a channel model and a mic, in memory."""
    rng = np.random.default_rng(seed)
    segments = {}
    for entry in entries:
        played = _stereo(entry) * 10.0 ** (entry["level_db_peak"] / 20.0)
        sig = model(played, FS, rng)
        mono = sig.sum(axis=1) * gain
        mono = mono + rng.standard_normal(len(mono)) * ROOM_NOISE_RMS
        segments[entry["file"]] = mono
    return segments


def check_stimulus():
    """The stimulus set matches the brief: levels, crest, total playback time."""
    entries = ms.signals()
    problems = []
    total = 0.0
    for entry in entries:
        total += entry["duration_s"]
        peak = float(np.max(np.abs(entry["mono"])))
        if abs(peak - 1.0) > 1e-9:
            problems.append("%s: unit peak expected before level scaling, got %.6f"
                            % (entry["file"], peak))
        if entry["kind"] == "multitone":
            c = entry["crest_db"]
            if not 11.0 <= c <= 13.0:
                problems.append("%s: crest %.2f dB outside 11 to 13 dB" % (entry["file"], c))
        if entry["kind"] == "sweep" and entry["duration_s"] != 5.0:
            problems.append("%s: sweep must be 5 s" % entry["file"])
    total += ms.GAP_S * (len(entries) - 1)
    if total > EXPECTED_TOTAL_S:
        problems.append("playback %.1f s over the %.0f s budget" % (total, EXPECTED_TOTAL_S))
    return entries, total, problems


def check_run_dir(signals_dir, work_dir, model=model_hardclip, calibrated=True):
    """End to end on files: generate a synthetic recording, then run analyze.py.

    This is the path a real run takes (manifest, recording file, alignment) but
    with a simulated speaker and no audio device.  The expected verdict is the
    hard clip channel, and every alignment must land within 5 ms of the truth.
    """
    import json
    import os

    import soundfile as sf

    with open(os.path.join(signals_dir, "signals.json")) as fh:
        signals = json.load(fh)
    rng = np.random.default_rng(11)
    os.makedirs(work_dir, exist_ok=True)
    pre = np.zeros(int(1.0 * FS))
    gap = np.zeros(int(ms.GAP_S * FS))
    parts = [pre]
    truth = {}
    position = len(pre)
    for index, entry in enumerate(signals["files"]):
        delay = np.zeros(int((index % 3) * 0.37 * FS))
        parts.append(delay)
        position += len(delay)
        data, fs = sf.read(entry["path"], dtype="float64", always_2d=True)
        if fs != FS:
            raise SystemExit("%s is %d Hz" % (entry["path"], fs))
        sig = model(data, FS, rng) * MIC_GAIN
        mono = sig.sum(axis=1) + rng.standard_normal(len(sig)) * ROOM_NOISE_RMS
        parts.append(mono)
        parts.append(gap)
        truth[entry["file"]] = position
        position += len(mono) + len(gap)
    recording = np.concatenate(parts)
    rec_name = "mic_raw.wav"
    sf.write(os.path.join(work_dir, rec_name), recording, FS, subtype="PCM_16")
    manifest = {
        "label": "selftest-run-dir",
        "calibrated_fixture": calibrated,
        "slider": 0,
        "created": "synthetic",
        "fs": FS,
        "gap_s": ms.GAP_S,
        "pre_roll_s": 1.0,
        "run_dir": os.path.abspath(work_dir),
        "signals_dir": os.path.abspath(signals_dir),
        "recording": {"file": rec_name, "fs": FS, "channels": 1, "format": "s16"},
        "devices": {"default_output": "synthetic", "microphone": "synthetic"},
        "files": signals["files"],
    }
    with open(os.path.join(work_dir, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    report, path = analyze.run(work_dir)
    problems = []
    for ch in sorted({e["channel"] for e in signals["files"] if e["kind"] != "multitone"}):
        got = report["channels"][ch]["verdict"]
        want = "HARD CLIPPING" if calibrated else "INCONCLUSIVE"
        if got != want:
            problems.append("run dir: channel %s expected %s, got %s" % (ch, want, got))
    if report.get("invalid_measurements"):
        problems.append("run dir false refusal: " + str(report["invalid_measurements"]))
    worst = 0
    for name, want in truth.items():
        got = report["alignment"].get(name)
        if got is None:
            problems.append("run dir: %s not aligned" % name)
            continue
        worst = max(worst, abs(got - want))
    if worst > int(0.005 * FS):
        problems.append("run dir: alignment off by %d samples" % worst)
    print("run dir: %d files, alignment within %d samples, verdicts %s"
          % (len(truth), worst,
             ", ".join("%s %s" % (ch, report["channels"][ch]["verdict"])
                       for ch in sorted(report["channels"]))))
    print("run dir: wrote %s" % path)
    if calibrated:
        problems.extend(check_run_dir(signals_dir, os.path.join(work_dir, "chain"), model_chain, calibrated=False))
    return problems


def main(argv=None):
    ap_args = sys.argv[1:]
    if ap_args and ap_args[0] in ("--run-dir", "--bass-run-dir"):
        if len(ap_args) != 2:
            print("usage: selftest.py --run-dir SIGNALS_DIR", file=sys.stderr)
            return 2
        import shutil
        import tempfile
        work = tempfile.mkdtemp(prefix="speakerkit-rundir.")
        try:
            if ap_args[0] == "--bass-run-dir":
                problems = check_run_dir(ap_args[1], work, model_chain, calibrated=False)
            else:
                problems = check_run_dir(ap_args[1], work)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        for p in problems:
            print("FAIL %s" % p)
        print("SELFTEST RUN DIR %s" % ("FAIL" if problems else "PASS"))
        return 1 if problems else 0

    entries, total_s, problems = check_stimulus()
    print("stimulus: %d files, %.1f s including gaps, fades %.0f ms"
          % (len(entries), total_s, ms.FADE_S * 1000))
    for p in problems:
        print("  STIMULUS FAIL %s" % p)

    cases = list(MODELS.items())
    cases.append(("mic clip (capture clipped)",
                  (model_clean, {"L": "INCONCLUSIVE", "R": "INCONCLUSIVE"})))
    case_opts = {"mic clip (capture clipped)": {"gain": 3.0}}

    failures = []
    for name, (model, expected) in cases:
        opts = case_opts.get(name, {})
        gain = opts.get("gain", MIC_GAIN)
        segments = record(entries, model, gain=gain)
        if opts.get("gain"):
            for key, seg in segments.items():
                segments[key] = np.clip(seg, -1.0, 1.0)
        report = analyze.analyse_segments(entries, segments, FS, {"label": name}, calibrated=True)
        table = analyze.format_table(report)
        print("\n=== %s" % name)
        print(table)
        for ch, want in expected.items():
            got = report["channels"][ch]["verdict"]
            if got != want:
                failures.append("%s: channel %s expected %s, got %s"
                                % (name, ch, want, got))
    failures.extend(check_physical_chain(entries))
    print("\n=== result")
    if problems or failures:
        for f in problems + failures:
            print("FAIL %s" % f)
        print("SELFTEST FAIL (%d checks)" % (len(problems) + len(failures)))
        return 1
    print("SELFTEST PASS: %d simulated channels, %d channels checked, "
          "stimulus spec ok" % (len(cases), sum(len(e) for _, e in cases)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
