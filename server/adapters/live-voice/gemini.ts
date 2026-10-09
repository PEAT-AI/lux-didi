import type { GeminiLiveVoiceOptions, LiveVoiceControl, LiveVoicePort, LiveVoiceRequest, LiveVoiceSession } from './types.js';
import { LiveVoiceError } from './types.js';

/** Compile-safe contract scaffold for the behavioral red checkpoint. */
export class GeminiLiveVoiceAdapter implements LiveVoicePort {
  constructor(_options: GeminiLiveVoiceOptions) {}
  open(_request: LiveVoiceRequest, _control: LiveVoiceControl): LiveVoiceSession {
    throw new LiveVoiceError('not_ready');
  }
}
