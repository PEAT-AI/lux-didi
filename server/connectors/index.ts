import { LUX_KNOWLEDGE_TOOLS } from './lux-knowledge.js';
import { GOOGLE_TOOLS } from './google.js';

export * from './lux-knowledge.js';
export * from './google.js';

/**
 * The locally maintained read envelope per connector. The host approves exactly these names
 * under owner-trusted-reads, never the remote's readOnlyHint. One line per connector.
 */
export const CONNECTOR_ENVELOPES: Readonly<Record<string, readonly string[]>> = {
  'lux-knowledge': LUX_KNOWLEDGE_TOOLS,
  'google': GOOGLE_TOOLS,
};
