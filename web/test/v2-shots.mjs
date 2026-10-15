// Screenshot + DOM measurement harness for the three-lane rework (#255 item 7).
// Reuses the accepted connected fixture exactly as server/test/connected-browser.mjs does:
// fork connected-process.js over the built web/dist, pair through the operator API, then drive the UI.
// Run through `lux-browser-slot run -- node web/test/v2-shots.mjs`.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { chromium } = createRequire(new URL('../package.json', import.meta.url))('playwright');
const root = resolve(import.meta.dirname, '../..');
const out = '/Users/rob/.lux/reports/lux-didi-stability-1015/v2-shots';
await mkdir(out, { recursive: true });
const state = await mkdtemp(join(tmpdir(), 'v2-shots-'));
let child, descriptor;
let stderr = '';

function waitPhase(name) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { cleanup(); rej(Error(`timeout ${name}: ${stderr.slice(-800)}`)); }, 15000);
    const cleanup = () => { clearTimeout(timer); child.off('message', listener); child.off('exit', exited); };
    const listener = value => { if (value?.phase === name) { cleanup(); res(value); } };
    const exited = () => { cleanup(); rej(Error(`exit before ${name}: ${stderr.slice(-800)}`)); };
    child.on('message', listener); child.once('exit', exited);
  });
}
async function start() {
  child = fork(join(root, 'server/dist/test/connected-process.js'), [state, join(root, 'web/dist'), '0'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  descriptor = (await waitPhase('ready')).descriptor;
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const proc = child, exited = once(proc, 'exit'); proc.send('stop');
  try { await Promise.race([exited, new Promise((_, r) => setTimeout(() => r(Error('stop timeout')), 5000))]); }
  finally { if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await exited; } }
}
async function operator(path, body = {}) {
  const token = (await readFile(join(state, 'admin-credential'), 'utf8')).trim();
  const response = await fetch(descriptor.origin + '/api/v1' + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Didi-Authority-Epoch': descriptor.authorityEpoch, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).data;
}

const shots = [];
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  await start();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
  const page = await context.newPage();
  await page.goto(descriptor.origin);
  await page.locator('#pair-code').waitFor();
  const pairing = await operator('/auth/pairing');
  await page.locator('#pair-code').fill(pairing.pairingCode);
  await page.locator('#pair-form').evaluate(form => form.requestSubmit());
  await page.locator('#connected-send').waitFor();
  await page.locator('#didi-orb').waitFor();

  const ready = async () => { await page.locator('#connected-send').waitFor(); await page.locator('#didi-orb').waitFor(); };
  const setTheme = async mode => { await page.evaluate(m => localStorage.setItem('didi-theme', m), mode); await page.reload(); await ready(); };
  const startLive = async () => {
    await page.locator('#voice-start').click();
    const allow = page.locator('#consent-allow');
    if (await allow.count()) await allow.click();
    await page.locator('#pill-stop').waitFor();
  };
  const stopLive = async () => { const stop = page.locator('#pill-stop'); if (await stop.count()) { await stop.click(); await page.locator('#voice-start').waitFor(); } };
  const shot = async (name, full = false) => { await page.screenshot({ path: join(out, `${name}.png`), fullPage: full }); shots.push(name); };

  await setTheme('dark');
  await shot('1440x900-dark-idle');

  const measure = await page.evaluate(() => {
    const rect = selector => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
    const rgb = value => { const hex = value.match(/^#([0-9a-f]{6})$/i); if (hex) { const n = parseInt(hex[1], 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; } const m = value.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b] = m[1].split(',').map(Number); return { r, g, b }; };
    const lum = c => { const f = v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100; };
    const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const orbCore = rgb(cssVar('--orb-core')), bg = rgb(cssVar('--bg'));
    const headings = document.querySelectorAll('.live-transcript h1, .live-transcript h2, #connected-entries h1, #connected-entries h2, .entries h1, .entries h2');
    const body = document.body.innerText;
    const lanes = document.querySelectorAll('.lane');
    return {
      voiceHeader: rect('.voice-head'), orbStage: rect('.orb-stage'), orbCanvas: rect('#didi-orb'),
      composer: rect('#connected-draft'), composerForm: rect('#connected-send-form'),
      rail: rect('#rail'), laneVoice: lanes[0] ? Math.round(lanes[0].getBoundingClientRect().width) : null,
      laneChat: lanes[1] ? Math.round(lanes[1].getBoundingClientRect().width) : null,
      windowBottom: window.innerHeight,
      transcriptHeadingCount: headings.length,
      visibleHttpsCount: (body.match(/https?:\/\//g) ?? []).length,
      idleOrbContrastToCard: orbCore && bg ? ratio(orbCore, bg) : null,
    };
  });

  const table = [
    '# DOM measurements at 1440x900, dark, idle',
    '',
    '| metric | value |',
    '| --- | --- |',
    `| voice header height | ${measure.voiceHeader?.h} px |`,
    `| orb stage height | ${measure.orbStage?.h} px |`,
    `| orb canvas | ${measure.orbCanvas?.w}x${measure.orbCanvas?.h} px |`,
    `| composer (#connected-draft) height | ${measure.composer?.h} px |`,
    `| composer bottom gap to window | ${measure.windowBottom - (measure.composerForm?.bottom ?? 0)} px |`,
    `| rail width | ${measure.rail?.w} px |`,
    `| Voice lane width | ${measure.laneVoice} px |`,
    `| Chat lane width | ${measure.laneChat} px |`,
    `| h1/h2 inside transcripts | ${measure.transcriptHeadingCount} |`,
    `| visible https:// strings | ${measure.visibleHttpsCount} |`,
    `| idle orb to card contrast ratio | ${measure.idleOrbContrastToCard}:1 |`,
    '',
  ].join('\n');
  await writeFile(join(out, 'measurements.md'), table);
  console.log(table);

  await startLive();
  await shot('1440x900-dark-live');
  await stopLive();

  await setTheme('light');
  await shot('1440x900-light-idle');

  await setTheme('dark');
  await page.locator('[data-tab="Settings"]').click();
  await page.locator('#sheet').waitFor();
  await shot('1440x900-dark-sheet');
  await page.locator('#sheet-close').click();

  await page.locator('[data-lane="voice"]').click();
  await page.locator('#lane-voice[data-state="collapsed"]').waitFor();
  await shot('1440x900-dark-voice-collapsed');
  await page.locator('[data-lane="voice"]').click();
  await page.locator('#lane-voice[data-state="open"]').waitFor();

  await page.setViewportSize({ width: 800, height: 900 });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await setTheme('dark');
  await shot('800x900-dark-idle');
  await startLive();
  await shot('800x900-dark-live');
  await stopLive();
  await setTheme('light');
  await shot('800x900-light-idle');

  await writeFile(join(out, 'shots.json'), JSON.stringify({ shots, measure }, null, 2));
  console.log('SHOTS', shots.join(', '));
  console.log('MEASURE', JSON.stringify(measure));
} finally {
  await stop();
  await browser.close();
}
