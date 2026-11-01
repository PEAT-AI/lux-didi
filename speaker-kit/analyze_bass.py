#!/usr/bin/env python3
"""Offline, numerical bass spectrogram analysis. Never plays or records audio.

Levels are captured dBFS, not calibrated SPL. Harmonics are not fault evidence.
A six dB same-band gap margin is a screening threshold, not a fault verdict.
"""
import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np
import soundfile as sf


MARGIN = 6.0


def db(power):
    return float(10 * np.log10(max(float(power), 1e-20)))


def spectrum(x, fs):
    n = min(len(x), int(fs * .25))
    if n < 64:
        raise ValueError("insufficient samples for spectrum")
    hop = n // 4
    frames = np.lib.stride_tricks.sliding_window_view(x, n)[::hop]
    window = np.blackman(n + 1)[:-1]
    p = abs(np.fft.rfft(frames * window, axis=1))**2 / (n * (window**2).sum())
    p[:, 1:-1] *= 2
    f = np.fft.rfftfreq(n, 1/fs)
    t = (np.arange(len(frames))*hop + n/2)/fs
    return f, t, p.T


def measure(x, gap, fs, hz):
    f, _, p = spectrum(x, fs)
    fg, _, pg = spectrum(gap, fs)
    noise = np.interp(f, fg, pg.mean(axis=1))
    mean = p.mean(axis=1)
    bands = [abs(f - hz * h) <= 16 for h in range(1, 11)]
    between = (f >= max(35, hz - 15)) & (f <= hz * 10 + 12)
    for band in bands:
        between &= ~band
    above = (f > hz * 10 + 16) & (f <= 12000)
    # Above H10 still contains intentional higher harmonics. Keep the raw band,
    # but rank only the portion outside every harmonic's Blackman main lobe.
    above_nonharmonic = above.copy()
    for h in range(11, int(min(12000, fs/2)/hz)+1):
        above_nonharmonic &= abs(f-h*hz) > 16
    def band(mask):
        level, floor = db(mean[mask].sum()), db(noise[mask].sum())
        return dict(dbfs=level, gap_dbfs=floor, over_gap_db=level-floor)
    ladder = [band(b) for b in bands]
    energy = p[(f >= 35) & (f <= 12000)].sum(axis=0)
    flutter = 10 * np.log10(max(np.percentile(energy, 90), 1e-20) /
                           max(np.percentile(energy, 10), 1e-20))
    inter, high, nonharm = band(between), band(above), band(above_nonharmonic)
    return dict(fundamental=ladder[0], harmonics=ladder[1:], between=inter,
                above_h10=high, above_h10_nonharmonic=nonharm, flutter_db=float(flutter),
                score_db=max(inter['over_gap_db'], nonharm['over_gap_db']))


def locate(y, fs, entries, pre, gap, timestamps=None):
    """Ordered energy/ladder candidates, no waveform correlation.

    Retain best alternatives and refuse ambiguous or weak segments. Adjacent
    silent intervals must be quieter than the candidate's ladder energy.
    """
    f, t, p = spectrum(y, fs)
    starts, rows, cursor = [], [], pre
    origin = None
    if timestamps and timestamps.get('recording_start_utc'):
        origin = dt.datetime.fromisoformat(timestamps['recording_start_utc'])
    for e in entries:
        dur = e['duration_s']
        stamped = origin is not None and e.get('playback_start_utc')
        expected = ((dt.datetime.fromisoformat(e['playback_start_utc'])-origin).total_seconds()
                    if stamped else cursor)
        hz = e.get('tone_hz', 100)
        mask = np.zeros(len(f), dtype=bool)
        for h in range(1, 11):
            mask |= abs(f-h*hz) <= 8
        if e['kind'] in ('voice', 'bass-voice'):
            mask = np.zeros(len(f), dtype=bool)
            for voice_hz in e['tones_hz']:
                mask |= abs(f-voice_hz) <= 12
        elif e['kind'] != 'bass-tone':
            mask = (f >= 40) & (f <= 4000)
        energy = p[mask].sum(axis=0)
        candidates = []
        for start in np.arange(max(0, expected-.6), expected+1.21, .025):
            inside = (t >= start+.18) & (t <= start+dur-.18)
            before = (t >= start-.55) & (t <= start-.15)
            after = (t >= start+dur+.15) & (t <= start+dur+.55)
            if not inside.any() or not before.any() or not after.any():
                continue
            floor = max(np.median(energy[before]), np.median(energy[after]), 1e-20)
            score = db(np.median(energy[inside])/floor)
            candidates.append((score, float(start)))
        candidates.sort(reverse=True)
        if not candidates:
            raise ValueError('no spectral candidates: '+e['file'])
        best, start = candidates[0]
        alternatives = [c for c in candidates if abs(c[1]-start) > .25]
        separation = best-alternatives[0][0] if alternatives else None
        resolved = best >= MARGIN and (separation is None or separation >= 1)
        rows.append(dict(file=e['file'], start_s=start, end_s=start+dur,
                         expected_s=expected,
                         stamped_end_s=((dt.datetime.fromisoformat(e['playback_end_utc'])-origin).total_seconds()
                                        if stamped and e.get('playback_end_utc') else None),
                         source='wall-clock' if stamped else 'ordered ladder',
                         contrast_db=best, separation_db=separation, resolved=resolved,
                         candidates=[dict(start_s=s, contrast_db=v) for v, s in candidates[:3]]))
        starts.append(start)
        cursor = start+dur+gap
    return starts, rows


def analyze(run):
    run = Path(run)
    m = json.loads((run/'manifest.json').read_text())
    entries = m['files']
    y, fs = sf.read(run/m['recording']['file'], always_2d=True)
    y = y.mean(axis=1)
    starts, alignment = locate(y, fs, entries, m['pre_roll_s'], m['gap_s'], m)
    tones, kicks, voices = [], [], {}
    for e, start, align in zip(entries, starts, alignment):
        end = start+e['duration_s']
        x = y[int((start+.15)*fs):int((end-.15)*fs)]
        # Closest preceding silent gap, avoiding the window edges.
        g = y[max(0, int((start-min(m['gap_s'], .9)+.12)*fs)):int((start-.3)*fs)]
        if len(g) < fs*.25:
            align['resolved'] = False
            continue
        if e['kind'] == 'bass-tone':
            row = measure(x, g, fs, e['tone_hz'])
            row.update(file=e['file'], hz=e['tone_hz'], level=e['level_db_peak'],
                       resolved=align['resolved'], channel=e.get('channel', 'both'))
            tones.append(row)
        elif e['kind'] == 'bass-kick':
            for i in range(16):
                hit = y[int((start+i*.25)*fs):int((start+(i+1)*.25)*fs)]
                f, t, p = spectrum(hit, fs)
                # 10 ms RMS envelope preserves the hit's attack and decay.
                blocks = hit[:len(hit)//480*480].reshape(-1, 480)
                kicks.append(dict(hit=i+1, rms_envelope_dbfs=[db(v) for v in (blocks**2).mean(axis=1)],
                                  broadband_dbfs=db(p[(f>=1000)&(f<=12000)].sum(axis=0).mean())))
        else:
            f, _, p = spectrum(x, fs)
            fg, _, pg = spectrum(g, fs)
            mean, noise = p.mean(axis=1), np.interp(f, fg, pg.mean(axis=1))
            def band(mask):
                return dict(dbfs=db(mean[mask].sum()), gap_dbfs=db(noise[mask].sum()))
            voices[e['kind']] = dict(voice_band=band((f>=300)&(f<=3000)),
                tones=[dict(hz=hz, carrier=band(abs(f-hz)<=8),
                            lower=band(abs(f-(hz-100))<=8), upper=band(abs(f-(hz+100))<=8))
                       for hz in e['tones_hz']])
    for row in tones:
        previous = next((r for r in tones if r['hz']==row['hz'] and
                         r['channel']==row['channel'] and
                         r['level']=={-6:-12, -3:-6}.get(row['level'])), None)
        row['growth_db'] = ({k:row[k]['dbfs']-previous[k]['dbfs']
                             for k in ('fundamental', 'between', 'above_h10', 'above_h10_nonharmonic')} if previous else None)
    channel_growth = []
    for left in tones:
        if left['channel'] != 'L' or left['growth_db'] is None:
            continue
        right = next((r for r in tones if r['channel']=='R' and r['hz']==left['hz'] and
                      r['level']==left['level'] and r['growth_db'] is not None), None)
        if right:
            channel_growth.append(dict(hz=left['hz'], level=left['level'],
                right_minus_left_growth_db={k:right['growth_db'][k]-left['growth_db'][k]
                                           for k in left['growth_db']}))
    voice_change = None
    if 'voice' in voices and 'bass-voice' in voices:
        a, b = voices['voice'], voices['bass-voice']
        voice_change = dict(band_change_db=b['voice_band']['dbfs']-a['voice_band']['dbfs'],
            tones=[dict(hz=x['hz'], **{key:y[key]['dbfs']-x[key]['dbfs']
                                      for key in ('carrier', 'lower', 'upper')})
                   for x, y in zip(a['tones'], b['tones'])])
    tones.sort(key=lambda r:r['score_db'], reverse=True)
    return dict(run=run.name, alignment=alignment, tones=tones, kicks=kicks, voice=voices,
                voice_change_db=voice_change, channel_growth=channel_growth,
                limitations='Gap subtraction cannot separate television from speaker noise. '
                'Harmonics may be intentional. Unresolved timing is provisional, not a fault verdict.')


def table(result):
    lines = ['| Hz | Channel | Input dBFS | Between / gap dBFS | Above H10 nonharmonic / gap dBFS | Excess dB | Flutter dB | Timing |',
             '| --- | --- | --- | --- | --- | --- | --- | --- |']
    for r in result['tones']:
        lines.append('| %g | %s | %g | %.1f / %.1f | %.1f / %.1f | %.1f | %.1f | %s |' % (
            r['hz'], r['channel'], r['level'], r['between']['dbfs'], r['between']['gap_dbfs'],
            r['above_h10_nonharmonic']['dbfs'], r['above_h10_nonharmonic']['gap_dbfs'], r['score_db'],
            r['flutter_db'], 'candidate' if not r['resolved'] else 'located'))
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('run', type=Path)
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()
    result = analyze(args.run)
    args.out.write_text(json.dumps(result, indent=2)+'\n')
    print(table(result))
    print(result['limitations'])


if __name__ == '__main__':
    main()
