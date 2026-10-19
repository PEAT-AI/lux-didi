import { validHistoryArguments } from '../domain/history-reader.js';
export const HISTORY_IDENTITY = { name: 'conversation_history', accountId: 'gateway:history', resourceId: 'owner-history' } as const;
export const HISTORY_PARAMETERS = {
  type: 'object', additionalProperties: false,
  properties: {
    query: { type: 'string', maxLength: 4096 }, from: { type: 'string', description: 'Inclusive UTC ISO timestamp.' }, to: { type: 'string', description: 'Exclusive UTC ISO timestamp.' },
    limit: { type: 'integer', minimum: 1, maximum: 20 }, cursor: { type: 'string' }, recordRef: { type: 'string' },
  },
};
export { validHistoryArguments as validateHistory };
