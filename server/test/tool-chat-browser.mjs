import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const dependencyRoot = process.env.DIDI_TOOL_CHAT_DEPENDENCIES;
assert.ok(dependencyRoot, 'Producer must supply the verified dependency root');
const require = createRequire(resolve(dependencyRoot, '../../web/package.json'));
const { chromium } = require('playwright');
function message(child, phase, diagnostics = () => '') {
  return new Promise((resolve, reject) => {
    const bootstrap = []; let bootstrapOverflow = 0;
    const detail = () => diagnostics().replace(/tool-chat-synthetic-key-(?:one|two)|synthetic-mcp-token/g, '[redacted]').slice(-1000)
      + ` :: bootstrap=${JSON.stringify(bootstrap)} overflow=${bootstrapOverflow}`;
    const timer = setTimeout(() => finish(Error(`Synthetic process ${phase} timeout :: ${detail()}`)), 10000);
    const receive = value => {
      if (value.phase === 'bootstrap') {
        if (bootstrap.length < 4) bootstrap.push({ mode: value.mode === 'browser' ? 'browser' : value.mode === 'recovery' ? 'recovery' : 'other',
          entryMatches: value.entryMatches === true, canonicalEntryMatches: value.canonicalEntryMatches === true });
        else bootstrapOverflow++;
      }
      if (value.phase === phase) finish(null, value);
    };
    const exited = (code, signal) => finish(Error(`Synthetic process exited before ${phase} (code=${code}, signal=${signal}) :: ${detail()}`));
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
  const ready = await message(child, 'ready', () => output);
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(); const page = await context.newPage();
  const httpOperations = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/v1/')) httpOperations.push({ method: request.method(), path });
  });
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
  const panel = page.locator('#connected-panel');
  // Visible, per-run selection: the run that actually reaches the model is started from the panel
  // control, never from a bare fetch. Only the ready integration is selectable.
  if (!(await panel.locator('#connected-consent').isChecked())) await panel.locator('#connected-consent').check();
  // Consent attaches/re-renders the panel; select the per-run connection in that current panel.
  await panel.locator('#connected-selection input[data-connection="synthetic-lux"]').check();
  assert.equal(await panel.locator('#connected-selection input[data-connection]:disabled').count(), 0);
  await panel.locator('#connected-draft').fill('Use synthetic insight 731.');
  const panelResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/chat');
  await panel.locator('#connected-send-form').evaluate(form => { if (form instanceof HTMLFormElement) form.requestSubmit(); });
  const response = await panelResponse;
  const request = response.request(); const body = request.postDataJSON(); const key = request.headers()['idempotency-key'];
  assert.ok(key, 'Capture the actual panel idempotency identity');
  assert.equal(body.sessionId, ready.sessionId);
  assert.equal(body.text, 'Use synthetic insight 731.');
  assert.deepEqual(body.selectedConnectionIds, ['synthetic-lux'], 'The panel actually selected the approved source');
  const accepted = { status: response.status(), body: await response.json() };
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body)); assert.ok(accepted.body.data.runId);
  // Observe the actual selected panel run to terminal over the existing authenticated SSE route.
  const terminal = await page.evaluate(async ({ runId, csrfToken, authorityEpoch }) => {
    const response = await fetch(`/api/v1/chat/${runId}/events`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Didi-CSRF': csrfToken, 'X-Didi-Authority-Epoch': authorityEpoch
    }, body: '{}' });
    if (!response.ok || !response.body) throw Error('Panel run event subscription failed');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) throw Error('Panel run ended without terminal');
        pending += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const packet = pending.slice(0, end); pending = pending.slice(end + 2);
          const data = packet.split('\n').find(line => line.startsWith('data: '));
          if (!data) continue;
          const event = JSON.parse(data.slice(6));
          if (event.type === 'snapshot' && event.run.state === 'terminal') return event.run;
        }
      }
    } finally { await reader.cancel(); }
  }, { runId: accepted.body.data.runId, csrfToken, authorityEpoch });
  const observation = message(child, 'observations', () => output);
  child.send({ type: 'observations', runId: terminal.runId });
  const boundary = await observation;
  console.log('TOOL_CHAT_BROWSER_BOUNDARY ' + JSON.stringify({ requestIdentity: { key, body }, runId: terminal.runId, outcome: terminal.outcome, httpOperations, boundary }));
  assert.equal(terminal.outcome, 'complete', JSON.stringify({ terminal, boundary }));
  const accept = () => page.evaluate(async ({ body, key, csrfToken, authorityEpoch }) => {
    const response = await fetch('/api/v1/chat', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Didi-CSRF': csrfToken, 'X-Didi-Authority-Epoch': authorityEpoch
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { body, key, csrfToken, authorityEpoch });
  // Rendering must be based on the current real conversation/event stream,
  // never injected HTML, a mocked API response, or an empty payload.
  await panel.getByText(/Synthetic insight 731/).first().waitFor({ state: 'visible', timeout: 15000 });
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
