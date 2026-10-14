import { clientDiagnostic } from '../http/routes.js';
import { TOOL_FAILURE_CODES } from '../adapters/model/types.js';
import { ConfigError } from '../config/files.js';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// W10 typed direct logger. Every event kind has a closed field schema; a field outside it
// is a programming error: dropped and counted as log.schema_violation, never written.
// Values are only numbers, booleans, closed enums, ids and timestamps. No free-text field exists.
export type FieldType = 'id' | 'num' | 'bool' | 'ts';
export type FieldSpec = FieldType | readonly string[];
export type KindSchema = Record<string, FieldSpec>;

const idPattern = /^[A-Za-z0-9._:+-]{1,128}$/;
const eventPattern = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
const tsPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Correlation ids ride on every line when known; never caller text.
const correlation: KindSchema = {
  launchId: 'id', attemptId: 'id', liveSessionId: 'id', generation: 'num', turnSeq: 'num', toolCallId: 'id',
};

const audioFlowFields: KindSchema = {
  side: ['native', 'host'],
  tapFrames: 'num', converterBytesOut: 'num', ringEnqueued: 'num', ringDropped: 'num', ringResidual: 'num',
  wsBytesSent: 'num', playbackScheduled: 'num', playbackRendered: 'num', underruns: 'num', flushedFrames: 'num',
  lateFramesAfterFlush: 'num', bytesFromNative: 'num', bytesToProvider: 'num', bytesFromProvider: 'num', bytesToNative: 'num',
};

// One closed schema per event kind. The contract's vocabulary, no per-chunk events.
export const eventSchemas: Record<string, KindSchema> = {
  'host.started': { releaseCommit: 'id', configDir: ['effective', 'seeded'], endpoints: 'num' },
  'host.stop_requested': { actor: ['native_supervisor', 'signal', 'owner', 'user'], reason: 'id' },
  'host.exit': { stage: ['descriptor', 'log', 'store', 'owner', 'listen', 'ready'], reason: ['close', 'exit'], signal: ['SIGINT', 'SIGTERM'], code: 'num' },
  'live.attempt_start': {},
  'live.session_open': { languageCode: 'id', voice: 'id' },
  'live.state_change': { from: 'id', to: 'id' },
  'live.reconnect': { reason: 'id', attempt: 'num' },
  'live.session_terminal': { code: 'id', wsCloseCode: 'num', lastInbound: 'id', lastOutbound: 'id', tokenCount: 'num', frames: 'num', bytes: 'num' },
  'provider.turn': { reason: ['turnComplete', 'generationComplete', 'interrupted'], frames: 'num', bytes: 'num', firstAudioMs: 'num', onsetMono: 'num', activityStartMono: 'num', interruptedMono: 'num' },
  'provider.frame_rejected': { stage: ['parsed', 'json'], code: 'id', kind: 'id', bytes: 'num', keyList: 'id', unknownKeys: 'num' },
  'tool.call_start': { name: 'id' },
  'tool.call_end': { name: 'id', latencyMs: 'num', outcome: ['success', 'error', 'cancelled', 'after_barge_in'], failureStage: 'id', code: 'id' },
  'audio.flow': audioFlowFields,
  'audio.config': { inputRate: 'num', channels: 'num', channelMap: 'id', voiceProcessing: 'bool', languageCode: 'id', voice: 'id' },
  'log.schema_violation': { kind: 'id', dropped: 'num' },
};

function fieldOk(value: unknown, spec: FieldSpec): boolean {
  if (Array.isArray(spec)) return typeof value === 'string' && (spec as readonly string[]).includes(value);
  switch (spec) {
    case 'num': return typeof value === 'number' && Number.isFinite(value);
    case 'bool': return typeof value === 'boolean';
    case 'id': return typeof value === 'string' && idPattern.test(value);
    case 'ts': return typeof value === 'string' && tsPattern.test(value);
    default: return false;
  }
}

let logContext: Record<string, unknown> = {};
export function setLogContext(context: Record<string, unknown>): void { logContext = { ...context }; }
export function mergeLogContext(context: Record<string, unknown>): void { logContext = { ...logContext, ...context }; }
export function monoMs(): number { return Number(process.hrtime.bigint() / 1_000_000n); }

export function emitHostEvent(kind: string, fields: Record<string, unknown> = {}): void {
  const schema = eventSchemas[kind];
  if (schema === undefined || !eventPattern.test(kind)) { emitViolation('unknown_event', Object.keys(fields).length); return; }
  const merged = { ...logContext, ...fields };
  const record: Record<string, unknown> = { ts: new Date().toISOString(), mono: monoMs(), level: 'info', process: 'host', event: kind, pid: process.pid };
  let dropped = 0;
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'ts' || key === 'mono' || key === 'level' || key === 'process' || key === 'event' || key === 'pid') continue;
    const spec = correlation[key] ?? schema[key];
    if (spec === undefined || !fieldOk(value, spec)) { dropped += 1; continue; }
    record[key] = value;
  }
  if (dropped > 0) emitViolation(kind, dropped);
  for (const sink of sinks) sink.write(record);
}

function emitViolation(kind: string, dropped: number): void {
  const record = { ts: new Date().toISOString(), mono: monoMs(), level: 'error', process: 'host', event: 'log.schema_violation', pid: process.pid, kind: eventPattern.test(kind) ? kind : 'invalid', dropped };
  for (const sink of sinks) sink.write(record);
}

// Only the existing diagnostic schemas cross this boundary, never arbitrary console text.
export function safeEvent(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as Record<string, unknown>;
  if (value.event === 'tool_failure') {
    const codes: readonly string[] = TOOL_FAILURE_CODES;
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(v);
    if (typeof value.code !== 'string' || !codes.includes(value.code) || !token(value.tool) || !token(value.connector)
      || !['Error', 'SyntaxError', 'UnknownThrow', 'McpResultError'].includes(String(value.errorClass))
      || value.messageHead !== value.code || String(value.messageHead).length > 120) return;
    return { event: 'tool_failure', code: value.code, tool: value.tool, connector: value.connector, errorClass: value.errorClass, messageHead: value.messageHead };
  }
  if (value.event === 'mattermost_shape') {
    // Closed shape: tool, recognised shape kind and sizes only, never any message content.
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
    const sizes = ['rawCharacters', 'shapedCharacters', 'itemCount'] as const;
    if (Object.keys(value).sort().join(',') !== ['event', 'tool', 'shape', ...sizes].sort().join(',')
      || !token(value.tool) || !token(value.shape)
      || sizes.some(key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) return;
    return { event: 'mattermost_shape', tool: value.tool, shape: value.shape, rawCharacters: value.rawCharacters, shapedCharacters: value.shapedCharacters, itemCount: value.itemCount };
  }
  if (value.event === 'client_diagnostic' && value.source === 'native' && typeof value.receivedAt === 'string' && Number.isFinite(Date.parse(value.receivedAt)) && value.diagnostic && typeof value.diagnostic === 'object' && !Array.isArray(value.diagnostic)) {
    try { return { event: value.event, source: value.source, receivedAt: value.receivedAt, diagnostic: clientDiagnostic(value.diagnostic as Record<string, unknown>) }; } catch { return; }
  }
  if (value.event === 'host_started' && typeof value.releaseCommit === 'string' && /^(?:[0-9a-f]{40}|unknown)$/.test(value.releaseCommit) && (value.configDir === 'effective' || value.configDir === 'seeded') && Number.isSafeInteger(value.endpoints) && Number(value.endpoints) >= 0 && Number(value.endpoints) <= 65535) {
    return { event: value.event, releaseCommit: value.releaseCommit, configDir: value.configDir, endpoints: value.endpoints };
  }
  if (value.event === 'host_exit' && ['descriptor', 'log', 'store', 'owner', 'listen', 'ready'].includes(String(value.stage))
    && (value.reason === 'close' || value.reason === 'exit')
    && (value.signal === undefined || value.signal === 'SIGINT' || value.signal === 'SIGTERM')
    && (value.code === undefined || (Number.isSafeInteger(value.code) && Number(value.code) >= 0))) {
    return { event: 'host_exit', stage: value.stage, reason: value.reason,
      ...(value.signal !== undefined ? { signal: value.signal } : {}),
      ...(value.code !== undefined ? { code: value.code } : {}) };
  }
  if (value.event === 'config_seeded' && ['live.json', 'mcp.json', 'providers.json'].includes(String(value.file)) && value.from === 'provider-config') {
    return { event: value.event, file: value.file, from: value.from };
  }
  if (value.event === 'live_attach_rejected' && typeof value.code === 'string' && /^[A-Za-z0-9_]{1,107}$/.test(value.code)) {
    return { event: value.event, ...(typeof value.liveSessionId === 'string' && /^[0-9a-f-]{36}$/i.test(value.liveSessionId) ? { liveSessionId: value.liveSessionId } : {}), code: value.code };
  }
  if (value.event === 'live_session_diagnostics') {
    const numeric = ['adapterGenerations','ownerAudioCalls','ownerAudioBytes','ownerRebuildingDropCalls','ownerRebuildingDropBytes',
      'adapterAudioCalls','adapterAudioBytes','drainingDropCalls','drainingDropBytes',
      'localWriteEnqueuedCalls','localWriteEnqueuedPCMBytes','localWriteCallbackSuccessCalls','localWriteCallbackSuccessPCMBytes',
      'localWriteCallbackErrorCalls','localWriteCallbackErrorPCMBytes','localWriteCallbackPendingCalls','localWriteCallbackPendingPCMBytes',
      'inputTranscriptionEvents','inputTranscriptionCharacters','generationCompleteEvents','turnCompleteEvents','outputAudioFrames','outputAudioPCMBytes',
      'outputAudioAfterInitialTurnFrames','outputAudioAfterInitialTurnPCMBytes'];
    const keys = ['event','terminalCode',...numeric].sort();
    if (Object.keys(value).sort().join(',') !== keys.join(',') || typeof value.terminalCode !== 'string'
      || !/^[a-z][a-z0-9_]{0,63}$/.test(value.terminalCode)
      || numeric.some(key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) return;
    return Object.fromEntries(['event','terminalCode',...numeric].map(key => [key, value[key]]));
  }
  if (value.event === 'live_frame_rejected') {
    // Closed shape: code, frame kind, byte length and key-name paths only, never a value or id.
    if (Object.keys(value).sort().join(',') !== ['event','code','kind','bytes','keys'].sort().join(',')) return;
    const codes = ['protocol_error', 'provider_error', 'unsupported_tool'];
    const keyPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}(?:\[\])?(?:\.[A-Za-z][A-Za-z0-9_]{0,63}(?:\[\])?)*$/;
    if (typeof value.code !== 'string' || !codes.includes(value.code)) return;
    if (typeof value.kind !== 'string' || !/^[A-Za-z][A-Za-z0-9_+]{0,80}$/.test(value.kind)) return;
    if (!Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 || Number(value.bytes) > 64 * 1024 * 1024) return;
    if (!Array.isArray(value.keys) || value.keys.length > 24 || value.keys.some(key => typeof key !== 'string' || !keyPattern.test(key))) return;
    return { event: 'live_frame_rejected', code: value.code, kind: value.kind, bytes: value.bytes, keys: value.keys };
  }
}

export class HostLog {
  private readonly path: string;
  constructor(dataDir: string, private readonly limit = 5 * 1024 * 1024) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const root = lstatSync(dataDir);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid diagnostics state directory');
    const directory = join(dataDir, 'logs');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Invalid diagnostics directory');
    this.path = join(directory, 'host.log');
  }
  event(raw: unknown): void { const event = safeEvent(raw); if (event) this.append(event); }
  write(record: Record<string, unknown>): void { this.appendLine(Buffer.from(JSON.stringify(record) + '\n')); }
  terminal(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const code = (raw as { code?: unknown }).code;
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(code)) return;
    this.append({ event: 'host_error', class: 'LiveTerminal', code });
  }
  error(error: unknown): void {
    // Class is a closed token. Exception messages and stacks are deliberately never read.
    this.append({ event: 'host_error', class: error instanceof ConfigError ? 'ConfigError' : 'Error', ...(error instanceof ConfigError ? { code: error.code } : {}) });
  }
  private append(event: Record<string, unknown>): void {
    this.appendLine(Buffer.from(JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, ...event }) + '\n'));
  }
  private appendLine(line: Buffer): void {
    if (line.length > this.limit) return;
    let fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new Error('Invalid diagnostics file');
      fchmodSync(fd, 0o600);
      if (info.size + line.length > this.limit) {
        closeSync(fd); fd = -1;
        if (existsSync(this.path + '.2')) unlinkSync(this.path + '.2');
        if (existsSync(this.path + '.1')) renameSync(this.path + '.1', this.path + '.2');
        renameSync(this.path, this.path + '.1');
        fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        const rotated = fstatSync(fd);
        if (!rotated.isFile() || rotated.nlink !== 1 || (process.getuid && rotated.uid !== process.getuid())) throw new Error('Invalid diagnostics file');
        fchmodSync(fd, 0o600);
      }
      writeSync(fd, line);
    } finally { if (fd >= 0) closeSync(fd); }
  }
}

const sinks = new Set<HostLog>();
let installed = false;
export function captureHostDiagnostics(log: HostLog): () => void {
  sinks.add(log);
  if (!installed) {
    installed = true;
    for (const method of ['log', 'error', 'warn'] as const) {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        for (const sink of sinks) {
          try {
            let event: unknown;
            if (args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('{')) {
              try { event = JSON.parse(args[0]); } catch { /* not a structured event */ }
            }
            if (event) sink.event(event);
            else if (method !== 'log') sink.error(undefined);
          } catch { original('diagnostics_unavailable'); }
        }
        original(...args);
      };
    }
  }
  return () => { sinks.delete(log); };
}
