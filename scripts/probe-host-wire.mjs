#!/usr/bin/env node
/** Synthetic host composition, with real voice and helper models. Never opens an audio device. */
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import WebSocket from '../server/node_modules/ws/index.js';
import { OpenAiLiveVoiceAdapter } from '../server/dist/adapters/live-voice/openai.js';
import { Store } from '../server/dist/runtime/store.js';
import { domainMigrations } from '../server/dist/domain/schema.js';
import { chatMigrations } from '../server/dist/chat/schema.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile } from '../server/dist/live/index.js';
import { hostTaskFactory } from '../server/dist/tasks/host.js';
import { createModelPort } from '../server/dist/tasks/model.js';
import { resolveTaskModels } from '../server/dist/config/tasks.js';
import { documentResult } from '../server/dist/tasks/results.js';
import { attachHostLogSink } from '../server/dist/tools/host-events.js';
import { composeLiveInstruction, NAYA_LIVE_BASE } from '../server/dist/prompt/index.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
if (args.includes('--help')) {
  console.log('node scripts/probe-host-wire.mjs --env-file PATH --report PATH --transcripts PATH [--count 3] [--scenarios H,I,J]');
  process.exit(0);
}
const envFile = option('--env-file');
const report = option('--report');
const transcripts = option('--transcripts');
if (!envFile || !report || !transcripts) throw Error('Required: --env-file, --report, --transcripts');
const count = Number(option('--count', '3'));
const scenarios = option('--scenarios', 'H,I,J').split(',');
if (!Number.isInteger(count) || count < 1 || count > 4 || scenarios.some(x => !/^(H|I|J)$/.test(x))) throw Error('Invalid trial selection');
// Deliberately extract only the authorized key; never populate process.env or inspect other values.
const match = readFileSync(envFile, 'utf8').match(/^OPENAI_API_KEY\s*=\s*["']?([^\r\n"']+)["']?\s*$/m);
if (!match) throw Error('OPENAI_API_KEY missing');
const key = match[1].trim();
const credentials = { resolve: async () => key };
const cap = 2.50;
const textRate = 30 / 1e6 / 3; // Same P1 estimate: $0.05/socket minute, 3 chars/token, $30/M blended.
const ledger = `${transcripts}.budget.json`;
let spent = existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')).spent : 0;
if (!Number.isFinite(spent) || spent < 0 || spent >= cap) throw Error('BUDGET_STOP');
let active;
const note = text => appendFileSync(report, `${text}\n`);
const raw = value => appendFileSync(transcripts, `${JSON.stringify(value)}\n`);
const persist = () => writeFileSync(ledger, JSON.stringify({ spent, ceiling: cap, method: 'P1 socket/time/text plus helper tokens at conservative $30/M; reservation before each trial' }));
const estimate = () => spent + (active ? (Date.now() - active.start) / 60000 * 0.05 + active.textChars * textRate + active.helperCost : 0);
const guard = (reserve = 0) => { if (estimate() + reserve >= cap - 0.03) throw Error('BUDGET_STOP'); };
const dir = mkdtempSync(join(tmpdir(), 'synthetic-host-wire-'));
const pcmCache = new Map();
function speech(text) {
  if (pcmCache.has(text)) return pcmCache.get(text);
  const aiff = join(dir, 'speech.aiff'), pcm = join(dir, 'speech.pcm');
  execFileSync('/usr/bin/say', ['-r', '220', '-o', aiff, text]);
  execFileSync('/opt/homebrew/bin/ffmpeg', ['-y', '-v', 'error', '-i', aiff, '-f', 's16le', '-ac', '1', '-ar', '24000', pcm]);
  const bytes = readFileSync(pcm); pcmCache.set(text, bytes); return bytes;
}
// Exact synthetic owner literal from server/test/prompt.test.ts, not any installed owner profile.
const ownerProfile = { schemaVersion: 1, kind: 'profile', ownerId: 'alice', profileVersion: 'fixture-a', displayName: 'Example',
  style: { text: 'SYNTHETIC exact warm style', dataClass: 'private' }, lore: { text: 'SYNTHETIC exact library lore', dataClass: 'sensitive' } };
const prompt = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile }).text;
const route = { enabled: true, provider: 'openai', modelId: 'gpt-live-1', dataClasses: ['ordinary', 'private', 'sensitive'] };
const facts = ['The harbor inspection is on Tuesday at nine.', 'Mira Vale is the synthetic sender.', 'The meeting point is the blue gate.', 'The north pier is closed for repairs.', 'Bring a yellow safety vest.', 'The survey boat is called Lantern.', 'The access code is synthetic 4826.', 'The water samples go to Bay Lab.', 'The budget is 240 synthetic credits.', 'The backup date is Thursday.', 'The coordinator is Ivo Reed.', 'The final report is due Friday at noon.'];
const longRecord = facts.map((x, i) => `${i + 1}. ${x} ${['This detail belongs to the fictional harbor planning record.', 'Retain this detail in the synthetic briefing.'][i % 2]}`).join('\n');
const shortRecord = 'Synthetic mail from Mira Vale, subject Harbor plan: The harbor inspection is Tuesday at nine. Meet at the blue gate. Bring a yellow safety vest. The north pier is closed.';
const questions = {
  H: 'Please look up what epistemology means in philosophy, just the general idea, not anything personal.',
  I: 'Read the synthetic harbor briefing from Mira Vale and explain all twelve facts in order, slowly and in detail, at least two hundred words.',
  J: 'What did the synthetic sender Mira Vale write about the harbor?',
  B: 'What did the synthetic sender Mira Vale write about the harbor?',
  C: 'Read the synthetic harbor briefing from Mira Vale and tell me all twelve facts in order, about twelve hundred characters, without leaving any out.',
  D: 'I think I want something new in my life, and you turned out pretty well.',
  E: 'Why is the sky blue? Answer in one short sentence.',
  F: 'Read the synthetic harbor briefing from Mira Vale and tell me all twelve facts, slowly and in detail.',
  G: 'I was thinking that maybe we should',
};
const clean = event => {
  const copy = { ...event };
  for (const field of ['pcm', 'audio', 'delta']) if (field in copy && (field !== 'delta' || /audio/.test(copy.type ?? ''))) copy[field] = '[audio omitted]';
  return copy;
};
async function trial(scenario, number) {
  guard(0.45);
  // Persist a crash reservation. Successful finalization replaces it with the measured estimate.
  writeFileSync(ledger, JSON.stringify({ spent: spent + 0.45, ceiling: cap, reserved: true }));
  active = { start: Date.now(), textChars: 0, helperCost: 0, scenario, number, sessions: 0, events: [], logs: [], commentary: [], acks: [], tools: [], helper: [], audio: [], ownerEnds: [], stopped: false };
  const t = active;
  raw({ trial: `${scenario}-${number}`, start: new Date().toISOString(), prompt, longRecord: scenario === 'I' ? longRecord : undefined });
  const log = e => { t.logs.push({ at: Date.now() - t.start, ...e }); raw({ at: Date.now() - t.start, host: e }); };
  const detach = attachHostLogSink({ event: log });
  const adapter = new OpenAiLiveVoiceAdapter({ modelId: 'gpt-live-1', voice: 'marin', keyReference: 'synthetic', credentials, route,
    socketFactory: (url, config) => {
      t.sessions++;
      const ws = new WebSocket(url, config);
      const send = ws.send.bind(ws);
      ws.send = (data, ...rest) => {
        const e = JSON.parse(String(data));
        if (e.type === 'session.update') { const text = JSON.stringify(e); guard(text.length * textRate); t.textChars += text.length; }
        if (/commentary/.test(e.type)) { t.commentary.push({ at: Date.now() - t.start, ...e }); t.textChars += JSON.stringify(e).length; raw({ outgoing: e, at: Date.now() - t.start }); }
        return send(data, ...rest);
      };
      ws.on('message', data => {
        let e; try { e = JSON.parse(String(data)); } catch { return; }
        if (/commentary/.test(e.type)) { t.acks.push(e); raw({ incoming: e, at: Date.now() - t.start }); }
        if (e.type === 'error') raw({ providerError: e, at: Date.now() - t.start });
      });
      return ws;
    } });
  const voice = { capabilities: adapter.capabilities, open(request, control) {
    const session = adapter.open(request, control);
    const events = { async *[Symbol.asyncIterator]() {
      for await (const e of session.events) {
        const at = Date.now() - t.start;
        if (e.type === 'audio') { if (e.audible) t.audio.push(at); }
        else { t.events.push({ at, ...clean(e) }); raw({ at, voice: clean(e) }); if (typeof e.text === 'string') t.textChars += e.text.length; }
        yield e;
      }
    } };
    return new Proxy(session, { get(target, prop) { if (prop === 'events') return events; const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; } });
  } };
  const models = resolveTaskModels(undefined);
  const infer = createModelPort({ role: models.worker, credentials, transport: async (url, init) => {
    guard(0.15);
    const body = JSON.parse(init.body);
    const inputChars = JSON.stringify(body).length;
    const reservation = inputChars / 3 * 30 / 1e6 + 0.12; // Reserve 4,000 output tokens before request.
    guard(reservation); // A refused request must not be charged to the cumulative ledger.
    t.helperCost += reservation;
    raw({ helperRequest: body, at: Date.now() - t.start });
    const response = await fetch(url, init);
    const result = await response.clone().json();
    const usage = result.usage;
    // Keep at least the conservative reservation; account additional usage if it is larger.
    const actual = ((usage?.input_tokens ?? inputChars / 3) + (usage?.output_tokens ?? 4000)) * 30 / 1e6;
    if (usage?.input_tokens !== undefined && usage?.output_tokens !== undefined) t.helperCost += actual - (inputChars / 3 * 30 / 1e6 + 0.12);
    t.helper.push({ http: response.status, usage, result });
    raw({ helperResponse: result, at: Date.now() - t.start });
    return response;
  } });
  const store = new Store(join(dir, `${scenario}-${number}`), [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  const execute = async (name, args) => { t.tools.push({ name, args }); raw({ tool: name, args }); return documentResult(scenario === 'I' ? longRecord : shortRecord, 'synthetic-harbor'); };
  const executors = Object.fromEntries(['search_mail', 'read_mail', 'mail_search', 'mail_read', 'search_memory'].map(name => [name, args => execute(name, args)]));
  const owner = createLiveSessionOwner({ store, voice, log,
    profile: validateLiveProfile({ provider: 'openai', liveModelId: 'gpt-live-1', voice: 'marin', keyReference: 'synthetic', route, prompt: { text: prompt, dataClass: 'sensitive' } }),
    createTaskRuntime: hostTaskFactory({ store, credentials, models, infer, bindings: () => [], executors: () => executors, timeZone: 'UTC', effectCheck: async () => false, log }) });
  const context = { clientId: 'synthetic-client', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
  let attachment, timer, draining;
  const frameQueue = [];
  let lastWord = null;
  function enqueue(text) { const bytes = speech(text); for (let i = 0; i < bytes.length; i += 1440) frameQueue.push(bytes.subarray(i, i + 1440)); }
  async function until(test, ms) { const end = Date.now() + ms; while (!test() && Date.now() < end) { if (t.stopped) throw Error('BUDGET_STOP'); await pause(30); } return test(); }
  async function say(text) { raw({ owner: text, at: Date.now() - t.start }); enqueue(text); await until(() => frameQueue.length === 0, 60000); lastWord = Date.now() - t.start; t.ownerEnds.push(lastWord); }
  async function quiet(ms) { await until(() => false, ms); }
  async function answerDone(ms = 35000) {
    const after = lastWord;
    await until(() => t.logs.some(e => e.at >= after && e.event === 'task_lifecycle' && e.phase === 'complete'), ms);
    const delivered = t.logs.filter(e => e.event === 'task_delivery' && e.at >= after).at(-1)?.at ?? after;
    await until(() => t.events.some(e => e.at >= delivered && e.type === 'turnComplete'), ms);
  }
  try {
    const session = owner.create({ idempotencyKey: `synthetic-${scenario}-${number}`, inputClass: 'ordinary' }, context);
    attachment = owner.attach({ liveSessionId: session.liveSessionId }, context);
    draining = (async () => { for await (const chunk of attachment.output) { if (chunk.kind === 'marker') raw({ marker: chunk.marker, at: Date.now() - t.start }); } })();
    await Promise.race([attachment.ready, pause(20000).then(() => { throw Error('ready timeout'); })]);
    timer = setInterval(() => {
      try { guard(); attachment.sendAudio({ pcm: frameQueue.shift() ?? Buffer.alloc(1440) }); }
      catch (error) { t.stopped = true; t.error = error.message; clearInterval(timer); }
    }, 30);
    // The real host opens model-first. Let that opening finish before measuring an owner ask.
    if (!await until(() => t.events.some(e => e.type === 'turnComplete'), 20000)) throw Error('opening did not complete');
    await quiet(1000);
    if (scenario.startsWith('A')) {
      await say('Why does the moon'); await quiet(scenario === 'A1' ? 1000 : 3000); await say('look larger when it is near the horizon?');
    } else await say(scenario === 'H' ? [questions.H, 'Can you check what stoicism means, as a general philosophy?', 'Look up the general meaning of metaphysics for me.', 'Please research what epistemology is, in ordinary words.'][number - 1] : questions[scenario]);
    if (scenario === 'I') {
      const delivered = () => t.logs.filter(e => e.event === 'task_delivery').at(-1)?.at;
      const speakingLong = await until(() => {
        const start = delivered();
        const audio = t.audio.filter(at => start !== undefined && at >= start);
        return audio.length > 0 && audio.at(-1) - audio[0] >= 15000 && Date.now() - t.start - audio.at(-1) < 400;
      }, 55000);
      raw({ bargePrerequisite: speakingLong, at: Date.now() - t.start });
      if (speakingLong) { await say('Stop. Forget the harbor. What is two plus two?'); await quiet(20000); }
      else t.error = 'Long audible answer prerequisite not met';
    } else { await answerDone(); await quiet(5000); }
  } catch (error) { t.error = error.message; raw({ trialError: t.error }); }
  finally {
    clearInterval(timer);
    if (attachment) { try { attachment.close(); } catch {} }
    await owner.shutdown();
    if (draining) await draining.catch(error => { t.error ??= error.message; });
    store.close(); detach();
    spent = estimate(); active = undefined; persist();
  }
  const outputs = t.events.filter(e => e.type === 'outputTranscription');
  // Adapter transcription events are deltas; finished markers can contain only a newline.
  const finalText = outputs.map(e => e.text).join('');
  const latency = t.ownerEnds.map(end => ({ ownerEndMs: end, firstAudioMs: t.audio.find(at => at >= end) ?? null, latencyMs: (t.audio.find(at => at >= end) ?? NaN) - end }));
  const rebuild = t.logs.filter(e => e.event === 'live_rebuild').length;
  const result = { audibleAudio: t.audio, ownerEnds: t.ownerEnds, scenario, number, error: t.error ?? null, live_rebuild: rebuild, providerSessions: t.sessions,
    delegations: t.events.filter(e => /delegation/i.test(e.type)), commentary: t.commentary, chunks: t.commentary.length, acks: t.acks,
    helperStatus: t.logs.filter(e => /task/.test(e.event ?? '')), helperCalls: t.helper.length, tools: t.tools, latency,
    answerTimeMs: t.audio.length ? t.audio.at(-1) - (t.audio.find(at => at >= t.ownerEnds[0]) ?? t.audio[0]) : null,
    audioLastMs: t.audio.at(-1) ?? null, transcript: finalText, outputEvents: outputs, cumulativeEstimatedUSD: spent,
    estimatedHelperUSD: t.helperCost, elapsedMs: Date.now() - t.start,
    repeatAssessment: 'Review full delta transcript for repeated facts; no semantic model judge is used.',
    announcements: (finalText.match(/look(?:ing)? (?:it |that )?up|check(?:ing)?|find(?:ing)?|search(?:ing)?/gi) ?? []).length };
  raw({ result });
  note(`| ${scenario}-${number} | REVIEW | ${rebuild} | ${t.sessions} | ${t.commentary.length}/${t.acks.length} | ${t.helper.length} | ${latency.map(x => Number.isFinite(x.latencyMs) ? x.latencyMs : 'none').join(',')} | ${result.answerTimeMs} | ${spent.toFixed(4)} |`);
  console.log(JSON.stringify({ scenario, number, error: result.error, sessions: t.sessions, helper: t.helper.length, cost: spent, transcript: finalText }));
}
appendFileSync(transcripts, '\n# Synthetic host-wire event stream\n');
note('\n## Host-wire measurements\n| Trial | Verdict pending semantic review | live_rebuild | Sessions | Commentary/acks | Helper calls | First audio latency ms | Answer span ms | Cumulative USD |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
try {
  for (let n = 1; n <= count; n++) for (const scenario of scenarios) {
    try { await trial(scenario, n); }
    catch (error) { if (error.message === 'BUDGET_STOP') { note(`Budget stopped before ${scenario}-${n}: estimated USD ${spent.toFixed(4)} / 2.50.`); throw error; } throw error; }
  }
} catch (error) { note(`Probe stopped: ${error.message}`); if (error.message !== 'BUDGET_STOP') process.exitCode = 1; }
finally { rmSync(dir, { recursive: true, force: true }); }
