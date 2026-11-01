// Real GPU browser view of explicit per-message local-note selection.
// Run through the installed lux-browser-slot admission helper only; headless Chromium with GPU.
// Artifacts are this lane's own directory, SHA-stamped; no other lane's screenshots are touched.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createArtifactDir } from './artifacts.mjs';

const { chromium } = createRequire(new URL('../../web/package.json', import.meta.url))('playwright');
const root = resolve(import.meta.dirname, '../..');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env: { ...process.env, GIT_PAGER: 'cat', GIT_EDITOR: 'true' } }).toString().trim();
const artifacts = await createArtifactDir('memory-selection-ui/screenshots');
const state = await mkdtemp(join(tmpdir(), 'selected-memory-browser-'));
let child, descriptor, seeded, browser, context, page, stderr = '';
const steps = [];

const waitPhase = (name, afterCalls = 0) => new Promise((resolvePromise, rejectPromise) => {
  const timer = setTimeout(() => rejectPromise(new Error(`Fixture phase timeout: ${name}\n${stderr.slice(-1500)}`)), 20000);
  child.on('message', value => { if (value && value.phase === name && (value.calls ?? 0) >= afterCalls) { clearTimeout(timer); resolvePromise(value); } });
});
async function start() {
  child = fork(join(root, 'server/dist/test/selected-memory-browser-fixture.js'), [state, join(root, 'web/dist'), '0'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const ready = await waitPhase('ready');
  descriptor = ready.descriptor; seeded = ready.seeded;
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
  const response = await fetch(descriptor.origin + '/api/v1' + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Didi-Authority-Epoch': descriptor.authorityEpoch, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).data;
}
async function operatorGet(path) {
  const token = (await readFile(join(state, 'admin-credential'), 'utf8')).trim();
  const response = await fetch(descriptor.origin + '/api/v1' + path, { headers: { Authorization: `Bearer ${token}`, 'X-Didi-Authority-Epoch': descriptor.authorityEpoch } });
  assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).data;
}
async function shot(name) {
  const panel = page.locator('#connected-panel');
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: join(artifacts, `${name}-${sha}.png`) });
}
async function step(name, action) { await action(); steps.push(name); console.log(`PASS ${name}`); }
// U1 (#282): the chat lane is #panel-right and launches collapsed, so its content is hidden until the
// owner opens the panel. Open it the owner's way and assert the open state before using the chat.
async function openPanel(id) {
  const control = page.locator(`#panel-toggle-${id}`);
  if (await control.getAttribute('aria-expanded') !== 'true') await control.click();
  await page.locator(`#panel-${id}[data-state="open"]`).waitFor();
  assert.equal(await control.getAttribute('aria-expanded'), 'true', `${id} panel toggled open`);
}
async function find(query) {
  await page.locator('#connected-notes-query').fill(query);
  await page.locator('#connected-notes-search button').click();
  await page.waitForFunction(text => {
    const list = document.querySelector('#connected-notes-results');
    return !!list && list.textContent.includes(text);
  }, query === 'tomatoes' ? 'tomatoes' : query);
}
async function selectNote(text) {
  await page.locator('#connected-notes-results li', { hasText: text }).getByRole('button', { name: 'Select', exact: true }).click();
}
const wireLines = async () => (await readFile(join(state, 'wire.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
// The owner opens the note picker with the composer's attach control; the notes details only renders
// once that page state is open (web/src/connected.ts:181 and 221-223), so expand it the owner's way.
async function openNotes() {
  if (!(await page.locator('#connected-notes').count())) await page.locator('#connected-attach').click();
  await page.locator('#connected-notes').waitFor();
  if (!(await page.locator('#connected-notes').evaluate(node => node.open))) await page.locator('#connected-notes summary').click();
  await page.locator('#connected-notes-query').waitFor();
}
// The lane prints no "Selected notes (n)" sentence: the count rides on the attach control.
async function selectedCount() {
  return (await page.locator('#connected-notes-summary .notes-count').innerText()).trim();
}

try {
  await start();
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' }); page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await step('actual headless hardware GPU, no product fixture mode, preserved orb layout', async () => {
    await page.goto(descriptor.origin); await page.locator('#pair-code').waitFor();
    assert.equal(await page.locator('meta[name="didi-test-mode"]').count(), 0);
    const renderer = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl'); const info = gl.getExtension('WEBGL_debug_renderer_info'); return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); });
    await writeFile(join(artifacts, `renderer-${sha}.json`), JSON.stringify({ sha, renderer, step: 'selected-memory' }, null, 2));
    assert.match(String(renderer), /Metal|ANGLE/i, `Hardware renderer, saw ${renderer}`);
    const pairing = await operator('/auth/pairing'); await page.locator('#pair-code').fill(pairing.pairingCode); await page.locator('#pair-form').evaluate(form => form.requestSubmit());
    await openPanel('right');
    // The connected lane no longer renders a #connected-route status paragraph: the configured model is
    // named in the lane's own disclosure line (web/src/connected.ts:189-193), so assert that current surface.
    await page.locator('.connected-conversation').waitFor();
    await page.waitForFunction(() => document.querySelector('.connected-disclosure')?.textContent.includes('gemini-connected-test'));
    // The accepted desktop orb at a 1440 wide viewport is 290 px (web/src/style.css:469, FE1-R1), not the
    // 190 px this lane first pinned before the hero orb landed.
    assert.equal(Math.round((await page.locator('#didi-orb').boundingBox()).width), 290, 'Preserve the accepted desktop orb layout');
  });
  await step('explicitly connected conversation started with consent', async () => {
    const disclosure = await page.locator('.connected-disclosure').innerText();
    assert.doesNotMatch(disclosure, /does not send[^.]*local notes/i, 'the disclosure must not claim stored local notes are never sent');
    assert.match(disclosure, /Chat messages go to .*gemini-connected-test.* when you send them/i, 'the disclosure names the model a send reaches');
    // Consent is the disclosure's own Allow control now, and the first send starts the conversation.
    await page.locator('#connected-consent').click();
    await page.locator('#connected-draft:not([disabled])').waitFor();
  });
  await step('a stored local note is found, visibly selected and counted', async () => {
    await openNotes();
    const guidance = await page.locator('#connected-notes summary + p.muted').innerText();
    assert.match(guidance, /Choose exact stored notes for this one message/i);
    assert.match(guidance, /nothing is sent until you press Send/i);
    await find('tomatoes');
    await selectNote('tomatoes');
    assert.equal(await selectedCount(), '1', 'the attach control counts the selection');
    await find('overlong');
    await selectNote('overlong');
    assert.equal(await selectedCount(), '2', 'both selected notes are counted');
    await shot('selected-notes');
  });
  await step('Send carries the frozen selection and the canonical used/omitted metadata', async () => {
    const before = (await wireLines()).length;
    await page.locator('#connected-draft').fill('Which stored note should guide this small next step?');
    await page.locator('#connected-send').click();
    // U3-R1: a completed run renders no success status line, so the answer entry is the completion signal.
    await page.waitForFunction(() => document.querySelectorAll('#connected-entries .assistant').length === 1);
    assert.equal((await wireLines()).length, before + 1);
    // The same metadata the run callout shows while a run is live, read from the canonical snapshot.
    const runId = await page.locator('#connected-run').getAttribute('data-run-id');
    assert.ok(runId, 'the run snapshot id is rendered for the completed turn');
    const snapshot = await operatorGet(`/chat/${runId}`);
    assert.equal(snapshot.state, 'terminal');
    const selection = snapshot.memorySelection;
    assert.equal(selection.frozen, true, 'the selection froze for this message');
    assert.deepEqual(selection.counts, { requested: 2, used: 1, omitted: 1 });
    assert.match(selection.omitted.map(item => item.reason).join(' '), /budget|oversized/);
    const wire = await readFile(join(state, 'wire.jsonl'), 'utf8');
    assert.match(wire, /water the tomatoes/);
    assert.doesNotMatch(wire, /SELMEM-CANARY-NEVER-SELECTED/);
    assert.doesNotMatch(wire, /SELMEM-UNKNOWN-NOTE/);
    assert.doesNotMatch(wire, /SELMEM-SENSITIVE-NOTE/);
    await shot('used-and-omitted');
  });
  await step('deselection affects only the next message and never implies erasure', async () => {
    await page.locator('#connected-notes-selected li', { hasText: 'tomatoes' }).getByRole('button', { name: 'Remove' }).click();
    assert.equal(await selectedCount(), '1', 'removing one note leaves one selected');
    await page.locator('#connected-notes-clear').click();
    assert.match(await page.locator('#connected-notes-none').innerText(), /conversation history only/);
    assert.doesNotMatch(await page.locator('#connected-notes-none').innerText(), /erased|forgotten|deleted/i);
  });
  await step('refresh keeps the durable transcript', async () => {
    await page.reload();
    await page.locator('#connected-entries .assistant').first().waitFor();
    assert.equal(await page.locator('#connected-entries .assistant').count(), 1, 'the saved answer survives the reload');
    // U3-R1 drops the leading "Naya: " prefix from rendered answers.
    assert.match(await page.locator('#connected-entries').innerText(), /Let us choose one small next step/);
  });
  await step('an unclassified note is refused with a local explanation and captures nothing', async () => {
    const before = (await wireLines()).length;
    await openNotes();
    await find('classified');
    await selectNote('classified');
    await page.locator('#connected-draft').fill('Try to use an unclassified note.');
    await page.locator('#connected-send').click();
    await page.locator('#connected-error').waitFor();
    assert.match(await page.locator('#connected-error').innerText(), /has no stored classification|not permitted/);
    assert.equal((await wireLines()).length, before, 'no provider call for a refused selection');
    await shot('refused-unclassified');
  });
  await step('actual 390px viewport captures at the note controls, refusal and history states', async () => {
    // Unstitched, viewport-sized captures only: a full-page capture above the viewport gets
    // tiled by the GPU and can repeat the top block. Geometry is recorded so a real layout
    // defect is distinguishable from a capture artifact.
    const shot = async (name, selector) => {
      await page.locator(selector).scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await page.evaluate(sel => {
        const box = target => { const element = document.querySelector(target); if (!element) return null; const r = element.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), visible: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight, unoccluded: element === hit || element.contains(hit) }; };
        return { viewport: { width: innerWidth, height: innerHeight }, scrollY: Math.round(scrollY), document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }, target: box(sel), notes: box('#connected-notes'), query: box('#connected-notes-query'), selected: box('#connected-notes-selected'), usage: box('#connected-notes-usage'), error: box('#connected-error'), disclosure: box('.connected-disclosure'), send: box('#connected-send') };
      }, selector);
      await page.screenshot({ path: join(artifacts, `${name}-${sha}.png`) });
      return geometry;
    };
    await page.setViewportSize({ width: 390, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal overflow at 390px');
    const counts = await page.evaluate(() => Object.fromEntries(['#connected-panel', '#connected-send-form', '#connected-notes', '#connected-notes-query', '#connected-notes-search', '#connected-send', 'canvas'].map(selector => [selector, document.querySelectorAll(selector).length])));
    for (const [selector, count] of Object.entries(counts)) assert.equal(count, 1, `Unique rendered DOM ${selector}`);
    // (a) the corrected disclosure, as root asked to retain
    const noteGuidance = await shot('mobile-390-note-guidance', '#connected-notes summary + p.muted');
    assert.match(await page.locator('#connected-notes summary + p.muted').innerText(), /nothing is sent until you press Send/i);
    assert.ok(noteGuidance.target && noteGuidance.target.visible && noteGuidance.target.unoccluded, 'the note-consent line is visible and unoccluded at 390px');
    // (b) refusal state: scrolled to the actual refusal explanation, with Send context where possible
    const refusal = await shot('mobile-390-refused', '#connected-error');
    assert.ok(refusal.error && refusal.error.visible && refusal.error.unoccluded, 'refusal explanation visible and unoccluded at 390px');
    assert.match(await page.locator('#connected-error').innerText(), /has no stored classification|not permitted/);
    const refusedSend = await shot('mobile-390-refused-send', '#connected-send-form');
    assert.ok(refusedSend.send.visible && refusedSend.send.unoccluded, 'Send control visible and unoccluded at 390px');
    // (c) note controls with a real selection: the picker is on screen, preserved for root
    await page.locator('#connected-notes-clear').click();
    await find('tomatoes');
    await selectNote('tomatoes');
    const controls = await shot('mobile-390-notes', '#connected-notes-selected');
    assert.ok(controls.selected.visible && controls.selected.unoccluded, 'selected-note list visible and unoccluded at 390px');
    assert.equal(await selectedCount(), '1', 'one note selected at 390px');
    // (d) history state: the durable transcript is the only view a completed run leaves (U3-R1)
    await page.locator('#connected-notes-clear').click();
    const history = await shot('mobile-390-history', '#connected-entries .assistant');
    assert.ok(history.target.visible && history.target.unoccluded, 'the durable answer is visible and unoccluded at 390px');
    assert.match(await page.locator('#connected-entries').innerText(), /Let us choose one small next step/);
    await writeFile(join(artifacts, `mobile-geometry-${sha}.json`), JSON.stringify({ sha, counts, noteGuidance, refusal, refusedSend, controls, history, source: 'actual shipped DOM geometry and unstitched hardware-rendered 390px viewport captures' }, null, 2));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);
    await page.screenshot({ path: join(artifacts, `desktop-1440-${sha}.png`) });
  });
  assert.deepEqual(errors, []);
  await writeFile(join(artifacts, `proof-${sha}.json`), JSON.stringify({ sha, steps, errors, renderer: await readFile(join(artifacts, `renderer-${sha}.json`), 'utf8').then(JSON.parse).then(record => record.renderer), screenshots: [`selected-notes-${sha}.png`, `used-and-omitted-${sha}.png`, `refused-unclassified-${sha}.png`, `mobile-390-disclosure-${sha}.png`, `mobile-390-refused-${sha}.png`, `mobile-390-refused-send-${sha}.png`, `mobile-390-notes-${sha}.png`, `mobile-390-history-${sha}.png`, `mobile-geometry-${sha}.json`, `desktop-1440-${sha}.png`], liveModel: false }, null, 2));
  console.log(`SELMEM-BROWSER PASS steps=${steps.length} sha=${sha} images=${artifacts}`);
} catch (error) {
  if (page) { const visible = { error: await page.locator('#connected-error').textContent().catch(() => null), usage: await page.locator('#connected-notes-usage').textContent().catch(() => null), summary: await page.locator('#connected-notes-summary').textContent().catch(() => null) }; console.error('BROWSER STATE', JSON.stringify(visible)); }
  throw error;
} finally { await context?.close(); await browser?.close(); await stop(); await rm(state, { recursive: true, force: true }); }
