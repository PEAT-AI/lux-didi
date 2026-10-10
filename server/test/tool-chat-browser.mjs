import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const dependencyRoot = process.env.DIDI_TOOL_CHAT_DEPENDENCIES;
assert.ok(dependencyRoot, 'Producer must supply the verified dependency root');
const require = createRequire(resolve(dependencyRoot, '../../web/package.json'));
const { chromium } = require('playwright');
function message(child, phase) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error(`Synthetic process ${phase} timeout`)), 10000);
    const receive = value => { if (value.phase === phase) finish(null, value); };
    const exited = () => finish(Error(`Synthetic process exited before ${phase}`));
    function finish(error, value) {
      clearTimeout(timer); child.off('message', receive); child.off('exit', exited);
      if (error) reject(error); else resolve(value);
    }
    child.on('message', receive); child.on('exit', exited);
  });
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.send('stop');
  let timer;
  try {
    const [code] = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Synthetic child did not stop')), 4000);
    })]);
    assert.equal(code, 0);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      const forcedExit = once(child, 'exit'); child.kill('SIGTERM');
      try { await Promise.race([forcedExit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic forced browser child exit timeout')), 2000); })]); }
      finally { clearTimeout(timer); }
    }
  }
}

test('B3/B5 built browser renders real trusted source identifiers and durable tool refs, never model navigation', { timeout: 45000 }, async t => {
  const child = fork(resolve(process.env.DIDI_TOOL_CHAT_PROCESS), ['browser'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; let outputBytes = 0;
  const capture = chunk => { outputBytes += chunk.length; if (outputBytes <= 65536) output += chunk; };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  t.after(() => stop(child));
  const ready = await message(child, 'ready');
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(); const page = await context.newPage();
  const pairing = await fetch(`${ready.origin}/api/v1/auth/pairing`, { method: 'POST',
    headers: { Authorization: `Bearer ${ready.credential}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(pairing.status, 200); const { data: { pairingCode } } = await pairing.json();
  await page.goto(ready.origin);
  const paired = await page.evaluate(async pairingCode => {
    const response = await fetch('/api/v1/auth/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode }) });
    return { status: response.status, body: await response.json() };
  }, pairingCode);
  assert.equal(paired.status, 200, JSON.stringify(paired.body)); const csrfToken = paired.body.data.csrfToken; assert.ok(csrfToken);
  // The client reads the epoch from the response envelope (web/src/api.ts) and sends it on every
  // mutation; server/http/server.ts rejects a mutation without it as STALE_AUTHORITY. Same view, not guessed.
  const authorityEpoch = String(paired.body.authorityEpoch); assert.ok(authorityEpoch.length > 0 && authorityEpoch !== 'undefined', 'Pairing envelope carries the current authority epoch');
  await page.reload();
  await page.locator('#connected-history').selectOption(ready.sessionId);
  // Visible, per-run selection: the run that actually reaches the model is started from the panel
  // control, never from a bare fetch. Only the ready integration is selectable.
  await panel.locator('#connected-selection input[data-connection="synthetic-lux"]').check();
  assert.equal(await panel.locator('#connected-selection input[data-connection]:disabled').count(), 0);
  if (!(await panel.locator('#connected-consent').isChecked())) await panel.locator('#connected-consent').check();
  await panel.locator('#connected-draft').fill('Use synthetic insight 731.');
  await panel.locator('#connected-send-form').evaluate(form => { if (form instanceof HTMLFormElement) form.requestSubmit(); });
  await panel.getByText('synthetic-lux', { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 });
  const key = randomUUID();
  const accept = () => page.evaluate(async ({ sessionId, key, csrfToken, authorityEpoch }) => {
    const response = await fetch('/api/v1/chat', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Didi-CSRF': csrfToken, 'X-Didi-Authority-Epoch': authorityEpoch
    }, body: JSON.stringify({ sessionId, text: 'Use synthetic insight 731.', selectedConnectionIds: ['synthetic-lux'] }) });
    return { status: response.status, body: await response.json() };
  }, { sessionId: ready.sessionId, key, csrfToken, authorityEpoch });
  const accepted = await accept(); assert.equal(accepted.status, 200, JSON.stringify(accepted.body)); assert.ok(accepted.body.data.runId);
  // Rendering must be based on the current real conversation/event stream,
  // never injected HTML, a mocked API response, or an empty payload.
  const panel = page.locator('#connected-panel');
  await panel.getByText('synthetic-lux', { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 });
  const rendered = await panel.innerText();
  assert.match(rendered, /Synthetic insight 731/); assert.match(rendered, /synthetic-lux/);
  const replay = await accept(); assert.equal(replay.status, 200, JSON.stringify(replay.body));
  const final = replay.body.data; assert.equal(final.runId, accepted.body.data.runId); assert.equal(final.outcome, 'complete');
  assert.ok(final.toolReferences.length > 0); assert.ok(final.sourceIds.includes('synthetic-lux'));
  for (const ref of final.toolReferences) {
    const strings = JSON.stringify(ref).match(/[a-f0-9]{64}|[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+/g) ?? [];
    assert.ok(strings.length > 0, 'Durable reference must have a stable visible identifier');
    assert.ok(strings.some(id => rendered.includes(id)), 'A durable result reference is visibly rendered, not only present in JSON');
  }
  assert.equal(await panel.locator('a[href^="mcp:"], a[href^="https://model-link.invalid/"]').count(), 0);
  const proofPromise = message(child, 'proof'); child.send('proof'); const proof = await proofPromise;
  assert.equal(proof.sdkCalls.length, 1); assert.equal(proof.modelCalls.length, 2);
  assert.match(proof.modelCalls[1].body, /functionResponse/); assert.match(proof.modelCalls[1].body, /Synthetic nonempty evidence/);
  assert.ok(outputBytes <= 65536, 'Bounded synthetic process stdout/stderr capture exceeded; never silently discard overflow');
  const publicEvidence = JSON.stringify({ final, rendered, output, proof });
  assert.doesNotMatch(publicEvidence, /tool-chat-synthetic-key|synthetic-mcp-token/);
  console.log('CASE_RECORD B3 real Store HTTP SDK continuation built-browser trusted-id durable-ref counts=1,2');
});
