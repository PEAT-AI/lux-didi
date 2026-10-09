import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Reuse the accepted web package's installed browser; no dependency/fixture copy.
const { chromium } = createRequire(new URL('../../web/package.json', import.meta.url))('playwright');
const root = resolve(import.meta.dirname, '../..');
const state = await mkdtemp(join(tmpdir(), 'didi-host-browser-state-'));
const artifacts = process.env.DIDI_HOST_ARTIFACTS || await mkdtemp(join(tmpdir(), 'didi-host-proof-'));
await mkdir(artifacts, { recursive: true });
console.log(`Host browser artifacts: ${artifacts}`);
let host, browser, context, page, descriptor;
const timings = [], requests = [], errors = [];
const exec = resolve(root, 'server/dist/host/index.js');
async function start(port = 0) {
  const child = spawn(process.execPath, [exec, '--data-dir', state, '--web-root', join(root, 'web/dist'), '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  host = child;
  let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(([code]) => { throw Error(`Host startup exited ${code}: ${stderr}`); })]);
  descriptor = JSON.parse(await readFile(join(state, 'host-runtime.json'), 'utf8'));
  return descriptor.origin;
}
async function stop() {
  if (!host || host.exitCode !== null || host.signalCode !== null) return;
  const exited = once(host, 'exit'); host.kill('SIGTERM');
  assert.equal((await exited)[0], 0);
}
async function operatorCode() {
  const child = spawn(process.execPath, [exec, 'pair', '--data-dir', state], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  assert.equal((await once(child, 'exit'))[0], 0, `Local pairing operator failed: ${stderr}`);
  return stdout.trim();
}
async function api(path, method = 'GET', body) {
  const credential = (await readFile(join(state, 'admin-credential'), 'utf8')).trim();
  const response = await fetch(`${descriptor.origin}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${credential}`, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Didi-Authority-Epoch': descriptor.authorityEpoch }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, 200, `Real API ${method} ${path}`);
  return (await response.json()).data;
}
async function step(name, action) {
  const start = performance.now(); await action();
  timings.push({ name, ms: +(performance.now() - start).toFixed(2) });
  console.log(`HOST browser PASS: ${name}`);
}
async function visible(text) { await page.getByText(text, { exact: true }).first().waitFor(); }
async function tab(name) { await page.locator(`[data-tab="${name}"]`).click(); }
async function submit(id) { await page.locator(`${id} button[type="submit"], ${id} button:not([type])`).first().click(); }
let sessionId, entryId, commitmentId, originalEpoch, originalAssistant;
try {
  const origin = await start();
  originalEpoch = descriptor.authorityEpoch; originalAssistant = descriptor.assistantId;
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('request', req => requests.push({ url: req.url(), method: req.method() }));
  page.on('pageerror', error => errors.push(error.message));
  await step('real shell security and GPU renderer', async () => {
    const response = await page.goto(origin);
    const policy = JSON.parse(await readFile(join(root, 'web/security-headers.json'), 'utf8'));
    for (const [name, value] of Object.entries(policy)) assert.equal(response.headers()[name.toLowerCase()], value);
    const renderer = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl'); const ext = gl?.getExtension('WEBGL_debug_renderer_info'); return ext ? { renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) } : null; });
    assert.ok(renderer, 'GPU renderer must be observable');
    assert.doesNotMatch(renderer.renderer, /swiftshader|llvmpipe|software/i);
    await writeFile(join(artifacts, 'renderer.json'), JSON.stringify(renderer, null, 2));
    await page.locator('#pair-code').waitFor();
  });
  await step('secure pairing and truthful capabilities', async () => {
    await page.locator('#pair-code').fill(await operatorCode());
    await submit('#pair-form');
    await page.locator('#message:not([disabled])').waitFor();
    const cookies = await context.cookies();
    const cookie = cookies.find(item => item.name === 'didi_session');
    assert.ok(cookie?.httpOnly); assert.equal(cookie.sameSite, 'Strict');
    const status = await api('/status');
    assert.deepEqual(status.capabilities, { memory: true, commitments: true, notifications: false, model: false });
    assert.equal(status.model.configured, false);
    assert.ok(await page.locator('#ask-didi').isDisabled());
  });
  await step('shipped conversation captures meaningful durable text', async () => {
    await page.locator('#message').fill('Host browser kestrel launch: review the release checklist before noon.');
    await page.getByRole('button', { name: 'Save message', exact: true }).click();
    await visible('Message saved.');
    await visible('Host browser kestrel launch: review the release checklist before noon.');
    const sessions = await api('/sessions'); assert.equal(sessions.items.length, 1); sessionId = sessions.items[0].id;
    const conversation = await api(`/sessions/${sessionId}`);
    assert.equal(conversation.entries.length, 1); entryId = conversation.entries[0].id;
    assert.equal(conversation.entries[0].text, 'Host browser kestrel launch: review the release checklist before noon.');
    await page.screenshot({ path: join(artifacts, 'desktop-conversation.png'), fullPage: true });
  });
  await step('real recall keeps meaningful source and opens conversation', async () => {
    await tab('Memory'); await page.locator('#recall-query').fill('kestrel'); await submit('#recall-form');
    await page.getByText('Host browser kestrel launch:', { exact: false }).first().waitFor();
    const recall = await api('/recall?q=kestrel&limit=10');
    assert.equal(recall.totalMatches, 1); assert.equal(recall.hits[0].entryId, entryId);
    assert.ok(recall.hits[0].sourceRefs.some(source => source.availability === 'present' && source.label.length > 0));
    await page.getByRole('button', { name: 'Open conversation source', exact: true }).first().click();
    await visible('Host browser kestrel launch: review the release checklist before noon.');
  });
  await step('Today commitment and due-date correction use actual domain revisions', async () => {
    await tab('Today'); await page.locator('#commitment-title').fill('Kestrel release checklist'); await submit('#commitment-form');
    await visible('Commitment saved.'); await page.getByRole('heading', { name: 'Kestrel release checklist', exact: true }).waitFor();
    const commitments = await api('/commitments'); assert.equal(commitments.items.length, 1); commitmentId = commitments.items[0].id;
    await page.locator(`[data-edit="${commitmentId}"]`).click();
    await page.locator('#edit-notes').fill('Prepare the meaningful release evidence.');
    const date = new Date().toISOString().slice(0, 10);
    await page.locator('#edit-due').fill(`${date}T12:00`); await submit('#edit-form');
    await visible('Due date updated.');
    const detail = await api(`/commitments/${commitmentId}`);
    assert.equal(detail.commitment.revision, 2); assert.equal(detail.commitment.dueAt, `${date}T12:00:00.000Z`);
    const plan = await api(`/plan?date=${date}&timeZone=UTC`);
    assert.ok(plan.items.some(item => item.commitment.id === commitmentId && item.commitment.notes.includes('meaningful release')));
    await page.screenshot({ path: join(artifacts, 'desktop-today.png'), fullPage: true });
  });
  await step('visible stale correction conflict and explicit reviewed retry', async () => {
    await page.locator(`[data-edit="${commitmentId}"]`).click();
    await page.locator('#edit-title').fill('Kestrel checklist — final review');
    await api(`/commitments/${commitmentId}`, 'PATCH', { expectedRevision: 2, title: 'Kestrel checklist — concurrent correction' });
    await submit('#edit-form');
    await page.getByText('This changed on another device.', { exact: false }).waitFor();
    assert.equal((await api(`/commitments/${commitmentId}`)).commitment.revision, 3);
    assert.equal(await page.locator('#edit-title').inputValue(), 'Kestrel checklist — final review');
    await page.screenshot({ path: join(artifacts, 'desktop-conflict.png'), fullPage: true });
    await submit('#edit-form'); await visible('Due date updated.');
    const detail = await api(`/commitments/${commitmentId}`);
    assert.equal(detail.commitment.revision, 4); assert.equal(detail.commitment.title, 'Kestrel checklist — final review');
  });
  await step('actual process/store restart and browser rebootstrap preserve records', async () => {
    const port = Number(new URL(origin).port); await stop(); await start(port);
    assert.equal(descriptor.authorityEpoch, originalEpoch); assert.equal(descriptor.assistantId, originalAssistant);
    await page.reload(); await page.locator('#message:not([disabled])').waitFor();
    await page.locator('#conversation-select').selectOption(sessionId);
    await visible('Host browser kestrel launch: review the release checklist before noon.');
    const entries = (await api(`/sessions/${sessionId}`)).entries;
    assert.equal(entries.length, 1); assert.equal(entries[0].id, entryId);
    await tab('Today'); await page.getByRole('heading', { name: 'Kestrel checklist — final review', exact: true }).waitFor();
  });
  await step('offline refusal and online recovery without mutation replay', async () => {
    await tab('Conversation'); const before = requests.filter(req => req.method === 'POST').length;
    await context.setOffline(true); await visible('Offline');
    assert.ok(await page.getByRole('button', { name: 'Save message', exact: true }).isDisabled());
    assert.ok(await page.locator('#ask-didi').isDisabled());
    assert.equal(requests.filter(req => req.method === 'POST').length, before);
    await context.setOffline(false); await page.locator('#message:not([disabled])').waitFor();
    assert.equal((await api(`/sessions/${sessionId}`)).entries.length, 1, 'offline refusal must not queue/replay');
  });
  await step('375px shipped UI and private-source/token refusal', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: join(artifacts, 'mobile-375.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '375px must not overflow horizontally');
    const credential = (await readFile(join(state, 'admin-credential'), 'utf8')).trim();
    assert.ok(!(await page.content()).includes(credential));
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    const privatePaths = await page.evaluate(async () => Promise.all(['/.env', '/admin-credential', '/server/runtime/store.ts'].map(async path => (await fetch(path)).status)));
    assert.ok(privatePaths.every(status => status >= 400));
    const cachedPaths = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(req => new URL(req.url).pathname)))).flat());
    assert.ok(cachedPaths.every(path => !path.startsWith('/api') && !path.includes('credential') && !path.includes('.env')));
    assert.ok(requests.every(req => new URL(req.url).origin === origin), 'no remote/proxy route');
    assert.deepEqual(errors, []);
  });
  await writeFile(join(artifacts, 'browser-proof.json'), JSON.stringify({ source: 'canonical host + accepted durable domain + shipped Vite UI', checks: timings, viewport: [1440, 375], capabilities: { memory: true, commitments: true, model: false, notifications: false }, nativeWK: 'separate install gate, not exercised' }, null, 2));
  console.log(`HOST browser checks ${timings.length}, all passed; no fixture routes/model/tool/device authority`);
} catch (error) {
  if (page) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context?.close(); await browser?.close(); await stop(); await rm(state, { recursive: true, force: true });
}
