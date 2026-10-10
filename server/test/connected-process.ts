import { createServer } from 'node:http';
import { mkdir, writeFile, access, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from '../host/runtime.js';

export const syntheticKey = 'connected-synthetic-not-a-real-key';
export const answer = 'Naya: Let us choose one small next step and keep the rest for later.';
export async function profile(dir: string, model = 'gemini-connected-test', classes = ['ordinary', 'private']) {
  const configDir = join(dir, 'provider-config');
  await mkdir(configDir, { mode: 0o700 });
  await writeFile(join(configDir, 'profile.json'), JSON.stringify({ schemaVersion: 1, enabled: true, provider: 'gemini', modelId: model, keyReference: 'gemini-primary', dataClasses: classes,
    preferences: { dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'off', verbosity: 'balanced' } }), { mode: 0o600 });
  await writeFile(join(configDir, 'gemini-primary.json'), JSON.stringify({ schemaVersion: 1, keyReference: 'gemini-primary', key: syntheticKey }), { mode: 0o600 });
  return configDir;
}
export function modelFrames(text = answer, finish = 'STOP') {
  return `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: text.slice(0, 25) }] } }] })}\n\ndata: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: text.slice(25) }] }, finishReason: finish }] })}\n\n`;
}
export function sse(text = answer, finish = 'STOP') {
  const bytes = new TextEncoder().encode(modelFrames(text, finish));
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes.slice(0, 17));
    timer = setTimeout(() => { for (let i = 17; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); }, 40);
  }, cancel() { if (timer) clearTimeout(timer); } }), { headers: { 'content-type': 'text/event-stream' } });
}

// Test fixture entry only; not packaged or reachable via host CLI/environment.
async function main() {
  const [dir, webRoot, rawPort, mode] = process.argv.slice(2);
  if (!dir || !webRoot) throw Error('Connected fixture needs state and built web paths');
  try { await access(join(dir, 'provider-config')); } catch { await profile(dir); }
  let calls = 0, aborted = 0, nextMode = '';
  const completions = new Set<() => void>();
  process.on('message', value => { if (value === 'hold-next' || value === 'fail-next' || value === 'stream-next') nextMode = value; if (value === 'finish-stream') for (const finish of [...completions]) finish(); });
  const responses = new Set<import('node:http').ServerResponse>();
  const transportServer = createServer(async (req, res) => {
    responses.add(res); let body = ''; for await (const chunk of req) body += String(chunk);
    calls++; await appendFile(join(dir, 'wire.jsonl'), JSON.stringify({ body: JSON.parse(body) }) + '\n');
    process.send?.({ phase: 'transport', calls });
    let timer: ReturnType<typeof setTimeout> | undefined;
    res.on('close', () => { if (timer) clearTimeout(timer); responses.delete(res); if (!res.writableFinished) { aborted++; if (process.connected) process.send?.({ phase: 'aborted', aborted }); } });
    const control = nextMode; nextMode = '';
    if (mode === 'hold' || control === 'hold-next') return;
    if (control === 'fail-next') { res.writeHead(503); res.end('controlled provider failure'); return; }
    const frames = Buffer.from(modelFrames()); res.writeHead(200, { 'content-type': 'text/event-stream' });
    const cut = frames.indexOf('\n\n') + 2; res.write(frames.subarray(0, cut));
    const finish = () => { completions.delete(finish); for (let i = cut; i < frames.length; i += 7) res.write(frames.subarray(i, i + 7)); res.end(); };
    res.on('close', () => completions.delete(finish));
    if (control === 'stream-next') completions.add(finish);
    else timer = setTimeout(finish, 150);
  });
  await new Promise<void>(resolveListen => transportServer.listen(0, '127.0.0.1', resolveListen));
  const addr = transportServer.address(); if (!addr || typeof addr === 'string') throw Error('Missing capturing transport address');
  const host = await startHost({ dataDir: resolve(dir), webRoot: resolve(webRoot), port: Number(rawPort ?? 0), modelTesting: {
    credentials: { resolve: async reference => { if (reference !== 'gemini-primary') throw Error('bad fixture reference'); return syntheticKey; } },
    transport: async (url, init) => { if (!url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-')) throw Error('Wrong actual adapter URL'); const response = await fetch(`http://127.0.0.1:${addr.port}/capture`, init);
      // Trusted synthetic provider transport: stream the actual local HTTP body,
      // not a redirected provider Response. Production URL validation stays intact.
      return new Response(response.body, { status: response.status, headers: response.headers }); }
  } });
  let closing = false;
  async function stop() {
    if (closing) return; closing = true; await host.close();
    for (const response of responses) response.destroy();
    await new Promise<void>(resolveClose => { transportServer.close(() => resolveClose()); transportServer.closeAllConnections(); });
    process.disconnect?.();
  }
  process.on('message', value => { if (value === 'stop') void stop(); });
  process.on('disconnect', () => { void stop(); });
  process.send?.({ phase: 'ready', descriptor: host.descriptor });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(error); process.exitCode = 1; });
