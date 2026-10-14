#!/usr/bin/env node
// W10 read-only call timeline: merge host and native jsonl logs for one call.
// No SQLite, no pruning, no writes. Prints or serializes the ordered events.
//
// Usage:
//   node scripts/call-timeline.mjs --last [--json] [--dir <logs dir>]
//   node scripts/call-timeline.mjs --session <liveSessionId> [--json]
//   node scripts/call-timeline.mjs --attempt <attemptId> [--json]
//
// A call is the union of lines that share any of launchId / attemptId / liveSessionId.
// Lines are ordered by ts across processes and by mono within a process.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const KEY_FIELDS = ['launchId', 'attemptId', 'liveSessionId'];
const LOG_FILES = ['host.log', 'host.log.1', 'host.log.2', 'native-live.log', 'native-live.log.1', 'native-live.log.2'];

function defaultLogsDir() {
  if (process.env.LUX_LOGS_DIR) return process.env.LUX_LOGS_DIR;
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Lux Didi', 'logs');
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Lux Didi', 'logs');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'lux-didi', 'logs');
}

function parseArgs(argv) {
  const options = { mode: null, id: null, json: false, dir: defaultLogsDir() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--last') options.mode = 'last';
    else if (arg === '--json') options.json = true;
    else if (arg === '--session' || arg === '--attempt') { options.mode = arg === '--session' ? 'session' : 'attempt'; options.id = argv[++index] ?? null; }
    else if (arg === '--dir') options.dir = argv[++index] ?? options.dir;
    else if (arg === '--help' || arg === '-h') options.mode = 'help';
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function readLines(dir) {
  const lines = [];
  for (const name of LOG_FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let record;
      try { record = JSON.parse(raw); } catch { continue; }
      if (!record || typeof record !== 'object' || typeof record.event !== 'string') continue;
      lines.push({ ...record, _file: name });
    }
  }
  // Newest first so union ordering and --last are stable.
  return lines;
}

function tsOf(record) {
  const value = record.ts ?? record.timestamp;
  return typeof value === 'string' ? value : '';
}

class Union {
  constructor() { this.parent = new Map(); }
  find(key) {
    if (!this.parent.has(key)) { this.parent.set(key, key); return key; }
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(key) !== root) { const next = this.parent.get(key); this.parent.set(key, root); key = next; }
    return root;
  }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

function group(lines) {
  const union = new Union();
  const indexKeys = lines.map((line, position) => {
    const keys = KEY_FIELDS.filter(field => typeof line[field] === 'string' && line[field]).map(field => `${field}:${line[field]}`);
    keys.forEach(key => union.find(key));
    for (let i = 1; i < keys.length; i += 1) union.union(keys[0], keys[i]);
    return { keys, position };
  });
  const groups = new Map();
  indexKeys.forEach(({ keys, position }) => {
    if (!keys.length) return;
    const root = union.find(keys[0]);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(lines[position]);
  });
  return { groups, union, indexKeys };
}

function orderLines(lines) {
  return [...lines].sort((a, b) => {
    const ta = tsOf(a), tb = tsOf(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    const pa = String(a.process ?? ''), pb = String(b.process ?? '');
    if (pa !== pb) return pa < pb ? -1 : 1;
    const ma = typeof a.mono === 'number' ? a.mono : 0, mb = typeof b.mono === 'number' ? b.mono : 0;
    return ma - mb;
  });
}

function selectGroup(lines, options) {
  const { groups, union } = group(lines);
  if (options.mode === 'last') {
    let best = null, bestTs = '';
    for (const selected of groups.values()) {
      for (const line of selected) { const ts = tsOf(line); if (ts >= bestTs) { bestTs = ts; best = selected; } }
    }
    return best ? orderLines(best) : [];
  }
  const field = options.mode === 'session' ? 'liveSessionId' : 'attemptId';
  if (options.id === null) throw new Error(`${options.mode} requires an id`);
  const keys = groups.values();
  void union;
  for (const selected of keys) {
    if (selected.some(line => line[field] === options.id)) return orderLines(selected);
  }
  return [];
}

function render(line) {
  const ts = tsOf(line);
  const mono = typeof line.mono === 'number' ? String(line.mono).padStart(10, ' ') : '         -';
  const process = String(line.process ?? (line._file.startsWith('native') ? 'native' : 'host')).padEnd(6);
  const extras = Object.entries(line)
    .filter(([key]) => !['ts', 'timestamp', 'mono', 'level', 'process', 'event', '_file'].includes(key))
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' ');
  return `${ts} ${mono} ${process} ${line.event}${extras ? ' ' + extras : ''}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'help' || options.mode === null) {
    process.stdout.write('usage: call-timeline.mjs --last | --session <id> | --attempt <id> [--json] [--dir <logs>]\n');
    return;
  }
  const lines = readLines(options.dir);
  const selected = selectGroup(lines, options);
  if (options.json) process.stdout.write(JSON.stringify(selected, null, 1) + '\n');
  else process.stdout.write(selected.map(render).join('\n') + (selected.length ? '\n' : ''));
}

main();
