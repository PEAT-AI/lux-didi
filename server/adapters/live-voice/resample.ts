/**
 * Linear PCM16 upsampler for the GPT-Live adapter. The host captures at 16 kHz; GPT-Live takes 24 kHz
 * both ways (`audio.format` is one rate), so the adapter converts input before the wire and never
 * touches the native pipeline.
 *
 * Output sample k sits at input position 2k/3 (exact integer thirds, so a long stream never drifts).
 * One input sample is held across a chunk boundary, which costs a single-sample lookahead: a
 * 480-sample chunk yields 719 samples the first time and exactly 720 (1.5x) from the second chunk on.
 * No per-sample allocation: one output buffer per call.
 */
export const LIVE_INPUT_RATE = 16_000;
export const LIVE_PROVIDER_RATE = 24_000;

const EMPTY = new Uint8Array(0);

export class Pcm16Upsampler {
  /** Read position of the next output sample, in thirds of an input sample, relative to this chunk. */
  private position3 = 0;
  /** Final input sample of the previous chunk; it is the left neighbour for a chunk-local -1 position. */
  private held = 0;

  process(pcm: Uint8Array): Uint8Array {
    const samples = Math.floor(pcm.byteLength / 2);
    if (!samples) return EMPTY;
    const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
    const out = new Uint8Array(Math.ceil(samples * 1.5) * 2 + 4);
    const sink = new DataView(out.buffer);
    let written = 0;
    for (let index = Math.floor(this.position3 / 3); index <= samples - 2; index = Math.floor(this.position3 / 3)) {
      const left = index < 0 ? this.held : view.getInt16(index * 2, true);
      const right = view.getInt16((index + 1) * 2, true);
      const thirds = this.position3 - index * 3;
      sink.setInt16(written * 2, Math.round(left + (right - left) * (thirds / 3)), true);
      written += 1;
      this.position3 += 2;
    }
    this.position3 -= samples * 3;
    this.held = view.getInt16((samples - 1) * 2, true);
    return out.subarray(0, written * 2);
  }
}
