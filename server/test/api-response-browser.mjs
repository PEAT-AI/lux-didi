import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const { chromium } = createRequire(new URL('../../web/package.json', import.meta.url))('playwright');
const root = resolve(import.meta.dirname, '../..');
const artifacts = process.env.DIDI_API_RESPONSE_ARTIFACTS;
const sha = process.env.DIDI_API_RESPONSE_SHA;
assert.ok(artifacts && /^[a-f0-9]{40}$/.test(sha ?? ''), 'Producer artifact directory and full source SHA required');
// The boundary is the connected composer's chat send (POST /api/v1/chat with an idempotency key,
// web/src/connected.ts:367, web/src/api.ts:22-56). Each case commits a real turn first, then makes
// the response the browser sees uncertain, then retries the way the owner does.
const cases = [
  ['C1', 'missing data'], ['C2', 'null envelope'], ['C3', 'numeric epoch'],
  ['C4', 'post-commit 502'], ['C5', 'invalid JSON'], ['C6', 'connection abort'],
  ['C7', 'authority changed'], ['C8', 'deliberate second send'],
];

async function stop(child) {
  let timer;
  try {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.send('stop');
    const [code] = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Fixture stop timeout')), 4000);
    })]);
    assert.equal(code, 0, 'Clean fixture exit');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  }
}

async function runCase(browser, id) {
  const dir = join(artifacts, id), state = join(dir, 'state');
  await mkdir(state, { recursive: true });
  const started = performance.now();
  const proof = { sha, case: id, attempts: [], exceptions: [], firstExceptions: [], browserErrors: [], transportCalls: 0 };
  let collecting = false, child, context, page, cdp, stderr = '';
  try {
    child = fork(join(root, 'server/dist/test/connected-process.js'), [state, join(root, 'web/dist'), '0'],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on('message', value => { if (value?.phase === 'transport') proof.transportCalls = value.calls; });
    const [ready] = await once(child, 'message');
    const descriptor = ready?.descriptor;
    assert.ok(descriptor?.origin && descriptor?.authorityEpoch, `Fixture ready descriptor ${stderr}`);
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'UTC' });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => proof.browserErrors.push(error.message));
    await page.goto(descriptor.origin);
    await page.locator('#pair-code').waitFor();
    proof.renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    });
    assert.ok(proof.renderer); assert.doesNotMatch(proof.renderer, /swiftshader|llvmpipe|software/i);
    assert.equal(await page.locator('meta[name="didi-test-mode"]').count(), 0);
    const token = (await readFile(join(state, 'admin-credential'), 'utf8')).trim();
    async function pair() {
      const response = await fetch(descriptor.origin + '/api/v1/auth/pairing', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Didi-Authority-Epoch': descriptor.authorityEpoch,
          'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(6000),
      });
      assert.equal(response.status, 200, 'Pairing code issued');
      const pairing = (await response.json()).data;
      await page.locator('#pair-code').fill(pairing.pairingCode);
      await page.locator('#pair-form').evaluate(form => form.requestSubmit());
    }
    async function openPanel() {
      const control = page.locator('#panel-toggle-right');
      if (await control.getAttribute('aria-expanded') !== 'true') await control.click();
      await page.locator('#panel-right[data-state="open"]').waitFor();
    }
    async function composer() {
      await page.locator('#connected-send').waitFor();
      await openPanel();
      if (await page.locator('#connected-consent').count()) await page.locator('#connected-consent').click();
      await page.locator('#connected-draft:not([disabled])').waitFor();
    }
    async function send(text) {
      await page.locator('#connected-draft').fill(text);
      await page.locator('#connected-send:not([disabled])').waitFor();
      await page.locator('#connected-send').click();
    }
    async function settleFailure() {
      await page.locator('#connected-error').waitFor();
      proof.lastError = await page.locator('#connected-error').innerText();
      if (id !== 'C7') await page.locator('#connected-send:not([disabled])').waitFor();
    }
    async function get(path) {
      const response = await context.request.get(descriptor.origin + '/api/v1' + path, { timeout: 8000 });
      assert.equal(response.status(), 200, `Authenticated GET ${path}`);
      return (await response.json()).data;
    }
    await pair();
    await composer();
    cdp = await context.newCDPSession(page);
    await cdp.send('Debugger.enable');
    cdp.on('Debugger.paused', async event => {
      try {
        if (['exception', 'promiseRejection'].includes(event.reason) && event.data?.objectId) {
          const result = await cdp.send('Runtime.callFunctionOn', {
            objectId: event.data.objectId, returnByValue: true,
            functionDeclaration: 'function() { return {name: this.name, code: this.code, status: this.status, message: this.message, isError: this instanceof Error}; }',
          });
          proof.exceptions.push({ ...result.result.value, pauseReason: event.reason });
          if (collecting) proof.firstExceptions.push({ ...result.result.value, pauseReason: event.reason });
        }
      } catch (error) { proof.browserErrors.push(`Exception observation: ${error.message}`); }
      finally { await cdp.send('Debugger.resume').catch(error => proof.browserErrors.push(`Debugger resume: ${error.message}`)); }
    });
    await cdp.send('Debugger.setPauseOnExceptions', { state: 'all' });

    const setupText = `F4 ${id} synthetic setup`;
    const probeText = `F4 ${id} fixed synthetic probe`;
    let probes = 0;
    await page.route('**/api/v1/chat', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (body?.text === probeText) probes += 1;
      // The real service commits the turn first, so every anomaly below follows a durable commit.
      const genuine = await route.fetch({ timeout: 15000, maxRetries: 0 });
      const envelope = await genuine.json();
      proof.attempts.push({ path: new URL(route.request().url()).pathname, text: body?.text,
        key: route.request().headers()['idempotency-key'], status: genuine.status(), envelope });
      assert.equal(genuine.status(), 200, 'Real mutation commits before browser-visible anomaly');
      if (body?.text !== probeText || probes !== 1 || id === 'C8') return route.fulfill({ response: genuine });
      switch (id) {
        case 'C1': { const { data, ...withoutData } = envelope; return route.fulfill({ response: genuine, json: withoutData }); }
        case 'C2': return route.fulfill({ response: genuine, body: 'null', contentType: 'application/json' });
        case 'C3': return route.fulfill({ response: genuine, json: { ...envelope, authorityEpoch: 42 } });
        case 'C4': return route.fulfill({ response: genuine, status: 502, json: { error: { code: 'REQUEST_FAILED', message: 'Synthetic post-commit gateway failure.' } } });
        case 'C5': return route.fulfill({ response: genuine, body: '{"broken:', contentType: 'application/json' });
        case 'C6': return route.abort('connectionreset');
        case 'C7': return route.fulfill({ response: genuine, json: { ...envelope, authorityEpoch: 'f4-synthetic-different-authority' } });
        default: return route.fulfill({ response: genuine });
      }
    });

    await send(setupText);
    await page.waitForFunction(() => document.querySelectorAll('#connected-entries .assistant').length >= 1);
    const sessionId = proof.attempts[0].envelope.data.sessionId;
    assert.ok(sessionId, 'Nonempty real session from the first committed turn');
    proof.sessionId = sessionId;
    assert.equal(proof.attempts[0].text, setupText, 'Setup turn committed once');

    collecting = true;
    await send(probeText);
    if (id === 'C8') {
      await page.waitForFunction(() => document.querySelectorAll('#connected-entries .assistant').length >= 2);
    } else if (id === 'C7') {
      // A changed epoch clears the client's authority; the observed exception is the settle signal.
      for (let i = 0; i < 50 && !proof.firstExceptions.some(error => error.code === 'AUTHORITY_CHANGED'); i += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else {
      await settleFailure();
    }
    collecting = false;

    if (id === 'C7') {
      // A changed epoch clears the client's authority; the owner reconnects and retries by hand.
      await page.reload();
      if (await page.locator('#pair-code').count()) await pair();
      await composer();
      await send(probeText);
      // The committed but unconfirmed turn is still pending, so a manual retry is refused, never resent.
      await page.locator('#connected-error').waitFor();
      proof.lastError = await page.locator('#connected-error').innerText();
    } else {
      // C1 to C6 retry the same uncertain turn; C8 deliberately sends the same text again after a success.
      if (id === 'C8') await send(probeText); else await page.locator('#connected-send').click();
      await page.waitForFunction(() => document.querySelector('#connected-draft')?.value === '');
    }

    const [setup, first, second] = proof.attempts;
    assert.ok(setup && first, 'Setup and probe attempts observed');
    assert.ok(first.key && first.envelope.requestId && first.envelope.data.runId, 'Nonempty original durable identities');
    proof.keys = { first: first.key, second: second?.key };
    if (id === 'C7') {
      assert.equal(proof.attempts.length, 2, 'An unconfirmed turn is never resent by a manual retry');
      assert.ok(proof.firstExceptions.some(error => error.code === 'AUTHORITY_CHANGED' && error.status === 409), 'A changed authority epoch is refused');
      assert.match(proof.lastError ?? '', /pending acceptance key is retained/, 'The unresolved turn is reported, never silently dropped');
    } else {
      assert.equal(proof.attempts.length, 3, 'Exactly three observed chat attempts: setup, probe, retry');
      assert.ok(second.key, 'Nonempty retry mutation key');
      if (id === 'C8') {
        assert.notEqual(second.key, first.key, 'A completed turn releases its mutation key');
        assert.notEqual(second.envelope.data.runId, first.envelope.data.runId, 'A deliberate second send is a new run');
      } else {
        assert.equal(second.key, first.key, 'Uncertain attempt retains its mutation key');
        assert.equal(second.envelope.data.userEntryId, first.envelope.data.userEntryId, 'Same durable user receipt');
        assert.equal(second.envelope.data.sessionId, first.envelope.data.sessionId, 'Same real session');
        assert.equal(second.envelope.data.runId, first.envelope.data.runId, 'Same durable run');
      }
    }
    const probeSessions = [...new Set(proof.attempts.slice(1).map(attempt => attempt.envelope.data.sessionId).filter(Boolean))];
    proof.probeSessions = probeSessions;
    const probeEntries = [];
    for (const sid of probeSessions) {
      const session = await get(`/sessions/${sid}`);
      probeEntries.push(...session.entries.filter(entry => entry.role === 'user' && entry.text === probeText));
    }
    proof.probeEntryCount = probeEntries.length;
    assert.equal(probeEntries.length, id === 'C7' ? 1 : id === 'C8' ? 2 : 1, 'Durable probe turns match what the case proved');
    if (['C1', 'C2', 'C3'].includes(id)) {
      assert.ok(proof.firstExceptions.some(error => error.isError && error.name !== 'TypeError' && error.code === 'INVALID_RESPONSE' && error.status === 200), 'Malformed parsed success throws ApiError INVALID_RESPONSE (200)');
      assert.ok(!proof.firstExceptions.some(error => error.name === 'TypeError'), 'No accidental TypeError');
    }
    if (id === 'C5') assert.ok(proof.firstExceptions.some(error => error.name === 'SyntaxError'), 'A malformed body reaches the client as a JSON parse failure');
    if (id === 'C4') assert.ok(proof.firstExceptions.some(error => error.code === 'REQUEST_FAILED' && error.status === 502 && error.message === 'Synthetic post-commit gateway failure.'));
    if (id === 'C6') assert.ok(proof.firstExceptions.some(error => error.name === 'TypeError'), 'An aborted connection reaches the client as a transport error');
    assert.ok(proof.transportCalls >= 1, 'The connected composer drove the real model transport');
    assert.deepEqual(proof.browserErrors, [], 'No unexpected browser errors');
    proof.outcome = 'PASS';
  } catch (error) {
    proof.outcome = 'FAIL'; proof.failure = { name: error.name, message: error.message };
    throw error;
  } finally {
    await cdp?.detach();
    await context?.close();
    try { await stop(child); }
    finally {
      await rm(state, { recursive: true, force: true });
      proof.durationMs = Math.round(performance.now() - started);
      await writeFile(join(dir, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
      console.log(`CASE_RECORD ${id} ${proof.outcome ?? 'FAIL'} ${join(dir, 'proof.json')}`);
    }
  }
}

test('actual connected chat boundary (C1–C8)', { timeout: 90000 }, async t => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  try {
    for (const [id, description] of cases) await t.test(`${id} ${description}`, { timeout: 20000 }, () => runCase(browser, id));
  } finally { await browser.close(); }
});
