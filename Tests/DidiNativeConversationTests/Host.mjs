// Controlled synthetic fixture. Every acceptance goes through canonical authenticated HTTP/CHAT.
import { startHost, pairLocal } from '../../server/dist/host/runtime.js';
import { profile, sse, syntheticKey } from '../../server/dist/test/connected-process.js';
import { appendFileSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
const dir = process.argv[2];
try { await access(join(dir, 'provider-config')); } catch { await profile(dir); }
let holdProvider = false;
let responseMode = 'normal';
let wire = [];
const host = await startHost({ dataDir: dir, webRoot: dir, port: 0, modelTesting: {
  credentials: { resolve: async () => syntheticKey },
  transport: async () => {
    appendFileSync(join(dir, 'provider-attempts'), 'attempt\n');
    process.send({ event: 'provider' });
    if (holdProvider) return new Promise(() => {});
    return sse();
  }
} });
const proxy = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers }; delete headers.host; delete headers.connection; delete headers['content-length'];
    if (req.url === '/api/v1/chat') wire.push({ body: body.toString('utf8'), key: headers['idempotency-key'], epoch: headers['x-didi-authority-epoch'], authorization: headers.authorization ?? null });
    const response = await fetch(host.descriptor.origin + req.url, { method: req.method, headers, ...(body.length ? { body } : {}) });
    const data = await response.text();
    if (req.url === '/api/v1/chat' && response.status === 200) {
      process.send({ event: 'committed', run: JSON.parse(data).data });
      if (responseMode === 'hold') return;
      if (responseMode === 'drop') { res.destroy(); return; }
      if (responseMode === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{bad'); return; }
    }
    res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(data);
  } catch { res.destroy(); }
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const code = await pairLocal(dir);
const paired = await fetch(host.descriptor.origin + '/api/v1/auth/pair', { method: 'POST', headers: { Origin: host.descriptor.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode: code }) });
if (paired.status !== 200) throw Error('fixture pairing failed');
const data = await paired.json();
const auth = { cookie: paired.headers.get('set-cookie').split(';')[0], csrf: data.data.csrfToken };
async function call(path, body, key = 'fixture-' + crypto.randomUUID()) {
  const response = await fetch(host.descriptor.origin + '/api/v1' + path, { method: body === undefined ? 'GET' : 'POST', headers: {
    Cookie: auth.cookie, Origin: host.descriptor.origin, 'X-Didi-CSRF': auth.csrf, 'X-Didi-Authority-Epoch': host.store.authorityEpoch, 'Idempotency-Key': key, 'Content-Type': 'application/json'
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, ...(await response.json()) };
}
process.on('message', async message => {
  try {
    let result;
    if (message.command === 'call') result = await call(message.path, message.body, message.key);
    if (message.command === 'mode') { responseMode = message.response ?? 'normal'; holdProvider = message.provider ?? false; result = true; }
    if (message.command === 'stats') {
      const rows = host.store.transaction(tx => tx.all('SELECT run_id, session_id, state, outcome FROM chat_runs'));
      const captures = host.store.transaction(tx => tx.get("SELECT count(*) AS count FROM entries WHERE role='user'"));
      let attempts = 0; try { attempts = (await readFile(join(dir, 'provider-attempts'), 'utf8')).trim().split('\n').length; } catch {}
      result = { wire, rows, captures: Number(captures.count), attempts };
    }
    process.send({ id: message.id, result });
  } catch (error) { process.send({ id: message.id, error: String(error) }); }
});
process.send({ event: 'ready', config: { base: `http://127.0.0.1:${proxy.address().port}`, origin: host.descriptor.origin, ...auth, assistant: host.store.assistantId, epoch: host.store.authorityEpoch } });
