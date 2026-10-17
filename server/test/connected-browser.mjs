import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createArtifactDir } from '../../web/test/artifacts.mjs';
const { chromium } = createRequire(new URL('../../web/package.json', import.meta.url))('playwright');
const root = resolve(import.meta.dirname, '../..');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env: { ...process.env, GIT_PAGER: 'cat', GIT_EDITOR: 'true' } }).toString().trim();
const artifacts = await createArtifactDir('connected/screenshots');
const state = await mkdtemp(join(tmpdir(), 'connected-browser-'));
let child, descriptor, browser, context, page;
const requests = [], errors = [], steps = [];
let stderr = '';
const waitPhase = (name, afterCalls = 0) => new Promise((resolvePhase, reject) => {
  const proc = child;
  const timer = setTimeout(() => { cleanup(); reject(Error(`Fixture ${name} timeout: ${stderr.slice(-1200)}`)); }, 10000);
  const cleanup = () => { clearTimeout(timer); proc.off('message', listener); proc.off('exit', exited); };
  const listener = value => { if (value?.phase === name && (!afterCalls || value.calls > afterCalls)) { cleanup(); resolvePhase(value); } };
  const exited = () => { cleanup(); reject(Error(`Fixture exited before ${name}: ${stderr.slice(-1200)}`)); };
  proc.on('message', listener); proc.once('exit', exited);
});
async function start(port = 0, dir = state, mode) {
  child = fork(join(root, 'server/dist/test/connected-process.js'), [dir, join(root, 'web/dist'), String(port), ...(mode ? [mode] : [])], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
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
async function operator(path, body = {}, dir = state) {
  const token = (await readFile(join(dir, 'admin-credential'), 'utf8')).trim();
  const response = await fetch(descriptor.origin + '/api/v1' + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Didi-Authority-Epoch': descriptor.authorityEpoch, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).data;
}
async function api(path) {
  return page.evaluate(async path => {
    const response = await fetch('/api/v1' + path, { credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json(); if (!response.ok) throw Error(body.error.message); return body.data;
  }, path);
}
async function step(name, action) { await action(); steps.push(name); console.log(`PASS ${name}`); }
// U1 (#282): side panels launch collapsed, so a rail item is hidden until the owner opens the panel
// with its header toggle. Open it the owner's way and assert the open state before using a rail item.
async function openPanel(id) {
  const control = page.locator(`#panel-toggle-${id}`);
  if (await control.getAttribute('aria-expanded') !== 'true') await control.click();
  await page.locator(`#panel-${id}[data-state="open"]`).waitFor();
  assert.equal(await control.getAttribute('aria-expanded'), 'true', `${id} panel toggled open`);
}
// #282 keeps side panels two-state at every width, so a panel opened for a shot is closed again before the
// narrow pass: the launch state is the open chat alone, and an open 240 px rail plus the 360 px chat lane does
// not fit a 375 px viewport.
async function closePanel(id) {
  const control = page.locator(`#panel-toggle-${id}`);
  if (await control.getAttribute('aria-expanded') === 'true') await control.click();
  await page.locator(`#panel-${id}[data-state="collapsed"]`).waitFor();
  assert.equal(await control.getAttribute('aria-expanded'), 'false', `${id} panel toggled closed`);
}
try {
  await start();
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' }); page = await context.newPage();
  page.on('request', request => { if (request.url().includes('/api/v1')) requests.push({ path: new URL(request.url()).pathname, method: request.method() }); });
  page.on('pageerror', error => errors.push(error.message));
  await step('actual shared orb and headless hardware GPU, no product fixture mode', async () => {
    await page.goto(descriptor.origin); await page.locator('#pair-code').waitFor();
    assert.equal(await page.locator('meta[name="didi-test-mode"]').count(), 0);
    const renderer = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl'); const ext = gl?.getExtension('WEBGL_debug_renderer_info'); return ext ? { renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) } : null; });
    assert.ok(renderer); assert.doesNotMatch(renderer.renderer, /swiftshader|llvmpipe|software/i);
    await writeFile(join(artifacts, `renderer-${sha}.json`), JSON.stringify({ sha, renderer }, null, 2));
    const pairing = await operator('/auth/pairing'); await page.locator('#pair-code').fill(pairing.pairingCode); await page.locator('#pair-form').evaluate(form => form.requestSubmit());
    await page.locator('#connected-send').waitFor(); await page.locator('#didi-orb').waitFor();
    // FE1-R1: the orb is the hero. Spec 2.1 pins the orb area at about 300 px at 1440x900 (34 to 44
    // percent of the voice lane), the caption and the controls stack under it, and the stage sizes to its
    // content. The V3 (#264) top-third stage and 55 percent orb are replaced by that sizing.
    await page.locator('#orb-stage').waitFor();
    await page.waitForFunction(() => { const o = document.querySelector('#didi-orb'), s = document.querySelector('#orb-stage'); return !!o && !!s && s.getBoundingClientRect().height > 0 && o.getBoundingClientRect().height > 0; });
    const measured = await page.evaluate(() => { const or = document.querySelector('#didi-orb').getBoundingClientRect(), sr = document.querySelector('#orb-stage').getBoundingClientRect(), lr = document.querySelector('#lane-voice').getBoundingClientRect(); return { orb: { x: or.x, y: or.y, width: or.width, height: or.height }, stage: { x: sr.x, y: sr.y, width: sr.width, height: sr.height }, lane: { height: lr.height } }; });
    const desktopOrb = measured.orb, stage = measured.stage;
    const heroBand = [270, 330];
    assert.ok(desktopOrb.width >= heroBand[0] && desktopOrb.width <= heroBand[1] && desktopOrb.height >= heroBand[0] && desktopOrb.height <= heroBand[1], `the orb renders the hero diameter (${desktopOrb.width}x${desktopOrb.height}, band ${heroBand[0]}-${heroBand[1]})`);
    assert.ok(await page.locator('#didi-orb').isVisible(), 'the desktop stage orb canvas is visible');
    assert.equal(Math.round(desktopOrb.width), Math.round(desktopOrb.height), 'the orb canvas is square');
    assert.ok(Math.abs((desktopOrb.x + desktopOrb.width / 2) - (stage.x + stage.width / 2)) <= 1, 'the orb canvas is horizontally centred in the stage');
    assert.ok(desktopOrb.y >= stage.y && desktopOrb.y + desktopOrb.height <= stage.y + stage.height, 'the stage contains the whole orb');
    assert.ok(stage.height <= measured.lane.height, `the stage (${stage.height} px) never grows past the ${measured.lane.height} px voice lane`);
    assert.equal(await page.locator('.voice-state').first().innerText(), 'Live is off', 'the header state is the one source of truth');
    assert.equal(await page.locator('.live-state').count(), 0, 'no second Live state surface');
  });
  // The connected conversation lives in #panel-right (chat); U1 collapsed it by default, so open it
  // the owner's way before reading or clicking its content.
  await openPanel('right');
  await step('U3 declutter shots: the open chat without a grant', async () => {
    const u3 = '/Users/rob/.lux/reports/lux-didi-release-1014/u3-shots';
    await mkdir(u3, { recursive: true });
    await page.locator('#connected-consent').waitFor();
    await page.screenshot({ path: join(u3, 'desktop-1440-chat-no-grant.png'), fullPage: true });
  });
  await step('the open chat exposes consent before any model send', async () => {
    assert.match(await page.locator('.connected-disclosure').innerText(), /Chat messages go to[\s\S]*when you send them/);
    assert.equal(await page.locator('#connected-consent').count(), 1);
    await page.locator('#connected-consent').click(); await page.locator('#connected-draft:not([disabled])').waitFor();
    assert.equal(await page.locator('#connected-send').getAttribute('aria-label'), 'Send');
  });
  await step('real adapter captured request, split provisional stream, meaningful atomic saved answer', async () => {
    await page.locator('#connected-draft').fill('Help me choose one small next step for this synthetic release checklist.');
    child.send('stream-next');
    const partial = page.locator('.provisional').waitFor(); await page.locator('#connected-send').click(); await partial; child.send('finish-stream');
    await page.waitForFunction(() => document.querySelectorAll('#connected-entries .assistant').length === 1);
    await page.getByText('Let us choose one small next step and keep the rest for later.', { exact: true }).waitFor();
    const sessions = await api('/sessions');
    const enrolled = sessions.items.find(item => item.title === 'Naya connected conversation'); const entries = (await api(`/sessions/${enrolled.id}`)).entries;
    assert.deepEqual(entries.map(e => e.role), ['user', 'assistant']);
    assert.equal(await page.locator('#connected-draft').inputValue(), '');
    const wire = JSON.parse((await readFile(join(state, 'wire.jsonl'), 'utf8')).trim());
    assert.ok(wire.body.systemInstruction.parts[0].text.length > 100); assert.equal(wire.body.tools, undefined);
    await page.locator('#connected-draft').fill('Make that earlier next step concrete, without adding the local archive.'); await page.locator('#connected-send').click();
    await page.waitForFunction(() => document.querySelectorAll('#connected-entries .assistant').length === 2);
    const wires = (await readFile(join(state, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(wires.length, 2); assert.match(JSON.stringify(wires[1]), /synthetic release checklist/); assert.match(JSON.stringify(wires[1]), /keep the rest for later/);
  });
  await step('U3 declutter shots: the granted chat and the Settings switch', async () => {
    const u3 = '/Users/rob/.lux/reports/lux-didi-release-1014/u3-shots';
    await mkdir(u3, { recursive: true });
    await page.locator('#connected-entries .assistant').first().waitFor();
    await page.screenshot({ path: join(u3, 'desktop-1440-chat-with-grant.png'), fullPage: true });
    await openPanel('left');
    assert.equal(await page.locator('[data-tab="Settings"]').isVisible(), true, 'the opened panel renders the Settings rail item');
    await page.locator('[data-tab="Settings"]').click();
    await page.locator('#connected-history').waitFor();
    await page.screenshot({ path: join(u3, 'desktop-1440-settings.png'), fullPage: true });
    await page.locator('#sheet-close').click();
    await page.locator('#sheet').waitFor({ state: 'detached' });
    await closePanel('left');
  });
  await step('same-profile real restart preserves consent/history and never resends', async () => {
    const port = new URL(descriptor.origin).port; await stop(); await start(Number(port)); await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#connected-entries .assistant').length === 2);
    assert.equal(await page.locator('#connected-draft').isEnabled(), true);
    assert.equal((await readFile(join(state, 'wire.jsonl'), 'utf8')).trim().split('\n').length, 2);
    await page.bringToFront(); await page.waitForFunction(() => document.querySelectorAll('#connected-entries .assistant').length === 2);
    await page.screenshot({ path: join(artifacts, `desktop-${sha}.png`), fullPage: true });
    await page.setViewportSize({ width: 375, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const counts = await page.evaluate(() => Object.fromEntries(['#app', '#connected-panel', '#connected-entries', '#connected-draft', '#connected-send', '#didi-orb', '#orb-stage'].map(selector => [selector, document.querySelectorAll(selector).length])));
    for (const [selector, count] of Object.entries(counts)) assert.equal(count, 1, `Unique rendered DOM ${selector}`);
    // Narrow (#282, 2824816): the Voice/Chat switcher and its stacking rules were dropped and the connected
    // chat is the main surface, so at 375 the chat and its composer own the narrow viewport while the voice
    // lane keeps its place in the DOM. The hero orb geometry stays pinned by the desktop step above.
    await page.waitForFunction(() => document.querySelector('.app-shell')?.dataset.narrow === 'true', { timeout: 8000 });
    assert.equal(await page.locator('.lane-switch').count(), 0, 'the dropped narrow switcher never returns');
    assert.equal(await page.locator('#lane-voice').count(), 1, 'the voice lane keeps its place in the narrow DOM');
    assert.equal(await page.locator('#connected-draft').isVisible(), true, 'the connected composer is the narrow surface');
    assert.equal(await page.locator('#connected-draft').isEnabled(), true, 'the composer accepts typing without a switcher step');
    assert.equal(await page.locator('#connected-entries').isVisible(), true, 'the saved conversation is on that surface');
    assert.equal(await page.locator('#connected-entries .assistant').count(), 2);
    const savedTurns = await page.locator('#connected-entries article').count(); assert.equal(savedTurns, 4);
    const positions = [];
    const viewport = async (name, target) => {
      if (target) await page.locator(target).evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      else await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      positions.push(await page.evaluate(({ name, target }) => {
        const box = selector => { const element = document.querySelector(selector); const r = element.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { x: r.x, y: r.y, width: r.width, height: r.height, visible: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight, unoccluded: element === hit || element.contains(hit) }; };
        return { name, target, scrollY, viewport: { width: innerWidth, height: innerHeight }, document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }, send: box('#connected-send'), draft: box('#connected-draft'), turns: document.querySelectorAll('#connected-entries article').length };
      }, { name, target }));
      await page.screenshot({ path: join(artifacts, `mobile-375-${name}-${sha}.png`), fullPage: false });
    };
    // Preserve an unmodified full-page discriminator, but acceptance uses real viewports.
    await page.screenshot({ path: join(artifacts, `mobile-fullpage-discriminator-${sha}.png`), fullPage: true });
    await viewport('top', null);
    await viewport('history', '#connected-entries');
    await page.locator('#connected-draft').fill('Unsent synthetic mobile viewport proof; do not send automatically.');
    await viewport('composer', '#connected-draft');
    assert.ok(positions.at(-1).send.visible && positions.at(-1).send.unoccluded, `Actual Send control fully visible and unoccluded at375px (${JSON.stringify(positions.at(-1).send)})`);
    assert.ok(positions.at(-1).draft.visible && positions.at(-1).draft.unoccluded, `Actual composer fully visible and unoccluded at375px (${JSON.stringify(positions.at(-1).draft)})`);
    assert.equal(await page.locator('#connected-send').isEnabled(), true);
    await writeFile(join(artifacts, `mobile-dom-${sha}.json`), JSON.stringify({ sha, counts, positions, savedTurns, source: 'actual shipped DOM and hardware-rendered unstitched viewport captures' }, null, 2));
  });
  await step('failed acceptance preserves draft with no capture, credential send or automatic retry', async () => {
    const sessions = await api('/sessions'); const enrolled = sessions.items.find(item => item.title === 'Naya connected conversation');
    await page.locator('#connected-draft').fill('Keep this unsent draft after consent rejection.'); await operator(`/conversations/${enrolled.id}/revoke`);
    await page.locator('#connected-send').click(); await page.locator('#connected-error').waitFor();
    assert.equal(await page.locator('#connected-draft').inputValue(), 'Keep this unsent draft after consent rejection.');
    assert.equal((await api(`/sessions/${enrolled.id}`)).entries.length, 4);
    await page.reload(); await page.waitForFunction(() => document.querySelector('#connected-draft')?.value === 'Keep this unsent draft after consent rejection.');
    assert.equal(await page.locator('#connected-draft').inputValue(), 'Keep this unsent draft after consent rejection.');
    assert.equal((await readFile(join(state, 'wire.jsonl'), 'utf8')).trim().split('\n').length, 2);
  });
  await step('explicit cancel and provider failure render no saved answer, never a fake success', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.waitForFunction(() => document.querySelector('.app-shell')?.dataset.narrow === 'false');
    await page.locator('#connected-consent').click(); await page.locator('#connected-draft:not([disabled])').waitFor();
    child.send('hold-next'); const sent = waitPhase('transport');
    await page.locator('#connected-draft').fill('Cancel this explicitly sent synthetic turn.'); await page.locator('#connected-send').click(); await sent;
    await page.locator('#connected-cancel').click(); await page.waitForFunction(() => document.querySelector('#connected-run')?.textContent.includes('You cancelled this request. Ask again when ready. Content may have been sent before it stopped.'));
    assert.equal(await page.locator('#connected-entries .assistant').count(), 0);
    child.send('fail-next'); await page.locator('#connected-draft').fill('Show an honest controlled provider failure.'); await page.locator('#connected-send').click();
    await page.waitForFunction(() => document.querySelector('#connected-run')?.textContent.includes('The model failed. Ask again.'));
    assert.equal(await page.locator('#connected-entries .assistant').count(), 0);
    await page.screenshot({ path: join(artifacts, `truthful-errors-${sha}.png`), fullPage: true });
  });
  assert.deepEqual(errors, []);
  await step('default owner projection remains explicit public Lux Didi', async () => {
    assert.deepEqual((await api('/status')).ownerProfile, { status: 'default', displayName: 'Lux Didi' });
    await page.locator('#panel-right[data-state="open"] .lane-title').waitFor();
    assert.equal((await page.locator('#panel-right .lane-title').innerText()).trim(), 'Chat');
  });
  const productTitle = await page.title();
  for (const mode of ['owner-unconfigured', 'owner-configured']) {
    await step(`${mode}: independent safe owner label on the actual host and GPU browser`, async () => {
      await stop(); await context.close();
      const ownerState = await mkdtemp(join(tmpdir(), 'connected-owner-browser-'));
      try {
        await start(0, ownerState, mode);
        context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
        const unexpected = [], ownerErrors = [], ownerConsole = [], ownerRequests = [];
        let paired = false;
        await context.route('**/*', route => {
          const url = new URL(route.request().url());
          if (/^https?:$/.test(url.protocol) && url.origin !== descriptor.origin) { unexpected.push(url.origin); return route.abort(); }
          return route.continue();
        });
        page = await context.newPage();
        page.on('pageerror', error => ownerErrors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') ownerConsole.push({ text: message.text(), paired }); });
        page.on('request', request => { if (request.url().includes('/api/v1')) ownerRequests.push({ path: new URL(request.url()).pathname, method: request.method() }); });
        await page.goto(descriptor.origin); await page.locator('#pair-code').waitFor();
        const pairing = await operator('/auth/pairing', {}, ownerState);
        // Observe exact real lifecycle responses before submitting: no late-listener race.
        const pairResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/auth/pair');
        const clearResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/conversation-selection/clear');
        await page.locator('#pair-code').fill(pairing.pairingCode); await page.locator('#pair-form').evaluate(form => form.requestSubmit());
        const lifecycle = await Promise.all([pairResponse, clearResponse]);
        for (const response of lifecycle) assert.equal(response.status(), 200, 'expected real pairing/selection-clear route success');
        await page.locator('#connected-send').waitFor(); paired = true;
        const status = await api('/status'), route = await api('/chat/status');
        const label = 'Example <Owner> & Friend', configured = mode === 'owner-configured';
        assert.deepEqual(status.ownerProfile, { status: 'configured', displayName: label });
        assert.equal(status.model.configured, configured);
        assert.equal(route.status, configured ? 'configured' : 'unconfigured');
        assert.equal('displayName' in status.model, false); assert.equal('displayName' in route, false);
        assert.equal(await page.title(), productTitle, 'owner label must not rename the public product');
        assert.equal(await page.locator('#connected-consent').isDisabled(), false, 'R66 keeps explicit agreement operable without a route');
        if (!configured) {
          assert.equal(await page.locator('#connected-send').isDisabled(), true);
          await page.locator('#connected-consent').click();
          assert.equal(await page.locator('#connected-consent').count(), 0, 'Allow is consumed once');
          assert.equal(await page.locator('#connected-send').isDisabled(), true, 'a tick cannot configure a provider or authorize a send');
          await page.locator('#connected-send').evaluate(button => button.click());
          assert.equal((await api('/chat/status')).consent, null, 'a local tick is not a server grant');
          assert.equal((await api('/sessions')).items.length, 0, 'no conversation is enrolled without a route');
        }
        const profilePath = join(ownerState, 'owner-profile.json');
        const serialized = await readFile(profilePath, 'utf8'), owner = JSON.parse(serialized);
        assert.equal(status.assistantId, owner.ownerId);
        const surfaces = [JSON.stringify({ status, route }), await page.content(), await page.locator('body').textContent(), JSON.stringify({ ownerErrors, ownerConsole })];
        for (const value of [profilePath, owner.profileVersion, owner.style.text, owner.lore.text, createHash('sha256').update(serialized).digest('hex')]) {
          assert.ok(surfaces.every(surface => !surface.includes(value)), 'protected owner metadata must not reach status/UI');
        }
        assert.deepEqual(unexpected, []); assert.deepEqual(ownerErrors, []);
        assert.ok(ownerConsole.filter(event => !event.paired).every(event => event.text.includes('401 (Unauthorized)')), 'only the expected unauthenticated pairing response is allowed before pairing');
        assert.deepEqual(ownerConsole.filter(event => event.paired), []);
        const posts = ownerRequests.filter(request => request.method === 'POST');
        assert.deepEqual(posts.map(request => request.path).sort(), ['/api/v1/auth/pair', '/api/v1/conversation-selection/clear'], JSON.stringify(posts));
        assert.deepEqual((await api('/sessions')).items, [], 'owner presentation must not save a local session or entry');
        steps.push(`${mode} observed-posts=${JSON.stringify(posts)} pairing-clear-status=200 no-saved-sessions=true`);
        const wireExists = await readFile(join(ownerState, 'wire.jsonl')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        assert.equal(wireExists, false, 'owner label proof must make zero model transport calls');
        await page.screenshot({ path: join(artifacts, `${mode}-${sha}.png`), fullPage: true });
        steps.push(`${mode} configured=${configured} escaped-label=true status-ui-no-leak=true transport-calls=0`);
      } finally { await stop(); await rm(ownerState, { recursive: true, force: true }); }
    });
  }
  await writeFile(join(artifacts, `proof-${sha}.json`), JSON.stringify({ sha, steps, requests, errors, screenshots: [`desktop-${sha}.png`, `mobile-375-${sha}.png`, `truthful-errors-${sha}.png`, `owner-unconfigured-${sha}.png`, `owner-configured-${sha}.png`], liveModel: false, nativeVoice: false }, null, 2));
  console.log(`PASS ${steps.length} actual connected browser checks at ${sha}; artifacts ${artifacts}`);
} catch (error) {
  if (page) { const visible = { run: await page.locator('#connected-run').textContent().catch(() => null), error: await page.locator('#connected-error').textContent().catch(() => null), pageErrors: errors }; console.error(JSON.stringify({ ...visible, fixtureStderr: stderr.slice(-1500) })); await page.screenshot({ path: join(artifacts, `diagnostic-${sha}.png`), fullPage: true }).catch(() => {}); }
  throw error;
} finally { await context?.close(); await browser?.close(); await stop(); await rm(state, { recursive: true, force: true }); }
