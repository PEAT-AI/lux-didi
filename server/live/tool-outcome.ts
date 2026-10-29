import type { ToolCallOutcome } from '../host/events.js';

export interface ToolOutcome { outcome: ToolCallOutcome; refusalCode?: string }
/** Business settlement only. A successful socket write is not evidence of tool success. */
export function toolOutcomeOf(response: Readonly<Record<string, unknown>>): ToolOutcome {
  const status = response.status ?? response.state;
  const rawCode = response.code ?? response.reason ?? response.error;
  // Codes are metadata, never arbitrary error prose or tool content.
  const code = typeof rawCode === 'string' && /^[A-Za-z0-9_ -]{1,96}$/.test(rawCode)
    ? rawCode.replaceAll(' ', '_') : undefined;
  const result = (outcome: ToolCallOutcome): ToolOutcome => ({ outcome, ...(code ? { refusalCode: code } : {}) });
  if (status === 'clarify') return result('clarify');
  if (status === 'blocked') return result('blocked');
  if (status === 'refused' || response.saved === false || response.remembered === false || code === 'no_owner_input' || code === 'opener_not_fetched') return result('refused');
  if (response.error !== undefined || status === 'invalid' || status === 'failed' || status === 'error' || status === 'unavailable' || response.ok === false) return result('failed');
  if (status === 'stopped' || status === 'cancelled') return result('cancelled');
  if (status === 'partial') return result('partial');
  if (status === 'empty' || response.total === 0) return { outcome: 'empty' };
  const content = ['answer', 'text', 'content', 'messages', 'results', 'items', 'cards', 'channels', 'note', 'alarm', 'id']
    .some(key => {
      const value = response[key];
      return typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 : value !== null && typeof value === 'object' && Object.keys(value).length > 0;
    });
  if (content || response.saved === true || response.remembered === true) return { outcome: 'completed' };
  return { outcome: 'unknown' };
}
