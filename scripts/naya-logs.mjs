#!/usr/bin/env node
// naya-logs: read the private debug journal and host.log, fast. Read-only, no dependencies.
// The journal holds owner content. This tool prints it locally and never sends it anywhere;
// see docs/debugging.md for the privacy rule.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LINE_LIMIT = 200;
const APP_SUBSYSTEM = 'ai.lux.didi';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const usage = `naya-logs <command> [options]

  sessions [--since 24h] [--kind live|chat]   one row per session
  timeline <id|latest> [--content]            millisecond timeline, journal plus host.log
  tools <id|latest>                           each tool call: args, ms, outcome, result size
  errors [--since 24h]                        every recorded failure
  slow [--since 24h] [--over 5000]            model rounds and tools over the threshold
  native <id|latest>                          the app's own OS log records for the session window

  --data-dir <path>   override the host data directory
  --json              machine-readable output
  --lines <n>         raise or lower the 200 line cap
`;

// ---------- arguments ----------

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { process.stdout.write(usage); process.exit(argv.length === 0 ? 2 : 0); }
const command = argv[0];
const positional = [];
const options = { content: false, json: false, since: undefined, kind: undefined, over: 5000, dataDir: undefined, lines: LINE_LIMIT };
for (let i = 1; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--content') options.content = true;
  else if (arg === '--json') options.json = true;
  else if (arg === '--since') options.since = argv[++i];
  else if (arg === '--kind') options.kind = argv[++i];
  else if (arg === '--over') options.over = Number(argv[++i]);
  else if (arg === '--data-dir') options.dataDir = argv[++i];
  else if (arg === '--lines') options.lines = Number(argv[++i]);
  else if (arg.startsWith('--')) { process.stderr.write(`unknown option ${arg}\n`); process.exit(2); }
  else positional.push(arg);
}

// ---------- the data directory, resolved exactly as the host resolves it ----------

function dataDirectory() {
  if (options.dataDir !== undefined) return options.dataDir;
  const state = process.env.DIDI_STATE_DIR;
  if (state) return state;
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, 'lux-didi');
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
const debugRoot = join(root, 'debug');

function dayDirectories(cutoff) {
  if (!existsSync(debugRoot)) return [];
  return readdirSync(debugRoot).filter(name => DAY.test(name)).sort()
    .filter(day => cutoff === 0 || Date.parse(`${day}T23:59:59.999Z`) >= cutoff);
}

function readJournal(cutoff, onlyId) {
  const sessions = new Map();
  for (const day of dayDirectories(cutoff)) {
    let names;
    try { names = readdirSync(join(debugRoot, day)); } catch { continue; }
    for (const name of names) {
      const match = /^(live|chat)-(.+)\.jsonl$/.exec(name);
      if (!match) continue;
      if (onlyId !== undefined && match[2] !== onlyId) continue;
      let text;
      try { text = readFileSync(join(debugRoot, day, name), 'utf8'); } catch { continue; }
      const records = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (typeof record.t !== 'string') continue;
          if (cutoff !== 0 && Date.parse(record.t) < cutoff) continue;
          records.push(record);
        } catch { /* a torn final line is skipped, never a fatal error */ }
      }
      if (records.length === 0) continue;
      const existing = sessions.get(match[2]);
      const entry = { id: match[2], kind: match[1], day, records };
      if (existing) existing.records = existing.records.concat(records);
      else sessions.set(match[2], entry);
    }
  }
  for (const entry of sessions.values()) entry.records.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return sessions;
}

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

// ---------- shaping ----------

const first = (entry, event) => entry.records.find(record => record.event === event);
const all = (entry, event) => entry.records.filter(record => record.event === event);

function summarise(entry) {
  const start = entry.records[0];
  const end = first(entry, 'session_end') ?? entry.records[entry.records.length - 1];
  const startedAt = Date.parse(start.t);
  const endedAt = Date.parse(end.t);
  return {
    id: entry.id,
    kind: entry.kind,
    start: start.t,
    durationMs: Math.max(0, endedAt - startedAt),
    provider: start.provider ?? '',
    model: start.model ?? '',
    turns: all(entry, 'turn_start').length,
    tools: all(entry, 'tool').length,
    rounds: all(entry, 'model_round').length,
    terminal: (first(entry, 'session_end') ?? {}).code ?? 'open',
  };
}

function pickSession(idOrLatest) {
  const cutoff = sinceMs();
  const sessions = readJournal(cutoff);
  if (sessions.size === 0) { process.stderr.write(`no journal sessions under ${debugRoot}\n`); process.exit(1); }
  if (idOrLatest === undefined || idOrLatest === 'latest') {
    const list = [...sessions.values()].sort((a, b) => Date.parse(b.records[b.records.length - 1].t) - Date.parse(a.records[a.records.length - 1].t));
    return list[0];
  }
  const entry = sessions.get(idOrLatest);
  if (!entry) { process.stderr.write(`no session ${idOrLatest} under ${debugRoot}\n`); process.exit(1); }
  return entry;
}

// ---------- formatting ----------

const clock = ISO => new Date(ISO).toISOString().slice(11, 23);
const day = ISO => new Date(ISO).toISOString().slice(0, 10);
const duration = ms => ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;

function table(headers, rows) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => String(row[index] ?? '').length)));
  const line = cells => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ').trimEnd();
  return [line(headers), line(widths.map(width => '-'.repeat(width))), ...rows.map(line)];
}

function emit(lines, payload) {
  if (options.json) { process.stdout.write(JSON.stringify(payload ?? lines, null, 2) + '\n'); return; }
  const capped = lines.slice(0, Math.max(1, options.lines));
  if (lines.length > capped.length) capped.push(`[${lines.length - capped.length} more lines, raise with --lines ${lines.length}]`);
  process.stdout.write(capped.join('\n') + '\n');
}

const content = (text) => options.content ? String(text) : `[${String(text ?? '').length} chars hidden, --content]`;

// ---------- commands ----------

function cmdSessions() {
  const cutoff = sinceMs();
  const sessions = [...readJournal(cutoff).values()].filter(entry => options.kind === undefined || entry.kind === options.kind);
  const rows = sessions.map(entry => {
    const summary = summarise(entry);
    return [summary.id.slice(0, 26), summary.kind, `${day(summary.start)} ${clock(summary.start)}`, duration(summary.durationMs),
      summary.provider, summary.turns, summary.tools, summary.terminal];
  }).sort((a, b) => a[2] < b[2] ? 1 : -1);
  if (options.json) return emit([], sessions.map(summarise));
  emit(rows.length === 0 ? [`no sessions under ${debugRoot}${options.since ? ` since ${options.since}` : ''}`] : ['', ...table(['ID', 'KIND', 'START', 'DURATION', 'PROVIDER', 'TURNS', 'TOOLS', 'TERMINAL'], rows), '']);
}

function cmdTimeline() {
  const entry = pickSession(positional[0]);
  const startedAt = Date.parse(entry.records[0].t);
  const lines = [];
  const payload = [];
  const merged = [];
  for (const record of entry.records) merged.push({ at: Date.parse(record.t), source: 'journal', record });
  // host.log records that name this session, plus the session-less global records inside its window.
  const window = { from: startedAt, to: Date.parse(entry.records[entry.records.length - 1].t) };
  for (const record of readHostLog(0)) {
    const names = record.liveSessionId === entry.id;
    const global = record.liveSessionId === undefined && record.at >= window.from && record.at <= window.to;
    if (names || global) merged.push({ at: record.at, source: 'host.log', record });
  }
  merged.sort((a, b) => a.at - b.at);
  for (const item of merged) {
    const offset = `${item.at - startedAt}ms`.padStart(9);
    const record = item.record;
    const event = record.event ?? '';
    const detail = [];
    for (const [key, value] of Object.entries(record)) {
      if (['t', 'mono', 'kind', 'sessionId', 'generation', 'event', 'timestamp', 'pid', 'at'].includes(key)) continue;
      if (key === 'instructions' || key === 'text' || key === 'result') { detail.push(`${key}=${content(value)}`); continue; }
      if (typeof value === 'string' && value.length > 96) { detail.push(`${key}=${options.content ? value : `${value.slice(0, 96)}...`}`); continue; }
      detail.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
    }
    payload.push({ offsetMs: item.at - startedAt, source: item.source, event, fields: record });
    lines.push(`${offset}  ${clock(record.t ?? record.timestamp)}  ${item.source.padEnd(8)}  ${event.padEnd(16)}  ${detail.join(' ')}`);
  }
  if (options.json) return emit([], payload);
  emit(lines.length === 0 ? [`no records for ${entry.id}`] : [`session ${entry.id} (${entry.kind})`, ...lines]);
}

function cmdTools() {
  const entry = pickSession(positional[0]);
  const calls = all(entry, 'tool');
  const rows = calls.map((call, index) => [index + 1, String(call.tool), call.ms, call.outcome, call.resultChars,
    options.content ? JSON.stringify(call.args) : JSON.stringify(call.args).slice(0, 80)]);
  if (options.json) return emit([], calls);
  emit(rows.length === 0 ? [`no tool calls in ${entry.id}`]
    : [`session ${entry.id}: ${rows.length} tool calls`, '', ...table(['#', 'TOOL', 'MS', 'OUTCOME', 'CHARS', 'ARGS'], rows)]);
}

function failures(entry) {
  const found = [];
  for (const record of entry.records) {
    if (record.event === 'provider_error') found.push({ at: Date.parse(record.t), session: entry.id, kind: entry.kind, event: 'provider_error', detail: String(record.message ?? '') });
    if (record.event === 'session_end' && record.code !== 'closed' && record.code !== 'complete') found.push({ at: Date.parse(record.t), session: entry.id, kind: entry.kind, event: 'session_end', detail: String(record.code) });
    if (record.event === 'tool' && record.outcome !== 'completed') found.push({ at: Date.parse(record.t), session: entry.id, kind: entry.kind, event: 'tool', detail: `${record.tool} ${record.outcome}` });
    if (record.event === 'deadline') found.push({ at: Date.parse(record.t), session: entry.id, kind: entry.kind, event: 'deadline', detail: `${record.name} ${record.configuredMs}ms` });
    if (record.event === 'recovery') found.push({ at: Date.parse(record.t), session: entry.id, kind: entry.kind, event: 'recovery', detail: `${record.path} ${record.code}` });
  }
  return found;
}

function cmdErrors() {
  const cutoff = sinceMs();
  const rows = [];
  for (const entry of readJournal(cutoff).values()) for (const failure of failures(entry)) rows.push(failure);
  for (const record of readHostLog(cutoff)) {
    if (record.event === 'debug_journal_error') rows.push({ at: record.at, session: '-', kind: '-', event: 'debug_journal_error', detail: String(record.code) });
    if (record.event === 'host_error') rows.push({ at: record.at, session: record.liveSessionId ?? '-', kind: '-', event: 'host_error', detail: `${record.class}${record.code ? ` ${record.code}` : ''}` });
  }
  rows.sort((a, b) => a.at - b.at);
  if (options.json) return emit([], rows);
  const rendered = rows.map(row => [`${day(new Date(row.at).toISOString())} ${clock(new Date(row.at).toISOString())}`, row.session.slice(0, 26), row.kind, row.event, row.detail.slice(0, 100)]);
  emit(rendered.length === 0 ? ['no failures recorded'] : ['', ...table(['TIME', 'SESSION', 'KIND', 'EVENT', 'DETAIL'], rendered), '']);
}

function cmdSlow() {
  const cutoff = sinceMs();
  const rows = [];
  for (const entry of readJournal(cutoff).values()) {
    for (const round of all(entry, 'model_round')) {
      const ms = Number(round.requestMs ?? 0) + Number(round.responseMs ?? 0);
      if (ms >= options.over) rows.push({ at: Date.parse(round.t), session: entry.id, kind: entry.kind, what: `round ${round.round}`, ms, detail: round.stopReason ?? '' });
    }
    for (const call of all(entry, 'tool')) {
      if (Number(call.ms) >= options.over) rows.push({ at: Date.parse(call.t), session: entry.id, kind: entry.kind, what: `tool ${call.tool}`, ms: Number(call.ms), detail: `${call.outcome} ${call.resultChars} chars` });
    }
  }
  rows.sort((a, b) => b.ms - a.ms);
  if (options.json) return emit([], rows);
  const rendered = rows.map(row => [row.session.slice(0, 26), row.kind, row.what.slice(0, 32), row.ms, row.detail.slice(0, 60)]);
  emit(rendered.length === 0 ? [`nothing over ${options.over}ms`] : ['', ...table(['SESSION', 'KIND', 'WHAT', 'MS', 'DETAIL'], rendered), '']);
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
  case 'timeline': cmdTimeline(); break;
  case 'tools': cmdTools(); break;
  case 'errors': cmdErrors(); break;
  case 'slow': cmdSlow(); break;
  case 'native': cmdNative(); break;
  default: process.stderr.write(`unknown command ${command}\n\n${usage}`); process.exit(2);
}
