// MINI2: the pill, rendered in every state at 1x and at 2x.
//
// Headless, one browser slot, synthetic fixture only:
//   lux-browser-slot run --priority worker --want 1 -- node web/test/mini-shots.mjs
//
// The shot directory defaults to the MINI2 evidence directory and can be moved
// with DIDI_MINI_SHOTS. Nothing here opens an image: each file is verified by its
// byte length and by the width and height in its PNG header, so the evidence is
// the size of the render, not a look at it.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixture } from './fixture.mjs';

const shots = process.env.DIDI_MINI_SHOTS
  || '/Users/rob/.lux/reports/lux-didi-stability-1015/mini2-shots';
await mkdir(shots, { recursive: true });

/// A PNG's IHDR width and height, read from the file's own bytes.
async function pngSize(path) {
  const head = (await readFile(path)).subarray(0, 24);
  assert.equal(head.subarray(1, 4).toString('latin1'), 'PNG', `${path} is a PNG`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), bytes: (await stat(path)).size };
}

const STATES = ['idle', 'listening', 'thinking', 'speaking', 'muted', 'connecting'];
const fixture = await startFixture({ configured: false });
let browser;
const sizes = [];
try {
  browser = await chromium.launch({
    channel: 'chromium', headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'],
  });
  // The pill is 64x26 pt, so 1x is 64x26 px and 2x is 128x52 px.
  for (const scale of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 200, height: 120 }, deviceScaleFactor: scale });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(fixture.url);
    await page.getByLabel('One-time pairing code').fill('synthetic-only');
    await page.getByRole('button', { name: 'Pair this browser', exact: true }).click();
    await page.locator('.app-shell').waitFor();
    await page.locator('#connection-state', { hasText: 'Connected' }).waitFor();
    fixture.setLive({ state: 'idle', since: 'synthetic-mini-pill', entries: [], cursor: 0 });
    await page.goto(`${fixture.url}/?view=mini`);
    await page.locator('.mini-pill').waitFor();
    // One renderer: the built bundle's own orb canvas and level bars.
    assert.equal(await page.locator('.mini-pill canvas#didi-orb').count(), 1, 'one orb renderer');
    assert.equal(await page.locator('.mini-pill .mini-level i').count(), 5, 'five level bars');
    // Machine-wide GPU rendering rule (harness owner, 10-17): the browser renders
    // on Metal, never on a software path.
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2')
        || document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : String(gl && gl.getParameter(gl.RENDERER));
    });
    assert.match(String(renderer), /Metal/i, `headless renderer must be Metal, got ${renderer}`);
    const box = await page.locator('.mini-pill').boundingBox();
    assert.ok(Math.abs(box.width - 64) <= 0.5 && Math.abs(box.height - 26) <= 0.5,
      `the pill is 64x26 pt, got ${JSON.stringify(box)}`);
    const radius = await page.locator('.mini-pill').evaluate(el => getComputedStyle(el).borderTopLeftRadius);
    assert.equal(radius, '13px', 'the capsule radius is half the height');
    for (const state of STATES) {
      await page.locator('.mini-pill').evaluate((el, next) => el.setAttribute('data-mini-state', next), state);
      const path = join(shots, `pill-${state}@${scale}x.png`);
      await page.locator('.mini-pill').screenshot({ path });
      const size = await pngSize(path);
      assert.ok(size.bytes > 200, `${path} is a real render (${size.bytes} bytes)`);
      assert.deepEqual({ width: size.width, height: size.height }, { width: 64 * scale, height: 26 * scale },
        `${path} is the pill at ${scale}x`);
      sizes.push(`${state}@${scale}x=${size.width}x${size.height}/${size.bytes}B`);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`MINI-SHOTS PASS ${shots} ${sizes.join(' ')}`);
} finally {
  if (browser) await browser.close();
  await fixture.close();
}
