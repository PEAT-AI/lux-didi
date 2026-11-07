/** MCP envelope decoding only: what the payload is, never how a caller renders or validates it. */

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * The payload a lux tool result carries. lux documents the receipt as the text content, and FastMCP's wrap_result
 * returns the same text again as `structuredContent: {result: "<text>"}`, so the text content wins and a lone
 * structuredContent is unwrapped when its `result` string is the whole receipt. Any other shape is not a receipt.
 */
export function luxResultPayload(result: Record<string, unknown>): unknown {
  const content = Array.isArray(result.content) ? result.content : undefined;
  const text = (content ?? []).map(record).filter(part => part?.type === 'text').map(part => String(part?.text ?? '')).join('\n');
  if (text.length) return text;
  if (result.structuredContent !== undefined) {
    const wrapped = record(result.structuredContent)?.['result'];
    return typeof wrapped === 'string' ? wrapped : result.structuredContent;
  }
  return content ? '' : undefined;
}
