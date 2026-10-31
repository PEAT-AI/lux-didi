/**
 * The synthetic audio probe. It feeds a short, made-up utterance through the same realtime adapter in its audio
 * path and drops the provider's spoken output on the floor: the point is that the upload path, the chunking and
 * the adapter's own turn-taking survive an utterance, with no device, no speaker and no money.
 *
 * The utterance is synthetic: generated here, or built by the macOS `say` command into a file and never played.
 */

import { readFileSync } from 'node:fs';
import { createLiveVoiceAdapter } from '../../adapters/live-voice/index.js';
import type { LiveVoiceEvent } from '../../adapters/live-voice/types.js';
import { replayServer, type Recording } from './replay.js';

/** 24 kHz mono 16-bit PCM, the rate the adapter's own audio path declares. */
export const PROBE_RATE = 24_000;
/** About half a second: long enough to cross several upload chunks, short enough to stay a probe. */
export const PROBE_SAMPLES = 12_000;
/** One upload chunk. The probe and its plan both use it, so the plan's chunk count is the run's. */
export const PROBE_CHUNK_BYTES = 4_800;

/** A synthetic utterance: a 440 Hz tone at a fifth of full scale. Nothing recorded, nothing anyone said. */
export function synthUtterance(samples = PROBE_SAMPLES): Uint8Array {
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let at = 0; at < samples; at += 1) {
    const amplitude = Math.round(Math.sin((2 * Math.PI * 440 * at) / PROBE_RATE) * 6_500);
    view.setInt16(at * 2, amplitude, true);
  }
  return pcm;
}

/** A `say -o file --data-format=LEI16@24000` capture (WAV with a 44 byte header) or bare PCM16. */
export function readUtteranceFile(path: string): Uint8Array {
  const bytes = new Uint8Array(readFileSync(path));
  const riff = bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  return riff ? bytes.subarray(44) : bytes;
}

/** Bounded wait on the fake provider's own frames. The happy path settles in a few turns of the event loop. */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return;
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }
}

export interface AudioProbeOutcome {
  readonly uploadedBytes: number;
  readonly chunks: number;
  /** The provider's own spoken frames, counted and then dropped: the probe never plays audio. */
  readonly outputAudioFrames: number;
  readonly transcripts: readonly string[];
  readonly events: number;
  readonly connections: number;
}

/** What the probe would do, printed by `--dry-run`. It has opened nothing and imported no device. */
export function audioPlan(input: { readonly bytes: number; readonly source: string }): string {
  const chunks = Math.ceil(input.bytes / PROBE_CHUNK_BYTES);
  return [
    'tier 2 audio probe: dry run, no socket, no audio device, no model call',
    `  utterance: ${input.source}, ${input.bytes} bytes of 16-bit PCM at ${PROBE_RATE} Hz`,
    `  upload: ${chunks} chunk(s) of about 100 ms through session.sendAudio`,
    '  output: the provider\'s audio frames are counted and dropped, never played and never written',
  ].join('\n');
}

/**
 * Upload `pcm`, collect what comes back, and drop the audible part. The adapter is the production one; only the
 * socket and the provider's words are recorded.
 */
export async function runAudioProbe(input: { readonly pcm: Uint8Array; readonly recording: Recording; readonly timeoutMs?: number }): Promise<AudioProbeOutcome> {
  const timeoutMs = input.timeoutMs ?? 20_000;
  const replay = await replayServer(input.recording);
  const session = createLiveVoiceAdapter({
    modelId: 'gpt-live-1', voice: 'marin', keyReference: 'eval-audio-probe',
    route: { enabled: true, provider: 'openai', modelId: 'gpt-live-1', dataClasses: ['ordinary'] },
    credentials: { resolve: async () => 'synthetic-eval-key-never-sent-to-a-provider' },
    limits: { handshakeMs: 4000, idleMs: 4000, sessionMs: 60_000, closeMs: 200 },
    socketFactory: replay.socketFactory,
  }).open({ system: { text: 'Synthetic persona for the audio probe.', dataClass: 'ordinary' }, dataClasses: ['ordinary'] },
    { signal: AbortSignal.timeout(timeoutMs), deadlineMs: Date.now() + timeoutMs });

  const state = { outputAudioFrames: 0, transcripts: [] as string[], events: 0 };
  const pump = (async () => {
    for await (const event of session.events as AsyncIterable<LiveVoiceEvent>) {
      state.events += 1;
      if (event.type === 'audio') state.outputAudioFrames += 1;
      if (event.type === 'outputTranscription' && event.text.length > 0) state.transcripts = [...state.transcripts, event.text];
    }
  })();

  await session.ready;
  const chunk = PROBE_CHUNK_BYTES;
  let chunks = 0;
  for (let at = 0; at < input.pcm.length; at += chunk) {
    const slice = input.pcm.subarray(at, Math.min(at + chunk, input.pcm.length));
    session.sendAudio({ pcm: slice, dataClass: 'ordinary' });
    chunks += 1;
  }
  await replay.served();
  // The frames are on the socket, not yet through the adapter: wait for the first of them to land, bounded.
  await waitFor(() => state.outputAudioFrames > 0 && state.transcripts.length > 0, 4_000);
  session.close();
  await pump;
  const connections = replay.connections();
  await replay.close();
  return { uploadedBytes: input.pcm.length, chunks, outputAudioFrames: state.outputAudioFrames,
    transcripts: state.transcripts, events: state.events, connections };
}
