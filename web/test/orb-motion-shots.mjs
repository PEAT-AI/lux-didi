// Orb motion evidence for PEAT-AI/lux-didi#283: drives the real web orb (web/src/orb.ts) in a
// headless browser with a synthetic, deterministic speech-like level sequence (4 to 6 syllables per
// second, vowels and consonants) on a virtual clock, then writes per-state contact sheets (4x4
// frames over 2 s), an activity trace and a footprint/frame-rate table. No audio, no owner data,
// no window focus. Run through the host browser slot:
//   lux-browser-slot run --priority worker --want 1 -- node web/test/orb-motion-shots.mjs \
//     [--web <dir holding src/ and node_modules>] [--tag after] [--out <dir>] [--legacy]
// --legacy feeds the pre-#283 drive (one broadband RMS at 15 Hz) for a before run.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const web = resolve(opt('--web', resolve(import.meta.dirname, '..')));
const tag = opt('--tag', 'after');
const out = resolve(opt('--out', '/Users/rob/.lux/reports/lux-didi-stability-1015/orb-alive-shots'));
const legacy = args.includes('--legacy');
const size = Number(opt('--size', '300'));
await mkdir(out, { recursive: true });

const require = createRequire(join(resolve(import.meta.dirname, '..'), 'package.json'));
const { chromium } = require('playwright');
const { createServer } = require('vite');

const harness = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#111827}canvas#orb{width:${size}px;height:${size}px;display:block}
</style></head><body><canvas id="orb"></canvas><script type="module">
import { Orb } from '/src/orb.ts';
window.__orbReady = (state) => { window.__orb = new Orb(document.getElementById('orb'), state); return true; };
</script></body></html>`;

const server = await createServer({
  root: web, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false }, appType: 'custom',
  plugins: [{ name: 'orb-harness', configureServer(s) { s.middlewares.use((req, res, next) => {
    if (req.url !== '/orb-harness.html') return next();
    res.setHeader('content-type', 'text/html'); res.end(harness);
  }); } }],
});
await server.listen();
const origin = `http://127.0.0.1:${server.config.server.port ?? server.httpServer.address().port}`;

// Deterministic synthetic voice: per 10 ms window, linear RMS per band, the shape the native
// analyzer posts. Syllables at 4 to 6 per second: a short consonant (high band, little low band)
// then a vowel (low band body), grouped into phrases with breath pauses.
const speech = `
(() => {
  let seed = 283;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const windows = [];
  let t = 0;
  while (t < 30000) {
    const phraseMs = 1400 + rnd() * 900;
    const end = t + phraseMs;
    const loud = 0.75 + rnd() * 0.4;
    while (t < end) {
      const rate = 4 + rnd() * 2;               // syllables per second
      const syll = 1000 / rate;
      const cons = 30 + rnd() * 40;              // consonant ms
      const vowel = syll * (0.55 + rnd() * 0.2); // vowel ms
      const sib = rnd() < 0.35;                  // sibilant onset
      for (let ms = 0; ms < syll; ms += 10) {
        let low = 0.004, mid = 0.003, high = 0.002;
        if (ms < cons) { high = sib ? 0.07 : 0.035; mid = sib ? 0.02 : 0.03; low = sib ? 0.006 : 0.02; }
        else if (ms < cons + vowel) {
          const x = (ms - cons) / vowel; const env = Math.sin(Math.PI * Math.min(1, x * 1.25)) ** 0.6;
          low = 0.012 + 0.09 * env * loud; mid = 0.01 + 0.045 * env * loud; high = 0.004 + 0.008 * env;
        }
        windows.push([low, mid, high]);
      }
      t += syll;
    }
    const pause = 250 + rnd() * 350;
    for (let ms = 0; ms < pause; ms += 10) windows.push([0.002, 0.0015, 0.001]);
    t += pause;
  }
  const db = v => Math.max(-60, 20 * Math.log10(Math.max(v, 1e-6)));
  let prev = [-60, -60, -60];
  const frames = windows.map(([low, mid, high]) => {
    const now = [db(low), db(mid), db(high)];
    let rise = 0; for (let i = 0; i < 3; i++) rise += Math.max(0, now[i] - prev[i]);
    prev = now;
    return { level: Math.sqrt(low * low + mid * mid + high * high), low, mid, high, flux: Math.min(1, rise / 30) };
  });
  const at = ms => frames[Math.floor(ms / 10) % frames.length];
  const silent = { level: 0, low: 0, mid: 0, high: 0, flux: 0 };
  window.__drive = (mode, legacy) => {
    clearInterval(window.__driveTimer);
    if (mode === 'none') return;
    const start = performance.now();
    const tick = () => {
      const now = performance.now() - start;
      const voice = at(now);
      const output = mode === 'speaking' ? voice : silent;
      const input = mode === 'listening' ? { ...voice, level: voice.level * 0.6, low: voice.low * 0.6, mid: voice.mid * 0.6, high: voice.high * 0.6 } : silent;
      if (legacy) window.didiOrbLevel?.({ level: Math.max(input.level, output.level), playback: output.level });
      else window.didiOrbLevel?.({ v: 2, input, output });
    };
    tick();
    window.__driveTimer = setInterval(tick, legacy ? 66 : 1000 / 60);
  };
  window.__voiceAt = at;
})();`;

const browser = await chromium.launch({ headless: true, args: ['--disable-gpu-vsync', '--mute-audio'] });
const rows = [];
try {
  const scenarios = [
    { name: 'idle', state: 'IDLE', drive: 'none', focused: true },
    { name: 'idle-unfocused', state: 'IDLE', drive: 'none', focused: false, sheet: false },
    { name: 'listening', state: 'LISTENING', drive: 'listening', focused: true },
    { name: 'thinking', state: 'PROCESSING', drive: 'none', focused: true },
    { name: 'speaking', state: 'SPEAKING', drive: 'speaking', focused: true },
    { name: 'transition', state: 'LISTENING', drive: 'none', focused: true, then: 'PROCESSING', thenAt: 500, then2: 'SPEAKING', then2At: 1250 },
  ];
  for (const sc of scenarios) {
    const context = await browser.newContext({ viewport: { width: size + 40, height: size + 40 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    await page.addInitScript(`document.hasFocus = () => ${sc.focused};`);
    await page.addInitScript(speech);
    // Count paints for both old and new code: the orb clears its canvas once per drawn frame.
    await page.addInitScript(`window.__paints = 0; const clear = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function (...a) { if (this.canvas.id === 'orb') window.__paints++; return clear.apply(this, a); };`);
    await page.clock.install({ time: 0 });
    await page.goto(origin + '/orb-harness.html');
    await page.waitForFunction(() => typeof window.__orbReady === 'function');
    await page.evaluate(s => window.__orbReady(s), sc.state);
    await page.evaluate(([m, l]) => window.__drive(m, l), [sc.drive, legacy]);
    await page.clock.runFor(1500);
    // Frame-rate tier: draws during one virtual second.
    const before = await page.evaluate(() => window.__paints);
    const tickBefore = await page.evaluate(() => document.getElementById('orb').didiFrameStats().frames);
    await page.clock.runFor(1000);
    const after = await page.evaluate(() => window.__paints);
    const fps = before === null ? null : after - before;
    if (sc.then) {
      await page.evaluate(s => window.__orb.setState(s), sc.state);
    }
    // Capture: 16 frames, 125 ms apart (2 s), plus an activity trace at 60 Hz over 4 s.
    const frames = [], trace = [];
    const t0 = 0;
    for (let i = 0; i < 16; i++) {
      if (sc.then && i * 125 >= sc.thenAt && (i - 1) * 125 < sc.thenAt) await page.evaluate(s => window.__orb.setState(s), sc.then);
      if (sc.then2 && i * 125 >= sc.then2At && (i - 1) * 125 < sc.then2At) {
        await page.evaluate(([s, l]) => { window.__orb.setState(s); window.__drive('speaking', l); }, [sc.then2, legacy]);
      }
      frames.push(await page.evaluate(() => {
        const c = document.getElementById('orb');
        const ctx = c.getContext('2d'); const w = c.width, h = c.height;
        const data = ctx.getImageData(0, 0, w, h).data;
        // Azimuthal mean of visible intensity (alpha x luma) per radius bucket.
        const buckets = 100, sum = new Float64Array(buckets), count = new Float64Array(buckets);
        for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
          const i = (y * w + x) * 4; const r = Math.hypot(x - w / 2, y - h / 2) / (w / 2);
          if (r >= 1) continue; const b = Math.floor(r * buckets);
          const a = data[i + 3] / 255; const luma = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          sum[b] += a * Math.max(luma, 0.25); count[b]++;
        }
        const profile = Array.from(sum, (s, b) => s / Math.max(1, count[b]));
        // Footprint: the diameter (fraction of the canvas) out to which the azimuthal mean visible
        // intensity stays at or above 0.10 (body and corona; thin rings and faint haze excluded).
        let foot = 0, halo = 0; for (let b = 0; b < buckets; b++) { if (profile[b] >= 0.10) foot = (b + 1) / buckets; if (profile[b] >= 0.04) halo = (b + 1) / buckets; }
        const edge = profile.slice(96).reduce((a, b) => a + b, 0) / 4;
        return { url: c.toDataURL('image/png'), foot, halo, edge, state: c.dataset.state };
      }));
      await page.clock.runFor(125);
    }
    if (sc.name === 'speaking' || sc.name === 'listening') {
      await page.evaluate(([m, l]) => window.__drive(m, l), [sc.drive, legacy]);
      for (let i = 0; i < 240; i++) {
        await page.clock.runFor(1000 / 60);
        trace.push(await page.evaluate(([m, i]) => {
          const s = document.getElementById('orb').didiFrameStats();
          const v = window.__voiceAt(i * 1000 / 60);
          return { activity: s.activity, body: s.body ?? null, scale: s.scale ?? null, low: m === 'listening' ? v.low * 0.6 : v.low, level: v.level };
        }, [sc.drive, i]));
      }
    }
    const feet = frames.map(f => f.foot);
    const meanFoot = feet.reduce((a, b) => a + b, 0) / feet.length;
    const row = { scenario: sc.name, fps, meanFootprint: +meanFoot.toFixed(3), minFootprint: +Math.min(...feet).toFixed(3), maxFootprint: +Math.max(...feet).toFixed(3), meanHalo: +(frames.reduce((a, f) => a + f.halo, 0) / frames.length).toFixed(3), maxEdge: +Math.max(...frames.map(f => f.edge)).toFixed(4), drawMs: await page.evaluate(() => +document.getElementById('orb').didiFrameStats().meanDrawMs.toFixed(2)), ticks: tickBefore };
    rows.push(row);
    if (sc.sheet !== false) {
      const png = await page.evaluate(async ({ frames, title, filter, trace }) => {
        const cell = 300, pad = 6, head = 34, traceH = trace.length ? 170 : 0;
        const W = 4 * cell + 5 * pad, H = head + 4 * cell + 5 * pad + traceH;
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d');
        g.fillStyle = '#0b0f17'; g.fillRect(0, 0, W, H);
        g.fillStyle = '#e5e7eb'; g.font = '15px -apple-system, Helvetica, sans-serif'; g.fillText(title, pad + 4, 22);
        for (let i = 0; i < frames.length; i++) {
          const x = pad + (i % 4) * (cell + pad), y = head + pad + Math.floor(i / 4) * (cell + pad);
          const bg = g.createLinearGradient(0, y, 0, y + cell); bg.addColorStop(0, '#111827'); bg.addColorStop(1, '#1f2937');
          g.fillStyle = bg; g.fillRect(x, y, cell, cell);
          const img = new Image(); img.src = frames[i].url; await img.decode();
          g.save(); if (filter[frames[i].state]) g.filter = filter[frames[i].state]; g.drawImage(img, x, y, cell, cell); g.restore();
          g.fillStyle = '#9ca3af'; g.font = '11px Menlo, monospace';
          g.fillText(`${(i * 0.125).toFixed(3)}s ${frames[i].state} fp ${(frames[i].foot * 100).toFixed(0)}%`, x + 6, y + cell - 8);
        }
        if (trace.length) {
          const y0 = head + 4 * cell + 5 * pad + 10, h = traceH - 24, x0 = pad + 4, w = W - 2 * pad - 8;
          g.strokeStyle = '#374151'; g.strokeRect(x0, y0, w, h);
          const line = (vals, color, lo, hi) => { g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath();
            vals.forEach((v, i) => { const px = x0 + i / (vals.length - 1) * w, py = y0 + h - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) * h; i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.stroke(); };
          line(trace.map(p => p.level), '#4b5563', 0, 0.15);
          line(trace.map(p => p.low), '#f59e0b', 0, 0.15);
          line(trace.map(p => p.activity), '#34d399', 0, 2.6);
          if (trace[0].scale !== null) line(trace.map(p => p.scale), '#60a5fa', 0.8, 1.4);
          g.fillStyle = '#9ca3af'; g.font = '11px Menlo, monospace';
          g.fillText('4 s trace @60Hz: grey broadband RMS, amber low-band RMS (input), green activity (0..2.6), blue body scale (0.8..1.4)', x0 + 4, y0 + h + 14);
        }
        return c.toDataURL('image/png');
      }, { frames, title: `${tag}: ${sc.name} (${sc.state}${sc.then ? ' -> ' + sc.then + ' @0.5s -> ' + sc.then2 + ' @1.25s' : ''}), 16 frames over 2 s, ${fps ?? '?'} paints/s`, filter: { IDLE: 'grayscale(.82) brightness(.96) opacity(.9)', DISCONNECTED: 'grayscale(.82) brightness(.96) opacity(.9)' }, trace });
      await writeFile(join(out, `${tag}-${sc.name}.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
await writeFile(join(out, `${tag}-metrics.json`), JSON.stringify(rows, null, 2) + '\n');
console.table(rows);
