#!/usr/bin/env node
/** Synthetic-only live wire probe. No application, owner data or audio devices. */
import { readFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from '../server/node_modules/ws/index.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
if (args.includes('--help')) {
  console.log('node scripts/probe-client-delegation.mjs --env-file PATH --scenario A1..A8|B1..B5|C1..C4|N1..N3|T1..T3|S1|R1 --report PATH --frames PATH [--count N] [--length 2000|5000] [--pace quiet] [--variant NAME]');
  process.exit(0);
}
const scenario = option('--scenario');
if (!/^(A[1-8]|B[1-5]|C[1-4]|N[1-3]|T[1-3]|S1|R1)$/.test(scenario ?? '')) throw Error('Expected --scenario A1..A8, B1..B5 or C1..C4');
const report = option('--report');
const frames = option('--frames');
if (!report || !frames) throw Error('--report and --frames required');
const count = Number(option('--count', ({ A1: 5, A2: 3, A3: 3, A4: 2, A5: 3, A6: 2, A7: 2, A8: 10, C1: 3, C2: 2, C3: 3, C4: 2 })[scenario] ?? 3));
const length = Number(option('--length', scenario === 'A2' ? 2000 : 300));
const variant = option('--variant', 'default');
const paced = option('--pace') === 'quiet';
if (!Number.isInteger(count) || count < 1 || count > 10 || ![300, 1200, 2000, 5000].includes(length)) throw Error('Invalid count or length');
function key() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  let text;
  try { text = readFileSync(option('--env-file', resolve('secrets/.env')), 'utf8'); }
  catch (error) { throw Error(`BLOCKED: permitted env file read refused (${error.code ?? error.name})`); }
  const value = /^\s*OPENAI_API_KEY\s*=\s*(.*?)\s*$/m.exec(text)?.[1].replace(/^(["'])(.*)\1$/, '$2');
  text = undefined;
  if (!value) throw Error('BLOCKED: OPENAI_API_KEY absent in permitted env file');
  return value;
}
let credential;
try { credential = key(); } catch (error) { appendFileSync(report, `\n${error.message}\n`); process.exit(2); }
// Second-pass estimate only. $0.05/socket minute; text estimated at 3 chars/token,
// $30/million tokens blended. This is an explicit estimate, not provider billing.
let spent = Math.max(0, ...[...readFileSync(frames, 'utf8').matchAll(/ESTIMATE2_USD=([0-9.]+)/g)].map(m => Number(m[1])));
let serial = 0;
let active;
const sockets = new Set();
const textRate = 30 / 1_000_000 / 3;
const cap = 3;
const budgetError = () => Error(`BUDGET_STOP: cumulative second/third pass USD ${cap} estimate ceiling`);
const pause = ms => new Promise(done => setTimeout(done, ms));
const note = text => { appendFileSync(frames, `${text}\n`); };
const clean = value => JSON.stringify(value).replaceAll('|', '\\|');
const prompts = [
  'Look up the current synthetic observatory code in the host lookup service.',
  'Look up the current synthetic harbor flag count in the host lookup service.',
  'Check the latest synthetic greenhouse humidity in the host lookup service.',
  'Retrieve the synthetic station inventory count from the host lookup service.',
  'Check the synthetic ferry departure time using the host lookup service.',
  'Find the synthetic museum opening code using the host lookup service.',
  'Retrieve the synthetic library shelf code from the host lookup service.',
  'Check the synthetic laboratory sample count in the host lookup service.',
  'Look up the latest synthetic weather beacon reading in the host lookup service.',
  'Retrieve the synthetic shuttle platform number using the host lookup service.',
];
const speechCache = new Map();
function speech(text) {
  if (speechCache.has(text)) return speechCache.get(text);
  const dir = mkdtempSync(resolve(tmpdir(), 'client-delegation-synthetic-'));
  try {
    execFileSync('/usr/bin/say', ['-r', '220', '-o', resolve(dir, 'ask.aiff'), text]);
    execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', resolve(dir, 'ask.aiff'), '-f', 's16le', '-ac', '1', '-ar', '24000', resolve(dir, 'ask.pcm')]);
    const pcm = readFileSync(resolve(dir, 'ask.pcm')); speechCache.set(text, pcm); return pcm;
  } finally { rmSync(dir, { recursive: true }); }
}
const instructions = 'Synthetic wire test. Speak quickly and clearly. Every lookup question MUST delegate to the host lookup service. Never invent lookup facts. Do not merely promise to check. Read the finished result completely in order without shortening, paraphrasing, repeating or adding an introduction. Facts explicitly in conversation context do not need lookup.';
const backend = 'For every lookup request call run_task with the request. After tool results, return the finished result fully and exactly without shortening or paraphrasing. One tool call per request. Do not call again after receiving its result.';
const tool = { type: 'function', name: 'run_task', description: 'Host-owned synthetic lookup worker', parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'], additionalProperties: false } };
const seedItems = result => [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompts[0] }] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: result }] },
];
function resultText(size) {
  const sentences = []; let n = 1;
  while (sentences.join(' ').length + 100 < size) sentences.push(`Record ${n++}: the synthetic amber station reports seven blue flags and clear skies.`);
  const head = sentences.join(' ');
  const left = size - head.length - 1;
  const final = 'Final record: the synthetic verification marker is violet forty two. ';
  // Exact character length, sentences remain bounded and punctuation terminated.
  return `${head} ${final.padEnd(left, 'x').slice(0, left - 1)}.`;
}
function chunks(text) {
  const sentences = text.match(/[^.!?]*[.!?]+\s*/g) ?? [text];
  const out = []; let current = '';
  for (const sentence of sentences) {
    // ASCII chunk length <= 450 also bounds tokens below 500 even at one token/char.
    if (sentence.length > 450) throw Error('Synthetic sentence exceeds token-safe character bound');
    if (current.length + sentence.length > 450) { out.push(current); current = ''; }
    current += sentence;
  }
  if (current) out.push(current);
  if (out.join('') !== text) throw Error('Chunking lost content');
  return out;
}
const openingResult = 'The synthetic harbor code is blue nine. The count is seven.';
const openingInstructions = variant === 'seed' ? `${instructions} A finished host lookup result has just arrived in the seeded conversation. Tell the listener that finished result first, now. Do not look it up again.` : `${instructions} A finished host lookup result has just arrived. Tell the listener this finished result first, now: ${openingResult}`;
const naturalInstructions = 'Synthetic voice test. Every lookup question MUST delegate to the host lookup service. Results arrive as commentary. Say them in your own short words, keep station names, codes, counts and times exact. Do not read the whole result verbatim. Never invent facts.';
function naturalResult(size) {
  const facts = 'At synthetic Amber Station, code AX7, inventory is 42 blue crates and 17 green crates. The next shuttle leaves at 14:35 from platform 6. The synthetic harbor code is BN9. ';
  const filler = 'These synthetic test facts are confirmed for this experiment and no additional lookup is needed. ';
  let text = facts;
  while (text.length + filler.length < size) text += filler;
  return text.padEnd(size - 1, ' ') + '.';
}
async function open(run, seed = [], voiceInstructions = instructions) {
  if (spent > cap - 0.10) throw budgetError();
  const isResponses = scenario.startsWith('B');
  const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${credential}` } });
  const s = { ws, run, start: Date.now(), live: false, events: [], ids: [], calls: new Map(), transcripts: [], audio: [], input: undefined, offset: 0, lastText: 0, textChars: 0, accounted: false, errors: [] };
  active = s; sockets.add(s);
  s.ms = () => Date.now() - s.start;
  s.estimate = () => spent + s.ms() / 60000 * 0.05 + s.textChars * textRate;
  s.log = (direction, event) => note(`| ${scenario}/${run} | ${s.ms()} | ${direction} | ${clean(event)} |`);
  s.send = frame => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const text = JSON.stringify(frame);
    if (s.estimate() + text.length * textRate > cap - 0.03) throw budgetError();
    s.textChars += text.length;
    const payload = { event_id: `probe2_${++serial}`, ...frame };
    s.log('send', payload); ws.send(JSON.stringify(payload)); return true;
  };
  s.mic = enabled => {
    clearInterval(s.pump);
    if (enabled) s.pump = setInterval(() => {
      if (s.estimate() > cap - 0.03) { s.budgetStopped = true; s.close(); return; }
      if (ws.readyState !== WebSocket.OPEN) return;
      const chunk = s.input?.subarray(s.offset, s.offset + 1440); s.offset += 1440;
      ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: (chunk?.length ? chunk : Buffer.alloc(1440)).toString('base64') }));
    }, 30);
  };
  s.close = () => {
    clearInterval(s.pump); clearTimeout(s.deadline);
    if (!s.accounted) { spent = s.estimate(); s.accounted = true; note(`ESTIMATE2_USD=${spent.toFixed(6)} voice_rate=0.05_per_minute text_rate=30_per_million_tokens assumed_chars_per_token=3`); console.log(`${scenario}/${run} running estimate USD ${spent.toFixed(4)} / cumulative cap ${cap.toFixed(2)}`); }
    ws.close(); sockets.delete(s);
  };
  s.deadline = setTimeout(() => { s.log('local', { type: 'window_limit', seconds: 250 }); s.close(); }, 250000);
  ws.on('message', raw => {
    let e; try { e = JSON.parse(raw.toString()); } catch { s.log('receive', { type: 'unparseable' }); return; }
    const at = s.ms(); s.events.push({ at, event: e });
    if (e.type === 'session.output_audio.delta') {
      s.audio.push(at);
      const pcm = Buffer.from(e.audio ?? e.delta ?? '', 'base64');
      let peak = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
      if (peak > 100) (s.nonSilentAudio ??= []).push({ at, peak });
      if (s.audio.length === 1 || (at - (s.lastAudio ?? 0)) > 500) s.log('receive', { type: e.type, bytes: e.audio?.length ?? e.delta?.length, segment_start: true });
      s.lastAudio = at;
    } else {
      s.log('receive', e);
      if (e.type === 'session.output_transcript.delta') { s.transcripts.push({ at, text: e.delta ?? '' }); s.lastText = Date.now(); s.textChars += (e.delta ?? '').length; }
    }
    if (e.type === 'error') s.errors.push({ at, ...e.error });
    if (e.type === 'session.started') { s.live = true; s.mic(true); }
    if (e.type === 'session.delegation.created') s.ids.push({ at, id: e.delegation?.id ?? e.id, frame: e });
    const inner = e.type === 'response.event' ? e.event : e;
    if (inner?.type === 'response.output_item.done' && inner.item?.type === 'function_call') s.calls.set(inner.item.call_id, { ...inner.item, at, answered: false });
    if (inner?.type === 'response.function_call_arguments.done' && inner.call_id) s.calls.set(inner.call_id, { ...inner, at, answered: false });
    if (inner?.type === 'response.output_text.delta') s.textChars += (inner.delta ?? '').length;
  });
  ws.on('error', error => { s.log('receive', { type: 'socket.error', code: error.code ?? error.name }); });
  ws.on('close', code => { s.log('receive', { type: 'socket.close', code }); s.live = false; s.close(); });
  await new Promise(done => { ws.once('open', done); ws.once('error', done); setTimeout(done, 5000); });
  s.send({ type: 'session.start', session: {
    model: 'gpt-live-1', instructions: voiceInstructions,
    audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'marin' } },
    ...(seed.length ? { input: seed } : {}),
    delegation: isResponses ? { type: 'responses', responses: { model: 'gpt-6-luna', instructions: backend, tools: [tool], tool_choice: 'auto', parallel_tool_calls: true, ...(scenario === 'B5' ? { service_tier: 'priority' } : {}) } } : { type: 'client', ...(scenario === 'T3' ? { acknowledgement_delay_ms: 800 } : {}) },
  } });
  await until(s, () => s.live, 5000);
  return s;
}
async function until(s, predicate, timeout) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end && !s.accounted) await pause(50);
  if (s.budgetStopped) throw budgetError();
  return predicate();
}
async function ask(s, text, requireDelegation = true) {
  const pcm = speech(text); const before = s.ids.length; const at = s.ms();
  s.log('local', { type: 'synthetic_audio_ask', text, pcm_bytes: pcm.length, duration_ms: pcm.length / 48 });
  s.input = pcm; s.offset = 0;
  if (requireDelegation) await until(s, () => s.ids.length > before, pcm.length / 48 + 10000);
  else await pause(pcm.length / 48 + 4000);
  const id = s.ids.length > before ? s.ids.at(-1) : undefined;
  return { id: id?.id, askAt: at, delegationAt: id?.at, before };
}
async function quiet(s, minimum = 1500, maximum = 15000) {
  const start = Date.now();
  await until(s, () => Date.now() - start >= minimum && Date.now() - Math.max(s.lastText, start) >= 3000, maximum);
}
function content(s, id, text, type = 'session.commentary.append') {
  const at = s.ms();
  s.send({ type, ...(id ? { delegation_id: id } : {}), content: text });
  return at;
}
async function output(s, id, text) {
  const at = s.ms();
  for (const chunk of chunks(text)) {
    content(s, id, chunk);
    if (paced) await quiet(s, 1500, Math.min(45000, chunk.length / 10 * 1000 + 6000));
  }
  await quiet(s, Math.max(8000, Math.min(20000, text.length * 50)), Math.min(220000, text.length / 12 * 1000 + 15000));
  return at;
}
async function pending(s, timeout = 18000) { return until(s, () => [...s.calls.values()].some(c => !c.answered), timeout); }
async function toolOutput(s, text) {
  // Let the current response finish enumerating parallel calls before producing all outputs.
  await pause(2000);
  let written = 0;
  for (const call of s.calls.values()) if (!call.answered) {
    s.send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: text } }); call.answered = true; written++;
  }
  const at = s.ms(); if (written) s.send({ type: 'response.create' });
  return { at, written };
}
function summary(s, details) {
  const result = { scenario, run: s.run, length, variant, paced, ...details, ids: s.ids, calls: [...s.calls.values()], errors: s.errors, transcript: s.transcripts.map(t => t.text).join(''), transcriptEvents: s.transcripts, audio: s.audio, nonSilentAudio: s.nonSilentAudio ?? [], events: Object.fromEntries([...new Set(s.events.map(x => x.event.type))].map(type => [type, s.events.filter(x => x.event.type === type).length])), end: s.ms() };
  note(`RESULT2 ${JSON.stringify(result)}`);
  const sentAt = details.appendAt ?? details.outputAt;
  const firstAudio = sentAt === undefined ? undefined : s.audio.find(at => at >= sentAt);
  const answerTranscript = sentAt === undefined ? result.transcript : s.transcripts.filter(t => t.at >= sentAt).map(t => t.text).join('');
  appendFileSync(report, `| ${s.run} | ${details.askAt ?? 'n/a'} / ${details.delegationAt ?? 'none'} | ${s.ids.map(i => i.id).join(', ') || 'none'} | ${sentAt ?? 'n/a'} / ${firstAudio === undefined ? 'none' : firstAudio - sentAt} | ${answerTranscript.replaceAll('|', '\\|') || '(not observed)'} | ${s.errors.map(e => `${e.code ?? 'no code'}: ${e.message}`).join('; ').replaceAll('|', '\\|') || 'none observed'} |\n`);
}
note(`\n## WIRE-R2 ${scenario} length=${length} variant=${variant} pace=${paced ? 'quiet' : 'back-to-back'}\n| run | ms | direction | frame |\n| --- | --- | --- | --- |`);
appendFileSync(report, `\n## WIRE-R2 ${scenario}, ${length} chars, ${variant}, ${paced ? 'quiet-gap pacing' : 'back-to-back'}\n| run | ask / delegation ms from socket | delegation ids | append or output ms / next audio delta ms | OUTPUT TRANSCRIPT after append | rejection |\n| --- | --- | --- | --- | --- | --- |\n`);
async function night(run) {
  const history = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'The synthetic moon garden gate code is amber forty seven.' }] }];
  const initial = scenario === 'R1' && variant === 'say-first' ? `${instructions} Say first: The synthetic delivery has arrived.` : instructions;
  const s = await open(run, scenario === 'R1' ? history : [], initial);
  if (!s.live) { summary(s, { note: 'session failed to start' }); s.close(); return; }
  const details = { variant }; let retained = null;
  const append = (kind, text, id = null) => {
    const at = s.ms();
    s.send({ type: `session.${kind}.append`, delegation_id: id, content: text });
    return at;
  };
  if (['N2', 'T2', 'T3'].includes(scenario)) {
    const request = await ask(s, scenario === 'T2' ? 'Look up why the sky appears blue in the host lookup service.' : prompts[0]);
    retained = request.id;
    if (!retained) { summary(s, { note: 'missing prerequisite delegation' }); s.close(); return; }
    if (scenario === 'T3') details.appendAt = append('thinking', '', retained);
    else if (scenario === 'T2') details.appendAt = append('commentary', 'No source lookup is needed. Answer the original question from your own general knowledge in your own words.', retained);
    else { append('commentary', openingResult, retained); await pause(12000); }
  }
  if (scenario === 'N1' || scenario === 'N2') details.appendAt = append('commentary', 'The synthetic garden gate code is violet forty two. Tell the listener now.', variant === 'retained' ? retained : null);
  if (scenario === 'N3') {
    if (variant === 'story') {
      const before = s.audio.length;
      await ask(s, 'Tell a long synthetic story about a robot exploring a crystal garden.', false);
      await until(s, () => s.audio.length > before, 10000);
      details.lastAudioBeforeAppend = s.lastAudio;
    } else {
      s.input = speech('Here is a synthetic story about a robot exploring a crystal garden. The robot walks slowly past seven violet trees and stops to count every shining leaf.');
      s.offset = 0; await pause(1500);
      details.ownerAudioRemainingBytes = Math.max(0, s.input.length - s.offset);
    }
    details.appendAt = append('commentary', 'Important synthetic update: the garden gate code is violet forty two. Tell the listener.');
  }
  if (scenario === 'T1') {
    details.appendAt = append('thinking', 'The synthetic moon garden gate code is amber forty seven.');
    await pause(15000);
    details.quietWindowAudioCount = s.audio.filter(at => at >= details.appendAt).length;
    details.followUp = await ask(s, 'What is the synthetic moon garden gate code I gave you?', false);
  }
  if (scenario === 'S1') {
    const text = resultText(1500); details.payload = text;
    for (const part of variant === 'chunks' ? chunks(text) : [text]) {
      details.appendAt ??= s.ms(); append('commentary', part);
      if (variant === 'chunks') await pause(300);
    }
  }
  if (scenario === 'R1') {
    await pause(15000); details.openingAudioCount = s.audio.length;
    details.openingTranscript = s.transcripts.map(t => t.text).join('');
    details.followUp = await ask(s, 'What is the synthetic moon garden gate code I gave you?', false);
  }
  await pause(scenario === 'S1' ? 125000 : 18000);
  summary(s, details); s.close();
}
try {
  for (let index = 1; index <= count; index++) {
    const run = index + Number(option('--run-offset', 0));
    if (/^[NTSR]/.test(scenario)) { await night(run); continue; }
    const opening = scenario === 'C1' || scenario === 'C2';
    let s = await open(run, opening && variant === 'seed' ? seedItems(openingResult) : [], opening ? openingInstructions : scenario === 'C3' ? naturalInstructions : instructions); let details = {};
    if (!s.live) { summary(s, { note: 'session failed to start' }); s.close(); continue; }
    const text = resultText(length);
    if (scenario === 'C1' || scenario === 'C2') {
      details = { appendAt: s.ms(), note: 'No speech input for opening, paced silence only', openingResult };
      await quiet(s, 12000, 25000);
      details.openingTranscript = s.transcripts.map(t => t.text).join('');
      if (scenario === 'C2') {
        details.followUp = await ask(s, prompts[0]);
        if (details.followUp.id) details.followUpAppendAt = await output(s, details.followUp.id, 'The synthetic observatory code is amber seven.');
      }
    } else if (scenario === 'A4') {
      details = await ask(s, prompts[0]);
      if (!details.id) { summary(s, { ...details, note: 'No delegation; prerequisite failed' }); s.close(); continue; }
      await output(s, details.id, 'The synthetic observatory code is amber seven.');
      await quiet(s, 2000, 10000);
      details.appendAt = s.ms();
      if (variant === 'thinking') content(s, details.id, 'Host finished result: the synthetic harbor code is blue nine. Say the finished result now.', 'session.thinking.append');
      else if (variant === 'instructions') s.send({ type: 'session.instructions.append', instructions: 'Host finished result: the synthetic harbor code is blue nine. Say this result now.' });
      else if (variant === 'decision') { s.send({ type: 'decision.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Host result: the synthetic harbor code is blue nine. Say it now.' }] } }); s.send({ type: 'decision.create' }); }
      else content(s, details.id, 'The synthetic harbor code is blue nine.');
      await quiet(s, 5000, 15000);
      details.note = 'No new owner audio after initial result; id closure must be checked in frames, not presumed.';
    } else if (scenario === 'B2') {
      await quiet(s, 1500, 4000); details.outputAt = s.ms();
      s.send({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Host finished result: the synthetic harbor code is blue nine. Speak that result now without lookup.' }] } });
      s.send({ type: 'response.create' }); await quiet(s, 4000, 18000);
    } else {
      details = await ask(s, scenario === 'A8' ? prompts[run - 1] : prompts[0]);
      if (!details.id) { summary(s, { ...details, note: 'No delegation; no open-id experiment performed' }); s.close(); continue; }
      if (scenario === 'A1' || scenario === 'A2' || scenario === 'C3') details.appendAt = await output(s, details.id, scenario === 'A1' ? 'The synthetic observatory code is amber seven.' : scenario === 'C3' ? naturalResult(length) : text);
      if (scenario === 'C4') {
        await output(s, details.id, 'The synthetic observatory code is amber seven.');
        details.storyAsk = await ask(s, 'Tell a thirty second synthetic story about a kite in three long sentences. Do not look anything up.', false);
        details.transcriptBeforeInterruption = s.transcripts.map(t => t.text).join('');
        details.appendAt = content(s, details.id, 'Host update: the synthetic harbor code is blue nine.');
        await quiet(s, 10000, 35000);
      }
      if (scenario === 'A3') {
        const first = details.id;
        details.second = await ask(s, 'Correction: look up the current synthetic harbor code instead of the observatory code.');
        details.appendAt = content(s, details.second.id, 'The corrected synthetic harbor code is blue nine.');
        await pause(600); content(s, first, 'The superseded synthetic observatory code is amber seven.');
        await quiet(s, 4000, 15000);
      }
      if (scenario === 'A5' || scenario === 'B4') {
        if (scenario === 'B4') await pending(s);
        summary(s, { ...details, note: 'Closing genuinely open delegation before result' }); s.close(); await pause(100);
        s = await open(`${run}-rebuild`, seedItems('The synthetic observatory code is amber seven.'));
        details = { appendAt: s.ms(), note: 'Seeded finished result; no new audio ask' };
        if (scenario === 'B4') s.send({ type: 'response.create' });
        else if (variant === 'instructions') s.send({ type: 'session.instructions.append', instructions: 'Speak the finished observatory result already in the conversation now, without lookup.' });
        await quiet(s, 5000, 18000);
      }
      if (scenario === 'A6') {
        s.mic(false); details.appendAt = content(s, details.id, 'The synthetic observatory code is amber seven.');
        await pause(4000); details.resumeAt = s.ms(); s.mic(true); await quiet(s, 5000, 18000);
      }
      if (scenario === 'A7') {
        details.thinkingAt = content(s, details.id, 'The synthetic secret token is violet forty two.', 'session.thinking.append');
        await pause(1000); details.appendAt = content(s, details.id, 'The lookup is finished.'); await quiet(s, 3000, 12000);
        if (variant === 'recall') { details.followUp = await ask(s, 'What is the synthetic secret token that was just supplied? Answer from context without a lookup.', false); await quiet(s, 3000, 12000); }
      }
      if (scenario === 'A8') { await quiet(s, 3000, 6000); details.delegated = true; }
      if (['B1', 'B3', 'B5'].includes(scenario)) {
        const found = await pending(s);
        if (scenario === 'B3' && found) details.second = await ask(s, 'Correction: look up the current synthetic harbor code instead of the observatory code.');
        const delivered = await toolOutput(s, scenario === 'B3' ? 'The superseded synthetic observatory code is amber seven.' : text);
        details.outputAt = delivered.at; details.written = delivered.written;
        await quiet(s, 4000, Math.min(200000, length / 12 * 1000 + 20000));
      }
    }
    summary(s, details); s.close(); await pause(100);
  }
  appendFileSync(report, '\nVerdict: UNKNOWN pending transcript and frame review; audio after an append may be an acknowledgment rather than the result.\n');
} catch (error) {
  appendFileSync(report, `\nSTOP: ${error.message}. Verdict UNKNOWN for unexecuted attempts.\n`);
  console.error(error.message); process.exitCode = 2;
} finally { for (const s of sockets) s.close(); credential = undefined; }
