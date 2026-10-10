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
const cases = [
  ['C1', 'missing data'], ['C2', 'null envelope'], ['C3', 'numeric epoch'],
  ['C4', 'post-commit 502'], ['C5', 'invalid JSON'], ['C6', 'connection abort'],
  ['C7', 'authority changed'], ['C8', 'deliberate second save'],
];

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.send('stop');
  let timer;
  try {
    const [code] = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Fixture stop timeout')), 4000);
    })]);
    assert.equal(code, 0, 'Clean fixture exit');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
}

async function runCase(browser, id) {
  const dir = join(artifacts, id), state = join(dir, 'state');
  await mkdir(state, { recursive: true });
  const started = performance.now();
  const proof = { sha, case: id, attempts: [], exceptions: [], browserErrors: [], transportCalls: 0 };
  let child, context, page, cdp, stderr = '';
  try {
    child = fork(join(root, 'server/dist/test/connected-process.js'), [state, join(root, 'web/dist'), '0'],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on('message', value => { if (value?.phase === 'transport') proof.transportCalls = value.calls; });
    const descriptor = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error(`Fixture ready timeout: ${stderr}`)); }, 8000);
      const message = value => { if (value?.phase === 'ready') { cleanup(); resolveReady(value.descriptor); } };
      const exit = () => { cleanup(); reject(Error(`Fixture exited before ready: ${stderr}`)); };
      function cleanup() { clearTimeout(timer); child.off('message', message); child.off('exit', exit); }
      child.on('message', message); child.once('exit', exit);
    });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'UTC' });
    page = await context.newPage();
    page.setDefaultTimeout(6000);
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
    const pairingResponse = await fetch(descriptor.origin + '/api/v1/auth/pairing', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Didi-Authority-Epoch': descriptor.authorityEpoch,
        'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(6000),
    });
    assert.equal(pairingResponse.status, 200);
    const pairing = (await pairingResponse.json()).data;
    await page.locator('#pair-code').fill(pairing.pairingCode);
    await page.locator('#pair-form').evaluate(form => form.requestSubmit());
    await page.locator('#message').waitFor();
    async function save(text) {
      await page.locator('#message').fill(text);
      await page.locator('#message-form button[type="submit"]').click();
      // The current form is replaced by render; wait until mutation finally releases it.
      await page.waitForFunction(() => document.querySelector('#message-form button[type="submit"]')?.textContent === 'Save message');
    }
    async function get(path) {
      const response = await context.request.get(descriptor.origin + '/api/v1' + path, { timeout: 6000 });
      assert.equal(response.status(), 200, `Authenticated GET ${path}`);
      return (await response.json()).data;
    }
    const setupText = `F4 ${id} synthetic setup`;
    const probeText = `F4 ${id} fixed synthetic probe`;
    await save(setupText);
    const sessions = await get('/sessions');
    proof.sessionId = sessions.items[0]?.id;
    assert.ok(proof.sessionId, 'Nonempty real session');
    const readPath = `/sessions/${proof.sessionId}`;
    const path = `${readPath}/entries`;
    proof.setup = await get(readPath);
    assert.equal(proof.setup.session.id, proof.sessionId);
    assert.equal(proof.setup.entries.length, 1);
    assert.ok(proof.setup.entries[0].id, 'Nonempty setup entry');
    assert.equal(proof.setup.entries[0].text, setupText);

    // Observe the actual thrown object from the built application's request boundary.
    // No module substitution, global fetch stub or injected request implementation.
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
        }
      } catch (error) { proof.browserErrors.push(`Exception observation: ${error.message}`); }
      finally { await cdp.send('Debugger.resume').catch(error => proof.browserErrors.push(`Debugger resume: ${error.message}`)); }
    });
    await cdp.send('Debugger.setPauseOnExceptions', { state: 'all' });
    await page.route(`**/api/v1${path}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const genuine = await route.fetch({ timeout: 6000, maxRetries: 0 });
      const envelope = await genuine.json();
      const attempt = { key: route.request().headers()['idempotency-key'], status: genuine.status(), envelope };
      proof.attempts.push(attempt);
      assert.equal(genuine.status(), 200, 'Real mutation commits before browser-visible anomaly');
      if (proof.attempts.length !== 1 || id === 'C8') return route.fulfill({ response: genuine });
      switch (id) {
        case 'C1': { const { data, ...withoutData } = envelope; return route.fulfill({ response: genuine, json: withoutData }); }
        case 'C2': return route.fulfill({ response: genuine, body: 'null', contentType: 'application/json' });
        case 'C3': return route.fulfill({ response: genuine, json: { ...envelope, authorityEpoch: 42 } });
        case 'C4': return route.fulfill({ response: genuine, status: 502, json: { error: { code: 'REQUEST_FAILED', message: 'Synthetic post-commit gateway failure.' } } });
        case 'C5': return route.fulfill({ response: genuine, body: '{"broken":', contentType: 'application/json' });
        case 'C6': return route.abort('connectionreset');
        case 'C7': return route.fulfill({ response: genuine, json: { ...envelope, authorityEpoch: 'f4-synthetic-different-authority' } });
      }
    });
    await save(probeText);
    proof.firstExceptions = [...proof.exceptions];
    proof.afterFirst = await get(readPath);
    proof.firstAttemptCount = proof.attempts.length;
    proof.firstDraft = await page.locator('#message').inputValue();
    // C2/C5/C6 and C7 may disconnect. Reconnect through the actual UI, retaining
    // the existing request module state, rather than reload/rebootstrap the page.
    proof.firstConnection = await page.locator('#connection-state').innerText();
    proof.firstDisconnected = proof.firstConnection === 'Disconnected';
    if (proof.firstDisconnected) {
      await page.getByRole('button', { name: 'Refresh connection', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Connected');
    }
    await page.locator('#message-form button[type="submit"]').waitFor();
    await save(probeText);
    proof.afterRetry = await get(readPath);
    proof.probeEntries = proof.afterRetry.entries.filter(entry => entry.text === probeText);
    proof.setupEntries = proof.afterRetry.entries.filter(entry => entry.text === setupText);
    await page.screenshot({ path: join(dir, 'local-save.png') });

    // Collect original/replayed receipts, keys and durable counts BEFORE any
    // behavior assertion, so a red artifact diagnoses the uncertain commit.
    const [first, second] = proof.attempts;
    assert.equal(proof.firstAttemptCount, 1, 'No automatic mutation retry');
    assert.equal(proof.attempts.length, 2, 'Exactly two intentional UI submissions');
    assert.ok(first.key && second.key, 'Nonempty mutation keys');
    assert.ok(first.envelope.requestId && first.envelope.data.id, 'Nonempty original durable identities');
    assert.equal(proof.setupEntries.length, 1, 'Setup entry remains intact');
    assert.equal(proof.transportCalls, 0, 'Local Save never invokes model transport');
    assert.deepEqual(proof.browserErrors, [], 'No unexpected browser errors');
    if (id === 'C7' || id === 'C8') {
      assert.notEqual(second.key, first.key, 'Released/cleared key is not carried into next authority or intentional save');
      assert.notEqual(second.envelope.requestId, first.envelope.requestId);
      assert.notEqual(second.envelope.data.id, first.envelope.data.id);
      assert.equal(proof.probeEntries.length, 2);
      assert.equal(proof.afterRetry.entries.length, 3);
      if (id === 'C7') {
        assert.ok(proof.firstDisconnected, 'Authority callback disconnects the real UI');
        assert.ok(proof.firstExceptions.some(error => error.code === 'AUTHORITY_CHANGED' && error.status === 409));
      }
      else { assert.deepEqual(proof.firstExceptions, []); assert.equal(proof.firstDraft, ''); }
    } else {
      assert.equal(second.key, first.key, 'Uncertain attempt retains its mutation key');
      assert.equal(second.envelope.requestId, first.envelope.requestId, 'Same durable receipt');
      assert.equal(second.envelope.data.id, first.envelope.data.id, 'Same durable entry');
      assert.equal(proof.probeEntries.length, 1, 'Exactly one durable probe entry');
      assert.equal(proof.afterRetry.entries.length, 2, 'Probe plus setup entry only');
      if (['C1', 'C2', 'C3'].includes(id)) {
        assert.ok(proof.firstExceptions.some(error => error.isError && error.name !== 'TypeError' && error.code === 'INVALID_RESPONSE' && error.status === 200), 'Malformed parsed success throws ApiError INVALID_RESPONSE (200)');
        assert.ok(!proof.firstExceptions.some(error => error.name === 'TypeError'), 'No accidental TypeError');
      }
      if (id === 'C4') assert.ok(proof.firstExceptions.some(error => error.code === 'REQUEST_FAILED' && error.status === 502 && error.message === 'Synthetic post-commit gateway failure.'));
    }
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

test('actual Local Save uncertain-response boundary (C1–C8)', { timeout: 85000 }, async t => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  try {
    for (const [id, description] of cases) await t.test(`${id} ${description}`, { timeout: 10000 }, () => runCase(browser, id));
  } finally { await browser.close(); }
});
