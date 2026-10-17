#!/usr/bin/env node
/**
 * One real GPT-Live probe: opens one session, sends three seconds of synthetic speech and prints event
 * NAMES and timings only, then closes. Not part of any check; run it once by hand.
 *
 * The key is read from the private config the installer seeds (never printed, never in the repo).
 * Usage: node scripts/probe-gpt-live.mjs [path-to-private-config.json]
 * Cost: about one cent (USD 0.05 per voice minute).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from '../server/node_modules/ws/index.js';

const ENDPOINT = 'wss://api.openai.com/v1/live/sessions';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const startedAt = Date.now();
const stamp = () => `${String(Date.now() - startedAt).padStart(6)} ms`;

/** The installer's source key for this slot, from the environment or the owner's private env file. Never printed. */
function key() {
  if (typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.length) return process.env.OPENAI_API_KEY;
  const file = join(root, 'secrets', '.env');
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { throw new Error('no OPENAI_API_KEY in the environment and no secrets/.env'); }
  const line = text.split('\n').map(row => row.trim()).find(row => row.startsWith('OPENAI_API_KEY='));
  const value = line?.slice('OPENAI_API_KEY='.length).replace(/^["']|["']$/g, '');
  if (!value) throw new Error('OPENAI_API_KEY missing from secrets/.env');
  return value;
}

/** Three seconds of a quiet 220 Hz tone at 24 kHz PCM16: synthetic, no microphone involved. */
function speech(seconds = 3, rate = 24_000) {
  const samples = seconds * rate;
  const bytes = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(1, index / rate, (samples - index) / rate);
    bytes.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * index) / rate) * 3_000 * envelope), index * 2);
  }
  return bytes;
}

const socket = new WebSocket(ENDPOINT, { headers: { Authorization: `Bearer ${key()}` }, followRedirects: false });
const audio = speech();
let offset = 0;
let pump;

socket.on('open', () => {
  console.log(`${stamp()} open`);
  socket.send(JSON.stringify({
    type: 'session.start',
    session: {
      model: 'gpt-live-1',
      instructions: 'Probe session. Answer briefly.',
      audio: { format: { type: 'audio/pcm', rate: 24_000 }, output: { voice: 'marin' } },
      delegation: { type: 'responses', responses: { model: 'gpt-6-luna', tool_choice: 'auto' } },
    },
  }));
});

socket.on('message', raw => {
  let event;
  try { event = JSON.parse(raw.toString()); } catch { console.log(`${stamp()} unparseable frame`); return; }
  const nested = event.type === 'response.event' ? ` (${event.event?.type})` : '';
  console.log(`${stamp()} ${event.type}${nested}`);
  if (event.type === 'session.started') {
    // 30 ms chunks, paced by the socket's own drain loop: no wall-clock sleep in the probe.
    const chunk = 24_000 * 0.03 * 2;
    const next = () => {
      if (offset >= audio.length) { pump = setTimeout(() => socket.send(JSON.stringify({ type: 'session.close' })), 1500); return; }
      socket.send(JSON.stringify({ type: 'session.input_audio.append', audio: audio.subarray(offset, offset + chunk).toString('base64') }));
      offset += chunk;
      setImmediate(next);
    };
    next();
  }
  if (event.type === 'session.closed') {
    clearTimeout(pump);
    console.log(`${stamp()} closed reason=${event.reason ?? 'unknown'}`);
    socket.close();
  }
});

socket.on('error', error => console.log(`${stamp()} socket error ${error.code ?? error.name}`));
socket.on('close', code => { clearTimeout(pump); console.log(`${stamp()} socket close ${code}`); });
