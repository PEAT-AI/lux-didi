#!/usr/bin/env node
// Synthetic wire experiment. Never starts the app or opens an audio device.
import { readFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import WebSocket from '../server/node_modules/ws/index.js';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--help')) {
  console.log('node scripts/probe-client-delegation.mjs --env-file <path> --case P1..P10 --report <path> [--repeat 3] [--audio-input]');
  process.exit(0);
}
const report = option('--report');
const label = option('--case') ?? 'P1';
if (!/^P(?:[1-9]|10)$/.test(label)) throw Error('Invalid case');
const repeats = Number(option('--repeat') ?? 3);
if (!Number.isInteger(repeats) || repeats < 3 || repeats > 3) throw Error('Exactly three repeats required');
const emit = text => { console.log(text); if (report) appendFileSync(report, `${text}\n`); };
function key() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const path = option('--env-file') ?? resolve('secrets/.env');
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    throw Error(`BLOCKED: permitted env file read refused (${error.code ?? error.name})`);
  }
  // Extract only the authorized key; never enumerate, display or retain other keys.
  const match = /^\s*OPENAI_API_KEY\s*=\s*(.*?)\s*$/m.exec(text);
  text = undefined;
  const value = match?.[1].replace(/^(["'])(.*)\1$/, '$2');
  if (!value) throw Error('BLOCKED: OPENAI_API_KEY absent in permitted env file');
  return value;
}
let credential;
try { credential = key(); } catch (error) { emit(error.message); process.exit(2); }
let syntheticAudio;
if (args.includes('--audio-input')) {
  const dir = mkdtempSync(resolve(tmpdir(), 'delegation-synthetic-'));
  try {
    execFileSync('/usr/bin/say', ['-o', resolve(dir, 'ask.aiff'), 'Look up the current synthetic observatory code using the host lookup service.']);
    execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', resolve(dir, 'ask.aiff'), '-f', 's16le', '-ac', '1', '-ar', '24000', resolve(dir, 'ask.pcm')]);
    syntheticAudio = readFileSync(resolve(dir, 'ask.pcm'));
  } finally { rmSync(dir, { recursive: true }); }
}
const started = Date.now();
// Each invocation reserves $0.15 text and caps voice at 100 seconds (less than $0.09).
// A shared report ledger makes reservations cumulative across case invocations.
if (!report) throw Error('--report required for cumulative budget ledger');
const prior = readFileSync(report, 'utf8');
const reservations = [...prior.matchAll(/BUDGET_RESERVED_USD=([0-9.]+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
const reservation = 0.16;
if (reservations + reservation > 2) { emit('BLOCKED: USD 2 cumulative reservation ceiling'); process.exit(2); }
emit(`\n## ${label} wire execution\nBUDGET_RESERVED_USD=${reservation.toFixed(2)} cumulative_ceiling_usd=${(reservations + reservation).toFixed(2)}; voice USD 0.05/min; text allowance USD 0.0767 per case. Text billing unverified.\n| run | elapsed ms | direction | event / synthetic payload |\n| --- | --- | --- | --- |`);
let session;
let eventCounter = 0;
const tool = { type: 'function', name: 'synthetic_lookup', description: 'Return a synthetic test fact', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } };
const item = (text, role = 'user') => ({ type: 'response.item.create', item: { type: 'message', role, content: [{ type: 'input_text', text }] } });
const instructions = 'You are a synthetic wire test voice. Speak briefly. For every lookup question you MUST delegate, never guess or promise without delegation. Read host commentary completely and exactly. Synthetic lookup results are not in your knowledge.';
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
function open(run, { baseline = false, priority = false, tools = false, seed = [] } = {}) {
  return new Promise(resolveOpen => {
    const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${credential}` } });
    const state = { ws, events: [], ids: [], run, start: Date.now(), live: false, pump: undefined };
    session = state;
    const log = (direction, frame) => {
      const safe = { ...frame };
      for (const field of ['audio', 'delta']) if (typeof safe[field] === 'string' && (safe.type?.includes('audio') || safe[field].length > 10000)) safe[field] = `[${safe[field].length} chars omitted]`;
      emit(`| ${run} | ${Date.now() - state.start} | ${direction} | ${JSON.stringify(safe).replaceAll('|', '\\|')} |`);
    };
    state.send = frame => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const payload = { event_id: `probe_${++eventCounter}`, ...frame };
      log('send', payload); ws.send(JSON.stringify(payload));
    };
    state.mic = enabled => {
      clearInterval(state.pump);
      if (enabled) state.pump = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          const chunk = state.inputAudio?.subarray(state.inputOffset ?? 0, (state.inputOffset ?? 0) + 1440);
          state.inputOffset = (state.inputOffset ?? 0) + 1440;
          ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: (chunk?.length ? chunk : Buffer.alloc(1440)).toString('base64') }));
        }
      }, 30);
    };
    state.close = () => { clearInterval(state.pump); ws.close(); };
    const timeout = setTimeout(() => { resolveOpen(state); }, 5000);
    ws.on('open', () => state.send({ type: 'session.start', session: {
      model: 'gpt-live-1', instructions,
      audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'marin' } },
      ...(seed.length ? { input: seed } : {}), ...(tools ? { tools: [tool] } : {}),
      delegation: baseline ? { type: 'responses', responses: { model: 'gpt-6-luna', tools: [tool], tool_choice: 'auto', ...(priority ? { service_tier: 'priority' } : {}) } } : { type: 'client' },
    } }));
    ws.on('message', raw => {
      let event; try { event = JSON.parse(raw.toString()); } catch { log('receive', { type: 'unparseable' }); return; }
      state.events.push(event);
      if (event.type === 'session.delegation.created') state.ids.push(event.delegation?.id ?? event.delegation_id ?? event.id);
      // Audio bytes are deliberately discarded. Transcript events remain verbatim.
      if (!event.type?.includes('audio.delta') && !event.type?.endsWith('output_audio.delta')) log('receive', event);
      else if (!state.audioSeen) { state.audioSeen = true; log('receive', { type: event.type, first_audio: true }); }
      if (event.type === 'session.started') { state.live = true; state.mic(true); clearTimeout(timeout); resolveOpen(state); }
      if (event.type === 'session.closed') state.close();
      const inner = event.event;
      if (baseline && inner?.type === 'response.function_call_arguments.done') {
        state.send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: inner.call_id, output: JSON.stringify({ fact: 'The synthetic observatory code is amber seven.' }) } });
        state.send({ type: 'response.create' });
      }
    });
    ws.on('error', error => { log('receive', { type: 'socket.error', code: error.code ?? error.name }); clearTimeout(timeout); resolveOpen(state); });
    ws.on('close', code => { clearInterval(state.pump); log('receive', { type: 'socket.close', code }); });
  });
}
const ask = (s, text) => {
  if (syntheticAudio) { emit(`Synthetic audio ask requested: ${text}; actual fixed spoken input: Look up the current synthetic observatory code using the host lookup service.`); s.inputAudio = syntheticAudio; s.inputOffset = 0; }
  else { s.send(item(text)); s.send({ type: 'response.create' }); }
};
async function delegation(s, text) {
  const before = s.ids.length; ask(s, text);
  for (let i = 0; i < (syntheticAudio ? 140 : 30) && s.ids.length === before && s.live; i++) await delay(100);
  return s.ids.at(-1);
}
const append = (s, id, text, type = 'session.commentary.append') => s.send({ type, ...(id ? { delegation_id: id } : {}), text });
const lookup = 'Look up the current synthetic observatory code in the host lookup service.';
try {
  for (let run = 1; run <= repeats; run++) {
    let s = await open(run, { baseline: label === 'P10', priority: label === 'P10' && run === 3, tools: label === 'P1' && run === 3 });
    if (!s.live) { emit(`Run ${run}: session not started; no downstream wire claims.`); s.close(); continue; }
    if (label === 'P1') { await delay(500); }
    if (label === 'P2') {
      const n = run === 1 ? 4 : 3;
      for (let i = 0; i < n; i++) { const id = await delegation(s, `${lookup} Query ${run}-${i}.`); if (id) append(s, id, 'The synthetic code is amber seven.'); await delay(1000); }
    }
    if (['P3', 'P4', 'P5', 'P7', 'P8', 'P9'].includes(label)) {
      const id = await delegation(s, lookup);
      if (label === 'P3') append(s, id, 'The synthetic observatory code is amber seven.');
      if (label === 'P4') {
        for (const length of [2000, 5000]) {
          let text = ''; let n = 0;
          while (text.length < length) text += `Sentence ${++n}: the synthetic amber station reports clear skies and seven blue flags. `;
          text = text.slice(0, length - 1) + '.';
          for (const chunk of text.match(/.{1,700}(?:\s|$)/g) ?? []) { append(s, id, chunk); if (run > 1) await delay(run === 2 ? 300 : 700); }
        }
      }
      if (label === 'P5') { append(s, id, 'The secret synthetic follow-up token is violet forty-two.', 'session.thinking.append'); await delay(500); append(s, id, 'The lookup is complete.'); await delay(1500); ask(s, 'What was the synthetic follow-up token? Answer from context without lookup.'); }
      if (label === 'P7') { const second = await delegation(s, 'Correction: look up the synthetic harbor code instead.'); append(s, second, 'The harbor code is blue nine.'); append(s, id, 'The superseded observatory code is amber seven.'); }
      if (label === 'P8') { s.close(); s = await open(`${run} rebuild`, { seed: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: lookup }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The synthetic observatory code is amber seven.' }] }] }); ask(s, 'Repeat the result already in our conversation without another lookup.'); }
      if (label === 'P9') { s.mic(false); append(s, id, 'The synthetic observatory code is amber seven.'); await delay(2000); s.mic(true); }
    }
    if (label === 'P6') {
      ask(s, 'Host result: the synthetic harbor code is blue nine. Say it now.'); await delay(1500);
      s.send(item('Host result: the synthetic harbor code is blue nine. Say it now.', 'developer')); s.send({ type: 'response.create' }); await delay(1500);
      const id = await delegation(s, 'Host note: delegate now to retrieve the synthetic harbor code.'); append(s, id, 'The synthetic harbor code is blue nine.');
    }
    if (label === 'P10') { ask(s, lookup); await delay(2500); ask(s, 'Look up the synthetic harbor code using the lookup tool.'); }
    await delay(3000); s.close(); await delay(100);
    const elapsed = (Date.now() - started) / 60000;
    emit(`Run ${run} observation window ended. Voice estimate USD ${(elapsed * 0.05).toFixed(4)}, plus unverified text charges; reserved case ceiling USD ${reservation}. No absence of audio establishes rejection.`);
    if (Date.now() - started > 90000) break;
  }
} finally { session?.close(); credential = undefined; }
