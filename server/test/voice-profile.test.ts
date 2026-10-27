import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceProfileMeter } from '../live/voice-profile.js';
import { safeEvent } from '../host/log.js';

// C-PITCH: the voice meter that turns "Naya sounded male again" into a number. Every signal here is synthetic,
// so the estimate is checked against a pitch the test itself chose.

const RATE = 24000;

/** Signed 16-bit little-endian PCM, the shape the adapter already hands playback. */
function pcm16(samples: Float64Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(index * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

function sine(hz: number, ms: number, amplitude = 0.4, harmonics: readonly number[] = []): Uint8Array {
  const samples = new Float64Array(Math.round((RATE * ms) / 1000));
  const weights = [1, ...harmonics];
  for (let index = 0; index < samples.length; index += 1) {
    let value = 0;
    weights.forEach((weight, harmonic) => { value += weight * Math.sin((2 * Math.PI * hz * (harmonic + 1) * index) / RATE); });
    samples[index] = (amplitude * value) / weights.reduce((total, weight) => total + weight, 0);
  }
  return pcm16(samples);
}

/** Deterministic white noise: no period, so no voiced frame. */
function noise(ms: number, amplitude = 0.2): Uint8Array {
  const samples = new Float64Array(Math.round((RATE * ms) / 1000));
  let seed = 0x2545f491;
  for (let index = 0; index < samples.length; index += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    samples[index] = ((seed / 0xffffffff) * 2 - 1) * amplitude;
  }
  return pcm16(samples);
}

/** Feed one response in 20 ms chunks, as the provider streams it. */
function play(meter: VoiceProfileMeter, pcm: Uint8Array): void {
  const chunk = RATE * 2 * 0.02;
  for (let offset = 0; offset < pcm.length; offset += chunk) meter.push(pcm.subarray(offset, Math.min(pcm.length, offset + chunk)), RATE);
}

const near = (actual: number | null, expected: number, tolerance = 0.03): void => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) / expected <= tolerance, `expected about ${expected} Hz, measured ${actual}`);
};

test('a 220 Hz sine reads 220 Hz and one response reports a measured profile', () => {
  const meter = new VoiceProfileMeter();
  play(meter, sine(220, 1000));
  const report = meter.finish();
  assert.ok(report);
  near(report.profile.f0Hz, 220);
  near(report.profile.f0P10Hz, 220, 0.05);
  near(report.profile.f0P90Hz, 220, 0.05);
  assert.equal(report.profile.audibleMs, 1000);
  assert.ok(report.profile.voicedRatio > 0.8, `voiced ratio ${report.profile.voicedRatio}`);
  assert.ok(report.profile.rmsDbfs < 0 && report.profile.rmsDbfs > -30, `level ${report.profile.rmsDbfs}`);
  assert.equal(report.shift, undefined, 'the session has no earlier response to compare with');
});

test('a 110 Hz sine reads 110 Hz', () => {
  const meter = new VoiceProfileMeter();
  play(meter, sine(110, 1000));
  near(meter.finish()?.profile.f0Hz ?? null, 110);
});

test('a harmonic-rich 110 Hz voice reads its fundamental, not a harmonic', () => {
  const meter = new VoiceProfileMeter();
  play(meter, sine(110, 1000, 0.5, [0.8, 0.6, 0.4]));
  near(meter.finish()?.profile.f0Hz ?? null, 110);
});

test('white noise has no voiced frames and no pitch', () => {
  const meter = new VoiceProfileMeter();
  play(meter, noise(1000));
  const report = meter.finish();
  assert.ok(report);
  assert.equal(report.profile.f0Hz, null);
  assert.equal(report.profile.f0P10Hz, null);
  assert.equal(report.profile.f0P90Hz, null);
  assert.equal(report.profile.voicedRatio, 0);
});

test('a response that plays nothing reports nothing', () => {
  assert.equal(new VoiceProfileMeter().finish(), undefined);
});

test('a two-response session reports the shift once, at the change', () => {
  const meter = new VoiceProfileMeter();
  play(meter, sine(220, 800));
  const first = meter.finish();
  assert.ok(first);
  assert.equal(first.shift, undefined);
  play(meter, sine(110, 800));
  const second = meter.finish();
  assert.ok(second);
  near(second.profile.f0Hz, 110);
  assert.ok(second.shift, 'a 2x drop is the voice change the owner heard');
  assert.equal(second.shift.ratio, 0.5);
  assert.equal(second.shift.sessionMedianHz, 220);
  // Exactly one shift across the two responses: the first has no baseline, the second is the change.
  assert.equal([first.shift, second.shift].filter(shift => shift !== undefined).length, 1);
});

test('the shift compares against the running median, not a fixed baseline', () => {
  const meter = new VoiceProfileMeter();
  const reports = [220, 110, 110].map((hz) => {
    play(meter, sine(hz, 800));
    const report = meter.finish();
    assert.ok(report);
    return report;
  });
  assert.equal(reports[0]!.shift, undefined);
  assert.equal(reports[1]!.shift?.ratio, 0.5);
  // The medians so far are [220, 110], whose median is 165, so the third identical response is 1.5x away from
  // the session and is reported: the contract asks for the running median, and this pins that it is genuinely
  // running rather than a first-response baseline.
  assert.equal(reports[2]!.shift?.ratio, 0.67);
});

test('a steady voice never shifts, and the ratio is configurable', () => {
  const steady = new VoiceProfileMeter();
  for (let response = 0; response < 3; response += 1) {
    play(steady, sine(190, 500));
    assert.equal(steady.finish()?.shift, undefined);
  }
  const wide = new VoiceProfileMeter({ shiftRatio: 3 });
  play(wide, sine(220, 500));
  wide.finish();
  play(wide, sine(110, 500));
  assert.equal(wide.finish()?.shift, undefined, 'a 2x jump is inside a 3x band');
});

test('the two pitch events cross the log boundary as closed shapes only', () => {
  const profile = safeEvent({ event: 'live_voice_profile', liveSessionId: 'call-1', generation: 2, responseId: 'resp-3',
    audibleMs: 1400, f0Hz: 118, f0P10Hz: 96, f0P90Hz: 141, voicedRatio: 0.62, rmsDbfs: -21.4 });
  assert.deepEqual(profile, { event: 'live_voice_profile', liveSessionId: 'call-1', generation: 2, responseId: 'resp-3',
    audibleMs: 1400, f0Hz: 118, f0P10Hz: 96, f0P90Hz: 141, voicedRatio: 0.62, rmsDbfs: -21.4 });
  // The guarantee is the rejection: one extra key, a free-text field or an out-of-band number drops the line.
  assert.equal(safeEvent({ event: 'live_voice_profile', liveSessionId: 'call-1', generation: 2, responseId: 'resp-3',
    audibleMs: 1400, f0Hz: 118, f0P10Hz: 96, f0P90Hz: 141, voicedRatio: 0.62, rmsDbfs: -21.4, transcript: 'hello' }), undefined);
  assert.equal(safeEvent({ event: 'live_voice_profile', liveSessionId: 'call-1', generation: 2, responseId: 'Naya said hi',
    audibleMs: 1400, f0Hz: 118, f0P10Hz: 96, f0P90Hz: 141, voicedRatio: 0.62, rmsDbfs: -21.4 }), undefined);
  assert.equal(safeEvent({ event: 'live_voice_profile', liveSessionId: 'call-1', generation: 2, responseId: 'resp-3',
    audibleMs: 1400, f0Hz: 0, f0P10Hz: 96, f0P90Hz: 141, voicedRatio: 0.62, rmsDbfs: -21.4 }), undefined);
  assert.equal(safeEvent({ event: 'live_voice_shift', liveSessionId: 'call-1', generation: 2, responseId: 'resp-3',
    ratio: 0.5, medianHz: 110, sessionMedianHz: 220, transcript: 'hello' }), undefined);
  const shift = safeEvent({ event: 'live_voice_shift', liveSessionId: 'call-1', generation: 2, responseId: 'resp-3',
    ratio: 0.5, medianHz: 110, sessionMedianHz: 220 });
  assert.deepEqual(shift, { event: 'live_voice_shift', liveSessionId: 'call-1', generation: 2, responseId: 'resp-3',
    ratio: 0.5, medianHz: 110, sessionMedianHz: 220 });
});
