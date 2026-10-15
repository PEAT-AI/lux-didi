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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

function log(line) { process.stdout.write(line + '\n'); }
function now() { return Date.now(); }

const HOSTLESS_PROBES = ['probe2-connectors', 'probe3-text-turn', 'probe4-voice-turn'];

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
exactly one tool call (the intent, or the one internal read it fans out to) and no get_insight turn.
  const ok = names.length === 1 && (names[0] === 'search' || names[0] === 'search_knowledge') && answerBytes > 0 && rejections.length === 0 && pidStable;
  return { ok, stage: 'turn', names, answerBytes, rejections, outcome: snap.outcome, pidStable };
}

function synthClip() {
  // A short synthetic clip, written to a file: no microphone and no speaker is ever opened.
  const path = join(tmpdir(), `didi-smoke-clip-${randomUUID()}.wav`);
  execFileSync('/usr/bin/say', ['-o', path, '--data-format=LEI16@16000', QUESTION], { stdio: 'ignore' });
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

async function main() {
  const dev = process.argv.includes('--dev');
  const results = [];
  const dataDir = dev
    ? join(homedir(), 'Library/Application Support/Lux Didi')
    : await mkdtemp(join(tmpdir(), 'didi-smoke-'));
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
  } else {
    results.push(...noHostResults());
  }

  const supervisorOk = launch.status === 'ready' && host.invalid === null && host.error === null;
  results.unshift({ id: 'probe1-strict-supervisor', ok: supervisorOk, note: supervisorNote(launch, host) });

  await stopSupervised(host);
  if (!dev) await rm(dataDir, { recursive: true, force: true });

  for (const result of results) log(`${result.skip ? 'SKIP' : result.ok ? 'PASS' : 'FAIL'} ${result.id} ${result.note}`);
  const passed = results.filter(result => result.ok).length;
  const skipped = results.filter(result => result.skip).length;
  log(`SUMMARY ${results.length} probes: ${passed} pass ${results.length - passed - skipped} fail${skipped ? ` ${skipped} skip` : ''}`);
  process.exit(passed === results.length ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
