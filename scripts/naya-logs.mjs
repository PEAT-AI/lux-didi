#!/usr/bin/env node
// naya-logs: read host.log, fast. Read-only, no dependencies.
// host.log is content-free by contract, so nothing this tool prints is owner text. The per-turn record,
// including what was said, lives in the trace store: read it with scripts/didi-timeline.
// See docs/debugging.md for the privacy rule and the coverage table the debug journal left behind.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LINE_LIMIT = 200;
const APP_SUBSYSTEM = 'ai.lux.didi';

const usage = `naya-logs <command> [options]

  sessions [--since 24h] [--kind live|chat]   one row per session
  tools <id|latest>                           each tool receipt: time, event, call, ms
  errors [--since 24h]                        every recorded failure
  slow [--since 24h] [--over 5000]            tool and answer timings over the threshold
  native <id|latest>                          the app's own OS log records for the session window

  For a turn-by-turn timeline with turns, responses, calls and playback, use scripts/didi-timeline.

  --data-dir <path>   override the host data directory
  --json              machine-readable output
  --lines <n>         raise or lower the 200 line cap
`;

// ---------- arguments ----------

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { process.stdout.write(usage); process.exit(argv.length === 0 ? 2 : 0); }
const command = argv[0];
const positional = [];
const options = { json: false, since: undefined, kind: undefined, over: 5000, dataDir: undefined, lines: LINE_LIMIT };
for (let i = 1; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--json') options.json = true;
  else if (arg === '--since') options.since = argv[++i];
  else if (arg === '--kind') options.kind = argv[++i];
  else if (arg === '--over') options.over = Number(argv[++i]);
  else if (arg === '--data-dir') options.dataDir = argv[++i];
  else if (arg === '--lines') options.lines = Number(argv[++i]);
  else if (arg.startsWith('--')) { process.stderr.write(`unknown option ${arg}\n`); process.exit(2); }
  else positional.push(arg);
}

// ---------- the data directory, resolved exactly as the host resolves it ----------

// The same order and the same per-platform default as defaultDataDir() in server/host/runtime.ts.
function dataDirectory() {
  if (options.dataDir !== undefined) return options.dataDir;
  const state = process.env.DIDI_STATE_DIR;
  if (state) return state;
  // L8-Q10: the installed app's own directory, the store and logs the owner's calls write; a dev host passes --data-dir.
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ai.peat.lux-didi');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Lux Didi');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'lux-didi');
}

function sinceMs() {
  if (options.since === undefined) return 0;
  const match = /^(\d+)([mhd])$/.exec(options.since);
  if (!match) {
    const parsed = Date.parse(options.since);
    if (Number.isFinite(parsed)) return parsed;
    process.stderr.write(`--since takes 24h, 30m, 7d or an ISO date, not ${options.since}\n`);
    process.exit(2);
  }
  const scale = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return Date.now() - Number(match[1]) * scale;
}

// ---------- reading ----------

const root = dataDirectory();

function readHostLog(cutoff) {
  const records = [];
  for (const name of ['host.log.2', 'host.log.1', 'host.log']) {
    const path = join(root, 'logs', name);
    if (!existsSync(path)) continue;
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const at = Date.parse(record.timestamp);
        if (!Number.isFinite(at) || (cutoff !== 0 && at < cutoff)) continue;
        records.push({ ...record, at });
      } catch { /* skip */ }
    }
  }
  return records.sort((a, b) => a.at - b.at);
}

/**
 * host.log records grouped into one entry per session. A live session is named by liveSessionId, a chat run
 * by runId; a record that names neither is a host-wide receipt and belongs to no session row.
 */
function readSessions(cutoff) {
  const sessions = new Map();
  for (const record of readHostLog(cutoff)) {
    const id = typeof record.liveSessionId === 'string' ? record.liveSessionId : typeof record.runId === 'string' ? record.runId : undefined;
    if (id === undefined) continue;
    const entry = sessions.get(id) ?? { id, kind: record.liveSessionId === undefined ? 'chat' : 'live', records: [] };
    entry.records.push({ ...record, t: record.timestamp });
    sessions.set(id, entry);
  }
  for (const entry of sessions.values()) entry.records.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return sessions;
}

// ---------- shaping ----------

const first = (entry, event) => entry.records.find(record => record.event === event);
const all = (entry, event) => entry.records.filter(record => record.event === event);

function summarise(entry) {
  const start = entry.records[0];
  const end = first(entry, 'session_end') ?? entry.records[entry.records.length - 1];
  const toolTurns = all(entry, 'live_tool_turn');
  const failed = all(entry, 'tool_failure').length + all(entry, 'tool_cancelled').length;
  return {
    id: entry.id,
    kind: entry.kind,
    start: start.t,
    durationMs: Math.max(0, Date.parse(end.t) - Date.parse(start.t)),
    provider: start.provider ?? '',
    model: start.modelId ?? '',
    turns: toolTurns.length,
    tools: toolTurns.reduce((sum, record) => sum + (Number(record.toolCallsThisTurn) || 0), 0) + failed,
    rounds: all(entry, 'chat_timing').reduce((sum, record) => sum + (Array.isArray(record.rounds) ? record.rounds.length : 0), 0),
    terminal: (first(entry, 'session_end') ?? {}).reason ?? 'open',
  };
}

function pickSession(idOrLatest) {
  const cutoff = sinceMs();
  const sessions = readSessions(cutoff);
  if (sessions.size === 0) { process.stderr.write(`no sessions in ${join(root, 'logs')}\n`); process.exit(1); }
  if (idOrLatest === undefined || idOrLatest === 'latest') {
    const list = [...sessions.values()].sort((a, b) => Date.parse(b.records[b.records.length - 1].t) - Date.parse(a.records[a.records.length - 1].t));
    return list[0];
  }
  const entry = sessions.get(idOrLatest) ?? [...sessions.values()].find(candidate => candidate.id.startsWith(idOrLatest));
  if (!entry) { process.stderr.write(`no session ${idOrLatest} in ${join(root, 'logs')}\n`); process.exit(1); }
  return entry;
}

const day = ISO => new Date(ISO).toISOString().slice(0, 10);
const clock = ISO => new Date(ISO).toISOString().slice(11, 23);
const duration = ms => ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m`;

function table(headers, rows) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => String(row[index] ?? '').length)));
  const line = cells => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ').trimEnd();
  return [line(headers), line(widths.map(width => '-'.repeat(width))), ...rows.map(line)];
}

function emit(lines, payload) {
  if (options.json) { process.stdout.write(JSON.stringify(payload ?? lines, null, 2) + '\n'); return; }
  const capped = lines.slice(0, Math.max(1, options.lines));
  if (lines.length > capped.length) capped.push(`[${lines.length - capped.length} more lines, raise with --lines ${options.lines}]`);
  process.stdout.write(capped.join('\n') + '\n');
}

// ---------- commands ----------

function cmdSessions() {
  const cutoff = sinceMs();
  const sessions = [...readSessions(cutoff).values()].filter(entry => options.kind === undefined || entry.kind === options.kind);
  const rows = sessions.map(entry => {
    const summary = summarise(entry);
    return [summary.id.slice(0, 26), summary.kind, `${day(summary.start)} ${clock(summary.start)}`, duration(summary.durationMs),
      summary.provider, summary.turns, summary.tools, summary.terminal];
  }).sort((a, b) => a[2] < b[2] ? 1 : -1);
  if (options.json) return emit([], sessions.map(summarise));
  emit(rows.length === 0 ? [`no sessions in ${join(root, 'logs')}${options.since ? ` since ${options.since}` : ''}`]
    : ['', ...table(['SESSION', 'KIND', 'STARTED', 'DURATION', 'PROVIDER', 'TURNS', 'TOOLS', 'TERMINAL'], rows)]);
}

function cmdTools() {
  const entry = pickSession(positional[0]);
  const rows = [];
  for (const record of entry.records) {
    if (record.event === 'live_tool_turn') {
      const latencies = Array.isArray(record.toolLatencyMs) ? record.toolLatencyMs : [];
      if (latencies.length === 0) rows.push({ at: record.t, event: record.event, call: '-', ms: null });
      for (const ms of latencies) rows.push({ at: record.t, event: record.event, call: '-', ms });
    }
    if (record.event === 'tool_failure' || record.event === 'tool_cancelled' || record.event === 'tool_ceiling_hit') {
      rows.push({ at: record.t, event: record.event, call: String(record.tool ?? record.callId ?? '-'), ms: record.ms ?? record.inFlightMs ?? null });
    }
  }
  if (options.json) return emit([], rows);
  const rendered = rows.map(row => [`${day(row.at)} ${clock(row.at)}`, row.event, row.call, row.ms ?? '-']);
  emit(rendered.length === 0 ? [`no tool receipts in ${entry.id}`]
    : [`session ${entry.id}: ${rendered.length} tool receipts`, '', ...table(['TIME', 'EVENT', 'CALL', 'MS'], rendered)]);
}

/** The receipts host.log keeps for things that went wrong: a closed set of event names, never a message. */
const FAILURE_EVENTS = new Set(['host_error', 'live_provider_error', 'provider_error_unclassified', 'connector_failure',
  'turn_failed', 'tool_failure', 'tool_cancelled', 'tool_ceiling_hit', 'tool_ceiling_late', 'live_trace_rejected',
  'command_rejected', 'live_dead_air_nudge', 'live_rebuild']);
/** L8-Q04: an ask-to-audio gap this long is dead air, not a pause; a shorter one is an ordinary turn. */
const DEAD_AIR_FAILURE_MS = 5_000;

function failureRecord(record) {
  if (FAILURE_EVENTS.has(record.event)) return true;
  if (record.event === 'session_end') return record.reason !== undefined && record.reason !== 'ended';
  if (record.event === 'live_dead_air') return typeof record.deadAirMs === 'number' ? record.deadAirMs >= DEAD_AIR_FAILURE_MS : typeof record.msSinceAudible === 'number';
  // L8-Q04: a native action that did not open is a refusal or a failure.
  if (record.event === 'native_action') return record.code !== 'opened';
  return false;
}

function commandFailures(cutoff) {
  const rows = [];
  for (const record of readHostLog(cutoff)) {
    if (!failureRecord(record)) continue;
    const id = typeof record.liveSessionId === 'string' ? record.liveSessionId : typeof record.runId === 'string' ? record.runId : '-';
    const detail = [record.code, record.kind, record.tool, record.reason, record.trigger, record.action].filter(value => typeof value === 'string').join('/')
      || [record.deadAirMs, record.msSinceAudible, record.elapsedMs].filter(value => typeof value === 'number').map(ms => `${ms}ms`).join('/');
    rows.push({ at: record.at, session: id, kind: record.event, detail });
  }
  return rows.sort((a, b) => a.at - b.at);
}

function cmdErrors() {
  const rows = commandFailures(sinceMs());
  if (options.json) return emit([], rows);
  const rendered = rows.map(row => [`${day(new Date(row.at).toISOString())} ${clock(new Date(row.at).toISOString())}`, row.session.slice(0, 26), row.kind, row.detail]);
  emit(rendered.length === 0 ? ['no failures recorded'] : ['', ...table(['TIME', 'SESSION', 'EVENT', 'DETAIL'], rendered)]);
}

function cmdSlow() {
  const rows = [];
  for (const entry of readSessions(sinceMs()).values()) {
    for (const record of entry.records) {
      if (record.event === 'live_tool_turn' && Array.isArray(record.toolLatencyMs)) {
        for (const ms of record.toolLatencyMs) if (ms >= options.over) rows.push({ at: record.t, session: entry.id, what: 'tool', ms });
      }
      if (record.event === 'chat_timing') {
        for (const [what, ms] of [['answer', record.answerMs], ['fence', record.fenceMs]]) {
          if (typeof ms === 'number' && ms >= options.over) rows.push({ at: record.t, session: entry.id, what: `chat_${what}`, ms });
        }
      }
      if (record.event === 'live_stall' && typeof record.silentMs === 'number' && record.silentMs >= options.over) {
        rows.push({ at: record.t, session: entry.id, what: 'silence', ms: record.silentMs });
      }
    }
  }
  rows.sort((a, b) => b.ms - a.ms);
  if (options.json) return emit([], rows);
  const rendered = rows.map(row => [`${day(row.at)} ${clock(row.at)}`, row.session.slice(0, 26), row.what, duration(row.ms)]);
  emit(rendered.length === 0 ? [`nothing over ${options.over}ms`] : ['', ...table(['TIME', 'SESSION', 'WHAT', 'MS'], rendered)]);
}

function cmdNative() {
  const entry = pickSession(positional[0]);
  const from = new Date(Date.parse(entry.records[0].t) - 2_000).toISOString();
  const to = new Date(Date.parse(entry.records[entry.records.length - 1].t) + 2_000).toISOString();
  const predicate = `subsystem == "${process.env.NAYA_LOG_SUBSYSTEM ?? APP_SUBSYSTEM}"`;
  let output;
  try {
    output = execFileSync(process.env.NAYA_LOG_BIN ?? '/usr/bin/log', ['show', '--predicate', predicate, '--start', from, '--end', to, '--style', 'compact', '--info', '--debug'], { encoding: 'utf8', timeout: 120_000 });
  } catch (error) {
    process.stderr.write(`log show failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown'}\n`);
    process.exit(1);
  }
  const lines = output.split('\n').filter(line => line.trim() && !line.startsWith('Filtering the log data') && !line.startsWith('Timestamp '));
  if (options.json) return emit([], { session: entry.id, window: { from, to }, predicate, lines });
  emit(lines.length === 0 ? [`no app log records for ${entry.id}`] : [`app log for ${entry.id}, ${from} to ${to}`, '', ...lines]);
}

switch (command) {
  case 'sessions': cmdSessions(); break;
  case 'tools': cmdTools(); break;
  case 'errors': cmdErrors(); break;
  case 'slow': cmdSlow(); break;
  case 'native': cmdNative(); break;
  default: process.stderr.write(`unknown command ${command}\n\n${usage}`); process.exit(2);
}
