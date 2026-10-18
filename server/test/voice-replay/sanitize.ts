#!/usr/bin/env node
/**
 * Convert a recorded provider event log into a replay trace: every text-bearing field becomes a placeholder, so
 * a trace carries the causal order of real frames and none of their words.
 *
 * Used on test data only. It is never pointed at the owner's folder, and it refuses a log that is not a JSON
 * array of frames.
 *
 *   node dist/test/voice-replay/sanitize.js recorded.jsonl > traces/scenario-01.json
 *
 * Input: one JSON frame per line, or a JSON array of frames. Either an object `{ at_ms, direction, event }` or a
 * bare provider frame, in which case `at_ms` comes from the frame's own `at_ms` or accumulates 0.
 */
import { readFileSync } from 'node:fs';
import type { TraceStep } from './driver.js';

// Free text only. Provider identifiers (`id`, `call_id`, `delegation_id`, `name`) are tokens the provider
// minted, not owner content, and a trace keeps them so a call still joins to its output.
const TEXT_KEYS = new Set(['delta', 'text', 'arguments', 'message', 'instruction', 'instructions', 'output', 'content', 'query', 'summary']);
const PLACEHOLDER = 'synthetic';

const placeholder = (key: string, value: unknown): unknown => {
  if (!TEXT_KEYS.has(key) || typeof value !== 'string') return value;
  return `${PLACEHOLDER} text (${value.length} chars)`;
};

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = placeholder(key, scrub(entry));
    return out;
  }
  return value;
}

/** A recording is either one JSON array or one JSON frame per line. */
function framesFromText(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return text.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as unknown); }
}

export function sanitize(recorded: unknown): TraceStep[] {
  const frames = Array.isArray(recorded) ? recorded : framesFromText(String(recorded));
  let clock = 0;
  return frames.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`frame ${index} is not an object`);
    const record = entry as Record<string, unknown>;
    const wrapped = typeof record['direction'] === 'string' && 'event' in record;
    const event = scrub(wrapped ? record['event'] : record) as Record<string, unknown>;
    const at = typeof record['at_ms'] === 'number' ? record['at_ms'] : clock + 100;
    clock = at;
    const direction = wrapped ? record['direction'] : 'in';
    if (direction !== 'in' && direction !== 'client' && direction !== 'out') throw new Error(`frame ${index} has an unknown direction`);
    return { at_ms: at, direction, event } as TraceStep;
  });
}

if (process.argv[1] && process.argv[1].endsWith('sanitize.js')) {
  const source = process.argv[2];
  if (!source) { process.stderr.write('usage: sanitize.js <recorded-provider-log.json>\n'); process.exit(2); }
  process.stdout.write(`${JSON.stringify({ scenario: 'sanitized recording', deadline_ms: 20_000, steps: sanitize(readFileSync(source, 'utf8')) }, null, 2)}\n`);
}
