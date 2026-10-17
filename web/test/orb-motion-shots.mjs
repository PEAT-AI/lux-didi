// M3: the mini orb's motion proof, per state and per transition.
//
// Headless, one browser slot, the synthetic fixture only:
//   lux-browser-slot run --priority worker --want 1 -- node web/test/orb-motion-shots.mjs
//
// Two sizes, because the owner reads the strip at both: the pill itself (64x26)
// and the same renderer enlarged to 300x300, which is what makes an eased colour
// and a breathe visible. Six frames per transition at 100 ms, starting at the
// state change, so the strip shows the 250 ms debounce and then the 500 ms ease.
// Nothing here opens an image: each file is checked by its byte length and by the
// width and height in its own PNG header.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixture } from './fixture.mjs';

const shots = process.env.DIDI_ORB_SHOTS || '/Users/rob/.lux/reports/lux-didi-stability-1015/m3-shots';
await mkdir(shots, { recursive: true });

async function pngSize(path) {
  const head = (await readFile(path)).subarray(0, 24);
  assert.equal(head.subarray(1, 4).toString('latin1'), 'PNG', `${path} is a PNG`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), bytes: (await stat(path)).size };
}

/// The pill's own states, in the owner's words (M3-R2 added cold and hot-muted).
const STATES = ['idle', 'listening', 'thinking', 'tool', 'speaking', 'muted'];
/// The five transitions the owner asked to see, as the pill's state attributes.
const TRANSITIONS = [
  ['listening', 'thinking'],
  ['thinking', 'tool'],
  ['tool', 'speaking'],
  ['speaking', 'listening'],
  ['listening', 'muted'],
];

const fixture = await startFixture({ configured: false });
let browser;
const written = [];
try {
  browser = await chromium.launch({
    channel: 'chromium', headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'],
  });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 340, height: 340 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${fixture.url}/?view=mini`);
  await page.locator('.mini-pill').waitFor();
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
      || document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : String(gl && gl.getParameter(gl.RENDERER));
  });
  assert.match(String(renderer), /Metal/i, `headless renderer must be Metal, got ${renderer}`);

  const setState = (state) => page.locator('.mini-pill').evaluate((el, next) => el.setAttribute('data-mini-state', next), state);
  const capture = async (name, pill) => {
    const path = join(shots, `${name}.png`);
    await page.locator('.mini-pill').screenshot({ path });
    const size = await pngSize(path);
    assert.ok(size.bytes > 200, `${path} is a real render (${size.bytes} bytes)`);
    assert.deepEqual({ width: size.width, height: size.height }, pill ? { width: 64, height: 26 } : { width: 300, height: 300 },
      `${path} is ${pill ? 'the pill' : 'the 300x300 orb'}`);
    written.push(`${name}=${size.width}x${size.height}/${size.bytes}B`);
  };

  for (const state of STATES) {
    await setState(state);
    await page.waitForTimeout(700);            // past the debounce and the ease
    await capture(`state-${state}-pill`, true);
    // The same renderer enlarged to 300x300: the pill rules scaled up, nothing else.
    await page.locator('.mini-pill').evaluate((el) => {
      el.style.width = '300px'; el.style.height = '300px';
      el.querySelector('canvas').style.cssText = 'flex:0 0 240px;width:240px;height:240px';
    });
    await page.waitForTimeout(120);
    await capture(`state-${state}-300`, false);
    await page.locator('.mini-pill').evaluate((el) => {
      el.style.width = ''; el.style.height = '';
      el.querySelector('canvas').style.cssText = '';
    });
    await page.waitForTimeout(60);
  }

  for (const [from, to] of TRANSITIONS) {
    await setState(from);
    await page.waitForTimeout(900);            // settle the strip's starting state
    for (const enlarged of [false, true]) {
      if (enlarged) {
        await page.locator('.mini-pill').evaluate((el) => {
          el.style.width = '300px'; el.style.height = '300px';
          el.querySelector('canvas').style.cssText = 'flex:0 0 240px;width:240px;height:240px';
        });
        await page.waitForTimeout(120);
        await setState(from);
        await page.waitForTimeout(900);
      }
      await setState(to);
      const started = Date.now();
      for (let frame = 0; frame < 6; frame += 1) {
        const due = started + frame * 100;
        const wait = due - Date.now();
        if (wait > 0) await page.waitForTimeout(wait);
        await capture(`transition-${from}-to-${to}-${frame}-${enlarged ? '300' : 'pill'}`, !enlarged);
      }
      if (enlarged) {
        await page.locator('.mini-pill').evaluate((el) => {
          el.style.width = ''; el.style.height = '';
          el.querySelector('canvas').style.cssText = '';
        });
      }
    }
  }
  assert.deepEqual(errors, [], 'the pill raised no page error');
  console.log(`ORB-MOTION-SHOTS PASS ${shots} files=${written.length} ${written.join(' ')}`);
} finally {
  if (browser) await browser.close();
  await fixture.close();
}
