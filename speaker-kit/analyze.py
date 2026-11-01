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
        hi = min(len(rec), lo + n)
    if hi - lo < n:
        lo = max(0, hi - n)
    window = rec[lo:hi]
    m = len(window) + n
    nfft = 1 << int(math.ceil(math.log2(m)))
    corr = np.fft.irfft(
        np.fft.rfft(window, nfft) * np.conj(np.fft.rfft(ref, nfft)), nfft
    )[: len(window)]
    return lo + int(np.argmax(corr))


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


def analyse_segments(entries, segments, fs, meta=None):
    """Analyse in-memory segments; the CLI and the selftest share this path.

    entries  ordered list of {file,kind,channel,level_db_peak,...}
    segments dict file -> recorded mono float array
    """
    report = {
        "fs": fs,
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
    entries = manifest["files"]
    segments = {}
    alignment = {}
    residuals = {}
    gap_samples = int(round(float(manifest.get("gap_s", 1.0)) * fs))
    position = find_onset(rec, fs)
    search = int(0.25 * fs)
    for entry in entries:
        ref, rfs = load_signal(entry["path"])
        if rfs != fs:
            raise SystemExit("%s is %d Hz, expected %d" % (entry["file"], rfs, fs))
        lo = max(0, position - search)
        hi = min(len(rec), position + len(ref) + search)
        lag = align_offset(rec, ref, fs, lo, hi)
        segments[entry["file"]] = rec[lag: lag + len(ref)]
        alignment[entry["file"]] = lag
        residuals[entry["file"]] = round((lag - position) / fs, 4)
        position = lag + len(ref) + gap_samples
    meta = {
        "run_dir": os.path.abspath(run_dir),
        "label": manifest.get("label"),
        "slider": manifest.get("slider"),
        "created": manifest.get("created"),
        "alignment": alignment,
        "alignment_residual_s": residuals,
    }
    report = analyse_segments(entries, segments, fs, meta)
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
    print("\nwrote %s" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
