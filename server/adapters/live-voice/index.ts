import type { LiveVoiceAdapterOptions, LiveVoicePort } from './types.js';
import { GeminiLiveVoiceAdapter } from './gemini.js';
import { OpenAiLiveVoiceAdapter } from './openai.js';

export * from './types.js';
export { GeminiLiveVoiceAdapter } from './gemini.js';
export { OpenAiLiveVoiceAdapter, OPENAI_DEFAULT_VOICE, OPENAI_DELIVERY_SECTION, OPENAI_LANGUAGE_SECTION, OPENAI_TOOLS_SECTION, openAiInstructions } from './openai.js';
export { LIVE_INPUT_RATE, LIVE_PROVIDER_RATE, Pcm16Upsampler } from './resample.js';

/**
 * The one place an adapter is chosen: by the route provider the validated profile carries, never by a
 * call site literal. A provider in the union takes its own adapter and never borrows another's.
 */
export function createLiveVoiceAdapter(options: LiveVoiceAdapterOptions): LiveVoicePort {
  switch (options.route.provider) {
    case 'gemini': return new GeminiLiveVoiceAdapter(options);
    case 'openai': return new OpenAiLiveVoiceAdapter(options);
  }
}
