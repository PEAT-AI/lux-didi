/** Pure level-frame folding and the orb's motion envelope: a small dependency-free boundary so the
 *  native level contract and the smoothing are testable under node strip-only mode and reusable by
 *  any renderer host. */

/** One side's analysis window from the native tap, linear RMS 0..1 per band, flux already 0..1. */
export interface BandSample { level?: number; low?: number; mid?: number; high?: number; flux?: number }
/** Either the legacy scalar (`{level, playback}`, the 20 Hz `levels` bridge path) or the native
 *  orb frame (`{v: 2, input, output}`, posted at 60 Hz with model output and owner input apart). */
export interface LevelSample {
  level?: number; low?: number; mid?: number; high?: number; flux?: number; playback?: number;
  v?: number; input?: BandSample; output?: BandSample;
}
/** level/low/mid/high are perceptual 0..1 (dB mapped, like Vicuna's analyser bytes); playback stays
 *  linear RMS so the 0.01 audible threshold keeps its native meaning; `rich` marks a band frame. */
export interface AudioFrame { level: number; low: number; mid: number; high: number; flux: number; playback: number; rich: boolean; timestamp: number }

/** dBFS window mapped to 0..1. Vicuna's analyser maps -100..-30 dB per FFT bin to 0..255; the native
 *  tap sends band RMS instead, whose speech range is about -50 (quiet consonant body) to -14 dBFS. */
export const PERCEPTUAL_FLOOR_DB = -50;
export const PERCEPTUAL_CEIL_DB = -16;
/** Linear RMS at or above this counts as audible playback (native `meterSpeechThreshold`). */
export const AUDIBLE_RMS = 0.01;

const unit = (value: number | undefined, fallback = 0) => Math.min(1, Math.max(0, Number.isFinite(value) ? value! : fallback));

export function perceptual(rms: number | undefined): number {
  const value = unit(rms);
  if (value <= 0) return 0;
  const db = 20 * Math.log10(value);
  return Math.min(1, Math.max(0, (db - PERCEPTUAL_FLOOR_DB) / (PERCEPTUAL_CEIL_DB - PERCEPTUAL_FLOOR_DB)));
}

function bands(side: BandSample | undefined) {
  return { level: perceptual(side?.level), low: perceptual(side?.low), mid: perceptual(side?.mid), high: perceptual(side?.high), flux: unit(side?.flux), rms: unit(side?.level) };
}

export function levelFrame(sample: LevelSample): AudioFrame {
  if (sample.v === 2 && (sample.output || sample.input)) {
    // The voice that is sounding drives the orb: model output while it plays, else the owner.
    const output = bands(sample.output), input = bands(sample.input);
    const voice = output.rms >= AUDIBLE_RMS || output.rms >= input.rms ? output : input;
    return { level: voice.level, low: voice.low, mid: voice.mid, high: voice.high, flux: voice.flux, playback: output.rms, rich: true, timestamp: performance.now() };
  }
  // Legacy scalar: one broadband RMS, so every band honestly falls back to it and flux is unknown.
  const level = perceptual(sample.level);
  return {
    level,
    low: sample.low === undefined ? level : perceptual(sample.low),
    mid: sample.mid === undefined ? level : perceptual(sample.mid),
    high: sample.high === undefined ? level : perceptual(sample.high),
    flux: unit(sample.flux),
    playback: unit(sample.playback),
    rich: false,
    timestamp: performance.now(),
  };
}

export const silentFrame = (): AudioFrame => ({level:0,low:0,mid:0,high:0,flux:0,playback:0,rich:false,timestamp:performance.now()});
/** The latest drive frame. While the native 60 Hz band frame is flowing, the legacy 20 Hz scalar
 *  from the `levels` bridge path is ignored, so the two never interleave. */
export class LatestFrame {
  private frame = silentFrame();
  private richAt = -Infinity;
  push(frame: AudioFrame) {
    if (frame.rich) this.richAt = frame.timestamp;
    else if (frame.timestamp - this.richAt < 300) return;
    this.frame = { ...frame };
  }
  clear() { this.frame = silentFrame(); this.richAt = -Infinity; }
  read(now: number): AudioFrame { return now - this.frame.timestamp > 500 ? silentFrame() : this.frame; }
}

/** The audible level of one batched native tap: the louder of capture and playback, so the orb answers
 *  whoever is speaking (V3 item 1). Undefined when the batch carries no usable number. */
export function levelPeak(input: readonly number[], output: readonly number[]): number | undefined {
  const values = [...input, ...output].filter(value => Number.isFinite(value));
  if (!values.length) return undefined;
  return Math.min(1, Math.max(0, Math.max(...values)));
}

/** The playback (output) band alone, so the PROCESSING override never animates the orb for the owner's
 *  own capture (F6). Undefined when the batch carries no usable output number. */
export function playbackPeak(output: readonly number[]): number | undefined {
  const values = output.filter(value => Number.isFinite(value));
  if (!values.length) return undefined;
  return Math.min(1, Math.max(0, Math.max(...values)));
}

export type OrbPosture = 'speaking' | 'listening' | 'thinking' | 'quiet' | 'idle';

/** Map a state plus the current levels to a renderer posture. SPEAKING is authoritative; PROCESSING
 *  becomes speaking only on audible playback, never the owner's capture (F6). */
export function posture(state: string, levels: Pick<AudioFrame, 'level' | 'playback'>): OrbPosture {
  if (state === 'SPEAKING' || (state === 'PROCESSING' && levels.playback > 0.01)) return 'speaking';
  if (state === 'LISTENING') return 'listening';
  if (state === 'CONNECTING' || state === 'PROCESSING') return 'thinking';
  if (state === 'ERROR' || state === 'DISCONNECTED' || state === 'INTERRUPTED') return 'quiet';
  return 'idle';
}

// ---------------------------------------------------------------------------------------------
// Motion envelope (#283). Everything the frame loop animates is a continuous function of time:
// asymmetric one-pole followers with dt-corrected coefficients, and phases that are integrated
// from eased speeds, so neither a level step nor a state change can snap the drawing.

/** dt-corrected one-pole coefficient, `1 - e^(-dt/tau)` (same law as orb-classic smoothingAlpha). */
export function follow(current: number, target: number, dt: number, attack: number, release = attack): number {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dt) / tau));
}

export const MOTION_TAU = {
  // Vowel body (low band): Vicuna's attack; a shorter release so the body visibly rests between
  // syllables at 4 to 6 per second instead of holding one flat bloom through a sentence.
  lowAttack: 0.038689247052, lowDecay: 0.09,
  // Broadband playback level for tentacles and glow (Vicuna's playback taus).
  levelAttack: 0.032626919816, levelDecay: 0.057934324946,
  fluxAttack: 0.010355582243, fluxDecay: 0.09,
  // Speaking macro: blooms into a syllable (~60 ms), releases over ~130 ms (Vicuna 80/250 held the
  // bloom flat across syllables once the low band carried real vowel energy).
  activityAttack: 0.06, activityDecay: 0.13,
  // Listening is softer: the orb leans towards the owner, it does not jump.
  listenAttack: 0.1, listenDecay: 0.32,
  // Phrase-level swell of the whole body: follows sentences, not syllables.
  swellAttack: 0.18, swellDecay: 0.7,
  // Glow, flare, breath depth and swirl speed ease between states instead of snapping.
  state: 0.45,
} as const;

/** Per-posture targets. Breath is a slow sine on the whole drawing (period seconds, depth as a
 *  fraction of scale); swirl is the drawing's slow rotation speed in rad/s; scale is the resting
 *  size, larger at rest so a calm orb still holds its space while speech grows it with flames. */
export const POSTURE_TARGETS = {
  idle: { activity: 0.55, glow: 0.14, flare: 0.08, breathDepth: 0.05, breathPeriod: 5.2, swirl: 0.03, scale: 1.18 },
  quiet: { activity: 0.5, glow: 0.1, flare: 0.05, breathDepth: 0.03, breathPeriod: 6, swirl: 0.02, scale: 1.14 },
  listening: { activity: 0.85, glow: 0.4, flare: 0.25, breathDepth: 0.03, breathPeriod: 4.2, swirl: 0.06, scale: 1.1 },
  thinking: { activity: 0.8, glow: 0.32, flare: 0.2, breathDepth: 0.03, breathPeriod: 3.4, swirl: 0.32, scale: 1.1 },
  speaking: { activity: 1.0, glow: 0.45, flare: 0.35, breathDepth: 0.012, breathPeriod: 4.2, swirl: 0.05, scale: 1.0 },
} as const;

/** SPEAKING macro target from the smoothed perceptual low band. Vicuna's `1 + 1.5 * low` sat on its
 *  ceiling for every vowel once the band was real, so the curve is gentler at the top (exponent 1.3)
 *  to keep a visible syllable ripple, and capped so a loud vowel keeps a round silhouette. */
export const SPEAKING_ACTIVITY_CAP = 2.15;
export function speakingTarget(low: number): number { return Math.min(SPEAKING_ACTIVITY_CAP, 1 + 1.25 * Math.max(0, low) ** 1.3); }
/** LISTENING target: the owner's voice adds at most 0.5 to a calm 0.85, softly. */
export function listeningTarget(low: number): number { return POSTURE_TARGETS.listening.activity + 0.5 * low; }

export interface MotionState {
  low: number; level: number; flux: number; swell: number; activity: number;
  glow: number; flare: number; breathDepth: number; breathPeriod: number; breathPhase: number;
  swirlSpeed: number; swirl: number; rest: number;
}
export interface MotionOutput { activity: number; low: number; level: number; flux: number; glow: number; flare: number; scale: number; swirl: number; swell: number; activityTarget: number }

export function initialMotion(kind: OrbPosture = 'idle'): MotionState {
  const t = POSTURE_TARGETS[kind];
  return { low: 0, level: 0, flux: 0, swell: 0, activity: t.activity, glow: t.glow, flare: t.flare,
    breathDepth: t.breathDepth, breathPeriod: t.breathPeriod, breathPhase: 0, swirlSpeed: t.swirl, swirl: 0, rest: t.scale };
}

/** Advance the envelope by dt seconds. `still` (reduced motion, first paint) snaps every follower
 *  to its target and freezes the phases, so a still frame shows the state's resting pose. */
export function stepMotion(m: MotionState, kind: OrbPosture, frame: Pick<AudioFrame, 'level' | 'low' | 'flux'>, dt: number, still = false): MotionOutput {
  const t = POSTURE_TARGETS[kind];
  const voiced = kind === 'speaking' || kind === 'listening';
  const low = voiced ? frame.low : 0, level = voiced ? frame.level : 0, flux = voiced ? frame.flux : 0;
  const snap = still;
  const f = (cur: number, target: number, a: number, r = a) => snap ? target : follow(cur, target, dt, a, r);
  m.low = f(m.low, low, MOTION_TAU.lowAttack, MOTION_TAU.lowDecay);
  m.level = f(m.level, level, MOTION_TAU.levelAttack, MOTION_TAU.levelDecay);
  m.flux = f(m.flux, flux, MOTION_TAU.fluxAttack, MOTION_TAU.fluxDecay);
  m.swell = f(m.swell, low, MOTION_TAU.swellAttack, MOTION_TAU.swellDecay);
  let activityTarget: number = t.activity;
  if (kind === 'speaking') activityTarget = speakingTarget(m.low);
  else if (kind === 'listening') activityTarget = listeningTarget(m.low);
  const [attack, decay] = kind === 'listening' ? [MOTION_TAU.listenAttack, MOTION_TAU.listenDecay] : [MOTION_TAU.activityAttack, MOTION_TAU.activityDecay];
  // Out of speech the macro settles slowly (state tau), so a state change never drops the body.
  m.activity = snap ? activityTarget : follow(m.activity, activityTarget, dt, kind === 'speaking' || kind === 'listening' ? attack : MOTION_TAU.state, kind === 'speaking' || kind === 'listening' ? decay : MOTION_TAU.state * 1.6);
  const glowTarget = kind === 'speaking' ? t.glow + 0.3 * m.level : kind === 'listening' ? t.glow + 0.12 * m.low : t.glow;
  const flareTarget = kind === 'speaking' ? t.flare + 0.3 * m.level : t.flare;
  m.glow = f(m.glow, glowTarget, MOTION_TAU.state * 0.4, MOTION_TAU.state);
  m.flare = f(m.flare, flareTarget, MOTION_TAU.state * 0.4, MOTION_TAU.state);
  m.breathDepth = f(m.breathDepth, t.breathDepth, MOTION_TAU.state * 2);
  m.breathPeriod = f(m.breathPeriod, t.breathPeriod, MOTION_TAU.state * 2);
  m.swirlSpeed = f(m.swirlSpeed, t.swirl, MOTION_TAU.state * 2);
  m.rest = f(m.rest, t.scale, MOTION_TAU.state * 1.5);
  if (!still) {
    // Phases integrate an eased rate, never `time * rate`, so a rate change cannot jump the pose.
    m.breathPhase = (m.breathPhase + dt * 2 * Math.PI / m.breathPeriod) % (2 * Math.PI);
    m.swirl = (m.swirl + dt * m.swirlSpeed) % (2 * Math.PI);
  }
  // Breath is a slightly asymmetric wave (quicker in, slower out), the shape of a resting breath.
  const wave = Math.sin(m.breathPhase) + 0.18 * Math.sin(2 * m.breathPhase - 0.6);
  const scale = m.rest * (1 + m.breathDepth * wave + 0.07 * m.swell);
  // Idle and listening also breathe through the macro, so the corona rises and falls with the body.
  const activity = m.activity + (voiced ? 0.04 : 0.09) * wave;
  return { activity, low: m.low, level: m.level, flux: m.flux, glow: m.glow, flare: m.flare, scale, swirl: m.swirl, swell: m.swell, activityTarget };
}

/** Frame budget (#283): 60 fps while the orb is doing something, 30 when idle in a focused window,
 *  12 when idle and the window is not focused. A hidden document draws nothing (the caller stops). */
export function frameInterval(kind: OrbPosture, state: string, focused: boolean): number {
  const active = kind === 'speaking' || kind === 'listening' || kind === 'thinking' || state === 'CONNECTING';
  if (active) return 0;
  return 1000 / (focused ? 30 : 12);
}
/** Gate a rAF tick against the interval with a quarter-frame tolerance, so a 30 fps budget on a
 *  60 Hz display lands on every second vsync instead of alternating 33 and 50 ms. */
export function shouldPaint(elapsedMs: number, intervalMs: number): boolean {
  return intervalMs <= 0 || elapsedMs >= intervalMs - 4.5;
}
