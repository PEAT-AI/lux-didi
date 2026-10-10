// Real GPU browser view of shared page selection and durable external-run discovery.
// Run through the installed lux-browser-slot admission helper only; headless Chromium with GPU.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { chromium } = createRequire(new URL('../../web/package.json', import.meta.url))('playwright');
const { answer } = await import('../../server/dist/test/connected-process.js');
const root = resolve(import.meta.dirname, '../..');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env: { ...process.env, GIT_PAGER: 'cat', GIT_EDITOR: 'true' } }).toString().trim();
const artifacts = '/Users/rob/.lux/reports/lux-didi-overnight-1009/native-conversation-service/screenshots';
const state = await mkdtemp(join(tmpdir(), 'native-conversation-browser-'));
await mkdir(artifacts, { recursive: true });
let child, descriptor, browser, context, page, stderr = '';
const steps = [];

const waitPhase = (name, afterCalls = 0) => new Promise((resolvePromise, rejectPromise) => {
  const timer = setTimeout(() => rejectPromise(new Error(`Fixture phase timeout: ${name}\n${stderr.slice(-1500)}`)), 15000);
  child.on('message', value => { if (value && value.phase === name && (value.calls ?? 0) >= afterCalls) { clearTimeout(timer); resolvePromise(value); } });
});
async function start() {
  child = fork(join(root, 'server/dist/test/connected-process.js'), [state, join(root, 'web/dist'), '0'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  descriptor = (await waitPhase('ready')).descriptor;
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const proc = child, exited = once(proc, 'exit'); proc.send('stop');
  let timer;
  try { const result = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Fixture stop timeout')), 5000); })]); assert.equal(result[0], 0, `Fixture exit: ${stderr.slice(-1500)}`); }
  finally { clearTimeout(timer); if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await exited; } }
}
async function operator(path, body = {}) {
  const token = (await readFile(join(state, 'admin-credential'), 'utf8')).trim();
  const response = await fetch(descriptor.origin + '/api/v1' + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Didi-Authority-Epoch': descriptor.authorityEpoch, 'Idempotency-Key': `op-${path}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json().then(body => body.data).catch(() => undefined) };
}
async function api(path) {
  return page.evaluate(async target => {
    const response = await fetch('/api/v1' + target, { credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json(); if (!response.ok) throw Error(body.error.message); return body.data;
  }, path);
}
const selectValue = () => page.locator('#connected-history').inputValue();
const entryText = () => page.locator('#connected-entries').innerText();
async function choose(label) {
  await page.selectOption('#connected-history', { label });
  await page.waitForFunction(expected => document.querySelector('#connected-history')?.value === expected, await page.locator('#connected-history').evaluate((element, wanted) => [...element.options].find(option => option.label === wanted)?.value, label));
}
async function step(name, action) { await action(); steps.push(name); console.log(`PASS ${name}`); }

try {
  await start();
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' }); page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await step('actual headless hardware GPU without product fixture mode', async () => {
    await page.goto(descriptor.origin); await page.locator('#pair-code').waitFor();
    assert.equal(await page.locator('meta[name="didi-test-mode"]').count(), 0);
    const renderer = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl'); const ext = gl?.getExtension('WEBGL_debug_renderer_info'); return ext ? { renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) } : null; });
    assert.ok(renderer); assert.doesNotMatch(renderer.renderer, /swiftshader|llvmpipe|software/i);
  });

  const pairing = await operator('/auth/pairing');
  await page.locator('#pair-code').fill(pairing.data.pairingCode); await page.locator('#pair-form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => document.querySelector('#connected-route')?.textContent.includes('gemini-connected-test'));
  const a = (await operator('/conversations', { title: 'Native A', timeZone: 'UTC' })).data;
  const b = (await operator('/conversations', { title: 'Native B', timeZone: 'UTC' })).data;
  assert.ok(a.sessionId && b.sessionId);
  await page.reload();
  await page.locator('#connected-history').waitFor();

  await step('shared page selection publishes the chosen conversation for the paired principal', async () => {
    await choose('Native A · gemini-connected-test · active');
    await page.waitForFunction(() => document.querySelector('#connected-history')?.value !== '');
    assert.equal((await api('/conversation-selection')).sessionId, a.sessionId);
    assert.equal(await selectValue(), a.sessionId);
    await page.screenshot({ path: join(artifacts, `selected-a-${sha}.png`) });
  });

  await step('an externally accepted run appears on the displayed conversation without a refresh', async () => {
    const accepted = await operator('/chat', { sessionId: a.sessionId, text: 'Choose one small next step for the native conversation.' });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    await page.getByText(answer, { exact: true }).waitFor();
    assert.equal(await selectValue(), a.sessionId);
    await page.screenshot({ path: join(artifacts, `external-run-on-a-${sha}.png`) });
  });

  await step('page B stays B while the external run commits to A, and reselecting A recovers the saved answer', async () => {
    await choose('Native B · gemini-connected-test · active');
    assert.equal((await api('/conversation-selection')).sessionId, b.sessionId);
    assert.doesNotMatch(await entryText(), /Let us choose one small next step/);
    const accepted = await operator('/chat', { sessionId: a.sessionId, text: 'Never jump to a conversation I am not looking at.' });
    const runId = accepted.data.runId;
    // Observe the owning durable terminal state before asserting the frozen B view.
    await page.waitForFunction(async target => { const response = await fetch('/api/v1/chat/' + target, { credentials: 'same-origin', cache: 'no-store' }); return (await response.json()).data.state === 'terminal'; }, runId);
    assert.equal(await selectValue(), b.sessionId);
    assert.doesNotMatch(await entryText(), /Let us choose one small next step/);
    await page.screenshot({ path: join(artifacts, `page-b-no-jump-${sha}.png`) });
    await choose('Native A · gemini-connected-test · active');
    await page.getByText(answer, { exact: true }).waitFor();
    assert.equal((await api('/conversation-selection')).sessionId, a.sessionId);
    await page.screenshot({ path: join(artifacts, `reselect-a-recovered-${sha}.png`) });
  });

  await step('a fresh reload restores and republishes the saved selection', async () => {
    await page.reload();
    await page.locator('#connected-history').waitFor();
    await page.waitForFunction(expected => document.querySelector('#connected-history')?.value === expected, a.sessionId);
    await page.waitForFunction(async expected => { const response = await fetch('/api/v1/conversation-selection', { credentials: 'same-origin', cache: 'no-store' }); return (await response.json()).data.sessionId === expected; }, a.sessionId);
    await page.getByText(answer, { exact: true }).waitFor();
    await page.screenshot({ path: join(artifacts, `reload-restores-selection-${sha}.png`) });
    assert.deepEqual(errors, []);
  });

  console.log(`NATIVE-BROWSER PASS steps=${steps.length} sha=${sha} images=${artifacts}`);
} catch (error) {
  console.error(`NATIVE-BROWSER FAIL sha=${sha}\n${error?.stack ?? error}`);
  throw error;
} finally { await context?.close(); await browser?.close(); await stop(); await rm(state, { recursive: true, force: true }); }
