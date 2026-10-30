import type { ToolCallOutcome } from '../host/events.js';

export interface ToolOutcome { outcome: ToolCallOutcome; refusalCode?: string }
/** Business settlement only. A successful socket write is not evidence of tool success. */
export function toolOutcomeOf(response: Readonly<Record<string, unknown>>): ToolOutcome {
  const status = response.status ?? response.state;
  const rawCode = response.code ?? response.reason ?? response.error;
  // Codes are metadata, never arbitrary error prose or tool content.
  const code = typeof rawCode === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(rawCode)
    ? rawCode : undefined;
  const result = (outcome: ToolCallOutcome): ToolOutcome => ({ outcome, ...(code ? { refusalCode: code } : {}) });
  if (response.error === 'Tool not granted') return { outcome: 'refused', refusalCode: 'grant_not_permitted' };
  if (status === 'clarify') return result('clarify');
  if (status === 'blocked') return result('blocked');
  if (status === 'refused' || code === 'tool_result_denied' || code === 'no_owner_input' || code === 'opener_not_fetched') return result('refused');
  if (response.error !== undefined || status === 'invalid' || status === 'failed' || status === 'error' || status === 'unavailable' || response.ok === false) return result('failed');
  if (response.saved === false || response.remembered === false) return result(code === 'owner_text_mismatch' || code === 'not_owner_requested' || code === 'authorization_missing' ? 'refused' : 'unknown');
  if (status === 'stopped' || status === 'cancelled') return result('cancelled');
  if (status === 'partial') return result('partial');
  if (status === 'empty' || response.total === 0) return { outcome: 'empty' };
  // F11: an open that answered `opened`, and an alarm that answered `set` with its id, are settlements.
  if (code === 'opened') return { outcome: 'completed' };
  if (status === 'set' && typeof response.id === 'string' && response.id.trim().length > 0) return result('completed');
  if (status !== undefined && !['answered', 'complete', 'completed', 'ok', 'success', 'scheduled', 'created', 'set', 'available'].includes(String(status))) return { outcome: 'unknown' };
  const collections = ['findings', 'messages', 'results', 'items', 'cards', 'posts'].filter(key => Array.isArray(response[key]));
  if (collections.length > 0 && collections.every(key => (response[key] as unknown[]).length === 0)) return { outcome: 'empty' };
  const content = ['findings', 'result', 'entryId', 'alarmId', 'card', 'boards', 'lists', 'posts', 'answer', 'text', 'content', 'messages', 'results', 'items', 'cards', 'channels', 'note', 'alarm']
    .some(key => {
      const value = response[key];
      return typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 : value !== null && typeof value === 'object' && Object.keys(value).length > 0;
    });
  if (content || response.saved === true || response.remembered === true) return { outcome: 'completed' };
  return { outcome: 'unknown' };
}
