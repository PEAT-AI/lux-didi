import { initialMotion, levelFrame, POSTURE_TARGETS, silentFrame, stepMotion, type AudioFrame, type LevelSample, type OrbPosture } from './orb-level.ts';

type Weights = Record<OrbPosture, number>;
const weights = (kind: OrbPosture): Weights => ({ idle: 0, quiet: 0, thinking: 0, listening: 0, speaking: 0, [kind]: 1 });
const smooth = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };
const mixFrame = (from: AudioFrame, to: AudioFrame, t: number): AudioFrame => ({ ...to,
  level: from.level + (to.level - from.level) * t, low: from.low + (to.low - from.low) * t,
  mid: from.mid + (to.mid - from.mid) * t, high: from.high + (to.high - from.high) * t,
  flux: from.flux + (to.flux - from.flux) * t });

export class MotionCoordinator {
  private frame = silentFrame();
  private outputUntil = -Infinity;
  private richAt = -Infinity;
  private blocked = false;
  private source: 'input' | 'output' = 'input';
  private sourceFrom = this.frame;
  private sourceAt = -Infinity;
  private onset: number | undefined;
  private quiet: number | undefined;
  private speaking = false;
  private target: OrbPosture = 'idle';
  private from = weights('idle');
  private current = weights('idle');
  private targetAt = -Infinity;
  private lastAt: number | undefined;
  private elapsed = 0;
  private motion = initialMotion();
  private switches: number[] = [];
  readonly counters = { sourceChanges: 0, sourceChangesPerSecond: 0, frameIntervalMs: 0, frameAgeMs: 0 };

  interrupt() {
    this.outputUntil = -Infinity;
    this.blocked = true;
    this.speaking = false;
    this.onset = this.quiet = undefined;
  }

  sample(sample: LevelSample, at: number) {
    const folded = { ...levelFrame(sample), timestamp: at };
    if (folded.rich) this.richAt = at;
    else if (at - this.richAt < 300) return { ...this.frame, source: this.source };
    const rms = folded.playback;
    if (rms < 0.006) this.blocked = false;
    if (!this.blocked && rms >= 0.01) this.outputUntil = at + 160;
    const source = !this.blocked && (rms >= 0.01 || at < this.outputUntil) ? 'output' : 'input';
    let selected = folded;
    if (sample.v === 2) selected = { ...levelFrame({ v: 2, output: source === 'output' ? sample.output : sample.input }), playback: this.blocked ? 0 : rms, timestamp: at };
    if (source !== this.source) {
      this.sourceFrom = this.frame;
      this.sourceAt = at;
      this.source = source;
      this.counters.sourceChanges++;
      this.switches.push(at);
    }
    this.counters.frameIntervalMs = Math.max(0, at - this.frame.timestamp);
    this.frame = mixFrame(this.sourceFrom, selected, smooth((at - this.sourceAt) / 80));
    return { ...this.frame, source };
  }

  advance(state: string, at: number, still = false, muted = false, statusState = state) {
    const dt = this.lastAt === undefined ? 0 : Math.max(0, Math.min(0.1, (at - this.lastAt) / 1000));
    this.lastAt = at;
    this.counters.frameAgeMs = Math.max(0, at - this.frame.timestamp);
    this.switches = this.switches.filter(time => at - time < 1000);
    this.counters.sourceChangesPerSecond = this.switches.length;
    const frame = at - this.frame.timestamp > 500 ? { ...silentFrame(), timestamp: at } : this.frame;
    const disabled = muted || ['DISCONNECTED', 'ERROR', 'INTERRUPTED', 'IDLE'].includes(state);
    if (disabled) this.interrupt();
    const rms = disabled || this.blocked ? 0 : frame.playback;
    if (rms >= 0.012) {
      this.onset ??= at;
      if (at - this.onset >= 30) this.speaking = true;
    } else this.onset = undefined;
    if (rms < 0.006) {
      this.quiet ??= at;
      if (at - this.quiet >= 180) this.speaking = false;
    } else this.quiet = undefined;
    const kind: OrbPosture = !disabled && this.speaking ? 'speaking' : disabled ? 'quiet' : statusState === 'LISTENING' ? 'listening' : statusState === 'PROCESSING' ? 'thinking' : 'idle';
    const w = smooth((at - this.targetAt) / 240);
    for (const key of Object.keys(this.current) as OrbPosture[]) this.current[key] = this.from[key] + (Number(key === this.target) - this.from[key]) * w;
    if (kind !== this.target) { this.from = { ...this.current }; this.target = kind; this.targetAt = at; }
    if (still) this.current = weights(kind);
    const targets = { ...POSTURE_TARGETS.idle } as { -readonly [K in keyof typeof POSTURE_TARGETS.idle]: number };
    for (const key of Object.keys(targets) as (keyof typeof targets)[]) targets[key] = (Object.keys(this.current) as OrbPosture[]).reduce((sum, posture) => sum + POSTURE_TARGETS[posture][key] * this.current[posture], 0);
    if (!still) this.elapsed += dt;
    const periodModulation = 1 + 0.06 * Math.sin(this.elapsed * 2 * Math.PI / 23);
    const depthModulation = 1 + 0.08 * Math.sin(this.elapsed * 2 * Math.PI / 31);
    targets.breathPeriod *= periodModulation;
    targets.breathDepth *= depthModulation;
    const status: OrbPosture = statusState === 'PROCESSING' ? 'thinking' : statusState === 'SPEAKING' ? 'speaking' : statusState === 'LISTENING' ? 'listening' : ['DISCONNECTED','ERROR','INTERRUPTED'].includes(statusState) ? 'quiet' : 'idle';
    targets.swirl = POSTURE_TARGETS[status].swirl;
    const motion = stepMotion(this.motion, kind, disabled ? { ...frame, low: 0, level: 0, flux: 0 } : frame, dt, still, { ...targets, speakingWeight: this.current.speaking, listeningWeight: this.current.listening });
    return { ...motion, posture: kind, weights: { ...this.current }, source: this.source, frame, breathPhase: this.motion.breathPhase, periodModulation, depthModulation };
  }
}

interface InterruptSnapshot { since?: string; entries: readonly { seq: number; kind: string; text?: string }[] }
export function outputInterrupted(prior: InterruptSnapshot | undefined, next: InterruptSnapshot | undefined): boolean {
  if (!prior || !next || prior.since !== next.since) return false;
  const last = Math.max(-1, ...prior.entries.map(entry => entry.seq));
  return next.entries.some(entry => entry.seq > last && (entry.kind === 'interrupted' || (entry.kind === 'inputTranscription' && Boolean(entry.text?.trim()))));
}
