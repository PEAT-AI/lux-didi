// O1b-N: the single door a native playback receipt enters the trace store through.
// The app sends one bounded JSON frame over the live socket it already holds; this module
// validates the frame against O1a's native ingestion types and writes the event plus the
// `trace_playback` summary row. A frame is a closed shape: every key is known, every value is an
// id or a count, so no owner text and no provider payload can ever reach a metadata table.
import { isOneOf, PLAYBACK_TERMINATION_REASONS, type PlaybackTerminationReason } from './kinds.js';
import { record, type RecordResult, type TraceWritePort } from './record.js';

/** The six receipts a playback segment reports. Closed, so a receipt name is never free text. */
export const PLAYBACK_RECEIPTS = ['received', 'enqueued', 'started', 'drained', 'interrupted', 'terminated'] as const;
export type PlaybackReceipt = (typeof PLAYBACK_RECEIPTS)[number];

/** A receipt frame is a few hundred bytes; anything longer is not one of ours. */
export const PLAYBACK_RECEIPT_MAX_BYTES = 1024;

export type IngestRejectCode =
  | 'frame_too_large' | 'not_json' | 'not_object' | 'unknown_field' | 'missing_field' | 'invalid_field' | 'unknown_receipt';
export class IngestReject extends Error {
  constructor(readonly code: IngestRejectCode) { super(code); }
}

/** One validated receipt. `reason` is present only on `interrupted` and `terminated`. */
export interface NativePlaybackReceipt {
  receipt: PlaybackReceipt;
  segmentSeq: number;
  sourceInstanceId: string;
  sourceSeq: number;
  monoMs: number;
  wallMs: number;
  reason: PlaybackTerminationReason | null;
}

const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,95}$/;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const REQUIRED = ['type', 'receipt', 'segment_seq', 'source_instance_id', 'source_seq', 'mono_ms', 'wall_ms'] as const;
const OPTIONAL = ['reason'] as const;

/** Parse and validate one inbound frame. Every refusal is a typed code, never a message. */
export function parsePlaybackReceipt(raw: string): NativePlaybackReceipt {
  if (Buffer.byteLength(raw, 'utf8') > PLAYBACK_RECEIPT_MAX_BYTES) throw new IngestReject('frame_too_large');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new IngestReject('not_json'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new IngestReject('not_object');
  const frame = value as Record<string, unknown>;
  for (const key of Object.keys(frame)) {
    if (!(REQUIRED as readonly string[]).includes(key) && !(OPTIONAL as readonly string[]).includes(key)) throw new IngestReject('unknown_field');
  }
  for (const key of REQUIRED) if (!(key in frame)) throw new IngestReject('missing_field');
  if (!isOneOf(PLAYBACK_RECEIPTS, frame.receipt)) throw new IngestReject('unknown_receipt');
  if (typeof frame.source_instance_id !== 'string' || !ID_SHAPE.test(frame.source_instance_id)) throw new IngestReject('invalid_field');
  if (!isCount(frame.segment_seq) || !isCount(frame.source_seq) || !isCount(frame.mono_ms) || !isCount(frame.wall_ms)) throw new IngestReject('invalid_field');
  const reason = frame.reason === undefined ? null : frame.reason;
  if (reason !== null && !isOneOf(PLAYBACK_TERMINATION_REASONS, reason)) throw new IngestReject('invalid_field');
  if (reason !== null && frame.receipt !== 'interrupted' && frame.receipt !== 'terminated') throw new IngestReject('unknown_field');
  return {
    receipt: frame.receipt, segmentSeq: frame.segment_seq, sourceInstanceId: frame.source_instance_id,
    sourceSeq: frame.source_seq, monoMs: frame.mono_ms, wallMs: frame.wall_ms, reason,
  };
}

/** One playback segment is one key: the instance that played it and its own segment number. */
export function playbackKeyOf(sourceInstanceId: string, segmentSeq: number): string {
  return `${sourceInstanceId}:${segmentSeq}`;
}

/** What the host knows about a segment. Never guessed: an unknown field stays null in the row. */
export interface PlaybackAttribution { responseKey?: string; turnId?: string }

/**
 * Record one validated receipt as a `trace_event` with source native and its `trace_playback`
 * summary row. The producer's wall ms and monotonic ms are carried through untouched, so the
 * host never substitutes its own clock for the app's.
 */
export function recordPlaybackReceipt(port: TraceWritePort, liveSessionId: string, receipt: NativePlaybackReceipt,
  attribution: PlaybackAttribution = {}): RecordResult {
  const ids = {
    liveSessionId, source: 'native' as const, sourceInstanceId: receipt.sourceInstanceId, sourceSeq: receipt.sourceSeq,
    at: receipt.wallMs, monoMs: receipt.monoMs, playbackKey: playbackKeyOf(receipt.sourceInstanceId, receipt.segmentSeq),
    ...attribution,
  };
  switch (receipt.receipt) {
    case 'received':
      return record(port, 'playback.received', ids, { segmentSeq: receipt.segmentSeq, receivedAt: receipt.wallMs });
    case 'enqueued':
      return record(port, 'playback.enqueued', ids, { enqueuedAt: receipt.wallMs });
    case 'started':
      return record(port, 'playback.started', ids, { startedAt: receipt.wallMs });
    case 'drained':
      return record(port, 'playback.drained', ids, { drainedAt: receipt.wallMs });
    case 'interrupted':
      return record(port, 'playback.interrupted', ids, { interruptedAt: receipt.wallMs, terminationReason: receipt.reason ?? 'interrupted' });
    case 'terminated':
      return record(port, 'playback.terminated', ids, { terminationReason: receipt.reason ?? 'session_end' });
  }
}
