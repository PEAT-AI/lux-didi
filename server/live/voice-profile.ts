// C-PITCH: measure the voice the owner hears, per response, so a voice change is a number and not a guess.
// The owner heard Naya switch between a female and a male-sounding voice inside one provider session on
// 2026-10-27 (07:02Z and 07:04Z). The host sends the custom voice id once in session.start, no recovery
// reached the provider and no other playback source exists, so the leading hypothesis is that the provider's
// prompt-designed voice drifts per response. Raw audio is never stored; this meter reads the output PCM the
// host already forwards to playback and keeps only numbers.
//
// The estimator is a plain normalized autocorrelation, run per 40 ms frame with a 20 ms hop over a lag range
// that covers 70 to 400 Hz. Every buffer is allocated once, when the first chunk names the rate, so the hot
// path mixes samples into a fixed frame array and allocates nothing; one frame costs O(frame x lags) on a
// buffer the playback queue already holds, which is far below real time, so audio is never delayed.

export interface VoiceProfile {
  /** Milliseconds of output audio this response played, from the PCM it forwarded. */
  audibleMs: number;
  /** Median fundamental frequency over the response's voiced frames, or null when nothing was voiced. */
  f0Hz: number | null;
  f0P10Hz: number | null;
  f0P90Hz: number | null;
  /** Voiced frames over analyzed frames, 0 to 1. */
  voicedRatio: number;
  /** RMS level of the forwarded PCM in dBFS. */
  rmsDbfs: number;
}

export interface VoiceShift {
  /** This response's median over the session's running median. */
  ratio: number;
  medianHz: number;
  sessionMedianHz: number;
}

export interface VoiceResponseReport { profile: VoiceProfile; shift: VoiceShift | undefined }

export interface VoiceProfileOptions { shiftRatio?: number; voicedCorrelation?: number }

/** The estimator's fixed frame and the gap that names a voice change: 1.35x is roughly the distance between
 *  a typical female and a typical male speaking pitch, so a response beyond it is a different voice. */
export const VOICE_PROFILE = {
  frameMs: 40, hopMs: 20, minHz: 70, maxHz: 400,
  voicedCorrelation: 0.4, voicedFloorDbfs: -50,
  shiftRatio: 1.35, peakFraction: 0.85,
  maxFrames: 8192, maxResponses: 256,
} as const;

const round1 = (value: number): number => Math.round(value * 10) / 10;

export class VoiceProfileMeter {
  readonly #shiftRatio: number;
  readonly #voicedCorrelation: number;
  #rate = 0;
  #frameLength = 0;
  #hopLength = 0;
  #minLag = 0;
  #maxLag = 0;
  #frame = new Float32Array(0);
  #tailEnergy = new Float64Array(0);
  #correlation = new Float64Array(0);
  readonly #voiced = new Float32Array(VOICE_PROFILE.maxFrames);
  readonly #sessionMedians = new Float64Array(VOICE_PROFILE.maxResponses);
  #fill = 0;
  #analyzed = 0;
  #voicedCount = 0;
  #samples = 0;
  #sumSquares = 0;
  #sessionCount = 0;

  constructor(options: VoiceProfileOptions = {}) {
    this.#shiftRatio = options.shiftRatio ?? VOICE_PROFILE.shiftRatio;
    this.#voicedCorrelation = options.voicedCorrelation ?? VOICE_PROFILE.voicedCorrelation;
  }

  /** Feed the output PCM the host forwards to playback: little-endian signed 16-bit mono samples. */
  push(pcm: Uint8Array, rate: number): void {
    if (this.#rate === 0) {
      if (!(rate > 0)) return;
      this.#init(rate);
    } else if (rate !== this.#rate) return;
    const samples = pcm.length >> 1;
    for (let index = 0; index < samples; index += 1) {
      const raw = ((pcm[2 * index]! | (pcm[2 * index + 1]! << 8)) << 16) >> 16;
      const value = raw / 32768;
      this.#samples += 1;
      this.#sumSquares += value * value;
      this.#frame[this.#fill] = value;
      this.#fill += 1;
      if (this.#fill === this.#frameLength) {
        this.#analyze();
        this.#frame.copyWithin(0, this.#hopLength);
        this.#fill = this.#frameLength - this.#hopLength;
      }
    }
  }

  /** Close one response: its profile and, when it sits beyond the ratio from the session's running median, the
   *  shift. Returns undefined when this response played no audio at all. */
  finish(): VoiceResponseReport | undefined {
    if (this.#samples === 0) return undefined;
    const audibleMs = Math.round((this.#samples / this.#rate) * 1000);
    const rms = Math.sqrt(this.#sumSquares / this.#samples);
    const profile: VoiceProfile = {
      audibleMs,
      f0Hz: this.#percentile(0.5),
      f0P10Hz: this.#percentile(0.1),
      f0P90Hz: this.#percentile(0.9),
      voicedRatio: this.#analyzed === 0 ? 0 : Math.round((this.#voicedCount / this.#analyzed) * 1000) / 1000,
      rmsDbfs: rms > 0 ? round1(20 * Math.log10(rms)) : -120,
    };
    const shift = this.#shift(profile.f0Hz);
    if (profile.f0Hz !== null && this.#sessionCount < this.#sessionMedians.length) {
      this.#sessionMedians[this.#sessionCount] = profile.f0Hz;
      this.#sessionCount += 1;
    }
    this.#fill = 0; this.#analyzed = 0; this.#voicedCount = 0; this.#samples = 0; this.#sumSquares = 0;
    return { profile, shift };
  }

  #init(rate: number): void {
    this.#rate = rate;
    this.#frameLength = Math.max(1, Math.round((rate * VOICE_PROFILE.frameMs) / 1000));
    this.#hopLength = Math.max(1, Math.round((rate * VOICE_PROFILE.hopMs) / 1000));
    this.#minLag = Math.max(2, Math.floor(rate / VOICE_PROFILE.maxHz));
    this.#maxLag = Math.min(this.#frameLength - 2, Math.ceil(rate / VOICE_PROFILE.minHz));
    this.#frame = new Float32Array(this.#frameLength);
    this.#tailEnergy = new Float64Array(this.#frameLength);
    this.#correlation = new Float64Array(this.#maxLag + 2);
  }

  /** One frame: normalized autocorrelation over the lag range, the first strong peak as the period, then the
   *  parabolic refinement. Silence and noise fall under the voiced threshold and are counted, never estimated. */
  #analyze(): void {
    const frame = this.#frame, length = this.#frameLength;
    let energy = 0;
    for (let index = 0; index < length; index += 1) energy += frame[index]! * frame[index]!;
    this.#analyzed += 1;
    if (!(energy > 0)) return;
    if (20 * Math.log10(Math.sqrt(energy / length)) < VOICE_PROFILE.voicedFloorDbfs) return;
    let tail = 0;
    for (let index = length - 1; index >= this.#minLag; index -= 1) { tail += frame[index]! * frame[index]!; this.#tailEnergy[index] = tail; }
    let best = 0, bestLag = 0;
    for (let lag = this.#minLag; lag <= this.#maxLag; lag += 1) {
      const limit = length - lag;
      let sum = 0;
      for (let index = 0; index < limit; index += 1) sum += frame[index]! * frame[index + lag]!;
      const norm = Math.sqrt(energy * this.#tailEnergy[lag]!);
      const correlation = norm > 0 ? sum / norm : 0;
      this.#correlation[lag] = correlation;
      if (correlation > best) { best = correlation; bestLag = lag; }
    }
    if (bestLag === 0 || best < this.#voicedCorrelation) return;
    const floor = VOICE_PROFILE.peakFraction * best;
    let chosen = bestLag;
    for (let lag = this.#minLag + 1; lag < this.#maxLag; lag += 1) {
      const here = this.#correlation[lag]!;
      if (here >= floor && here >= this.#correlation[lag - 1]! && here >= this.#correlation[lag + 1]!) { chosen = lag; break; }
    }
    const left = this.#correlation[chosen - 1]!;
    const middle = this.#correlation[chosen]!;
    const right = this.#correlation[chosen + 1]!;
    const curvature = left - 2 * middle + right;
    const offset = curvature === 0 ? 0 : (0.5 * (left - right)) / curvature;
    const hz = this.#rate / (chosen + (Math.abs(offset) < 1 ? offset : 0));
    if (hz < VOICE_PROFILE.minHz || hz > VOICE_PROFILE.maxHz) return;
    if (this.#voicedCount < this.#voiced.length) { this.#voiced[this.#voicedCount] = hz; this.#voicedCount += 1; }
  }

  #percentile(quantile: number): number | null {
    if (this.#voicedCount === 0) return null;
    const voiced = this.#voiced.subarray(0, this.#voicedCount);
    voiced.sort();
    const position = quantile * (this.#voicedCount - 1);
    const low = Math.floor(position), high = Math.min(this.#voicedCount - 1, low + 1);
    const value = voiced[low]! + (voiced[high]! - voiced[low]!) * (position - low);
    return Math.round(value);
  }

  /** The median of every median this session has played, so the comparison is against the session, not a
   *  hard-coded pitch. */
  #shift(f0Hz: number | null): VoiceShift | undefined {
    if (f0Hz === null || this.#sessionCount === 0) return undefined;
    const medians = this.#sessionMedians.subarray(0, this.#sessionCount);
    medians.sort();
    const middle = Math.floor(this.#sessionCount / 2);
    const sessionMedianHz = this.#sessionCount % 2 === 0
      ? (medians[middle - 1]! + medians[middle]!) / 2
      : medians[middle]!;
    if (!(sessionMedianHz > 0)) return undefined;
    const ratio = f0Hz / sessionMedianHz;
    const magnitude = ratio >= 1 ? ratio : 1 / ratio;
    if (magnitude <= this.#shiftRatio) return undefined;
    return { ratio: Math.round(ratio * 100) / 100, medianHz: f0Hz, sessionMedianHz: Math.round(sessionMedianHz) };
  }
}
