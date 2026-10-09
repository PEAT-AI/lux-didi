import type { DomainContext } from '../contracts/domain.js';
import { ChatError, type AcceptInput, type ChatConfig, type ChatEvent, type ChatPort, type RunSnapshot } from './types.js';
export * from './types.js';
export { chatMigrations } from './schema.js';

// Compiling contract checkpoint: acceptance deliberately unavailable until the
// durable engine is implemented. The real-Store tests must fail behaviorally.
export class ChatService implements ChatPort {
  constructor(_config: ChatConfig) {}
  recover(_context: DomainContext): RunSnapshot[] { return []; }
  accept(_input: AcceptInput, _context: DomainContext): RunSnapshot { throw new ChatError('unavailable'); }
  get(_runId: string, _context: DomainContext): RunSnapshot { throw new ChatError('not_found'); }
  cancel(_runId: string, _context: DomainContext): RunSnapshot { throw new ChatError('not_found'); }
  subscribe(_runId: string, _context: DomainContext): AsyncIterable<ChatEvent> { throw new ChatError('not_found'); }
}
