// M3: the mini orb's motion proof, per state and per transition.
//
// Headless, one browser slot, the synthetic fixture only:
//   lux-browser-slot run --priority worker --want 1 -- node web/test/orb-states-shots.mjs
//
// Named orb-states-shots.mjs, not orb-motion-shots.mjs: that path is already the
// #283 evidence runner and stays as it is.
//
// Two sizes, because the owner reads the strip at both: the pill itself (64x26, its
// dot and bars stay) and the mini stage enlarged to 300x300, which is the orb and its
// rings only and is what makes an eased colour and a breathe visible. Six frames per
// transition at 100 ms, starting at the state change, so the strip shows the 250 ms
// debounce and then the 500 ms ease.
// Nothing here opens an image: each file is checked by its byte length and by the
// width and height in its own PNG header.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixture } from './fixture.mjs';

const shots = process.env.DIDI_ORB_STATE_SHOTS || '/Users/rob/.lux/reports/lux-didi-stability-1015/m3-shots';
await mkdir(shots, { recursive: true });

async function pngSize(path) {
  const head = (await readFile(path)).subarray(0, 24);
  assert.equal(head.subarray(1, 4).toString('latin1'), 'PNG', `${path} is a PNG`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), bytes: (await stat(path)).size };
}

/// The orb's own states, in the owner's words (M3-R6 asks for cold and hot-muted strips
/// of their own). The page paints a pill state, so each visual maps to the attribute.
const STATES = ['cold', 'connecting', 'listening', 'thinking', 'tool', 'speaking', 'hot-muted'];
const PILL_STATE = {
  cold: 'idle', connecting: 'connecting', listening: 'listening', thinking: 'thinking',
  tool: 'tool', speaking: 'speaking', 'hot-muted': 'muted',
};
/// The five transitions the owner asked to see, as visual states.
const TRANSITIONS = [
  ['listening', 'thinking'],
  ['thinking', 'tool'],
  ['tool', 'speaking'],
  ['speaking', 'listening'],
  ['listening', 'hot-muted'],
];

const fixture = await startFixture({ configured: false });
let browser;
const written = [];
const moved = [];
try {
  browser = await chromium.launch({
    channel: 'chromium', headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'],
  });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 340, height: 340 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${fixture.url}/?view=mini`);
  await page.locator('.mini-pill .mini-stage').waitFor();
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
      || document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : String(gl && gl.getParameter(gl.RENDERER));
  });
  assert.match(String(renderer), /Metal/i, `headless renderer must be Metal, got ${renderer}`);

  /// The frame's own bytes: a still orb encodes to one PNG and a moving one does not, so a
  /// frame that repeats its neighbour is a frame the transition did not reach.
  const frameHash = async (name) => {
    const bytes = await readFile(join(shots, `${name}.png`));
    return `${bytes.length}:${bytes.subarray(24, 64).toString('base64')}`;
  };

  /// The visual the loop last painted. The hue and the glow are the state machine's own
  /// eased numbers, so they prove a transition moved the colour, where a PNG byte count
  /// would pass on the breathe alone (review F5).
  const painted = () => page.evaluate(() => {
    const visual = window.didiOrbVisual && window.didiOrbVisual();
    return visual ? {
      hue: Math.round(visual.hue * 10) / 10,
      glow: Math.round(visual.glow * 1000) / 1000,
      state: visual.state,
      // M3-R6: the crossfade progress, 1 when the change has landed.
      mix: visual.mixing ? Math.round(visual.mixing.t * 1000) / 1000 : null,
      mixFrom: visual.mixing ? Math.round(visual.mixing.from * 10) / 10 : null,
      mixTo: visual.mixing ? Math.round(visual.mixing.to * 10) / 10 : null,
    } : null;
  });
  const HUES = { cold: 216, connecting: 216, listening: 167, thinking: 34, tool: 34, speaking: 173, 'hot-muted': 216 };

  // The state lives on the mini stage (M3-R4: the stage is the orb, the pill is the chrome).
  const setState = (state) => page.locator('.mini-stage').evaluate((el, next) => el.setAttribute('data-mini-state', next), state);
  // M3-R5: the orb is its own 300 px window, the orb and its rings only. The stylesheet
  // below is that window; switching it on hides every piece of pill chrome (the wash and
  // the five bars) and gives the stage the full 300 px, so a strip frame is about the orb.
  // M3-R5: the orb is its own 300 px window. Content Security Policy forbids an injected
  // <style>, so the window is built from element styles: the pill gives up its 64x26 box
  // and its clipping, the stage becomes the 300 px surface and the canvas fills it. The
  // 300 px frame is the canvas alone, so the pill's wash and its five bars cannot appear.
  const enlarge = async (on) => {
    await page.evaluate((big) => {
      const pill = document.querySelector('.mini-pill');
      const stage = document.querySelector('.mini-stage');
      const canvas = stage.querySelector('canvas');
      const level = document.querySelector('.mini-level');
      pill.style.cssText = big ? 'width:300px;height:300px;min-height:300px;padding:0;gap:0;border:none;background:transparent;overflow:visible;justify-content:center' : '';
      stage.style.cssText = big ? 'flex:0 0 300px;width:300px;height:300px;min-height:300px;border-radius:150px' : '';
      canvas.style.cssText = big ? 'width:300px;height:300px' : '';
      level.style.cssText = big ? 'display:none' : '';
    }, on);
    await page.waitForTimeout(180);   // the ResizeObserver has to redraw at the new size
  };
  const capture = async (name, pill) => {
    const path = join(shots, `${name}.png`);
    await page.locator(pill ? '.mini-pill' : '.mini-stage canvas').screenshot({ path });
    const size = await pngSize(path);
    // A 300 px orb frame that is an empty box is the defect R5 reported, so the floor is
    // a drawn orb rather than a blank window.
    assert.ok(size.bytes > (pill ? 200 : 5000), `${path} is a real render (${size.bytes} bytes)`);
    assert.deepEqual({ width: size.width, height: size.height }, pill ? { width: 64, height: 26 } : { width: 300, height: 300 },
      `${path} is ${pill ? 'the pill' : 'the 300x300 orb'}`);
    written.push(`${name}=${size.width}x${size.height}/${size.bytes}B`);
  };

  for (const state of STATES) {
    await setState(PILL_STATE[state]);
    await page.waitForTimeout(700);            // past the debounce and the ease
    await capture(`state-${state}-pill`, true);
    // The mini stage enlarged to 300x300: the orb and its rings, nothing else.
    await enlarge(true);
    await capture(`state-${state}-300`, false);
    await enlarge(false);
  }

  for (const [from, to] of TRANSITIONS) {
    await setState(PILL_STATE[from]);
    await page.waitForTimeout(900);            // settle the strip's starting state
    for (const enlarged of [false, true]) {
      if (enlarged) {
        await enlarge(true);
        await setState(PILL_STATE[from]);
        await page.waitForTimeout(900);
      }
      await setState(PILL_STATE[to]);
      const started = Date.now();
      const samples = [];
      const visuals = [];
      for (let frame = 0; frame < 6; frame += 1) {
        const due = started + frame * 100;
        const wait = due - Date.now();
        if (wait > 0) await page.waitForTimeout(wait);
        const name = `transition-${from}-to-${to}-${frame}-${enlarged ? '300' : 'pill'}`;
        await capture(name, !enlarged);
        samples.push(await frameHash(name));
        visuals.push(await painted());
      }
      const distinct = new Set(samples).size;
      assert.ok(distinct >= 3, `${from} to ${to} moves through at least three frames, got ${JSON.stringify(samples)}`);
      // The colour: M3-R6 forbids walking a hue between teal and amber, so the strip
      // proves a crossfade instead. The incoming layer is the target from the first frame,
      // the fade is partial in the middle of the strip, and it lands at 1.
      const first = visuals[0], last = visuals.at(-1);
      assert.ok(first && last, `${from} to ${to} reported a painted visual on every frame`);
      assert.equal(last.hue, HUES[to], `${from} to ${to} fades in the ${to} hue`);
      assert.equal(first.mix, null, `${from} to ${to} starts on the old state, before the fade`);
      const partial = visuals.filter((v) => v.mix !== null && v.mix > 0 && v.mix < 1).length;
      assert.ok(partial >= 1, `${from} to ${to} fades across the strip: ${JSON.stringify(visuals.map((v) => v.mix))}`);
      assert.equal(last.mixFrom ?? HUES[from], HUES[from], `${from} to ${to} fades from the ${from} hue`);
      await page.waitForTimeout(450);
      const settled = await painted();
      if (HUES[from] === HUES[to]) {
        assert.equal(settled.state, to, `${from} to ${to} lands on ${to}`);
      } else {
        assert.equal(settled.hue, HUES[to], `${from} to ${to} settles on the ${to} hue`);
        assert.equal(settled.mix, null, `${from} to ${to} finishes the fade`);
      }
      moved.push(`${from}-to-${to}${enlarged ? '@300' : ''}:${distinct}->${Math.round(settled.hue)}`);
      if (enlarged) await enlarge(false);
    }
  }
  assert.deepEqual(errors, [], 'the pill raised no page error');
  console.log(`ORB-MOTION-SHOTS PASS ${shots} files=${written.length} frames-moved=${moved.join(' ')} ${written.join(' ')}`);
} finally {
  if (browser) await browser.close();
  await fixture.close();
}
