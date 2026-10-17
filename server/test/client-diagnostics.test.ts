import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { listenService } from '../http/server.js';
import { HostLog } from '../host/log.js';

const audio = { event: 'live_precreate_failed', failureClass: 'audio', code: 'permissionDenied' };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'didi-diagnostics-'));
  const store = new Store(dir);
  let time = Date.now();
  const service = await listenService({ store, port: 0, now: () => time });
  const auth = { Authorization: `Bearer ${store.adminCredential}`, 'Content-Type': 'application/json' };
  const post = (body: unknown, headers: Record<string, string> = auth) => fetch(`${service.origin}/api/v1/diagnostics/client`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const lines = () => existsSync(join(dir, 'logs/host.log')) ? readFileSync(join(dir, 'logs/host.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { dir, store, service, auth, post, lines, advance() { time += 60000; }, async close() { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test('operator diagnostics append exact nested typed events alongside another HostLog instance', async () => {
  const f = await fixture();
  try {
    const serviceEvent = { event: 'live_precreate_failed', failureClass: 'service', code: 'http', detail: 503 };
    for (const diagnostic of [audio, serviceEvent]) {
      const response = await f.post(diagnostic);
      assert.equal(response.status, 204); assert.equal(await response.text(), '');
      new HostLog(f.dir).event({ event: 'live_attach_rejected', code: 'unavailable' });
    }
    const lines = f.lines();
    assert.equal(lines.length, 4);
    const diagnostics = lines.filter(line => line.event === 'client_diagnostic');
    assert.equal(diagnostics.length, 2);
    for (const [index, line] of diagnostics.entries()) {
      assert.deepEqual(Object.keys(line).sort(), ['diagnostic', 'event', 'pid', 'receivedAt', 'source', 'timestamp'].sort());
      assert.equal(line.source, 'native'); assert.ok(Number.isFinite(Date.parse(line.receivedAt)));
      assert.deepEqual(line.diagnostic, [audio, serviceEvent][index]);
    }
  } finally { await f.close(); }
});
test('cookie principal is forbidden and unauthenticated diagnostics are unauthorized', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post(audio, { 'Content-Type': 'application/json' })).status, 401);
    const pairing = await fetch(`${f.service.origin}/api/v1/auth/pairing`, { method: 'POST', headers: f.auth, body: '{}' });
    const pairingCode = (await pairing.json()).data.pairingCode;
    const paired = await fetch(`${f.service.origin}/api/v1/auth/pair`, { method: 'POST', headers: { Origin: f.service.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode }) });
    assert.equal(paired.status, 200);
    const csrf = (await paired.json()).data.csrfToken;
    assert.equal((await f.post(audio, { Cookie: paired.headers.get('set-cookie')!, Origin: f.service.origin, 'X-Didi-CSRF': csrf, 'Content-Type': 'application/json' })).status, 403);
    assert.deepEqual(f.lines(), []);
  } finally { await f.close(); }
});
test('free text and every invalid diagnostic shape are rejected without logging', async () => {
  const f = await fixture();
  try {
    for (const invalid of [
      { ...audio, message: 'private free text' }, { ...audio, code: 'unknown' }, { ...audio, failureClass: 'service' },
      { ...audio, extra: 1 }, { ...audio, event: 'other' }, { ...audio, detail: 1 },
      { event: 'live_precreate_failed', failureClass: 'service', code: 'http', detail: 1.5 },
      { event: 'live_precreate_failed', failureClass: 'service', code: 'socketClosed', detail: '1006' },
      JSON.stringify(audio) + ' '.repeat(513),
    ]) {
      const response = await f.post(invalid); assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'BAD_REQUEST');
    }
    assert.deepEqual(f.lines(), []);
  } finally { await f.close(); }
});
test('rolling minute allows thirty diagnostics, rejects the next and expires without a real wait', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 30; index++) assert.equal((await f.post(audio)).status, 204);
    const rejected = await f.post(audio); assert.equal(rejected.status, 429);
    assert.equal((await rejected.json()).error.code, 'rate_limited'); assert.equal(f.lines().length, 30);
    f.advance(); assert.equal((await f.post(audio)).status, 204); assert.equal(f.lines().length, 31);
  } finally { await f.close(); }
});

test('#352: a mic mode receipt carries the two names and refuses anything else', async () => {
  const f = await fixture();
  try {
    const receipt = { event: 'mic_mode', preferred: 'voiceIsolation', active: 'standard' };
    const accepted = await f.post(receipt);
    assert.equal(accepted.status, 204); assert.equal(await accepted.text(), '');
    for (const refused of [
      { event: 'mic_mode', preferred: 'loud', active: 'standard' },
      { event: 'mic_mode', preferred: 'standard', active: 'standard', text: 'owner speech' },
      { event: 'mic_mode', preferred: 'standard' },
    ]) assert.equal((await f.post(refused)).status, 400, `refused ${JSON.stringify(refused)}`);
    const diagnostics = f.lines().filter(line => line.event === 'client_diagnostic');
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0].diagnostic, receipt);
  } finally { await f.close(); }
});
