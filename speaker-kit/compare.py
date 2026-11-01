#!/usr/bin/env python3
"""Describe differences between two slider runs with unchanged mic and room.

    .venv/bin/python compare.py RUN_A RUN_B [-o changes.json]

Only current measurement-version reports are reused. Invalid capture or
alignment makes the comparison INCONCLUSIVE. Reporting tolerances below are
not measured repeatability, statistical confidence or proof of speaker damage.
"""

import argparse
import json
import os
import sys

import analyze

LEVEL_NOISE_DB = 1.0
SLOPE_NOISE = 0.05
HI_NOISE_DB = 2.0
RESIDUAL_NOISE_DB = 2.0
SIDEBAND_NOISE_DB = 6.0


def load(run_dir):
    path = os.path.join(run_dir, "analysis.json")
    if os.path.exists(path):
        with open(path) as fh:
            report = json.load(fh)
        if report.get("measurement_version") == 2:
            return report
    report, _ = analyze.run(run_dir)
    return report


def _delta(a, b):
    if a is None or b is None:
        return None
    return round(b - a, 2)


def compare(a, b):
    if a.get("invalid_measurements") or b.get("invalid_measurements"):
        return [{"what": "INCONCLUSIVE: invalid alignment or capture; no slider inference permitted"}], []

    changes = []
    noise = []
    # These are descriptive tolerances, not a measured repeatability model.
    # Capture position, mic gain, chain and room must be unchanged by the owner.
    for ch in sorted(set(a["channels"]) | set(b["channels"])):
        ca = a["channels"].get(ch)
        cb = b["channels"].get(ch)
        if not ca or not cb:
            changes.append({"what": "%s channel" % ch, "change": "present in one run only"})
            continue
        if ca.get("verdict") != cb.get("verdict"):
            changes.append({"what": "%s verdict" % ch,
                            "from": ca.get("verdict"), "to": cb.get("verdict")})
        levels_a = sorted(ca["sweep"], key=float)
        levels_b = sorted(cb["sweep"], key=float)
        common_levels = [lv for lv in levels_a if lv in levels_b]
        for band in analyze.BAND_NAMES:
            d = _delta(ca["fund_slope_db_per_db"].get(band),
                       cb["fund_slope_db_per_db"].get(band))
            if d is None:
                continue
            rec = {"what": "%s %s level slope" % (ch, band), "delta": d,
                   "unit": "dB per dB"}
            (changes if abs(d) > SLOPE_NOISE else noise).append(rec)
            for lv in common_levels:
                ea = ca["sweep"][lv].get(band, {})
                eb = cb["sweep"][lv].get(band, {})
                if not (ea.get("valid") and eb.get("valid")):
                    continue
                d = _delta(ea.get("fund_dbfs"), eb.get("fund_dbfs"))
                if d is not None:
                    rec = {"what": "%s %s level at %s dBFS" % (ch, band, lv),
                           "delta": d, "unit": "dB"}
                    (changes if abs(d) > LEVEL_NOISE_DB else noise).append(rec)
            top = common_levels[-1] if common_levels else None
            if top:
                ea = ca["sweep"][top].get(band, {})
                eb = cb["sweep"][top].get(band, {})
                d = _delta(ea.get("hi_ratio_db"), eb.get("hi_ratio_db"))
                if d is not None:
                    sem = max(HI_NOISE_DB / 2.0,
                              (ea.get("hi_sem_db") or 0.0) * 2.0,
                              (eb.get("hi_sem_db") or 0.0) * 2.0)
                    rec = {"what": "%s %s above 10th harmonic at %s dBFS"
                                  % (ch, band, top), "delta": d, "unit": "dB",
                           "noise_db": round(sem, 2)}
                    (changes if abs(d) > max(HI_NOISE_DB, 2.0 * sem) else noise).append(rec)
                d = _delta(ea.get("hi_crest"), eb.get("hi_crest"))
                if d is not None and abs(d) > 0.5:
                    changes.append({"what": "%s %s high-order crest" % (ch, band),
                                    "delta": d, "unit": ""})
    for lv in sorted(set(a.get("multitone", {})) & set(b.get("multitone", {})),
                     key=float):
        d = _delta(a["multitone"][lv].get("residual_db"),
                   b["multitone"][lv].get("residual_db"))
        if d is not None:
            rec = {"what": "multitone residual at %s dBFS" % lv, "delta": d, "unit": "dB"}
            (changes if abs(d) > RESIDUAL_NOISE_DB else noise).append(rec)
    for ch in sorted(set(a.get("twintone", {})) & set(b.get("twintone", {}))):
        sa = a["twintone"][ch].get("sidebands_db") or []
        sb = b["twintone"][ch].get("sidebands_db") or []
        for i, (x, y) in enumerate(zip(sa, sb)):
            d = _delta(x, y)
            rec = {"what": "%s twin tone sideband %d" % (ch, i + 1), "delta": d,
                   "unit": "dB"}
            (changes if abs(d) > SIDEBAND_NOISE_DB else noise).append(rec)
    ta = {(v["frequency_hz"], v["level_dbfs"]): v for v in a.get("bass", {}).get("tones", [])}
    tb = {(v["frequency_hz"], v["level_dbfs"]): v for v in b.get("bass", {}).get("tones", [])}
    for key in sorted(set(ta) & set(tb)):
        x, y = ta[key], tb[key]
        if not (x["valid"] and y["valid"]):
            continue
        for metric in ("fund_dbfs", "gain_change_db", "pumping_db"):
            d = _delta(x[metric], y[metric])
            item = {"what": "bass %g Hz at %g dBFS %s" % (*key, metric), "delta": d, "unit": "dB"}
            (changes if abs(d) > LEVEL_NOISE_DB else noise).append(item)
        for order, (hx, hy) in enumerate(zip(x["harmonics_db"], y["harmonics_db"]), 2):
            d = _delta(hx, hy)
            item = {"what": "bass %g Hz at %g dBFS H%d" % (*key, order), "delta": d, "unit": "dB"}
            (changes if abs(d) > HI_NOISE_DB else noise).append(item)
    va, vb = a.get("bass", {}).get("voice", {}), b.get("bass", {}).get("voice", {})
    for key in ("gain_change_db", "sideband_change_db", "sidebands_above_noise_db"):
        d = _delta(va.get(key), vb.get(key))
        if d is not None:
            item = {"what": "bass plus voice " + key, "delta": d, "unit": "dB"}
            (changes if abs(d) > RESIDUAL_NOISE_DB else noise).append(item)
    return changes, noise


def format_changes(changes, noise):
    lines = []
    if not changes:
        lines.append("no change beyond descriptive reporting tolerances (not a noise estimate)")
    else:
        lines.append("differences beyond descriptive reporting tolerances:")
        for c in changes:
            if "from" in c:
                lines.append("  %-44s %s -> %s" % (c["what"], c["from"], c["to"]))
            elif c.get("delta") is not None:
                lines.append("  %-44s %+7.2f %s" % (c["what"], c["delta"], c["unit"]))
            else:
                lines.append("  %-44s %s" % (c["what"], c.get("change", "")))
    lines.append("")
    lines.append("%d measurement(s) inside reporting tolerances" % len(noise))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="compare two speaker-kit runs")
    ap.add_argument("run_a")
    ap.add_argument("run_b")
    ap.add_argument("-o", "--out", default=None, help="write the change list as JSON")
    args = ap.parse_args(argv)
    a = load(args.run_a)
    b = load(args.run_b)
    changes, noise = compare(a, b)
    print("A: %s  %s  slider %s  %s" % (args.run_a, a.get("label"),
                                        a.get("slider"), a.get("created")))
    print("B: %s  %s  slider %s  %s" % (args.run_b, b.get("label"),
                                        b.get("slider"), b.get("created")))
    print("")
    print("Assumes unchanged mic gain, position, room and DSP. Tolerances are NOT measured noise bounds.")
    print(format_changes(changes, noise))
    if args.out:
        with open(args.out, "w") as fh:
            json.dump({"a": args.run_a, "b": args.run_b, "changes": changes,
                       "within_noise": noise}, fh, indent=1)
        print("\nwrote %s" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
