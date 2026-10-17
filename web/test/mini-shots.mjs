// W15 mini orb screenshots: the compact orb route at 300x300 in idle,
// thinking-with-a-tool-line and speaking. Headless, synthetic fixture only.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { startFixture } from './fixture.mjs';

const shots = process.env.DIDI_MINI_SHOTS;
assert.ok(shots, 'caller owns the mini orb shot directory');
await mkdir(shots, { recursive: true });
const fixture = await startFixture({ configured: false });
let browser;
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Pair once on the full route; the same page cookie then serves the mini route.
  await page.goto(fixture.url);
  await page.getByLabel('One-time pairing code').fill('synthetic-only');
  await page.getByRole('button', { name: 'Pair this browser', exact: true }).click();
  // main's three-lane shell has no #connected-route; the header state is the
  // signal that pairing finished and the same cookie can serve the mini route.
  await page.locator('.app-shell').waitFor();
  await page.locator('#connection-state', { hasText: 'Connected' }).waitFor();

  const since = 'synthetic-mini-orb';
  const openMini = async state => {
    fixture.setLive(state);
    await page.goto(`${fixture.url}/?view=mini`);
    await page.locator('.mini-stage').waitFor();
  };
  await page.setViewportSize({ width: 300, height: 300 });

  await openMini({ state: 'idle', since, entries: [], cursor: 0 });
  // UI3A-R8: the orb and its rings fit inside the panel with even padding, and the
  // caption stays below the orb inside the same panel.
  const geometry = await page.evaluate(() => {
    const box = element => {
      const r = element.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const stage = document.querySelector('.mini-stage');
    return { stage: box(stage), orb: box(stage.querySelector('canvas')),
      glow: box(stage.querySelector('.presence-glow')),
      caption: box(stage.querySelector('.orb-caption')) };
  });
  const shorter = Math.min(geometry.stage.width, geometry.stage.height);
  assert.ok(geometry.orb.width <= shorter * 0.86 + 0.5, `orb width ${geometry.orb.width} must be at most 0.86 of ${shorter}`);
  assert.ok(geometry.orb.height <= shorter * 0.86 + 0.5, `orb height ${geometry.orb.height} must be at most 0.86 of ${shorter}`);
  for (const part of ['orb', 'glow']) {
    const b = geometry[part];
    assert.ok(b.left >= geometry.stage.left - 0.5 && b.right <= geometry.stage.right + 0.5 &&
      b.top >= geometry.stage.top - 0.5 && b.bottom <= geometry.stage.bottom + 0.5,
      `${part} must fit inside the panel: ${JSON.stringify({ part: b, stage: geometry.stage })}`);
  }
  assert.ok(geometry.caption.top >= geometry.orb.bottom - 0.5,
    `the caption sits below the orb: ${JSON.stringify({ caption: geometry.caption, orb: geometry.orb })}`);
  assert.ok(geometry.caption.bottom <= geometry.stage.bottom + 0.5 && geometry.caption.left >= geometry.stage.left - 0.5 &&
    geometry.caption.right <= geometry.stage.right + 0.5, 'the caption stays inside the panel');
  assert.ok(Math.abs(geometry.orb.left - geometry.stage.left - (geometry.stage.right - geometry.orb.right)) < 1,
    'the orb is horizontally even');
  console.log('MINI-GEOMETRY ' + JSON.stringify(geometry));
  await page.locator('.mini-stage[data-mini-state="idle"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('.sidebar, [data-tab], .voice-text').count(), 0, 'mini route has no full-window chrome');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/idle.png` });

  await openMini({ state: 'thinking', since, cursor: 1, entries: [
    { seq: 1, kind: 'toolCall', tool: { name: 'gmail_list' } },
  ] });
  await page.locator('.mini-stage[data-mini-state="tool"]').waitFor({ timeout: 15000 });
  assert.match(await page.locator('.activity-text').innerText(), /mail/i, 'the tool line shows the connector phrase');
  await page.waitForTimeout(500);
  console.log('MINI-ACTIVITY ' + JSON.stringify(await page.evaluate(() => {
    const el = document.querySelector('.mini-stage .activity-text');
    const stage = document.querySelector('.mini-stage');
    const cs = getComputedStyle(el);
    return { color: cs.color, opacity: cs.opacity, whiteSpace: cs.whiteSpace, textOverflow: cs.textOverflow, fontSize: cs.fontSize, lines: el.getClientRects().length, stageBg: getComputedStyle(stage).backgroundColor };
  })));
  await page.screenshot({ path: `${shots}/thinking-tool.png` });

  await openMini({ state: 'speaking', since, cursor: 1, entries: [
    { seq: 1, kind: 'outputTranscription', text: 'Hi there' },
  ] });
  await page.locator('.mini-stage[data-mini-state="speaking"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('.mini-stage canvas').count(), 1, 'one orb canvas');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/speaking.png` });

  assert.deepEqual(errors, []);
  console.log(`MINI-SHOTS PASS ${shots}/idle.png ${shots}/thinking-tool.png ${shots}/speaking.png`);
} finally {
  if (browser) await browser.close();
  await fixture.close();
}
