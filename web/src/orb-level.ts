/** Pure level-frame folding: a small dependency-free boundary so the native level contract
 *  is testable under node strip-only mode and reusable by any renderer host. */
export interface LevelSample { level: number; low?: number; mid?: number; high?: number; flux?: number }
export interface AudioFrame { level: number; low: number; mid: number; high: number; flux: number; timestamp: number }

export function levelFrame(sample: LevelSample): AudioFrame {
  const clamp = (value: number | undefined, fallback = 0) => Math.min(1, Math.max(0, Number.isFinite(value) ? value! : fallback));
  const level = clamp(sample.level);
  return {
    level,
    low: clamp(sample.low, level),
    mid: clamp(sample.mid, level),
    high: clamp(sample.high, level),
    flux: clamp(sample.flux),
    timestamp: performance.now(),
  };
}

/** The audible level of one batched native tap: the louder of capture and playback, so the orb answers
 *  whoever is speaking (V3 item 1). Undefined when the batch carries no usable number. */
export function levelPeak(input: readonly number[], output: readonly number[]): number | undefined {
  const values = [...input, ...output].filter(value => Number.isFinite(value));
  if (!values.length) return undefined;
  return Math.min(1, Math.max(0, Math.max(...values)));
}
