// Synthetic local-note fixture for the selected-memory browser proof.
// Real canonical Store + Domain + ChatService + HTTP host over a controlled provider transport.
// Notes are seeded through the trusted Domain port with an explicit writer/dataClass, exactly as
// the accepted MEMORY backend expects; this file adds no production backdoor.
import { createServer } from 'node:http';
import { access, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from '../host/runtime.js';
import { createDomainPort } from '../domain/facade.js';
import { Outbox } from '../runtime/outbox.js';
import { profile, modelFrames, syntheticKey, answer } from './connected-process.js';

export { answer };
export const notes = {
  ordinary: { title: 'Garden plan', text: 'SELMEM-ORDINARY-NOTE water the tomatoes on Thursday and prune the basil.' },
  private: { title: 'Project scratch', text: 'SELMEM-PRIVATE-NOTE the release checklist needs one small next step.' },
  sensitive: { title: 'Clinic letter', text: 'SELMEM-SENSITIVE-NOTE beyond the current grant.' },
  unknown: { title: 'Unfiled notes', text: 'SELMEM-UNKNOWN-NOTE never classified.' },
  canary: { title: 'Canary archive', text: 'SELMEM-CANARY-NEVER-SELECTED must never reach the model.' },
  oversized: { title: 'Long transcript', text: `SELMEM-OVERSIZE-NOTE overlong ${'x'.repeat(45000)}` },
};

async function main() {
  const [dir, webRoot, rawPort] = process.argv.slice(2);
  if (!dir || !webRoot) throw Error('Selected-memory fixture needs state and built web paths');
  try { await access(resolve(dir, 'provider-config')); } catch { await profile(dir); }
  let calls = 0, nextMode = '';
  const completions = new Set<() => void>();
  process.on('message', value => { if (value === 'hold-next' || value === 'fail-next' || value === 'stream-next') nextMode = value; if (value === 'finish-stream') for (const finish of [...completions]) finish(); });
  const responses = new Set<import('node:http').ServerResponse>();
  const transportServer = createServer(async (req, res) => {
    responses.add(res); let body = ''; for await (const chunk of req) body += String(chunk);
    calls++; await appendFile(resolve(dir, 'wire.jsonl'), JSON.stringify({ body: JSON.parse(body) }) + '\n');
    process.send?.({ phase: 'transport', calls });
    let timer: ReturnType<typeof setTimeout> | undefined;
    res.on('close', () => { if (timer) clearTimeout(timer); responses.delete(res); });
    const control = nextMode; nextMode = '';
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
    credentials: { resolve: async () => syntheticKey },
    transport: async (url, init) => { if (!url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-')) throw Error('Wrong actual adapter URL'); const response = await fetch(`http://127.0.0.1:${addr.port}/capture`, init); return new Response(response.body, { status: response.status, headers: response.headers }); }
  } });
  // Trusted in-process seeding of labelled and unclassified synthetic notes.
  const domain = createDomainPort({ outbox: Outbox });
  const ctx = () => ({ assistantId: host.store.assistantId, clientId: 'local-admin', authorityEpoch: host.store.authorityEpoch, now: new Date(0).toISOString() });
  const seed = (title: string, text: string, label?: { writer: string; dataClass: string }) => {
    const session = host.store.transaction(tx => domain.execute(tx, 'createSession', { title, timeZone: 'UTC' }, ctx(), label as never)) as { id: string };
    const entry = host.store.transaction(tx => domain.execute(tx, 'appendEntry', { sessionId: session.id, text, role: 'user', timeZone: 'UTC' }, ctx(), label as never)) as { id: string };
    return { sessionId: session.id, entryId: entry.id };
  };
  // The Domain accepts only capture/private or model/private|sensitive as trusted write labels.
  const privateLabel = { writer: 'capture', dataClass: 'private' };
  const sensitiveLabel = { writer: 'model', dataClass: 'sensitive' };
  const seeded = {
    ordinary: seed(notes.ordinary.title, notes.ordinary.text, privateLabel),
    private: seed(notes.private.title, notes.private.text, privateLabel),
    sensitive: seed(notes.sensitive.title, notes.sensitive.text, sensitiveLabel),
    unknown: seed(notes.unknown.title, notes.unknown.text),
    canary: seed(notes.canary.title, notes.canary.text, privateLabel),
    oversized: seed(notes.oversized.title, notes.oversized.text, privateLabel),
  };
  let closing = false;
  async function stop() {
    if (closing) return; closing = true; await host.close();
    for (const response of responses) response.destroy();
    await new Promise<void>(resolveClose => { transportServer.close(() => resolveClose()); transportServer.closeAllConnections(); });
    process.disconnect?.();
  }
  process.on('message', value => { if (value === 'stop') void stop(); });
  process.on('disconnect', () => { void stop(); });
  process.send?.({ phase: 'ready', descriptor: host.descriptor, seeded });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(error); process.exitCode = 1; });
