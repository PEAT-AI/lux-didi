import { fakeLiveVoicePort } from '../test/fixtures/fake-live-voice.js';
import type { LiveVoicePort } from '../adapters/live-voice/index.js';

/**
 * The eval audio route: the repo's fake live voice port records the spoken text instead of pushing PCM
 * anywhere. `audible` is a literal false, and the case's expected_state names `recording-only` as the sink.
 */
/** The one route a spoken frame takes in eval mode. Typed as a plain string: the value must be checkable. */
export const RECORDING_ONLY = 'recording-only';

export interface SpokenEntry { kind: string; at: number; text: string; outputSink: string }

export interface RecordingSink {
  readonly port: LiveVoicePort;
  speak(kind: string, text: string): SpokenEntry;
  readonly entries: SpokenEntry[];
  transcripts(): string[];
}

export function recordingSink(clock: { now(): number }): RecordingSink {
  const fake = fakeLiveVoicePort();
  const entries: SpokenEntry[] = [];
  return {
    port: fake.port,
    speak(kind: string, text: string) {
      const entry: SpokenEntry = { kind, at: clock.now(), text, outputSink: RECORDING_ONLY };
      entries.push(entry);
      // The fake port's own transcript log is where a real session's output transcription would land.
      if (fake.sessionsOpened > 0) fake.emit({ type: 'outputTranscription', text, finished: true });
      return entry;
    },
    entries,
    transcripts: () => entries.map(entry => entry.text),
  };
}
