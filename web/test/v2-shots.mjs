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

  const ready = async () => { await page.locator('.app-shell').waitFor(); await page.locator('#didi-orb').waitFor(); };
  // Probe: does the consent checkbox stick after a click?
  const allow = page.locator('#connected-consent');
  if (await allow.count()) await allow.click();
  await page.locator('#connected-draft:not([disabled])').waitFor();
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
      voiceHeader: rect('#lane-voice .lane-head'), chatHeader: rect('#lane-chat .lane-head'), emptyState: rect('.voice-empty'), orbCanvas: rect('#didi-orb'),
      composer: rect('#connected-draft'), composerForm: rect('#connected-send-form'),
      chatInner: rect('#lane-chat .lane-inner'), chatFill: rect('.chat-fill'), connPanel: rect('#connected-panel'), connConv: rect('.connected-conversation'), connEntries: rect('#connected-entries'),
      rail: rect('#rail'), laneVoice: lanes[0] ? Math.round(lanes[0].getBoundingClientRect().width) : null,
      laneChat: lanes[1] ? Math.round(lanes[1].getBoundingClientRect().width) : null,
      windowBottom: window.innerHeight,
      transcriptHeadingCount: headings.length,
      visibleHttpsCount: (body.match(/https?:\/\//g) ?? []).length,
      headerOrb: rect('#lane-voice .voice-orb'), nestedCards: document.querySelectorAll('#lane-voice .panel, #lane-chat .panel').length,
      idleOrbContrastToCard: orbCore && bg ? ratio(orbCore, bg) : null,
      readyWhenYouAreCount: (body.match(/Ready when you are/g) ?? []).length,
      serifCount: [...document.querySelectorAll('*')].filter(el => /serif/i.test(getComputedStyle(el).fontFamily) && !/sans-serif/i.test(getComputedStyle(el).fontFamily)).length,
    };
  });

  const table = [
    '# DOM measurements at 1440x900, dark, idle',
    '',
    '| metric | value |',
    '| --- | --- |',
    `| voice header height | ${measure.voiceHeader?.h} px |`,
    `| chat header height | ${measure.chatHeader?.h} px |`,
    `| empty state height | ${measure.emptyState?.h} px |`,
    `| orb canvas | ${measure.orbCanvas?.w}x${measure.orbCanvas?.h} px |`,
    `| composer (#connected-draft) height | ${measure.composer?.h} px |`,
    `| composer bottom gap to window | ${measure.windowBottom - (measure.composerForm?.bottom ?? 0)} px |`,
    `| rail width | ${measure.rail?.w} px |`,
    `| Voice lane width | ${measure.laneVoice} px |`,
    `| Chat lane width | ${measure.laneChat} px |`,
    `| h1/h2 inside transcripts | ${measure.transcriptHeadingCount} |`,
    `| visible https:// strings | ${measure.visibleHttpsCount} |`,
    `| idle orb to card contrast ratio | ${measure.idleOrbContrastToCard}:1 |`,
    `| visible \"Ready when you are\" | ${measure.readyWhenYouAreCount} |`,
    `| serif font-family elements | ${measure.serifCount} |`,
    `| header orb size | ${measure.headerOrb ? measure.headerOrb.w + 'x' + measure.headerOrb.h + ' px' : 'absent in the empty state'} |`,
    `| nested cards inside lanes | ${measure.nestedCards} |`,
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
  await page.locator('#sheet').waitFor({ state: 'detached' }).catch(() => {});

  await page.locator('#lane-voice .lane-toggle').click({ force: true });
  await page.locator('#lane-voice[data-state="collapsed"]').waitFor();
  await shot('1440x900-dark-voice-collapsed');
  await page.evaluate(() => document.querySelector('#lane-voice .lane-toggle').click());
  await page.waitForFunction(() => document.querySelector('#lane-voice').dataset.state === 'open');

  // V2-R1 item 10: a voice transcript with 3 turns and one tool chip, and a chat with 2 turns.
  await page.route('**/api/v1/live/current*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data = {
      state: 'idle', since: new Date().toISOString(), cursor: 4, entries: [
        { seq: 1, kind: 'inputTranscription', text: 'What did Rob ask me to do next?' },
        { seq: 2, kind: 'outputTranscription', text: 'Ship the three-lane UI and the live pill.' },
        { seq: 3, kind: 'outputTranscription', text: 'I checked the inbox and the calendar.' },
        { seq: 4, kind: 'toolResult', tool: { name: 'search', status: 'completed', markdown: '**Answer** see [source](https://example.org)', sources: [{ title: 'lux 123', url: 'https://example.org' }] } }
      ]
    };
    await route.fulfill({ response, json: body });
  });
  await setTheme('dark');
  { const a = page.locator('#connected-consent'); if (await a.count()) await a.click(); }
  await page.locator('#connected-draft:not([disabled])').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#live-panel .live-tool-result').length === 1, { timeout: 12000 });
  for (const text of ['First synthetic chat turn.', 'Second synthetic chat turn.']) {
    await page.locator('#connected-draft').fill(text);
    await page.locator('#connected-send').click();
    await page.locator('#connected-entries').getByText(text, { exact: false }).first().waitFor({ timeout: 20000 });
  }
  await page.waitForFunction(() => document.querySelectorAll('#connected-entries .assistant').length >= 2, { timeout: 20000 });
  await shot('1440x900-dark-chat-turns');
  const r4 = await page.evaluate(() => {
    const rn = v => Math.round(v);
    const q = s => document.querySelector(s);
    const box = s => { const el = q(s); if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
    const voice = box('#lane-voice'), chat = box('#lane-chat');
    const chip = box('.live-tool-result'), naya = box('.live-turns .entry.naya'), user = box('.live-turns .entry.user');
    const composer = box('#connected-send-form'), field = box('.composer-field'), send = box('#connected-send'), hide = box('#lane-voice .lane-toggle');
    const entries = [...document.querySelectorAll('.live-turns > *')];
    const sA = box('#voice-start'), sB = box('#new-conversation');
    const summary = q('.live-tool-result > summary');
    const label = q('.live-turns .entry strong'); const labelDiv = q('.live-turns .entry .markdown, .live-turns .entry p');
    const allow = q('.allow-link');
    return {
      nayaLeftInset: naya ? rn(naya.left - voice.left) : null,
      userRightInset: user ? rn(voice.right - user.right) : null,
      chipLeftInset: chip ? rn(chip.left - voice.left) : null,
      composerLeftInset: composer ? rn(composer.left - chat.left) : null,
      composerRightInset: composer ? rn(chat.right - composer.right) : null,
      composerBottomGap: composer ? rn(chat.bottom - composer.bottom) : null,
      send: send ? `${rn(send.width)}x${rn(send.height)}` : null,
      sendRightInset: field && send ? rn(field.right - send.right) : null,
      sendCentre: field && send ? Math.abs(rn((send.top + send.height / 2) - (field.top + field.height / 2))) : null,
      headerOrb: box('#lane-voice .voice-orb canvas'),
      hideRightInset: hide ? rn(voice.right - hide.right) : null,
      gapStartNew: sA && sB ? rn(sB.left - sA.right) : null,
      gapNewHide: sB && hide ? rn(hide.left - sB.right) : null,
      turnGap: entries.length > 1 ? rn(entries[1].getBoundingClientRect().top - entries[0].getBoundingClientRect().bottom) : null,
      chipPad: summary ? `${getComputedStyle(summary).paddingTop} ${getComputedStyle(summary).paddingRight}` : null,
      chipDisplay: summary ? getComputedStyle(summary).display : null,
      labelGap: label && labelDiv ? rn(labelDiv.getBoundingClientRect().top - label.getBoundingClientRect().bottom) : null,
      labelFont: label ? getComputedStyle(label).fontSize : null,
      nayaMax: q('.live-turns .entry.naya') ? getComputedStyle(q('.live-turns .entry.naya')).maxWidth : null,
      allowHeight: allow ? rn(allow.getBoundingClientRect().height) : null,
      nestedCards: document.querySelectorAll('#lane-voice .panel, #lane-chat .panel').length,
    };
  });
  await writeFile(join(out, 'measurements-v2r4.md'), ['# V2-R4 A-G measurements (1440x900, dark, live transcript and empty chat)', '', '| item | metric | value |', '| --- | --- | --- |',
    `| A | naya turn left inset | ${r4.nayaLeftInset} px |`,
    `| A | user turn right inset | ${r4.userRightInset} px |`,
    `| A | tool chip left inset | ${r4.chipLeftInset} px |`,
    `| A | composer left / right inset | ${r4.composerLeftInset} / ${r4.composerRightInset} px |`,
    `| B | composer bottom gap | ${r4.composerBottomGap} px |`,
    `| C | send button | ${r4.send} px; right inset ${r4.sendRightInset}; centre offset ${r4.sendCentre} |`,
    `| D | header orb | ${r4.headerOrb ? Math.round(r4.headerOrb.width) + 'x' + Math.round(r4.headerOrb.height) : 'absent'} px |`,
    `| D | Hide right inset / Start-New gap / New-Hide gap | ${r4.hideRightInset} / ${r4.gapStartNew} / ${r4.gapNewHide} px |`,
    `| E | tool chip | ${r4.chipDisplay}, padding ${r4.chipPad} |`,
    `| F | turn gap / label gap / label font / naya max width | ${r4.turnGap} / ${r4.labelGap} / ${r4.labelFont} / ${r4.nayaMax} |`,
    `| G | Allow height | ${r4.allowHeight} px |`,
    `| A | nested cards inside lanes | ${r4.nestedCards} |`,
    ''].join('\n'));
  await page.unroute('**/api/v1/live/current*');
  await page.reload(); await ready();

  await page.setViewportSize({ width: 800, height: 900 });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await setTheme('dark');
  await shot('800x900-dark-idle');
  await startLive();
  await shot('800x900-dark-live');
  await stopLive();
  await setTheme('light');
  await shot('800x900-light-idle');

  await page.setViewportSize({ width: 375, height: 900 });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await setTheme('dark');
  const probe = await page.evaluate(() => {
    const info = selector => { const el = document.querySelector(selector); if (!el) return 'missing'; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { w: Math.round(r.width), h: Math.round(r.height), display: cs.display, visibility: cs.visibility, state: el.dataset ? el.dataset.state : null }; };
    return { innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, row: info('.lane-row'), lanes: info('.lanes'), voiceLane: info('#lane-voice'), voiceInner: info('#lane-voice .lane-inner'), orbStage: info('.orb-stage'), orb: info('#didi-orb') };
  });
  console.log('PROBE375', JSON.stringify(probe));

  await writeFile(join(out, 'shots.json'), JSON.stringify({ shots, measure, probe }, null, 2));
  console.log('SHOTS', shots.join(', '));
  console.log('MEASURE', JSON.stringify(measure));
} finally {
  await stop();
  await browser.close();
}
