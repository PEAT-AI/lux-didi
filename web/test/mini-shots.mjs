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
  await page.locator('#connected-route').waitFor();

  const since = 'synthetic-mini-orb';
  const openMini = async state => {
    fixture.setLive(state);
    await page.goto(`${fixture.url}/?view=mini`);
    await page.locator('.mini-stage').waitFor();
  };
  await page.setViewportSize({ width: 300, height: 300 });

  await openMini({ state: 'idle', since, entries: [], cursor: 0 });
  await page.locator('.mini-stage[data-mini-state="idle"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('.sidebar, [data-tab], .voice-text').count(), 0, 'mini route has no full-window chrome');
  await page.screenshot({ path: `${shots}/idle.png` });

  await openMini({ state: 'thinking', since, cursor: 1, entries: [
    { seq: 1, kind: 'toolCall', tool: { name: 'gmail_list' } },
  ] });
  await page.locator('.mini-stage[data-mini-state="tool"]').waitFor({ timeout: 15000 });
  assert.match(await page.locator('.activity-text').innerText(), /mail/i, 'the tool line shows the connector phrase');
  await page.screenshot({ path: `${shots}/thinking-tool.png` });

  await openMini({ state: 'speaking', since, cursor: 1, entries: [
    { seq: 1, kind: 'outputTranscription', text: 'Hi there' },
  ] });
  await page.locator('.mini-stage[data-mini-state="speaking"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('.mini-stage canvas').count(), 1, 'one orb canvas');
  await page.screenshot({ path: `${shots}/speaking.png` });

  assert.deepEqual(errors, []);
  console.log(`MINI-SHOTS PASS ${shots}/idle.png ${shots}/thinking-tool.png ${shots}/speaking.png`);
} finally {
  if (browser) await browser.close();
  await fixture.close();
}
