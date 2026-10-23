// #283: the orb's level mapping, motion envelope and frame budget, run as pure functions on a
// synthetic speech-like sequence (no browser, no audio).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIBLE_RMS, LatestFrame, POSTURE_TARGETS, PERCEPTUAL_CEIL_DB, PERCEPTUAL_FLOOR_DB, SPEAKING_ACTIVITY_CAP,
  frameInterval, initialMotion, levelFrame, perceptual, shouldPaint, stepMotion, type OrbPosture,
} from '../src/orb-level.ts';

const db = (value: number) => 10 ** (value / 20);
const DT = 1 / 60;

/** 10 ms windows of a 5 syllables/s voice: 60 ms consonant (high band) then 140 ms vowel (low band). */
function voice(ms: number) {
  const inSyllable = ms % 200;
  if (inSyllable < 60) return { level: 0.05, low: 0.006, mid: 0.02, high: 0.06, flux: inSyllable < 10 ? 0.8 : 0, vowel: false };
  return { level: 0.1, low: 0.09, mid: 0.04, high: 0.008, flux: inSyllable < 70 ? 0.5 : 0, vowel: true };
}

function run(kind: OrbPosture, seconds: number, sample: (ms: number) => { level: number; low: number; mid: number; high: number; flux: number }, state = initialMotion(kind)) {
  const out = [];
  for (let i = 0; i < seconds * 60; i++) {
    const ms = i * 1000 * DT;
    const frame = levelFrame({ v: 2, output: kind === 'speaking' ? sample(ms) : undefined, input: kind === 'listening' ? sample(ms) : undefined });
    out.push({ ms, ...stepMotion(state, kind, frame, DT) });
  }
  return { out, state };
}

test('perceptual maps dBFS onto 0..1 between the floor and the ceiling', () => {
  assert.equal(perceptual(0), 0);
  assert.equal(perceptual(Number.NaN), 0);
  assert.equal(perceptual(db(PERCEPTUAL_FLOOR_DB - 6)), 0);
  assert.equal(perceptual(db(PERCEPTUAL_CEIL_DB + 3)), 1);
  assert.ok(Math.abs(perceptual(db((PERCEPTUAL_FLOOR_DB + PERCEPTUAL_CEIL_DB) / 2)) - 0.5) < 1e-9);
  let previous = -1;
  for (let rms = 0.001; rms < 1; rms *= 1.3) { const value = perceptual(rms); assert.ok(value >= previous); previous = value; }
});

test('a band frame follows the voice that is sounding and keeps playback linear', () => {
  const speaking = levelFrame({ v: 2, output: { level: 0.1, low: 0.09, mid: 0.04, high: 0.01, flux: 0.3 }, input: { level: 0.02, low: 0.01 } });
  assert.equal(speaking.rich, true);
  assert.equal(speaking.playback, 0.1, 'playback stays linear RMS for the 0.01 audible threshold');
  assert.ok(speaking.low > speaking.high, 'the vowel body is in the low band');
  assert.equal(speaking.flux, 0.3);
  const owner = levelFrame({ v: 2, output: { level: 0 }, input: { level: 0.05, low: 0.04, high: 0.002 } });
  assert.equal(owner.playback, 0);
  assert.equal(owner.low, perceptual(0.04), 'silent output hands the orb to the owner');
  const consonant = levelFrame({ v: 2, output: { level: 0.05, low: 0.004, mid: 0.02, high: 0.06, flux: 0.8 } });
  assert.ok(consonant.low < 0.25 && consonant.high > 0.6, 'a sibilant barely reaches the low band');
  assert.ok(AUDIBLE_RMS === 0.01);
});

test('the legacy scalar folds into a bounded frame with every band falling back to it', () => {
  const frame = levelFrame({ level: 2, low: -1, playback: 0.3 });
  assert.equal(frame.level, 1);
  assert.equal(frame.low, 0);
  assert.equal(frame.mid, 1, 'a missing band defaults to the scalar level');
  assert.equal(frame.flux, 0);
  assert.equal(frame.playback, 0.3);
  assert.equal(frame.rich, false);
  assert.equal(levelFrame({ level: Number.NaN }).level, 0, 'a non-finite level is clamped to silence');
});

test('while band frames flow, the legacy scalar never interleaves; stale frames read as silence', () => {
  const latest = new LatestFrame();
  latest.push({ level: 0.7, low: 0.7, mid: 0.2, high: 0.1, flux: 0, playback: 0.1, rich: true, timestamp: 1000 });
  latest.push({ level: 0.2, low: 0.2, mid: 0.2, high: 0.2, flux: 0, playback: 0.02, rich: false, timestamp: 1100 });
  assert.equal(latest.read(1150).low, 0.7);
  latest.push({ level: 0.2, low: 0.2, mid: 0.2, high: 0.2, flux: 0, playback: 0.02, rich: false, timestamp: 1400 });
  assert.equal(latest.read(1450).low, 0.2, 'the legacy path takes over once band frames stop');
  assert.equal(latest.read(2000).level, 0, 'a frame older than 500 ms is silence');
});

test('speaking: the body follows syllables smoothly and consonants do not bloom it', () => {
  const { out } = run('speaking', 6, voice);
  const steady = out.filter(p => p.ms > 1000);
  const vowelEnds = steady.filter(p => p.ms % 200 > 150 && p.ms % 200 < 200).map(p => p.activity);
  const consonantEnds = steady.filter(p => p.ms % 200 > 40 && p.ms % 200 < 60).map(p => p.activity);
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(mean(vowelEnds) - mean(consonantEnds) > 0.1, `macro syllable ripple ${mean(vowelEnds)} vs ${mean(consonantEnds)}`);
  const bodyAt = (from: number, to: number) => mean(steady.filter(p => p.ms % 200 > from && p.ms % 200 < to).map(p => p.low));
  assert.ok(bodyAt(150, 200) - bodyAt(40, 60) > 0.25, `the body (low band) swells on vowels and rests on consonants`);
  assert.ok(Math.max(...steady.map(p => p.activity)) <= SPEAKING_ACTIVITY_CAP + 0.05, 'a loud vowel stays under the cap');
  let maxStep = 0, maxCurve = 0;
  for (let i = 2; i < steady.length; i++) {
    maxStep = Math.max(maxStep, Math.abs(steady[i]!.activity - steady[i - 1]!.activity));
    maxCurve = Math.max(maxCurve, Math.abs(steady[i]!.activity - 2 * steady[i - 1]!.activity + steady[i - 2]!.activity));
  }
  assert.ok(maxStep < 0.08, `no per-frame jump (max ${maxStep})`);
  assert.ok(maxCurve < 0.05, `no consonant jitter (max curvature ${maxCurve})`);
  const sibilants = run('speaking', 2, () => ({ level: 0.05, low: 0.004, mid: 0.02, high: 0.07, flux: 0.6 })).out;
  assert.ok(sibilants.at(-1)!.activity < 1.3, `a run of sibilants keeps the body near rest (${sibilants.at(-1)!.activity})`);
  assert.ok(sibilants.at(-1)!.flux > 0.3, 'flux still reaches the sparkles');
});

test('listening leans towards the owner softly; speaking moves more', () => {
  const span = (kind: OrbPosture) => { const values = run(kind, 4, voice).out.filter(p => p.ms > 1000).map(p => p.activity); return [Math.min(...values), Math.max(...values)] as const; };
  const [lo, hi] = span('listening');
  const [slo, shi] = span('speaking');
  assert.ok(hi > POSTURE_TARGETS.listening.activity + 0.15, `the owner's voice is visible (${hi})`);
  assert.ok(hi - lo < shi - slo, 'listening reacts less than speaking');
  assert.ok(hi < slo + 0.4, 'listening never reaches a speaking bloom');
});

test('idle breathes slowly and organically, with no jumps', () => {
  const { out } = run('idle', 12, () => ({ level: 0, low: 0, mid: 0, high: 0, flux: 0 }));
  const scales = out.map(p => p.scale);
  const rest = POSTURE_TARGETS.idle.scale;
  const depth = (Math.max(...scales) - Math.min(...scales)) / 2 / rest;
  assert.ok(depth > 0.035 && depth < 0.07, `visible but gentle breath depth ${depth}`);
  let crossings = 0;
  for (let i = 1; i < scales.length; i++) if ((scales[i - 1]! - rest) < 0 !== (scales[i]! - rest) < 0) crossings++;
  const period = 12 / (crossings / 2);
  assert.ok(period > 4 && period < 6.5, `a slow breath period of ${period.toFixed(2)} s`);
  for (let i = 1; i < scales.length; i++) assert.ok(Math.abs(scales[i]! - scales[i - 1]!) < 0.004);
});

test('thinking swirls calmly and every state change eases glow, flare, scale and swirl', () => {
  const state = initialMotion('idle');
  const silent = { level: 0, low: 0, flux: 0 };
  for (let i = 0; i < 120; i++) stepMotion(state, 'idle', silent, DT);
  const trace: ReturnType<typeof stepMotion>[] = [];
  for (const kind of ['thinking', 'speaking', 'listening', 'idle'] as OrbPosture[]) {
    for (let i = 0; i < 90; i++) trace.push(stepMotion(state, kind, kind === 'speaking' ? { level: 0.7, low: 0.75, flux: 0 } : silent, DT));
  }
  for (let i = 1; i < trace.length; i++) {
    const [a, b] = [trace[i - 1]!, trace[i]!];
    assert.ok(Math.abs(b.glow - a.glow) < 0.03, `glow eases (step ${b.glow - a.glow} at ${i})`);
    assert.ok(Math.abs(b.flare - a.flare) < 0.03, `flare eases (step ${b.flare - a.flare} at ${i})`);
    assert.ok(Math.abs(b.scale - a.scale) < 0.01, `scale eases (step ${b.scale - a.scale} at ${i})`);
    const turn = ((b.swirl - a.swirl) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    assert.ok(Math.abs(turn) < 0.01, `swirl is continuous (step ${turn} at ${i})`);
  }
  const thinkingTurn = trace[89]!.swirl - trace[60]!.swirl;
  assert.ok(thinkingTurn > 0.05 && thinkingTurn < 0.25, `thinking turns calmly (${thinkingTurn} rad in 0.5 s)`);
});

test('still frames snap to the resting pose and freeze the phases', () => {
  const state = initialMotion('idle');
  const first = stepMotion(state, 'speaking', { level: 0.5, low: 0.5, flux: 0 }, DT, true);
  const again = stepMotion(state, 'speaking', { level: 0.5, low: 0.5, flux: 0 }, DT, true);
  assert.ok(Math.abs(first.activity - first.activityTarget - 0.04 * 0.18 * Math.sin(-0.6)) < 1e-12, 'the macro sits on its target');
  assert.equal(first.swirl, again.swirl);
  assert.equal(first.scale, again.scale);
});

test('frame budget: 60 fps active, 30 idle focused, 12 idle unfocused, steady cadence on a 60 Hz display', () => {
  for (const kind of ['speaking', 'listening', 'thinking'] as OrbPosture[]) assert.equal(frameInterval(kind, 'LISTENING', false), 0);
  assert.equal(frameInterval('idle', 'CONNECTING', true), 0);
  assert.equal(frameInterval('idle', 'CONNECTED', true), 1000 / 30);
  assert.equal(frameInterval('idle', 'CONNECTED', false), 1000 / 12);
  assert.equal(frameInterval('quiet', 'ERROR', false), 1000 / 12);
  const cadence = (interval: number) => {
    let last = 0, paints = 0; const gaps = new Set<number>();
    for (let frame = 1; frame <= 600; frame++) { const t = frame * 1000 / 60; if (shouldPaint(t - last, interval)) { gaps.add(Math.round(t - last)); last = t; paints++; } }
    return { fps: paints / 10, gaps };
  };
  assert.deepEqual(cadence(0), { fps: 60, gaps: new Set([17]) });
  const thirty = cadence(1000 / 30);
  assert.equal(thirty.fps, 30);
  assert.deepEqual([...thirty.gaps], [33], 'every second vsync, never alternating 33 and 50 ms');
  assert.equal(cadence(1000 / 12).fps, 12);
});

// ANIM-R1: both surfaces use this same pure, fake-clock coordinator.
import { MotionCoordinator } from '../src/orb-motion.ts';
const voiceSample = (output: number, input = 0) => ({ v: 2, output: { level: output, low: output }, input: { level: input, low: input } });

test('coordinator keeps output through a quiet tail and rejects speaker bleed', () => {
  const motion = new MotionCoordinator();
  motion.sample(voiceSample(0.1), 0);
  assert.equal(motion.sample(voiceSample(0.002, 0.8), 100).source, 'output');
  assert.equal(motion.sample(voiceSample(0.1, 0.8), 150).source, 'output');
  motion.interrupt();
  assert.equal(motion.sample(voiceSample(0.1, 0.8), 151).source, 'input');
});

test('coordinator requires 30 ms onset, holds exit, and never speaks from semantics alone', () => {
  const m = new MotionCoordinator();
  const step = (at: number, rms: number, state = 'PROCESSING') => {
    m.sample(voiceSample(rms), at);
    return m.advance(state, at);
  };
  assert.notEqual(step(0, 0.012).posture, 'speaking');
  assert.notEqual(step(20, 0.012).posture, 'speaking');
  assert.notEqual(step(21, 0).posture, 'speaking');
  step(40, 0.012);
  assert.equal(step(70, 0.012).posture, 'speaking');
  assert.equal(step(80, 0).posture, 'speaking');
  assert.equal(step(230, 0).posture, 'speaking');
  assert.notEqual(step(260, 0).posture, 'speaking');
  assert.notEqual(step(300, 0, 'SPEAKING').posture, 'speaking');
  assert.notEqual(step(340, 0.2, 'DISCONNECTED').posture, 'speaking');
});

test('coordinator is identical for window and mini and retargets continuous weights', () => {
  const windowMotion = new MotionCoordinator(), miniMotion = new MotionCoordinator();
  let previous = windowMotion.advance('PROCESSING', 0).weights;
  for (let at = 0; at <= 700; at += 10) {
    const state = at < 100 ? 'PROCESSING' : at < 220 ? 'SPEAKING' : 'PROCESSING';
    const sample = voiceSample(at >= 100 && at < 220 ? 0.1 : 0);
    windowMotion.sample(sample, at); miniMotion.sample(sample, at);
    const a = windowMotion.advance(state, at), b = miniMotion.advance(state, at);
    assert.deepEqual(a, b);
    for (const key of Object.keys(a.weights) as OrbPosture[]) assert.ok(Math.abs(a.weights[key] - previous[key]) <= 0.07);
    previous = a.weights;
  }
  assert.equal(previous.thinking, 1);
});

test('breath keeps phase across twenty state changes and modulation is bounded for ten minutes', () => {
  const m = new MotionCoordinator();
  let phase = 0, maxPeriod = 0, minPeriod = 2, maxDepth = 0, minDepth = 2;
  for (let at = 0; at <= 600000; at += 20) {
    m.sample(voiceSample(0), at);
    const state = Math.floor(at / 30000) % 2 ? 'LISTENING' : 'PROCESSING';
    const result = m.advance(state, at);
    if (at) {
      const delta = (result.breathPhase - phase + 2 * Math.PI) % (2 * Math.PI);
      assert.ok(delta > 0 && delta < 0.05, `continuous phase at ${at}: ${delta}`);
    }
    phase = result.breathPhase;
    minPeriod = Math.min(minPeriod, result.periodModulation); maxPeriod = Math.max(maxPeriod, result.periodModulation);
    minDepth = Math.min(minDepth, result.depthModulation); maxDepth = Math.max(maxDepth, result.depthModulation);
    assert.notEqual(result.posture, 'speaking');
  }
  assert.ok(minPeriod >= 0.94 && maxPeriod <= 1.06 && minPeriod < 0.941 && maxPeriod > 1.059);
  assert.ok(minDepth >= 0.92 && maxDepth <= 1.08 && minDepth < 0.921 && maxDepth > 1.079);
});

test('source bands blend for 80 ms and playback survives semantic tool thinking', () => {
  const m = new MotionCoordinator();
  assert.equal(m.sample(voiceSample(0.1), 0).low, 0);
  const half = m.sample(voiceSample(0.1), 40).low;
  const full = m.sample(voiceSample(0.1), 80).low;
  assert.ok(Math.abs(half - full / 2) < 1e-9);
  m.advance('PROCESSING', 80);
  assert.equal(m.advance('PROCESSING', 110).posture, 'speaking');
  assert.notEqual(m.advance('PROCESSING', 111, false, true).posture, 'speaking');
  assert.notEqual(m.advance('DISCONNECTED', 112).posture, 'speaking');
});

import { outputInterrupted } from '../src/orb-motion.ts';
test('only new authoritative host interruption or owner transcription clears ownership', () => {
  const before = { since: 'session', entries: [{ seq: 1, kind: 'interrupted' }] };
  assert.equal(outputInterrupted(undefined, before), false);
  assert.equal(outputInterrupted(before, before), false);
  assert.equal(outputInterrupted(before, { ...before, entries: [...before.entries, { seq: 2, kind: 'interrupted' }] }), true);
  assert.equal(outputInterrupted(before, { ...before, entries: [{ seq: 2, kind: 'inputTranscription', text: 'fixture owner speech' }] }), true);
  assert.equal(outputInterrupted(before, { ...before, entries: [{ seq: 2, kind: 'outputTranscription', text: 'fixture model speech' }] }), false);
  assert.equal(outputInterrupted(before, { ...before, entries: [{ seq: 2, kind: 'inputTranscription', text: ' ' }] }), false);
});

test('audible onset bypasses a stale debounced status without changing its swirl', () => {
  const m = new MotionCoordinator();
  m.sample(voiceSample(0.1), 0);
  m.advance('CONNECTING', 0, false, false, 'PROCESSING');
  m.sample(voiceSample(0.1), 30);
  const output = m.advance('CONNECTING', 30, false, false, 'PROCESSING');
  assert.equal(output.posture, 'speaking');
  assert.ok(Math.abs(output.swirl - 0.03 * POSTURE_TARGETS.thinking.swirl) < 1e-9);
  assert.notEqual(m.advance('DISCONNECTED', 31, false, false, 'SPEAKING').posture, 'speaking');
});

test('native band ownership is not overwritten by the slower legacy scalar bridge', () => {
  const m = new MotionCoordinator();
  m.sample(voiceSample(0.1), 0);
  const rich = m.sample(voiceSample(0.1), 80);
  const ignored = m.sample({ level: 0.8, playback: 0 }, 100);
  assert.equal(ignored.timestamp, rich.timestamp);
  assert.equal(ignored.playback, rich.playback);
  assert.equal(ignored.low, rich.low);
  assert.equal(m.sample({ level: 0.1, playback: 0 }, 400).rich, false);
});
