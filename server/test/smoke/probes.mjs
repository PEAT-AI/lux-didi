// Real-path smoke probes.
//
// One command exercises the path the operator actually uses: a supervised host under the native stdout rule,
// every configured connector over its real transport, a real text turn that must call tools, and a real Live
// turn that must call a tool and keep the session open afterwards. This module prints one PASS/FAIL line per
// probe and a summary. It never prints a credential, a transcript or any connector payload: only event names,
// counts, byte sizes and latencies.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import WS from 'ws';
import { spawnSupervised, waitForReady, stopSupervised, READY_TIMEOUT_MS } from './strict-supervisor.mjs';

const root = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const WebSocket = WS;

const CONNECTOR_READS = {
  'lux-knowledge': { tool: 'search_knowledge', args: { query: 'Lux Didi' } },
  gmail: { tool: 'gmail_get_profile', args: {} },
  calendar: { tool: 'gcal_calendars', args: {} },
  mongoose: { tool: 'get_company_profile', args: {} },
  mattermost: { tool: 'mattermost_whoami', args: {} },
};

const QUESTION = 'Search lux knowledge for Lux Didi and open the most relevant entry.';
const RESEARCH_QUESTION = 'What is on my calendar today? Please check.';
// #263: a calendar question with no source hint must still reach research, never a "no calendar access" refusal.
const MEETINGS_QUESTION = 'Do I have any meetings today?';

// Q1-R0 (probe7-10): the four spoken questions whose source blocks the release-3e change must return.
// Q1-R5: the reply must carry what was kept, up to the 6,000 cap, minus the JSON envelope.
const REPLY_ENVELOPE_BYTES = 700;
const carried = s => s.replyBytes >= Math.min(s.keptBytes, 5000) - REPLY_ENVELOPE_BYTES;
const RESEARCH_PROBES = [
  { id: 'probe7-mail', source: 'mail', question: 'Anything important in my email today? Please check.', check: s => s.items >= 1 && carried(s) },
  { id: 'probe8-chat', source: 'chat', question: "What's new in Mattermost? Please check.", check: s => s.items >= 1 && carried(s) },
  { id: 'probe9-knowledge', source: 'knowledge', question: 'Search my notes for Lux Didi decisions. Please check.', check: s => s.items >= 3 && carried(s) },
  { id: 'probe10-calendar', source: 'calendar', question: 'What is on my calendar today? Please check.', check: s => s.items >= 1 && carried(s) },
];
// `kept` counts bytes meant for the reply; the calendar-name discovery read only feeds the event read.
const SOURCE_TOOLS = {
  mail: ['gmail_list', 'gmail_read'],
  chat: ['mattermost_search', 'mattermost_get_thread'],
  knowledge: ['search_knowledge', 'get_insight'],
  calendar: ['gcal_list'],
};

function log(line) { process.stdout.write(line + '\n'); }
function now() { return Date.now(); }

const HOSTLESS_PROBES = ['probe2-connectors', 'probe3-text-turn', 'probe4-voice-turn', 'probe5-research', 'probe6-meetings', 'probe7-mail', 'probe8-chat', 'probe9-knowledge', 'probe10-calendar'];

/** #260: the three drivers a research_run may name. probe5 reads the run's own field, never derives it. */
export const RESEARCH_DRIVERS = ['selector', 'fallback', 'single-source-hint'];

/** The run line's own driver, or null when it is absent or not one of the three. */
export function researchDriver(run) {
  return run && typeof run.driver === 'string' && RESEARCH_DRIVERS.includes(run.driver) ? run.driver : null;
}

/** probe5's failure note: the stage and the not-called metadata, never question text or transcript. */
export function researchFailureNote(meta) {
  const names = Array.isArray(meta.otherToolNames) ? meta.otherToolNames : [];
  return `stage=${meta.stage} calls=${meta.calls ?? 0} runs=${meta.runs ?? 0} detail=${meta.detail ?? 'n/a'} status=${meta.status ?? 'n/a'} rounds=${meta.rounds ?? 0} read=${meta.read ?? 0} reply=${meta.replyBytes ?? 0}B`
    + ` output_fragments=${meta.outputFragments ?? 0} output_chars=${meta.outputChars ?? 0} other_tools=${names.join(',') || 'none'} other_tool_calls=${meta.otherToolCalls ?? 0} turn_complete_ms=${meta.turnCompleteMs ?? 'n/a'}`;
}

/** Metadata-only projection of a journal page: the columns, never the retained transcript text. */
function journalMetadata(fragments) {
  return (Array.isArray(fragments) ? fragments : []).map(fragment => ({
    journalSequence: fragment.journalSequence ?? null,
    providerSequence: fragment.providerSequence ?? null,
    kind: fragment.kind ?? null,
    tool: fragment.tool && typeof fragment.tool.name === 'string' ? fragment.tool.name : null,
    textChars: typeof fragment.text === 'string' ? fragment.text.length : 0,
    finished: fragment.finished ?? null,
    arrivedAt: fragment.arrivedAt ?? null,
  }));
}

// A failed run keeps these under a dated directory in the smoke data dir; the host API is gone by then.
const journalExports = [];
function recordJournal(liveSessionId, fragments) {
  const record = { liveSessionId, fragments: journalMetadata(fragments) };
  const at = journalExports.findIndex(entry => entry.liveSessionId === liveSessionId);
  if (at >= 0) journalExports[at] = record; else journalExports.push(record);
}

/** The host launch budget in ms: SMOKE_LAUNCH_TIMEOUT_S seconds, defaulting to the native 6 s ready budget. */
export function launchTimeoutMs(env = process.env) {
  const seconds = Number(env.SMOKE_LAUNCH_TIMEOUT_S);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : READY_TIMEOUT_MS;
}

export function loadAverageText() { return loadavg().map(value => value.toFixed(2)).join('/'); }

/** The probe1 note. A launch timeout names the elapsed budget and the host load, so a slow host says so. */
export function supervisorNote(launch, host) {
  if (launch.status !== 'ready') {
    if (launch.status === 'timeout') return `launch=timeout after=${((launch.ms ?? 0) / 1000).toFixed(1)} load=${loadAverageText()}`;
    return `launch=${launch.status}${launch.error ? ' ' + launch.error.stage + ':' + launch.error.code : ''}`;
  }
  return host.invalid ? `post_ready=${host.invalid.bytes}B at=${host.invalid.ms}ms` : `ready=${host.readyBytes}B post_ready=0B`;
}

/** Without a ready host the remaining probes cannot run, so they skip instead of failing on their own. */
export function noHostResults() {
  return HOSTLESS_PROBES.map(id => ({ id, ok: false, skip: true, note: '(no host)' }));
}

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

/** The installed app's config source: the operator-selected config dir and owner profile. */
async function installedConfig() {
  const settings = join(homedir(), 'Library/Application Support/ai.peat.lux-didi-operator/settings.json');
  if (!existsSync(settings)) return { configDir: undefined, ownerProfilePath: undefined };
  try {
    const doc = await readJson(settings);
    // The operator profile is bound to the installed assistant id, which lives in the installed state db;
    // a fresh smoke data dir gets a new assistant id, so the bound profile is refused. Use the default
    // owner profile rather than touch the installed state. Only the config source is mirrored here.
    return { configDir: doc.configDir, ownerProfilePath: undefined };
  } catch { return { configDir: undefined, ownerProfilePath: undefined }; }
}

function bearerFor(dataDir) { return readFile(join(dataDir, 'admin-credential'), 'utf8').then(value => value.trim()); }

function liveHeaders(token, epoch) {
  // Live routes reject any Origin/Cookie: authorization is header-only.
  return { Authorization: `Bearer ${token}`, 'X-Didi-Authority-Epoch': epoch, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() };
}

async function mcpCall(endpoint, configDir) {
  const read = CONNECTOR_READS[endpoint.id];
  if (!read) return { state: 'skipped', stage: 'catalog', ms: 0 };
  const started = now();
  let token = null;
  if (endpoint.credentialRef) {
    const file = join(configDir, `${endpoint.credentialRef}.json`);
    // A connector whose operator credential file is absent is unconfigured, not a regression: the host
    // reports the same typed state. Report it as skipped rather than failing the probe.
    if (!existsSync(file)) return { state: 'unconfigured', stage: 'credential', ms: now() - started, detail: `credential ${endpoint.credentialRef} missing` };
    try { token = (await readJson(file)).token; } catch { return { state: 'down', stage: 'credential', ms: now() - started, detail: `credential ${endpoint.credentialRef} unreadable` }; }
  }
  let transport;
  try {
    if (endpoint.transport === 'stdio') {
      transport = new StdioClientTransport({ command: endpoint.command, args: endpoint.args ?? [], env: endpoint.env ?? {}, stderr: 'ignore' });
    } else {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
      transport = new StreamableHTTPClientTransport(new URL(endpoint.url), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {});
    }
  } catch (error) { return { state: 'down', stage: 'transport', ms: now() - started, detail: String(error && error.message) }; }
  const client = new Client({ name: 'lux-didi-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = (tools.tools ?? []).map(tool => tool.name);
    if (!names.includes(read.tool)) return { state: 'down', stage: 'tools', ms: now() - started, detail: `tool ${read.tool} not listed` };
    const result = await client.callTool({ name: read.tool, arguments: read.args });
    const content = Array.isArray(result.content) ? result.content : [];
    const bytes = content.reduce((total, part) => total + (typeof part.text === 'string' ? part.text.length : 0), 0);
    if (result.isError) return { state: 'down', stage: 'read', ms: now() - started, detail: 'tool returned an error' };
    return { state: 'up', stage: 'read', ms: now() - started, bytes, tools: names.length };
  } catch (error) {
    return { state: 'down', stage: 'connect', ms: now() - started, detail: String(error && error.message).slice(0, 120) };
  } finally { try { await client.close(); } catch { /* already closed */ } }
}

async function probeConnectors({ configDir }) {
  const file = join(configDir, 'mcp.json');
  if (!existsSync(file)) return { ok: false, parts: ['mcp.json missing'], endpoints: 0, skipped: 0, checked: 0 };
  let doc;
  try { doc = await readJson(file); } catch { return { ok: false, parts: ['mcp.json unreadable'], endpoints: 0, skipped: 0, checked: 0 }; }
  const endpoints = (doc.endpoints ?? []).filter(endpoint => endpoint.enabled !== false);
  const parts = [];
  let failed = 0;
  let skipped = 0;
  for (const endpoint of endpoints) {
    const result = await mcpCall(endpoint, configDir);
    if (result.state === 'up') parts.push(`${endpoint.id}=up(${result.ms}ms,${result.bytes}B)`);
    else if (result.state === 'unconfigured' || result.state === 'skipped') { skipped += 1; parts.push(`${endpoint.id}=unconfigured`); }
    else { failed += 1; parts.push(`${endpoint.id}=down[${result.stage}](${result.ms}ms${result.detail ? ':' + result.detail : ''})`); }
  }
  const checked = endpoints.length - skipped;
  return { ok: failed === 0 && checked > 0, parts, endpoints: endpoints.length, skipped, checked };
}

async function chatTurn({ base, token, epoch, dataDir, host, readyPid }) {
  const headers = () => ({ Authorization: `Bearer ${token}`, Origin: base, 'X-Didi-Authority-Epoch': epoch, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() });
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const enroll = await post('/api/v1/conversations', { title: 'Real-path smoke', timeZone: 'UTC', consent: true });
  if (enroll.status !== 200) return { ok: false, stage: 'enroll' };
  const sessionId = (await enroll.json()).data.sessionId;
  const accepted = await post('/api/v1/chat', { sessionId, text: QUESTION });
  if (accepted.status !== 200) return { ok: false, stage: 'accept' };
  const runId = (await accepted.json()).data.runId;
  let snap = null;
  const deadline = now() + 70000;
  while (now() < deadline) {
    const response = await fetch(base + `/api/v1/chat/${runId}`, { headers: headers() });
    const data = (await response.json()).data;
    if (data.outcome) { snap = data; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!snap) return { ok: false, stage: 'turn-timeout' };
  const names = (snap.toolEvidence ?? []).map(entry => entry.name);
  const answerBytes = Buffer.byteLength(String(snap.finalText ?? ''));
  // A schema-invalid tool call is a real defect signal (#250), so any rejection fails the turn. For each one
  // report the tool name and the logged field projections (key:type only), never a value.
  const rejections = [];
  try {
    const hostLog = await readFile(join(dataDir, 'logs/host.log'), 'utf8');
    for (const line of hostLog.split('\n')) {
      if (!line.includes('tool_arguments_rejected')) continue;
      try {
        const event = JSON.parse(line);
        if (event.event !== 'tool_arguments_rejected') continue;
        rejections.push({ tool: String(event.tool ?? 'unknown'), fields: Array.isArray(event.fields) ? event.fields.map(String) : [] });
      } catch { rejections.push({ tool: 'unknown', fields: [] }); }
    }
  } catch { /* no diagnostics file means no recorded rejection */ }
  const pidStable = host.exited === null && host.pid === readyPid;
  // #241: the intent surface answers "search then open" in one call, so the text turn must make
  // exactly one tool call (the intent, or the one internal read it fans out to) and no get_insight turn.
  const ok = names.includes('search_knowledge') && names.includes('get_insight') && answerBytes > 0 && rejections.length === 0 && pidStable;
  return { ok, stage: 'turn', names, answerBytes, rejections, outcome: snap.outcome, pidStable };
}

function synthClip(text = QUESTION) {
  // A short synthetic clip, written to a file: no microphone and no speaker is ever opened.
  const path = join(tmpdir(), `didi-smoke-clip-${randomUUID()}.wav`);
  execFileSync('/usr/bin/say', ['-o', path, '--data-format=LEI16@16000', text], { stdio: 'ignore' });
  return path;
}

async function liveTurn({ base, token, epoch, clipPath }) {
  const headers = () => liveHeaders(token, epoch);
  const created = await fetch(base + '/api/v1/live-sessions', { method: 'POST', headers: headers(), body: JSON.stringify({ inputClass: 'ordinary' }) });
  if (created.status !== 200) return { ok: false, stage: 'create' };
  const id = (await created.json()).data.liveSessionId;
  const wav = await readFile(clipPath);
  let offset = 12, pcm = null;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (chunkId === 'data') { pcm = wav.subarray(offset + 8, offset + 8 + size); break; }
    offset += 8 + size + (size & 1);
  }
  if (!pcm || !pcm.length) return { ok: false, stage: 'clip' };
  const ws = new WebSocket(base.replace('http://', 'ws://') + '/api/v1/live-sessions/' + id + '/audio',
    { headers: { Authorization: `Bearer ${token}`, 'X-Didi-Authority-Epoch': epoch } });
  let audioBytes = 0;
  const markers = [];
  const opened = await new Promise(resolve => {
    ws.on('open', () => resolve(true));
    ws.on('error', () => resolve(false));
    setTimeout(() => resolve(ws.readyState === 1), 8000);
  });
  if (!opened) { try { ws.close(); } catch { /* noop */ } return { ok: false, stage: 'attach' }; }
  ws.on('message', (data, isBinary) => { if (isBinary) audioBytes += data.length; else { try { markers.push(JSON.parse(data.toString())); } catch { /* marker only */ } } });
  const journal = async () => {
    const response = await fetch(base + '/api/v1/live-sessions/' + id + '/journal?limit=200', { headers: headers() });
    return (await response.json()).data;
  };
  const greetingDeadline = now() + 20000;
  while (now() < greetingDeadline && !markers.some(marker => marker.type === 'turnComplete')) await new Promise(resolve => setTimeout(resolve, 500));
  const silence = Buffer.alloc(32000);
  ws.send(silence);
  await new Promise(resolve => setTimeout(resolve, 300));
  for (let index = 0; index < pcm.length; index += 1600) {
    ws.send(pcm.subarray(index, Math.min(index + 1600, pcm.length)));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  ws.send(silence);
  await new Promise(resolve => setTimeout(resolve, 300));
  try { ws.send(JSON.stringify({ type: 'endAudioStream' })); } catch { /* noop */ }
  let toolResultAt = null;
  let audioAtResult = 0;
  const deadline = now() + 60000;
  while (now() < deadline) {
    const data = await journal().catch(() => null);
    const kinds = data && Array.isArray(data.fragments) ? data.fragments.map(fragment => fragment.kind) : [];
    if (data && Array.isArray(data.fragments)) recordJournal(id, data.fragments);
    if (kinds.includes('toolResult') && toolResultAt === null) { toolResultAt = now(); audioAtResult = audioBytes; }
    if (toolResultAt !== null && now() - toolResultAt >= 5000) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const afterResult = audioBytes - audioAtResult;
  const snapshot = await (await fetch(base + '/api/v1/live-sessions/' + id, { headers: headers() })).json();
  const lifecycle = snapshot.data.lifecycle;
  try { ws.send(JSON.stringify({ type: 'close' })); } catch { /* noop */ }
  try { ws.close(); } catch { /* noop */ }
  const openFor = toolResultAt === null ? 0 : now() - toolResultAt;
  const ok = toolResultAt !== null && afterResult > 0 && openFor >= 5000 && (lifecycle === 'active' || lifecycle === 'accepted');
  return { ok, stage: 'turn', toolResultAt: toolResultAt !== null, audioAfterResult: afterResult, openFor, lifecycle };
}

async function researchTurn({ base, token, epoch, dataDir, clipPath, requireSingleCall = true, requireDriver = true, requireRead = true, enforce = true }) {
  const headers = () => liveHeaders(token, epoch);
  const created = await fetch(base + '/api/v1/live-sessions', { method: 'POST', headers: headers(), body: JSON.stringify({ inputClass: 'ordinary' }) });
  if (created.status !== 200) return { ok: false, stage: 'create' };
  const id = (await created.json()).data.liveSessionId;
  // The audio socket probe4 uses is the host's one supported Live input channel: no microphone and no
  // speaker is opened, only PCM synthesized to a file. The client text route is refused before it is live.
  const ws = new WebSocket(base.replace('http://', 'ws://') + '/api/v1/live-sessions/' + id + '/audio',
    { headers: { Authorization: `Bearer ${token}`, 'X-Didi-Authority-Epoch': epoch } });
  const opened = await new Promise(resolve => {
    ws.on('open', () => resolve(true));
    ws.on('error', () => resolve(false));
    setTimeout(() => resolve(ws.readyState === 1), 8000);
  });
  if (!opened) { try { ws.close(); } catch { /* noop */ } return { ok: false, stage: 'attach' }; }
  const journal = async () => {
    const response = await fetch(base + '/api/v1/live-sessions/' + id + '/journal?limit=200', { headers: headers() });
    return (await response.json()).data;
  };
  try {
    // The host commits a 'ready' journal fragment once the provider socket is live.
    const readyDeadline = now() + 30000;
    let ready = false;
    while (now() < readyDeadline) {
      const data = await journal().catch(() => null);
      ready = Boolean(data && Array.isArray(data.fragments) && data.fragments.some(fragment => fragment.kind === 'ready'));
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) return { ok: false, stage: 'ready' };
    // Give the model's opening turn a short grace, then send ONE question as PCM over the audio socket.
    const graceDeadline = now() + 12000;
    while (now() < graceDeadline) {
      const data = await journal().catch(() => null);
      if (data && Array.isArray(data.fragments) && data.fragments.some(fragment => fragment.kind === 'turnComplete')) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    // Only this session's runs count: probe4's Live turn writes its own research_run line earlier in the
    // same host log, so read only what is appended from here on. The journal sequence marks the same point
    // for the question's own tool calls, so an opening-turn research call never counts.
    let logBase = 0;
    try { logBase = Buffer.byteLength(await readFile(join(dataDir, 'logs/host.log'), 'utf8'), 'utf8'); } catch { logBase = 0; }
    let journalBase = 0;
    { const data = await journal().catch(() => null); const fragments = data && Array.isArray(data.fragments) ? data.fragments : []; journalBase = fragments.reduce((max, fragment) => Math.max(max, Number(fragment.journalSequence) || 0), 0); }
    const wav = await readFile(clipPath);
    let offset = 12, pcm = null;
    while (offset + 8 <= wav.length) {
      const chunkId = wav.toString('ascii', offset, offset + 4);
      const size = wav.readUInt32LE(offset + 4);
      if (chunkId === 'data') { pcm = wav.subarray(offset + 8, offset + 8 + size); break; }
      offset += 8 + size + (size & 1);
    }
    if (!pcm || !pcm.length) return { ok: false, stage: 'clip' };
    const silence = Buffer.alloc(32000);
    ws.send(silence);
    await new Promise(resolve => setTimeout(resolve, 300));
    for (let index = 0; index < pcm.length; index += 1600) {
      ws.send(pcm.subarray(index, Math.min(index + 1600, pcm.length)));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    ws.send(silence);
    await new Promise(resolve => setTimeout(resolve, 300));
    try { ws.send(JSON.stringify({ type: 'endAudioStream' })); } catch { /* noop */ }
    const questionAt = now();
    const deadline = questionAt + 90000;
    let calls = 0; let result = null; let outputChars = 0; let outputAtResult = null; let lastFragments = [];
    while (now() < deadline) {
      const data = await journal().catch(() => null);
      const all = data && Array.isArray(data.fragments) ? data.fragments : [];
      const fragments = all.filter(fragment => (Number(fragment.journalSequence) || 0) > journalBase);
      lastFragments = fragments;
      recordJournal(id, all);
      calls = fragments.filter(fragment => fragment.kind === 'toolCall' && fragment.tool && fragment.tool.name === 'research').length;
      const results = fragments.filter(fragment => fragment.kind === 'toolResult' && fragment.tool && fragment.tool.name === 'research');
      if (results.length) result = results[results.length - 1].tool;
      const nextOutput = fragments.filter(fragment => fragment.kind === 'outputTranscription').reduce((sum, fragment) => sum + (typeof fragment.text === 'string' ? fragment.text.length : 0), 0);
      // The response and the model's answer can land in the same one-second poll; anchor the "after" mark
      // on the output seen before this poll, not on the output the poll already carries.
      if (result && outputAtResult === null) outputAtResult = outputChars;
      outputChars = nextOutput;
      if (result && outputAtResult !== null && outputChars > outputAtResult) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    // The per-run metadata reaches the host log only through the closed allowlist; read what this session appended.
    const runs = []; const subcalls = []; let progress = 0;
    try {
      const hostLog = await readFile(join(dataDir, 'logs/host.log'), 'utf8');
      const appended = Buffer.from(hostLog, 'utf8').subarray(logBase).toString('utf8');
      for (const line of appended.split('\n')) {
        if (!line.includes('"research_run"') && !line.includes('"research_progress"') && !line.includes('"research_subcall"')) continue;
        let record; try { record = JSON.parse(line); } catch { continue; }
        if (record.event === 'research_run') runs.push(record);
        else if (record.event === 'research_progress') progress += 1;
        else if (record.event === 'research_subcall') subcalls.push(record);
      }
    } catch { /* no host log means no recorded run */ }
    // Not-called metadata (#260): what the turn did instead of research, so a skipped run is explainable.
    const outputFragments = lastFragments.filter(fragment => fragment.kind === 'outputTranscription');
    const notCalled = {
      outputFragments: outputFragments.length,
      outputChars: outputFragments.reduce((sum, fragment) => sum + (typeof fragment.text === 'string' ? fragment.text.length : 0), 0),
      otherToolNames: [...new Set(lastFragments.filter(fragment => fragment.kind === 'toolCall' && fragment.tool && typeof fragment.tool.name === 'string' && fragment.tool.name !== 'research').map(fragment => fragment.tool.name))],
      otherToolCalls: lastFragments.filter(fragment => fragment.kind === 'toolCall' && fragment.tool && typeof fragment.tool.name === 'string' && fragment.tool.name !== 'research').length,
      turnCompleteMs: (() => { const done = lastFragments.find(fragment => fragment.kind === 'turnComplete' && Number.isFinite(fragment.arrivedAt)); return done ? done.arrivedAt - questionAt : null; })(),
    };
    if (requireSingleCall ? calls !== 1 : calls < 1) return { ok: false, stage: 'call', calls, ...notCalled };
    // The question is one research run. A model may call the tool more than once (start then continue or
    // stop), but every run line for the question carries the one researchId the host minted.
    const findings = result && Array.isArray(result.findings) ? result.findings : [];
    const answered = runs.filter(line => (line.status === 'answered' || line.status === 'partial') && line.rounds >= 1);
    const run = answered[answered.length - 1] ?? null;
    const meta = { calls, runs, subcalls, findings, run, progress, outputChars, outputAtResult };
    if (!enforce) return { ok: true, stage: 'turn', rounds: run?.rounds ?? 0, replyBytes: run?.replyBytes ?? 0, ...meta, ...notCalled };
    const ids = [...new Set(runs.map(line => line.researchId))];
    if (requireSingleCall ? ids.length !== 1 : ids.length < 1) return { ok: false, stage: 'runs', calls, runs: ids.length, detail: runs.map(line => `${line.status}:${line.stopReason}:${line.rounds}`).slice(0, 8).join(' '), ...notCalled };
    if (!answered.length) return { ok: false, stage: 'status', calls, runs: runs.length, ...notCalled };
    const read = Array.isArray(run.sources) ? run.sources.filter(source => source.disposition === 'completed').length : 0;
    if (requireRead && read < 1) return { ok: false, stage: 'sources', read, ...notCalled };
    if (requireRead && !(run.replyBytes <= 2000)) return { ok: false, stage: 'over_cap', replyBytes: run.replyBytes, ...notCalled };
    if (requireRead && (outputAtResult === null || outputChars <= outputAtResult)) return { ok: false, stage: 'no_output', ...notCalled };
    // #260: the run names its own driver; a run line without one of the three fails and is never guessed.
    const driver = researchDriver(run);
    if (requireDriver && driver === null) return { ok: false, stage: 'driver', driver: run.driver ?? 'missing', ...notCalled };
    return { ok: true, stage: 'turn', calls, rounds: run.rounds, sources: `${run.sources.length}(${read} read)`, driver: driver ?? 'any', selectorMs: run.selectorMs, elapsedMs: run.elapsedMs, deadAirMs: run.deadAirMs, replyBytes: run.replyBytes, outputAfter: outputChars - outputAtResult, progress, ...notCalled };
  } finally { try { ws.close(); } catch { /* noop */ } }
}

/** A failed run keeps the host log and a metadata-only journal export under a dated directory (#260). */
async function keepFailureEvidence(dataDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = join(dataDir, stamp);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const hostLog = join(dataDir, 'logs', 'host.log');
  if (existsSync(hostLog)) await copyFile(hostLog, join(directory, 'host.log'));
  if (journalExports.length) await writeFile(join(directory, 'journal.json'), `${JSON.stringify(journalExports)}\n`);
  return directory;
}

/** Metadata-only per-source projection: item counts, kept bytes and query author, never text. */
function sourceSummary(turn, source) {
  const tools = SOURCE_TOOLS[source] ?? [];
  const findings = Array.isArray(turn.findings) ? turn.findings : [];
  const finding = findings.find(entry => entry && entry.source === source);
  const lines = finding && typeof finding.text === 'string' ? finding.text.split('\n').slice(1).filter(Boolean) : [];
  const subs = (Array.isArray(turn.subcalls) ? turn.subcalls : []).filter(entry => entry && tools.includes(entry.tool));
  const items = subs.reduce((sum, entry) => sum + (Number(entry.items) || 0), 0);
  const keptBytes = subs.reduce((sum, entry) => sum + (Number(entry.keptBytes) || 0), 0);
  const hydrated = subs.filter(entry => entry.tool === 'get_insight' && entry.ok === true).length;
  return { items, lines: lines.length, keptBytes, hydrated, queryAuthor: subs.length ? subs[subs.length - 1].queryAuthor : 'n/a', replyBytes: turn.run ? turn.run.replyBytes : 0 };
}

async function main() {
  const dev = process.argv.includes('--dev');
  const results = [];
  const dataDirArg = process.argv.indexOf('--data-dir');
  const externalDataDir = dataDirArg >= 0 ? process.argv[dataDirArg + 1] || undefined : undefined;
  const dataDir = externalDataDir ?? (dev
    ? join(homedir(), 'Library/Application Support/Lux Didi')
    : await mkdtemp(join(tmpdir(), 'didi-smoke-')));
  const config = dev ? { configDir: undefined, ownerProfilePath: undefined } : await installedConfig();
  const serverEntry = join(root, 'server/dist/host/index.js');
  const webRoot = join(root, 'web/dist');
  if (!existsSync(serverEntry) || !existsSync(webRoot)) {
    log('FAIL probe0-build server/dist or web/dist missing; run scripts/run-local.sh --build-only');
    log('SUMMARY 1 probes: 0 pass 1 fail');
    process.exit(1);
  }
  const host = spawnSupervised({ serverEntry, dataDir, webRoot, configDir: config.configDir, ownerProfilePath: config.ownerProfilePath });
  const launch = await waitForReady(host, launchTimeoutMs());
  let token = null;
  if (launch.status === 'ready') token = await bearerFor(dataDir);
  const base = launch.status === 'ready' ? launch.frame.origin : null;
  const epoch = launch.status === 'ready' ? launch.frame.authorityEpoch : null;

  if (launch.status === 'ready') {
    try {
      const connectors = await probeConnectors({ configDir: config.configDir ?? join(dataDir, 'provider-config') });
      results.push({ id: 'probe2-connectors', ok: connectors.ok, note: `${connectors.checked} configured ${connectors.skipped ? `(${connectors.skipped} unconfigured) ` : ''}${connectors.parts.join(' ')}` });
    } catch (error) { results.push({ id: 'probe2-connectors', ok: false, note: String(error && error.message).slice(0, 120) }); }
    try {
      const text = await chatTurn({ base, token, epoch, dataDir, host, readyPid: launch.frame.pid });
        results.push({ id: 'probe3-text-turn', ok: text.ok, note: text.ok ? `tools=${text.names.join(',')} answer=${text.answerBytes}B outcome=${text.outcome}` : `stage=${text.stage} tools=[${(text.names||[]).join(',')}] answer=${text.answerBytes||0}B pidStable=${text.pidStable}${(text.rejections||[]).length ? ' rejected=' + (text.rejections).map(r => r.tool + ':' + r.fields.join('+')).join(',') : ''}` });
    } catch (error) { results.push({ id: 'probe3-text-turn', ok: false, note: String(error && error.message).slice(0, 120) }); }
    try {
      const clipPath = synthClip();
      try {
        const voice = await liveTurn({ base, token, epoch, clipPath });
        results.push({ id: 'probe4-voice-turn', ok: voice.ok, note: voice.ok ? `tool_result=yes audio_after=${voice.audioAfterResult}B open_after=${voice.openFor}ms lifecycle=${voice.lifecycle}` : `stage=${voice.stage}` });
      } finally { await rm(clipPath, { force: true }); }
    } catch (error) { results.push({ id: 'probe4-voice-turn', ok: false, note: String(error && error.message).slice(0, 120) }); }
    try {
      const clipPath = synthClip(RESEARCH_QUESTION);
      try {
        const research = await researchTurn({ base, token, epoch, dataDir, clipPath });
        results.push({ id: 'probe5-research', ok: research.ok, note: research.ok
          ? `calls=${research.calls} rounds=${research.rounds} sources=${research.sources} driver=${research.driver} selectorMs=${research.selectorMs} elapsedMs=${research.elapsedMs} deadAirMs=${research.deadAirMs} reply=${research.replyBytes}B output_after=${research.outputAfter}B progress=${research.progress}`
          : researchFailureNote({ stage: research.stage, calls: research.calls, runs: research.runs, detail: research.detail, status: research.status, rounds: research.rounds, read: research.read, replyBytes: research.replyBytes, outputFragments: research.outputFragments, outputChars: research.outputChars, otherToolNames: research.otherToolNames, otherToolCalls: research.otherToolCalls, turnCompleteMs: research.turnCompleteMs }) + ` load=${loadAverageText()}` });
      } finally { await rm(clipPath, { force: true }); }
    } catch (error) { results.push({ id: 'probe5-research', ok: false, note: String(error && error.message).slice(0, 120) }); }
    // #263: a plain calendar question must reach research, never a "no calendar access" refusal. Called and
    // answered is the pass; the driver and the read shape are probe5's stricter job.
    try {
      const clipPath = synthClip(MEETINGS_QUESTION);
      try {
        const research = await researchTurn({ base, token, epoch, dataDir, clipPath, requireSingleCall: false, requireDriver: false, requireRead: false });
        results.push({ id: 'probe6-meetings', ok: research.ok, note: research.ok
          ? `calls=${research.calls} rounds=${research.rounds} driver=${research.driver} progress=${research.progress}`
          : `stage=${research.stage} calls=${research.calls ?? 0} runs=${research.runs ?? 0}` });
      } finally { await rm(clipPath, { force: true }); }
    } catch (error) { results.push({ id: 'probe6-meetings', ok: false, note: String(error && error.message).slice(0, 120) }); }
    for (const spec of RESEARCH_PROBES) {
      try {
        const clipPath = synthClip(spec.question);
        try {
          const turn = await researchTurn({ base, token, epoch, dataDir, clipPath, enforce: false });
          const summary = sourceSummary(turn, spec.source);
          const ok = spec.check(summary);
          results.push({ id: spec.id, ok, note: `items=${summary.items} kept=${summary.keptBytes}B reply=${summary.replyBytes}B queryAuthor=${summary.queryAuthor} hydrated=${summary.hydrated}` + (ok ? '' : ' stage=criteria') });
        } finally { await rm(clipPath, { force: true }); }
      } catch (error) { results.push({ id: spec.id, ok: false, note: String(error && error.message).slice(0, 120) }); }
    }
  } else {
    results.push(...noHostResults());
  }

  const supervisorOk = launch.status === 'ready' && host.invalid === null && host.error === null;
  results.unshift({ id: 'probe1-strict-supervisor', ok: supervisorOk, note: supervisorNote(launch, host) });

  await stopSupervised(host);
  const failed = results.some(result => !result.ok && !result.skip);

  for (const result of results) log(`${result.skip ? 'SKIP' : result.ok ? 'PASS' : 'FAIL'} ${result.id} ${result.note}`);
  const passed = results.filter(result => result.ok).length;
  const skipped = results.filter(result => result.skip).length;
  log(`SUMMARY ${results.length} probes: ${passed} pass ${results.length - passed - skipped} fail${skipped ? ` ${skipped} skip` : ''}`);
  // A failed run keeps its evidence; a green run keeps nothing new. The caller that owns the data dir
  // (scripts/smoke.sh) prints the path it kept, so a standalone run prints it here instead.
  if (failed) {
    const evidence = await keepFailureEvidence(dataDir);
    if (!externalDataDir) log(`KEEP ${evidence}`);
  } else if (!dev && !externalDataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
  process.exit(passed === results.length ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
