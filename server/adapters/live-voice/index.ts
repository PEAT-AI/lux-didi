import type { LiveVoiceAdapterOptions, LiveVoicePort } from './types.js';
import { LiveVoiceError } from './types.js';
import { GeminiLiveVoiceAdapter } from './gemini.js';

export * from './types.js';
export { GeminiLiveVoiceAdapter } from './gemini.js';

/**
 * The one place an adapter is chosen: by the route provider the validated profile carries, never by a
 * call site literal. A provider in the union with no adapter yet fails loudly and never borrows another.
 */
export function createLiveVoiceAdapter(options: LiveVoiceAdapterOptions): LiveVoicePort {
  switch (options.route.provider) {
    case 'gemini': return new GeminiLiveVoiceAdapter(options);
    // The OpenAI adapter lands in its own wagon; until then the switch fails closed instead of falling back.
    case 'openai': throw new LiveVoiceError('unsupported_provider');
  }
}
