/**
 * One level rule for every live adapter: whether a PCM16 output frame is audible speech or digital silence.
 * The idle clock (#592, C-LIVE N-2) hangs off this classification, so an adapter that forwards the provider's
 * own silence frames must classify them exactly as every other route does.
 */

/** Audible speech, in dBFS RMS against 16-bit full scale. -50 dBFS is a peak amplitude of about 100 counts of
 *  32767, far below any intelligible speech (conversational RMS sits around -35 to -12 dBFS) and far above the
 *  all-zero frames gpt-live-1 streams to fill its continuous output (session 1018 kept 48 kB/s for 98.5% of a
 *  339 s call while the state never left SPEAKING). A frame below it is forwarded and heard as nothing. */
export const AUDIBLE_RMS_DBFS = -50;
/** A digital-silent frame measures zero power: -Infinity is clamped here so the level stays a JSON number. */
export const SILENT_RMS_DBFS = -120;

/** The level of one PCM16 little-endian chunk in dBFS RMS, one pass and no per-sample allocation. */
export function pcm16RmsDbfs(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples === 0) return SILENT_RMS_DBFS;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const sample = view.getInt16(index * 2, true) / 32_768;
    sum += sample * sample;
  }
  const power = sum / samples;
  return power <= 0 ? SILENT_RMS_DBFS : Math.max(SILENT_RMS_DBFS, 10 * Math.log10(power));
}
