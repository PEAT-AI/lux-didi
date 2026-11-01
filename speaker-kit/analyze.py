#!/usr/bin/env python3
"""Analyse one speaker-kit run directory.

Reads `<run>/manifest.json` and the recording it names, aligns every played
stimulus against the recording, and writes `analysis.json` plus a plain table
to stdout.

Measurements, all as ratios to the fundamental measured in the same band, so
an unknown mic distance and mic gain cancel out:

  (a) high order distortion.  `hi` is the RMS of harmonic orders 10 to 20
      relative to the fundamental, per band.  `crest` is max/rms of that
      high-order content across frames: an impulsive fault (rattle, buzz) has
      a crest well above a steady nonlinearity.  `floor` is the same
      measurement taken between harmonics; `hi - floor` separates a coherent
      harmonic series from broadband noise that a rub or buzz radiates.
  (b) level linearity.  Fundamental level per band at -18, -9 and -3 dBFS,
      regressed: a slope below 1.0 dB per dB is a compressor or limiter.
  (c) left versus right, from the separate left-only and right-only plays.
  (d) distortion growth per dB, from `hi` at the three levels.
  (e) multitone residual floor between tones, per level.
  (f) twin tone sidebands around 7 kHz, spaced by the 60 Hz drive.
  (g) mic validity: a clipped recording or a band whose fundamental is not
      clear of the inter-harmonic floor is refused, and the channel verdict
      falls back to INCONCLUSIVE instead of guessing.

Harmonic analysis of a sweep uses matched demodulation at the known
instantaneous phase of each order: a plain STFT smears the sweep within a
frame, which would under-read exactly the high orders that matter.

Usage:
  .venv/bin/python analyze.py RUN_DIR [-o analysis.json]
"""

import argparse
import json
import math
import os
import sys

import numpy as np
import soundfile as sf

FS = 48000
BANDS = ((100.0, 300.0), (300.0, 1000.0), (1000.0, 3000.0), (3000.0, 12000.0))
BAND_NAMES = ("100-300", "300-1k", "1k-3k", "3k-12k")
FRAME = 2400
HOP = 2400
ORDERS = tuple(range(1, 21))
HI_ORDER_MIN = 10
OFF_ORDERS = (10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5)
SNR_MIN_DB = 6.0
MIC_CLIP_LEVEL = 0.999

# Verdict thresholds.  They are deliberately coarse: this kit separates classes
# of fault, it does not certify a speaker.  Numbers come from the simulated
# channels in selftest.py, which carry the same room noise and mic gain as a
# real run.
HI_PRESENT_DB = -30.0      # hi ratio at or above this is audible on its own
HI_COHERENT_DB = 8.0       # per-order hi above the between-harmonic floor
RATTLE_HI_DB = -50.0       # high-order energy worth classifying at all
RATTLE_CREST = 1.8         # bursty rather than steady, the rub and buzz signature
CLIP_HI_DB = -52.0         # clipping at -6 dBFS leaves high orders near -40 dB
CLIP_LINEARITY = 0.97      # dB out per dB in, hard clipping also flattens level
CLIP_JUMP_DB = 8.0         # hi ratio jump from the middle to the top level
LIMIT_HI_DB = -40.0        # soft saturation distorts here without a hard clip edge
ASYM_LEVEL_DB = 6.0
ASYM_DIST_DB = 10.0


def db(x, floor=1e-12):
    return 20.0 * math.log10(max(float(x), floor))


def _to_mono(data):
    if data.ndim == 1:
        return data
    return data.mean(axis=1)


def load_signal(path):
    data, fs = sf.read(path, dtype="float64", always_2d=True)
    return _to_mono(data), fs


def find_onset(rec, fs, rel=0.05):
    """First sample of the first play: the recording opens with silence."""
    if not len(rec):
        return 0
    peak = float(np.max(np.abs(rec)))
    if peak <= 0.0:
        return 0
    above = np.abs(rec) > rel * peak
    idx = int(np.argmax(above))
    if not above[idx]:
        return 0
    return max(0, idx - int(0.03 * fs))


def align_offset(rec, ref, fs, search_lo=0, search_hi=None, max_lag_s=8.0):
    """Sample offset of `ref` inside `rec`, by cross-correlation.

    The window must be narrow enough to hold one play: the three left sweeps
    carry the same waveform at three levels, so a wide search locks onto the
    loudest one.  The caller predicts the window from the play order.
    """
    n = len(ref)
    lo = max(0, int(search_lo))
    hi = len(rec) if search_hi is None else min(len(rec), int(search_hi))
    if hi - lo < n:
        raise ValueError("alignment: recording truncated or missing stimulus")
    window = rec[lo:hi]
    nfft = 1 << (len(window) + n - 1).bit_length()
    corr = np.fft.irfft(
        np.fft.rfft(window, nfft) * np.conj(np.fft.rfft(ref, nfft)), nfft
    )[:len(window) - n + 1]
    # Only full-length overlaps are candidates. Normalization prevents a loud
    # neighbouring transient winning simply because its energy is larger.
    energy = np.concatenate(([0.0], np.cumsum(window * window)))
    local_energy = np.maximum(energy[n:] - energy[:-n], 0.)
    denom = np.sqrt(np.maximum(local_energy * np.dot(ref, ref), 1e-30))
    scores = np.abs(corr) / denom
    # FFT roundoff against an all-zero padded window is not a match.
    scores[local_energy <= max(float(np.max(local_energy))*1e-8, 1e-24)] = 0.
    best = int(np.argmax(scores))
    if scores[best] < 0.025:
        raise ValueError("alignment: reference not found (correlation %.4f, expected %.3fs)" % (scores[best], (lo + hi - n) / (2 * fs)))
    if best == 0 or best == len(scores) - 1:
        raise ValueError("alignment: peak at search boundary, cannot trust timing")
    return lo + best


def alignment_landmarks(rec, ref, fs, onset):
    """Short-reference correlations expose capture dropouts inside a sweep.

    A single whole-file peak cannot establish that its interior has the same
    timebase. Only compare landmarks with adequate correlation.
    """
    points = []
    for t in np.arange(1.0, len(ref) / fs - 0.3, 0.5):
        offset = int(t * fs)
        part = ref[offset:offset + int(0.08 * fs)]
        expected = onset + offset
        try:
            lag = align_offset(rec, part, fs, max(0, expected-int(0.8*fs)),
                               min(len(rec), expected+len(part)+int(0.8*fs)))
        except ValueError:
            continue
        seg = rec[lag:lag+len(part)]
        score = abs(float(np.dot(seg, part))) / max(float(np.linalg.norm(seg)*np.linalg.norm(part)), 1e-30)
        if score >= 0.2:
            points.append({"reference_s": round(t, 3), "offset_s": round((lag-offset)/fs, 5),
                           "correlation": round(score, 3)})
    return points


def _frames(seg, fs, f1, f2, dur):
    """Matched-demodulate the harmonic orders and the between-harmonic floor."""
    k_log = math.log(f2 / f1)
    n = len(seg)
    frame = min(FRAME, n)
    starts = np.arange(0, max(1, n - frame + 1), HOP)
    idx = starts[:, None] + np.arange(frame)[None, :]
    idx = np.clip(idx, 0, n - 1)
    t = idx / fs
    win = np.hanning(frame)[None, :]
    wsum = win.sum()
    xw = seg[idx] * win
    phase = 2.0 * math.pi * f1 * dur / k_log * (np.exp(t * k_log / dur) - 1.0)
    t_center = (starts + frame / 2.0) / fs
    f_frame = f1 * np.exp(np.clip(t_center, 0.0, dur) * k_log / dur)
    amps = {}
    for k in ORDERS:
        z = np.sum(xw * np.exp(-1j * k * phase), axis=1) / wsum
        amps[k] = 2.0 * np.abs(z)
    off = {}
    for k in OFF_ORDERS:
        z = np.sum(xw * np.exp(-1j * k * phase), axis=1) / wsum
        off[k] = 2.0 * np.abs(z)
    return {
        "starts": starts,
        "frame": frame,
        "f": f_frame,
        "orders": amps,
        "off": off,
        "amp": amps[1],
    }


def sweep_band_metrics(fr, fs):
    """Per band summary of one sweep segment.

    hi_ratio_db is the total energy of orders 10 and above relative to the
    fundamental; hi_per_order_db divides that by the number of orders so it can
    be compared with the between-harmonic floor, which is measured per order.
    A harmonic series sits well above that floor; a rub or buzz does not.
    """
    out = {}
    n_frames = len(fr["starts"])
    for (blo, bhi), name in zip(BANDS, BAND_NAMES):
        use = (fr["f"] >= blo) & (fr["f"] < bhi)
        use &= fr["amp"] > 1e-9
        off_orders = [k for k in OFF_ORDERS if k * blo < 0.45 * fs]
        if off_orders:
            floor = np.mean([fr["off"][k] for k in off_orders], axis=0)
        else:
            floor = np.zeros(n_frames)
        use &= fr["amp"] > floor * 10.0 ** (SNR_MIN_DB / 20.0)
        count = int(use.sum())
        entry = {
            "band_hz": [blo, bhi],
            "frames": count,
            "frames_total": int(n_frames),
            "valid": False,
            "reason": "",
        }
        if count < 5:
            entry["reason"] = "no usable frames: low snr or short band"
            out[name] = entry
            continue
        a1 = float(np.mean(fr["amp"][use]))
        floor_mean = float(np.mean(floor[use]))
        entry.update({
            "valid": True,
            "fund_dbfs": round(db(a1), 2),
            "snr_db": round(db(a1 / floor_mean), 2) if floor_mean > 0 else None,
            "floor_ratio_db": round(db(floor_mean / a1), 2) if floor_mean > 0 else None,
        })
        hi_orders = [k for k in ORDERS if k >= HI_ORDER_MIN and k * bhi < 0.45 * fs]
        if hi_orders:
            ho = np.zeros(count)
            for k in hi_orders:
                ho += fr["orders"][k][use] ** 2
            ho = np.sqrt(ho)
            hi_mean = float(np.mean(ho))
            rms = float(np.sqrt(np.mean(ho ** 2)))
            hi_db = db(hi_mean / a1)
            per_order_db = hi_db - 10.0 * math.log10(len(hi_orders))
            entry.update({
                "hi_orders": len(hi_orders),
                "hi_ratio_db": round(hi_db, 2),
                "hi_per_order_db": round(per_order_db, 2),
                "hi_crest": round(float(np.max(ho)) / rms, 2) if rms > 0 else 0.0,
                "hi_sem_db": round(db((hi_mean + float(np.std(ho) / math.sqrt(count)))
                                      / max(hi_mean, 1e-12)), 2),
                "coherent_db": (round(per_order_db - entry["floor_ratio_db"], 2)
                                if entry["floor_ratio_db"] is not None else None),
            })
        else:
            entry.update({"hi_orders": 0, "hi_ratio_db": None, "hi_per_order_db": None,
                          "hi_crest": None, "hi_sem_db": None, "coherent_db": None})
        for k in (2, 3, 4, 5):
            if k * bhi < 0.45 * fs:
                entry["h%d_db" % k] = round(db(float(np.mean(fr["orders"][k][use])) / a1), 2)
            else:
                entry["h%d_db" % k] = None
        out[name] = entry
    return out


def multitone_metrics(seg, fs, tones, band_lo=80.0, band_hi=20000.0, exclude_bins=10):
    n = len(seg)
    win = np.hanning(n)
    spec = np.fft.rfft(seg * win)
    amp = 4.0 * np.abs(spec) / n  # Hann: amplitude 2|X|/(N*0.5)
    freqs = np.fft.rfftfreq(n, 1.0 / fs)
    tone_bins = []
    tone_rms = 0.0
    for f in tones:
        b = int(round(f / fs * n))
        lo = max(1, b - 2)
        hi = min(len(amp) - 1, b + 3)
        j = lo + int(np.argmax(amp[lo:hi + 1]))
        tone_bins.append(j)
        tone_rms += (amp[j] ** 2) / 2.0
    tone_rms = math.sqrt(tone_rms)
    keep = np.ones(len(amp), dtype=bool)
    keep[0] = False
    keep &= (freqs >= band_lo) & (freqs <= band_hi)
    for b in tone_bins:
        keep[max(0, b - exclude_bins): b + exclude_bins + 1] = False
    resid = amp[keep]
    resid_rms = math.sqrt(float(np.sum(resid ** 2)) / 2.0)
    crest = db(float(np.max(np.abs(seg))) / max(math.sqrt(float(np.mean(seg ** 2))), 1e-12))
    return {
        "residual_db": round(db(resid_rms / max(tone_rms, 1e-12)), 2),
        "crest_db": round(crest, 2),
        "tone_rms_dbfs": round(db(tone_rms), 2),
    }


def twintone_metrics(seg, fs, tones=(60.0, 7000.0)):
    n = len(seg)
    freq_res = fs / n
    win = np.hanning(n)
    spec = np.fft.rfft(seg * win)
    amp = 4.0 * np.abs(spec) / n

    def at(f):
        b = int(round(f / freq_res))
        lo = max(1, b - 2)
        hi = min(len(amp) - 1, b + 3)
        return float(np.max(amp[lo:hi + 1]))

    lf, hf = tones
    a_lf, a_hf = at(lf), at(hf)
    spacing = lf
    sides = []
    for mult in (1, 2, 3):
        up = at(hf + mult * spacing)
        down = at(hf - mult * spacing)
        sides.append(0.5 * (up + down))
    harm = []
    for k in range(2, 9):
        harm.append(at(k * lf))
    return {
        "lf_dbfs": round(db(a_lf), 2),
        "hf_dbfs": round(db(a_hf), 2),
        "sidebands_db": [round(db(s / max(a_hf, 1e-12)), 2) for s in sides],
        "lf_harmonics_db": [round(db(h / max(a_lf, 1e-12)), 2) for h in harm],
    }


def _slope(points):
    """Least squares slope of y (dB) against x (dB); points are (x, y)."""
    xs = np.array([p[0] for p in points], dtype=float)
    ys = np.array([p[1] for p in points], dtype=float)
    if len(xs) < 2:
        return None
    xs = xs - xs.mean()
    denom = float(np.sum(xs * xs))
    if denom == 0.0:
        return None
    return float(np.sum(xs * (ys - ys.mean())) / denom)


def relative_diagnostics(report):
    """Describe differential evidence, never infer failure from a harmonic ratio.

    Apple virtual bass, crossfeed and compression are not flat-speaker defects.
    Even a significant asymmetry is a candidate, not proof of a faulty driver:
    speaker-to-mic paths differ and room interference does not cancel.
    """
    report["comparison"] = []
    for ch, data in report["channels"].items():
        data["calibration_verdict"] = data["verdict"]
        data["verdict"] = "INCONCLUSIVE"
        data["reasons"] = ["No flat-speaker fault thresholds applied; DSP and room path are unknown."]
        levels = sorted(data["sweep"], key=float)
        if len(levels) < 2:
            continue
        low = levels[0]
        for band in BAND_NAMES:
            ref = data["sweep"][low][band]
            if not ref.get("valid"):
                continue
            for lv in levels[1:]:
                top = data["sweep"][lv][band]
                if not top.get("valid"):
                    continue
                gain = top["fund_dbfs"] - ref["fund_dbfs"] - (float(lv)-float(low))
                item = {"kind": "level", "channel": ch, "band": band,
                        "reference_dbfs": float(low), "level_dbfs": float(lv),
                        "gain_change_db": round(gain, 2)}
                report["comparison"].append(item)
                if abs(gain) > 3:
                    data["reasons"].append("%s: gain changes %+.1f dB at %s vs %s dBFS (DSP or measurement, not a fault verdict)" %
                                           (band, gain, lv, low))
    left = report["channels"].get("L", {}).get("sweep", {})
    right = report["channels"].get("R", {}).get("sweep", {})
    common = sorted(set(left) & set(right), key=float)
    for lv in common:
        for band in BAND_NAMES:
            a, b = left[lv][band], right[lv][band]
            if not (a.get("valid") and b.get("valid")):
                continue
            item = {"kind": "left-right", "level_dbfs": float(lv), "band": band,
                    "fund_L_minus_R_db": round(a["fund_dbfs"]-b["fund_dbfs"], 2)}
            if a.get("hi_ratio_db") is not None and b.get("hi_ratio_db") is not None:
                item["hi_L_minus_R_db"] = round(a["hi_ratio_db"]-b["hi_ratio_db"], 2)
                # Require a change in asymmetry from the same run's quiet
                # reference, not just unequal acoustic paths or virtual bass.
                low = common[0]
                ar, br = left[low][band], right[low][band]
                if (lv != low and ar.get("valid") and br.get("valid")
                        and ar.get("hi_ratio_db") is not None and br.get("hi_ratio_db") is not None):
                    delta = item["hi_L_minus_R_db"] - (ar["hi_ratio_db"]-br["hi_ratio_db"])
                    item["asymmetry_growth_db"] = round(delta, 2)
                    # Noise-like excess, supported by both level and channel
                    # controls. Coherent synthetic harmonics alone cannot pass.
                    for ch, sign, v, r in (("L", 1, a, ar), ("R", -1, b, br)):
                        excess = (v["hi_ratio_db"] + v["fund_dbfs"]
                                  - r["hi_ratio_db"] - r["fund_dbfs"])
                        # At low level, the mic noise/fundamental ratio is
                        # artificially high. Compare absolute excess energy
                        # against that quiet reference, not its ratio growth.
                        if sign*delta > 10 and excess > 10:
                            data = report["channels"][ch]
                            data["verdict"] = "ASYMMETRIC RATTLE CANDIDATE"
                            data["reasons"].append("%s at %s dBFS: high-order asymmetry grows %.1f dB vs quiet reference; rattle or asymmetric DSP, not proof of damage" %
                                                   (band, lv, sign*delta))
            report["comparison"].append(item)
    report["limitations"] = [
        "INCONCLUSIVE is not a clean-speaker certificate. No sustained bass in the sweep mode.",
        "Left/right means separate input routing, not isolated acoustic drivers: crossfeed is expected.",
        "Mic gain is unknown; headroom does not establish calibration, AGC absence or room SNR.",
        "Harmonics below 300 Hz can be intentional virtual bass; a weak fundamental makes ratios unstable.",
        "Matched harmonic windows are descriptive, not Farina impulse-response separation or proof of rattle.",
    ]


def spectral_amplitudes(x, fs, frequencies):
    """Windowed sinusoidal projection, independent of a constant acoustic delay."""
    t = np.arange(len(x)) / fs
    w = np.hanning(len(x))
    return np.array([2*abs(np.dot(x*w, np.exp(-2j*np.pi*f*t)))/max(w.sum(), 1e-20)
                     for f in frequencies])


def bass_metrics(entries, segments, fs):
    result = {"tones": [], "voice": {}, "verdict": "INCONCLUSIVE"}
    voice = {}
    for e in entries:
        x = segments.get(e["file"])
        if x is None or e["kind"] not in ("bass-tone", "bass-voice", "voice", "bass-kick"):
            continue
        if e["kind"] == "bass-tone":
            f = e["tone_hz"]
            # 200 ms frames, integer cycles at every specified frequency.
            frames = [x[int(t*fs):int((t+.2)*fs)] for t in np.arange(.1, 1.71, .2)]
            amp = np.array([spectral_amplitudes(z, fs, [f])[0] for z in frames])
            ladder = spectral_amplitudes(x[int(.1*fs):int(1.9*fs)], fs, [f*k for k in range(1, 9)])
            floor = spectral_amplitudes(x[int(.1*fs):int(1.9*fs)], fs, [f*k+13 for k in range(1, 9)])
            snr = db(ladder[0]/max(float(np.median(floor)), 1e-20))
            result["tones"].append({"frequency_hz": f, "level_dbfs": e["level_db_peak"],
                "fund_dbfs": round(db(ladder[0]), 2), "snr_db": round(snr, 2),
                "harmonics_db": [round(db(v/max(ladder[0], 1e-20)), 2) for v in ladder[1:]],
                "frame_level_dbfs": [round(db(v), 2) for v in amp],
                "pumping_db": round(db(float(np.mean(amp[-3:]))/max(float(np.mean(amp[:3])), 1e-20)), 2),
                "valid": snr >= 15})
        elif e["kind"] in ("voice", "bass-voice"):
            freqs = e["tones_hz"]
            z = x[int(.1*fs):int(3.9*fs)]
            amps = spectral_amplitudes(z, fs, freqs)
            # Bass modulation appears at +/-100 Hz. Keep the tone grid apart
            # from those windows; a noise control uses offset +/-137 Hz.
            side = spectral_amplitudes(z, fs, [f+d for f in freqs for d in (-100, 100)])
            noise = spectral_amplitudes(z, fs, [f+d for f in freqs for d in (-137, 137)])
            voice[e["kind"]] = {"tone_rms_dbfs": round(db(np.linalg.norm(amps)/np.sqrt(2)), 2),
                "sideband_rms_dbfs": round(db(np.linalg.norm(side)/np.sqrt(2)), 2),
                "noise_rms_dbfs": round(db(np.linalg.norm(noise)/np.sqrt(2)), 2)}
        else:
            result["kick"] = {"peak_dbfs": round(db(np.max(np.abs(x))), 2),
                              "rms_dbfs": round(db(np.sqrt(np.mean(x*x))), 2)}
    for f in sorted({v["frequency_hz"] for v in result["tones"]}):
        group = sorted([v for v in result["tones"] if v["frequency_hz"] == f], key=lambda v: v["level_dbfs"])
        ref = group[0]
        for item in group:
            item["gain_change_db"] = round(item["fund_dbfs"]-ref["fund_dbfs"]-(item["level_dbfs"]-ref["level_dbfs"]), 2)
            item["reference_dbfs"] = ref["level_dbfs"]
            if item["valid"] and ref["valid"] and (item["gain_change_db"] < -3 or item["pumping_db"] < -3):
                result["verdict"] = "LOW-FREQUENCY LEVEL DEPENDENCE (limiter candidate, not proof of damage)"
    if "voice" in voice and "bass-voice" in voice:
        a, b = voice["voice"], voice["bass-voice"]
        result["voice"] = {"alone": a, "with_bass": b,
            "gain_change_db": round(b["tone_rms_dbfs"]-a["tone_rms_dbfs"], 2),
            "sideband_change_db": round(b["sideband_rms_dbfs"]-a["sideband_rms_dbfs"], 2),
            "sidebands_above_noise_db": round(b["sideband_rms_dbfs"]-b["noise_rms_dbfs"], 2)}
    return result


def analyse_segments(entries, segments, fs, meta=None, calibrated=False):
    """Analyse in-memory segments; the CLI and the selftest share this path.

    entries  ordered list of {file,kind,channel,level_db_peak,...}
    segments dict file -> recorded mono float array
    """
    report = {
        "fs": fs,
        "measurement_version": 2,
        "signals": [
            {k: v for k, v in e.items() if k in ("file", "kind", "channel", "level_db_peak")}
            for e in entries
        ],
        "levels_db": {},
        "channels": {},
        "multitone": {},
        "twintone": {},
        "mic": {},
    }
    if meta:
        report.update(meta)

    peaks = [float(np.max(np.abs(s))) for s in segments.values() if len(s)]
    rec_peak = max(peaks) if peaks else 0.0
    report["mic"]["peak_dbfs"] = round(db(rec_peak), 2)
    report["mic"]["clipped"] = bool(rec_peak >= MIC_CLIP_LEVEL)

    sweeps = {}
    sweep_specs = {}
    multitone = {}
    twintone = {}
    for entry in entries:
        seg = segments.get(entry["file"])
        if seg is None or not len(seg):
            continue
        kind = entry["kind"]
        if kind == "sweep":
            f1 = entry.get("sweep_f1_hz", 100.0)
            f2 = entry.get("sweep_f2_hz", 12000.0)
            dur = entry["duration_s"]
            fr = _frames(seg, fs, f1, f2, dur)
            sweeps[(entry["channel"], entry["level_db_peak"])] = sweep_band_metrics(fr, fs)
            sweep_specs[(entry["channel"], entry["level_db_peak"])] = (f1, f2, dur)
        elif kind == "multitone":
            multitone[entry["level_db_peak"]] = multitone_metrics(
                seg, fs, entry.get("tones_hz") or [])
        elif kind == "twintone":
            twintone[entry["channel"]] = twintone_metrics(
                seg, fs, tuple(entry.get("tones_hz") or (60.0, 7000.0)))

    report["levels_db"]["sweep"] = sorted({lv for (_ch, lv) in sweeps})
    report["levels_db"]["multitone"] = sorted(multitone)

    for ch in sorted({e["channel"] for e in entries if e["kind"] != "multitone"}):
        levels = sorted(lv for (c, lv) in sweeps if c == ch)
        chdata = {"sweep": {}, "verdict": None, "reasons": [], "refused_bands": []}
        for lv in levels:
            chdata["sweep"][str(lv)] = sweeps[(ch, lv)]
        # level linearity and distortion growth per band
        slope = {}
        hi_growth = {}
        for name in BAND_NAMES:
            pts = []
            hip = []
            for lv in levels:
                band = sweeps[(ch, lv)][name]
                if band.get("valid"):
                    pts.append((lv, band["fund_dbfs"]))
                    if band.get("hi_ratio_db") is not None:
                        hip.append((lv, band["hi_ratio_db"]))
            slope[name] = round(_slope(pts), 2) if _slope(pts) is not None else None
            hi_growth[name] = round(_slope(hip), 2) if _slope(hip) is not None else None
        chdata["fund_slope_db_per_db"] = slope
        chdata["hi_growth_db_per_db"] = hi_growth
        refused = [n for n in BAND_NAMES
                   if sum(1 for lv in levels if sweeps[(ch, lv)][n].get("valid")) < 2]
        chdata["refused_bands"] = refused
        report["channels"][ch] = chdata

    report["multitone"] = {str(k): v for k, v in multitone.items()}
    report["twintone"] = twintone
    _assign_verdicts(report)
    if not calibrated:
        relative_diagnostics(report)
    report["bass"] = bass_metrics(entries, segments, fs)
    return report


def _hi_at(chdata, level, band):
    entry = chdata["sweep"].get(str(level), {}).get(band)
    if not entry or not entry.get("valid") or entry.get("hi_ratio_db") is None:
        return None
    return entry


def _classify(chdata, other):
    """Pick a fault class for one channel from its own measurements."""
    reasons = []
    if chdata.get("mic_clipped") or chdata["mic"]["clipped"]:
        reasons.append("recording clipped at the mic, no verdict")
        return "INCONCLUSIVE", reasons
    levels = sorted(float(k) for k in chdata["sweep"])
    if not levels:
        return "INCONCLUSIVE", ["no sweep recording for this channel"]
    if len(chdata["refused_bands"]) >= 3:
        return "INCONCLUSIVE", ["bands refused for low snr: %s"
                                % ", ".join(chdata["refused_bands"])]
    top = max(levels)
    mid = levels[len(levels) // 2]

    # (a) rub and buzz: high-order energy that is not a harmonic series
    broadband_bands = []
    for band in BAND_NAMES:
        e_top = _hi_at(chdata, top, band)
        if not e_top:
            continue
        coherent = e_top["coherent_db"]
        if coherent is None or e_top["hi_ratio_db"] < RATTLE_HI_DB:
            continue
        if coherent >= HI_COHERENT_DB:
            continue
        if e_top["hi_crest"] >= RATTLE_CREST:
            reasons.append(
                "%s: high-order energy %.1f dB at %.0f dBFS sits only %.1f dB per "
                "order above the between-harmonic floor, crest %.1f"
                % (band, e_top["hi_ratio_db"], top, coherent, e_top["hi_crest"]))
            return "RATTLE OR BUZZ", reasons
        broadband_bands.append(band)

    # (b) hard clipping: a steep jump in high-order energy next to a flat level
    for band in BAND_NAMES:
        e_top = _hi_at(chdata, top, band)
        e_mid = _hi_at(chdata, mid, band)
        slope = chdata["fund_slope_db_per_db"].get(band)
        if not e_top:
            continue
        jump = e_top["hi_ratio_db"] - (e_mid["hi_ratio_db"] if e_mid else -999.0)
        coherent = e_top["coherent_db"]
        if coherent is None:
            continue
        if (e_top["hi_ratio_db"] >= CLIP_HI_DB and jump >= CLIP_JUMP_DB
                and coherent >= HI_COHERENT_DB
                and slope is not None and slope < CLIP_LINEARITY):
            reasons.append(
                "%s: high-order energy jumps %.1f dB from %.0f to %.0f dBFS, "
                "level slope %.2f dB per dB"
                % (band, jump, mid, top, slope))
            return "HARD CLIPPING", reasons

    # (d) compressor or limiter: level no longer tracks the input
    compressed = [(b, chdata["fund_slope_db_per_db"][b]) for b in BAND_NAMES
                  if chdata["fund_slope_db_per_db"].get(b) is not None
                  and chdata["fund_slope_db_per_db"][b] < CLIP_LINEARITY]
    if compressed:
        reasons.append("level slope below %.2f dB per dB in %s"
                       % (CLIP_LINEARITY,
                          ", ".join("%s (%.2f)" % (b, s) for b, s in compressed)))
        if chdata["refused_bands"]:
            reasons.append("refused bands: %s" % ", ".join(chdata["refused_bands"]))
        return "LIMITER OR COMPRESSOR", reasons

    # soft saturation without a hard edge: odd harmonic series that grows
    for band in BAND_NAMES:
        e_top = _hi_at(chdata, top, band)
        if not e_top:
            continue
        growth = chdata["hi_growth_db_per_db"].get(band)
        if (e_top["hi_ratio_db"] >= LIMIT_HI_DB
                and e_top["coherent_db"] is not None
                and e_top["coherent_db"] >= HI_COHERENT_DB
                and growth is not None and growth > 1.2):
            reasons.append("%s: harmonic series %.1f dB at %.0f dBFS growing %.2f dB per dB"
                           % (band, e_top["hi_ratio_db"], top, growth))
            return "LIMITER OR COMPRESSOR", reasons

    if broadband_bands:
        return "INCONCLUSIVE", ["%s: broadband energy between harmonics that is not "
                                "bursty, cannot separate room noise from distortion"
                                % ", ".join(broadband_bands)]

    # (c) one sided: this channel differs from the other without its own class
    if other and other.get("usable"):
        for band in BAND_NAMES:
            a = chdata["sweep"].get(str(mid), {}).get(band)
            b = other["chdata"]["sweep"].get(str(mid), {}).get(band)
            if not a or not b or not a.get("valid") or not b.get("valid"):
                continue
            delta = a["fund_dbfs"] - b["fund_dbfs"]
            if delta <= -ASYM_LEVEL_DB:
                reasons.append("%s: %.1f dB quieter than the other channel at %.0f dBFS"
                               % (band, delta, mid))
                return "ONE-SIDED", reasons
            if (a.get("hi_ratio_db") is not None and b.get("hi_ratio_db") is not None
                    and a["hi_ratio_db"] - b["hi_ratio_db"] >= ASYM_DIST_DB
                    and b["hi_ratio_db"] < HI_PRESENT_DB):
                reasons.append("%s: distortion %.1f dB above the other channel"
                               % (band, a["hi_ratio_db"] - b["hi_ratio_db"]))
                return "ONE-SIDED", reasons
    return "CLEAN", reasons


def _assign_verdicts(report):
    threads = {}
    channels = report["channels"]
    for ch, chdata in channels.items():
        chdata["mic"] = report["mic"]
        threads[ch] = {"chdata": chdata, "usable": True}
    for ch, chdata in channels.items():
        others = [threads[c] for c in threads if c != ch]
        verdict, reasons = _classify(chdata, others[0] if others else None)
        chdata["verdict"] = verdict
        chdata["reasons"] = reasons
    return report


def format_table(report):
    if "comparison" in report:
        lines = ["COMPARATIVE MEASUREMENTS (dB; no flat-speaker fault verdicts)",
                 "kind         ch/band             level/ref       difference"]
        for item in report["comparison"]:
            if item["kind"] == "level":
                lines.append("level        %-2s %-9s %5g/%5g     gain %+.2f" %
                             (item["channel"], item["band"], item["level_dbfs"], item["reference_dbfs"], item["gain_change_db"]))
            else:
                lines.append("left-right      %-9s %5g           fundamental %+.2f%s" %
                             (item["band"], item["level_dbfs"], item["fund_L_minus_R_db"],
                              " hi ratio %+.2f" % item["hi_L_minus_R_db"] if "hi_L_minus_R_db" in item else ""))
        if not report["comparison"]:
            lines.append("INCONCLUSIVE: no valid aligned sweep comparisons.")
        for ch, data in report["channels"].items():
            lines.append(ch + ": " + data["verdict"])
            lines.extend("  " + r for r in data["reasons"])
        for lv, m in sorted(report["multitone"].items(), key=lambda p: float(p[0])):
            lines.append("multitone %s dBFS: tone %.2f dBFS, residual %.2f dB (descriptive only)" %
                         (lv, m["tone_rms_dbfs"], m["residual_db"]))
        lines.append("mic peak %.2f dBFS; input gain UNKNOWN; clipped=%s" %
                     (report.get("capture_peak_dbfs", report["mic"]["peak_dbfs"]), report["mic"]["clipped"]))
        if "noise_bands_dbfs" in report:
            lines.append("quiet-window band RMS dBFS: " + str(report["noise_bands_dbfs"]))
        if report.get("alignment_quality"):
            lines.append("file                     expected_s measured_s corr    valid landmark_spread_ms")
            for name, q in report["alignment_quality"].items():
                lines.append("%-24s %9.5f %10.5f %.4f %-5s %s" %
                             (name, q["expected_s"], q["measured_s"], q["correlation"],
                              q["valid"], q.get("landmark_spread_ms", "n/a")))
        bass = report.get("bass", {})
        if bass.get("tones"):
            lines.append("bass Hz input ref fundamental SNR gain_change pumping harmonics H2..H8 (dB)")
            for v in bass["tones"]:
                lines.append("%(frequency_hz)3g %(level_dbfs)5g %(reference_dbfs)5g %(fund_dbfs)7.2f %(snr_db)6.1f %(gain_change_db)+7.2f %(pumping_db)+7.2f %(harmonics_db)s" % v)
            lines.append("bass: " + bass["verdict"])
            lines.append("voice with/without bass: " + str(bass["voice"]))
        lines.extend(report.get("limitations", []))
        return "\n".join(lines)
    lines = []
    chans = sorted(report["channels"])
    levels = sorted({lv for c in chans for lv in
                     (float(k) for k in report["channels"][c]["sweep"])})
    if levels:
        lo, mid, top = levels[0], levels[len(levels) // 2], levels[-1]
    else:
        lo = mid = top = 0.0
    head = ("ch  band      slope  H2@%g   H3@%g  H4@%g  H5@%g  hi@%g  crest coher"
            "  floor" % (mid, mid, mid, mid, top))
    lines.append(head)
    for ch in chans:
        for band in BAND_NAMES:
            e = report["channels"][ch]["sweep"].get(str(mid), {}).get(band, {})
            et = report["channels"][ch]["sweep"].get(str(top), {}).get(band, {})

            def f(v):
                return "  n/a" if v is None else "%5.1f" % v
            if not e.get("valid"):
                lines.append("%-3s %-8s %s" % (ch, band, "REFUSED: " + (e.get("reason") or "")))
                continue
            lines.append("%-3s %-8s %5.2f  %s %s %s %s %s %s %s %s" % (
                ch, band, report["channels"][ch]["fund_slope_db_per_db"].get(band) or 0.0,
                f(e.get("h2_db")), f(e.get("h3_db")), f(e.get("h4_db")), f(e.get("h5_db")),
                f(et.get("hi_ratio_db")), f(et.get("hi_crest")),
                f(et.get("coherent_db")), f(et.get("floor_ratio_db"))))
    if report["multitone"]:
        lines.append("")
        lines.append("multitone residual between tones (dB below the tones), crest")
        for lv in sorted(report["multitone"], key=float):
            m = report["multitone"][lv]
            lines.append("  %6s dBFS  residual %6.1f  crest %5.1f  tone level %6.1f"
                         % (lv, m["residual_db"], m["crest_db"], m["tone_rms_dbfs"]))
    if report["twintone"]:
        lines.append("")
        lines.append("twin 60 Hz + 7 kHz: sidebands around 7 kHz and 60 Hz harmonics")
        for ch in sorted(report["twintone"]):
            t = report["twintone"][ch]
            lines.append("  %-3s sidebands %s  60 Hz harmonics %s" % (
                ch, " ".join("%.1f" % v for v in t["sidebands_db"]),
                " ".join("%.1f" % v for v in t["lf_harmonics_db"])))
    lines.append("")
    lines.append("mic peak %.1f dBFS%s" % (
        report["mic"]["peak_dbfs"], ", CLIPPED" if report["mic"]["clipped"] else ""))
    lines.append("")
    for ch in chans:
        c = report["channels"][ch]
        lines.append("%s: %s" % (ch, c["verdict"]))
        for r in c["reasons"]:
            lines.append("    %s" % r)
        if c["refused_bands"]:
            lines.append("    refused bands: %s" % ", ".join(c["refused_bands"]))
    return "\n".join(lines)


def run(run_dir, out_path=None):
    with open(os.path.join(run_dir, "manifest.json")) as fh:
        manifest = json.load(fh)
    rec_path = os.path.join(run_dir, manifest["recording"]["file"])
    rec, fs = load_signal(rec_path)
    if fs != manifest.get("fs", FS):
        raise SystemExit("recording is %d Hz, manifest says %s Hz" % (fs, manifest.get("fs")))
    capture_peak = db(float(np.max(np.abs(rec))))
    blocks = rec[:len(rec)//(fs//5)*(fs//5)].reshape(-1, fs//5)
    quiet = blocks[np.argsort(np.mean(blocks*blocks, axis=1))[:max(1, len(blocks)//10)]]
    spec = np.mean(np.abs(np.fft.rfft(quiet, axis=1))**2, axis=0)
    freq = np.fft.rfftfreq(quiet.shape[1], 1/fs)
    noise = {name: round(db(np.sqrt(2*np.sum(spec[(freq>=lo)&(freq<hi)]))/quiet.shape[1]), 2)
             for name, (lo, hi) in zip(BAND_NAMES, BANDS)}
    padding = 5 * fs
    rec = np.pad(rec, (padding, 0))
    entries = manifest["files"]
    segments = {}
    alignment = {}
    residuals = {}
    gap_samples = int(round(float(manifest.get("gap_s", 1.0)) * fs))
    position = padding + int(float(manifest.get("pre_roll_s", 1.0)) * fs)
    search = int(2.0 * fs)
    alignment_quality = {}
    invalid = []
    for index, entry in enumerate(entries):
        ref, rfs = load_signal(entry["path"])
        if rfs != fs:
            raise SystemExit("%s is %d Hz, expected %d" % (entry["file"], rfs, fs))
        lo = 0 if index == 0 else max(0, position - search)
        hi = min(len(rec), position + len(ref) + search)
        lag = align_offset(rec, ref, fs, lo, hi)
        segments[entry["file"]] = rec[lag: lag + len(ref)]
        segment = segments[entry["file"]]
        corr = abs(float(np.dot(segment, ref))) / max(
            float(np.linalg.norm(segment) * np.linalg.norm(ref)), 1e-30)
        if db(float(np.sqrt(np.mean(segment * segment)))) < -85:
            raise ValueError("alignment: implausibly quiet file " + entry["file"])
        alignment_quality[entry["file"]] = {
            "expected_s": round((position - padding) / fs, 5), "measured_s": round((lag - padding) / fs, 5),
            "valid": lag >= padding,
            "correlation": round(corr, 5),
            "rms_dbfs": round(db(float(np.sqrt(np.mean(segment * segment)))), 2),
        }
        if entry["kind"] != "sweep" and corr < 0.2:
            invalid.append(entry["file"] + ": weak whole-file reference correlation %.3f" % corr)
            alignment_quality[entry["file"]]["valid"] = False
        if entry["kind"] == "sweep":
            landmarks = alignment_landmarks(rec, ref, fs, lag)
            alignment_quality[entry["file"]]["landmarks"] = [
                dict(p, offset_s=round(p["offset_s"]-padding/fs, 5)) for p in landmarks]
            spread = np.ptp([p["offset_s"] for p in landmarks]) if len(landmarks) >= 3 else None
            alignment_quality[entry["file"]]["landmark_spread_ms"] = None if spread is None else round(spread*1000, 2)
            if spread is None or spread > 0.02:
                invalid.append(entry["file"] + ": reference timing inconsistent within file (landmark spread %s ms)" %
                               alignment_quality[entry["file"]]["landmark_spread_ms"])
                alignment_quality[entry["file"]]["valid"] = False
        if not alignment_quality[entry["file"]]["valid"]:
            segments.pop(entry["file"], None)
        if lag < padding:
            invalid.append(entry["file"] + ": recording starts %.3fs after stimulus onset" % ((padding-lag)/fs))
            segments.pop(entry["file"], None)
        alignment[entry["file"]] = lag - padding
        residuals[entry["file"]] = round((lag - position) / fs, 4)
        position = lag + len(ref) + gap_samples
    meta = {
        "alignment_quality": alignment_quality,
        "invalid_measurements": invalid,
        "capture_peak_dbfs": round(capture_peak, 2),
        "noise_bands_dbfs": noise,
        "run_dir": os.path.abspath(run_dir),
        "label": manifest.get("label"),
        "slider": manifest.get("slider"),
        "created": manifest.get("created"),
        "alignment": alignment,
        "alignment_residual_s": residuals,
    }
    report = analyse_segments(entries, segments, fs, meta, calibrated=manifest.get("calibrated_fixture", False))
    report["mic"]["clipped"] = capture_peak >= db(MIC_CLIP_LEVEL)
    if report["mic"]["clipped"]:
        for data in report["channels"].values():
            data["verdict"] = "INCONCLUSIVE"
            data["reasons"] = ["Capture clipping invalidates speaker inference."]
    report["recording"] = manifest["recording"]["file"]
    if out_path is None:
        out_path = os.path.join(run_dir, "analysis.json")
    with open(out_path, "w") as fh:
        json.dump(report, fh, indent=1)
    return report, out_path


def main(argv=None):
    ap = argparse.ArgumentParser(description="analyse one speaker-kit run directory")
    ap.add_argument("run_dir")
    ap.add_argument("-o", "--out", default=None, help="analysis JSON (default <run>/analysis.json)")
    args = ap.parse_args(argv)
    report, path = run(args.run_dir, args.out)
    print(format_table(report))
    for problem in report.get("invalid_measurements", []):
        print("INVALID: " + problem)
    print("\nwrote %s" % path)
    return 2 if report.get("invalid_measurements") else 0


if __name__ == "__main__":
    sys.exit(main())
