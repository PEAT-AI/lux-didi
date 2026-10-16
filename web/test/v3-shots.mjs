// V3 shots + the DOM measurement table for PEAT-AI/lux-didi#264: the orb is the hero of the voice
// lane, the chat lane is a classic chat. Reuses the accepted connected fixture exactly as
// server/test/connected-browser.mjs does: fork connected-process.js over the built web/dist, pair
// through the operator API, and drive the UI with synthetic text only, never owner data.
// Run through `lux-browser-slot run -- node web/test/v3-shots.mjs` after `bash scripts/run-local.sh --build-only`.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { chromium } = createRequire(new URL('../package.json', import.meta.url))('playwright');
const root = resolve(import.meta.dirname, '../..');
const out = '/Users/rob/.lux/reports/lux-didi-stability-1015/v3-shots';
await mkdir(out, { recursive: true });
const state = await mkdtemp(join(tmpdir(), 'v3-shots-'));
let child, descriptor, stderr = '';

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

// Synthetic content, built here so the shots hold no owner data at all.
const transcriptLines = [];
let seq = 0;
for (let index = 1; index <= 15; index++) {
  transcriptLines.push({ seq: ++seq, kind: 'inputTranscription', text: `Synthetic turn ${index}: what should I do next?` });
  transcriptLines.push({ seq: ++seq, kind: 'turnComplete' });
  transcriptLines.push({ seq: ++seq, kind: 'outputTranscription', text: `Synthetic turn ${index}: run the release checklist, then the checks.` });
  transcriptLines.push({ seq: ++seq, kind: 'turnComplete' });
  if (index === 5 || index === 10) {
    transcriptLines.push({ seq: ++seq, kind: 'toolResult', tool: { name: 'search_knowledge', status: 'completed', markdown: `**Synthetic note ${index === 5 ? 'one' : 'two'}** from lux.`, sources: [{ title: 'release checklist', url: 'https://example.org/synthetic' }] } });
  }
}
const listAnswer = [
  'Here is the synthetic release checklist:',
  '',
  '1. Freeze the branch.',
  '',
  '   The freeze note goes to the release channel.',
  '',
  '2. Run the declared checks.',
  '',
  '   The checks run locally, never on a shared host.',
  '',
  '3. Update the release notes.',
  '',
  '   The notes name every change.',
  '',
  '4. Tag the build.',
  '',
  '   The tag follows the notes.',
  '',
  '5. Announce the release.',
  '',
  '   The announcement is one calm paragraph.',
].join('\n');
const chatEntries = [];
for (let index = 1; index <= 12; index++) {
  const assistant = index % 2 === 0;
  chatEntries.push({
    id: `synthetic-${index}`,
    role: assistant ? 'assistant' : 'user',
    text: assistant ? (index === 10 ? listAnswer : `Synthetic answer ${index}: here is the calm next step for the release checklist.`) : `Synthetic question ${index}: what is next for the release checklist?`,
    sequence: index,
  });
}
const session = { id: 'synthetic-session', title: 'Synthetic release checklist' };
const conversation = { scope: 'conversation', sessionId: 'synthetic-session', provider: 'synthetic', state: 'active', revision: 1, permittedClasses: [], latestRunId: null };
let live = null, chatOn = false;

const flatten = row => ({
  ...row,
  sphereCore: row.sphere ? row.sphere.core : null,
  sphereCoreShare: row.sphere ? row.sphere.coreShare : null,
  orbDrawingShare: row.sphere ? row.sphere.drawnShare : null,
  orbBorderPixels: row.sphere ? row.sphere.border : null,
  bubbleRight: row.chatBubbleRight !== null && row.chatBubbleRight !== undefined ? row.chatBubbleRight : row.voiceBubbleRight,
});
const shots = [], tables = [];
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  await start();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
  const page = await context.newPage();
  // U1 (#282): the chat lane is #panel-right and launches collapsed, so its content is hidden until the
  // owner opens the panel. Open it the owner's way and assert the open state before reading the chat.
  const openPanel = async id => {
    const control = page.locator(`#panel-toggle-${id}`);
    if (await control.getAttribute('aria-expanded') !== 'true') await control.click();
    await page.locator(`#panel-${id}[data-state="open"]`).waitFor();
    assert.equal(await control.getAttribute('aria-expanded'), 'true', `${id} panel toggled open`);
  };
  const envelope = data => ({ data, authorityEpoch: descriptor.authorityEpoch });
  await page.route('**/api/v1/live/current*', route => live ? route.fulfill({ json: envelope(live) }) : route.continue());
  await page.route('**/api/v1/sessions/synthetic-session', route => chatOn ? route.fulfill({ json: envelope({ entries: chatEntries, items: [] }) }) : route.continue());
  await page.route('**/api/v1/sessions', route => chatOn && route.request().method() === 'GET' ? route.fulfill({ json: envelope({ items: [session] }) }) : route.continue());
  await page.route('**/api/v1/conversations/synthetic-session', route => chatOn ? route.fulfill({ json: envelope(conversation) }) : route.continue());
  await page.goto(descriptor.origin);
  await page.locator('#pair-code').waitFor();
  const pairing = await operator('/auth/pairing');
  await page.locator('#pair-code').fill(pairing.pairingCode);
  await page.locator('#pair-form').evaluate(form => form.requestSubmit());
  await page.locator('#connected-send').waitFor();
  await page.locator('#didi-orb').waitFor();
  await page.evaluate(() => localStorage.setItem('didi-theme', 'dark'));
  await page.reload();
  await page.locator('#didi-orb').waitFor();
  await page.locator('.connected-disclosure').waitFor({ timeout: 15000 });
  await openPanel('right');

  const measure = () => page.evaluate(() => {
    const box = selector => { const el = document.querySelector(selector); if (!el) return null; const rect = el.getBoundingClientRect(); return { width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) }; };
    const list = selector => { const el = document.querySelector(selector); return el ? { distance: Math.max(0, Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)), top: Math.round(el.scrollTop) } : null; };
    const voice = box('#lane-voice'), stage = box('#orb-stage'), orb = box('.orb-holder canvas'), transcript = list('.transcript'), chat = list('#connected-entries');
    const contentRight = selector => { const el = document.querySelector(selector); if (!el) return null; return el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight); };
    const columnEl = document.querySelector('#connected-entries');
    const mine = box('#connected-entries .entry.user'), bubbleVoice = box('.transcript .entry.user'), voiceColumn = contentRight('.transcript .live-turns');
    const rows = [...document.querySelectorAll('#connected-entries ol')].flatMap(list => [...list.children].map((_, index) => (list.start || 1) + index));
    const stageStyle = getComputedStyle(document.querySelector('#orb-stage'));
    const stageBox = box('#orb-stage'), transcriptBox = box('.transcript');
    const pill = document.querySelector('#voice-stop') ? 'Stop' : document.querySelector('#voice-start') ? 'Start' : 'none';
    const sphere = (() => {
      const canvas = document.querySelector('#didi-orb');
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const { width, height } = canvas, data = ctx.getImageData(0, 0, width, height).data;
      const boxSize = canvas.getBoundingClientRect().width || 1, scale = boxSize / width;
      const bounds = alpha => {
        let minX = width, maxX = -1, minY = height, maxY = -1;
        for (let y = 0; y < height; y += 2) {
          for (let x = 0; x < width; x += 2) {
            if (data[(y * width + x) * 4 + 3] >= alpha) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
          }
        }
        return maxX < 0 ? null : Math.round(Math.max(maxX - minX, maxY - minY) * scale);
      };
      const core = bounds(179), drawn = bounds(8);
      let border = 0;
      for (let x = 0; x < width; x++) for (const y of [0, height - 1]) if (data[(y * width + x) * 4 + 3] > 8) border++;
      for (let y = 0; y < height; y++) for (const x of [0, width - 1]) if (data[(y * width + x) * 4 + 3] > 8) border++;
      return { box: Math.round(boxSize), core, coreShare: core === null ? null : Number((core / boxSize).toFixed(3)), drawn, drawnShare: drawn === null ? null : Number((drawn / boxSize).toFixed(3)), border };
    })();
    return {
      stageShare: voice && stage ? Number((stage.height / voice.height).toFixed(3)) : null,
      orbDiameter: orb ? orb.height : null,
      orbShare: stage && orb ? Number((orb.height / stage.height).toFixed(3)) : null,
      orbCentre: stage && orb ? Math.abs(Math.round((orb.left + orb.width / 2) - (stage.left + stage.width / 2))) : null,
      stageTop: stage ? stage.top : null,
      transcriptDistance: transcript ? transcript.distance : null,
      chatDistance: chat ? chat.distance : null,
      chatColumn: columnEl ? Math.round(columnEl.getBoundingClientRect().width - parseFloat(getComputedStyle(columnEl).paddingLeft) - parseFloat(getComputedStyle(columnEl).paddingRight)) : null,
      chatBubbleRight: columnEl && mine ? Math.round(contentRight('#connected-entries') - mine.right) : null,
      voiceBubbleRight: voiceColumn !== null && bubbleVoice ? Math.round(voiceColumn - bubbleVoice.right) : null,
      composerBottom: Math.round(document.querySelector('#lane-chat').getBoundingClientRect().bottom - document.querySelector('.composer-field').getBoundingClientRect().bottom),
      viewport: `${document.documentElement.clientWidth}x${document.documentElement.clientHeight}`,
      sphere: sphere,
      stageBorder: Number.parseFloat(stageStyle.borderTopWidth) + Number.parseFloat(stageStyle.borderBottomWidth),
      stageBackground: stageStyle.backgroundColor,
      pill: pill,
      mute: !!document.querySelector('#voice-mute'),
      transcriptTopGap: stageBox && transcriptBox ? Math.round(transcriptBox.top - stageBox.bottom) : null,
      voiceColumn: Math.round((() => { const el = document.querySelector('.transcript .live-turns'); return el ? el.getBoundingClientRect().width : 0; })()),
      composerButtons: [...document.querySelectorAll('.composer-field button')].filter(button => button.getClientRects().length > 0).length,
      emptyBarsAboveComposer: (() => {
        const form = document.querySelector('#connected-send-form'), list = document.querySelector('#connected-entries');
        if (!form || !list) return 0;
        const top = list.getBoundingClientRect().bottom, bottom = form.getBoundingClientRect().top;
        return [...document.querySelectorAll('.connected-conversation *')].filter(el => {
          const rect = el.getBoundingClientRect();
          if (rect.height <= 0 || rect.width <= 0 || rect.top < top - 1 || rect.bottom > bottom + 1) return false;
          if (el.textContent.trim().length) return false;
          const style = getComputedStyle(el);
          const bordered = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].some(side => Number.parseFloat(style[side]) > 0);
          return bordered || style.backgroundImage !== 'none' || style.backgroundColor !== 'rgba(0, 0, 0, 0)';
        }).length;
      })(),
      attachGlyph: (() => { const glyph = document.querySelector('#connected-attach .attach-plus'); if (!glyph) return null; const rect = glyph.getBoundingClientRect(); return { w: Math.round(rect.width), h: Math.round(rect.height), text: glyph.textContent, color: getComputedStyle(glyph).color }; })(),
      attachVisible: (() => { const el = document.querySelector('#connected-attach'); return !!el && el.getClientRects().length > 0; })(),
      pillInsideStage: (() => { const control = document.querySelector('#voice-stop') ?? document.querySelector('#voice-start'); if (!control || !stageBox) return null; const rect = control.getBoundingClientRect(); return rect.top >= stageBox.top - 0.5 && rect.bottom <= stageBox.bottom + 0.5 && rect.left >= stageBox.left - 0.5 && rect.right <= stageBox.right + 0.5; })(),
      consentInset: (() => { const el = document.querySelector('.connected-disclosure'); if (!el) return null; const column = document.querySelector('#connected-entries'); return column ? Math.round(el.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(el).paddingLeft) - column.getBoundingClientRect().left) : null; })(),
      voiceWidth: voice ? voice.width : null,
      chatWidth: chat ? box('.chat-list').width : null,
      labels: document.querySelectorAll('.entry strong, .entry header').length,
      documentScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      listNumbers: rows.join(','),
      voiceJump: !document.querySelector('#transcript-jump').hidden,
      chatJump: !document.querySelector('#chat-jump').hidden,
      transcriptTop: box('.transcript')?.top ?? null,
    };
  });
  let idleStageTop = null;

  const sample = async (name, viewport) => {
    if (viewport) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(size => document.documentElement.clientWidth === size.width && document.documentElement.clientHeight === size.height, viewport);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    const table = flatten(await measure());
    await page.screenshot({ path: join(out, `${name}.png`) });
    shots.push(name); tables.push({ name, ...table });
    return table;
  };

  let table = await sample('1440x900-dark-a-idle');
  idleStageTop = table.stageTop;
  assert.equal(table.labels, 0, 'no speaker labels anywhere');
  assert.equal(table.documentScrolls, false, 'the document never scrolls');
  assert.equal(table.chatColumn <= 760, true, 'the chat column is at most 760 px');
  assert.equal(table.voiceJump, false, 'an empty transcript has nothing to jump to');
  assert.equal(table.pill, 'Start', 'Live is off offers Start');
  assert.equal(table.composerButtons, 2, 'the idle composer shows the attach plus and the send');
  assert.equal(table.attachVisible, true, 'the attach plus is visible in idle as well as with a draft');
  assert.equal(table.orbBorderPixels, 0, `no drawing pixel touches the orb box border (${table.orbBorderPixels})`);
  assert.equal(table.emptyBarsAboveComposer, 0, 'no empty bordered bar sits above the composer');
  assert.equal(table.attachGlyph !== null && table.attachGlyph.w >= 8 && table.attachGlyph.h >= 10 && table.attachGlyph.text === '+', true, `the attach control draws a real plus glyph (${JSON.stringify(table.attachGlyph)})`);
  assert.equal(table.pillInsideStage, true, 'every control sits fully inside the stage');
  assert.equal(table.consentInset, 24, 'the consent line uses the column side padding');
  assert.equal(table.composerBottom >= 16 && table.composerBottom <= 24, true, `the composer sits 16 to 24 px above the lane bottom (${table.composerBottom})`);
  const composerBottomIdle = table.composerBottom;
  await sample('2000x1250-dark-a-idle', { width: 2000, height: 1250 });

  live = { state: 'speaking', since: '2026-10-16T09:00:00Z', cursor: seq, entries: transcriptLines };
  chatOn = true;
  await page.reload();
  await page.locator('#didi-orb').waitFor();
  const allow = page.locator('#connected-consent');
  if (await allow.count()) await allow.click();
  try {
    await page.waitForFunction(() => document.querySelectorAll('#connected-entries .entry').length === 12, { timeout: 20000 });
  } catch (error) {
    const panel = await page.locator('#connected-panel').innerText().catch(() => 'unreadable');
    throw Error(`synthetic chat did not render: ${panel.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  await page.waitForFunction(() => document.querySelectorAll('.transcript .entry').length === 30);
  await page.waitForFunction(() => document.querySelectorAll('.transcript .live-tool-result').length === 2);
  table = await sample('1440x900-dark-b-speaking', { width: 1440, height: 900 });
  assert.equal(table.stageTop, idleStageTop, `appending 30 lines never moves the orb stage (${idleStageTop} then ${table.stageTop})`);
  assert.equal(table.transcriptDistance <= 2, true, `the transcript stays pinned at the bottom (distance ${table.transcriptDistance})`);
  if (table.chatDistance > 2) {
    const chatState = await page.evaluate(() => { const el = document.querySelector('#connected-entries'); const pill = document.querySelector('#chat-jump'); return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, jumpHidden: pill.hidden, entries: el.children.length }; });
    throw Error(`the chat list is not pinned: ${JSON.stringify({ ...chatState, distance: table.chatDistance })}`);
  }
  assert.equal(table.composerBottom, composerBottomIdle, `the composer never moves when lines arrive (${composerBottomIdle} then ${table.composerBottom})`);
  assert.equal(table.orbBorderPixels, 0, `no drawing pixel touches the orb box border (${table.orbBorderPixels})`);
  assert.equal(table.orbDrawingShare <= 0.95, true, `the whole drawing stays inside the box with margin (${table.orbDrawingShare})`);
  assert.equal(table.emptyBarsAboveComposer, 0, 'no empty bordered bar sits above the composer');
  assert.equal(table.listNumbers, '1,2,3,4,5', `the ordered list keeps its numbering (${table.listNumbers})`);
  assert.equal(table.chatBubbleRight, 0, 'the chat owner bubble sits at the column right edge');
  assert.equal(table.voiceBubbleRight, 0, 'the voice owner bubble sits at the column right edge');
  assert.equal(table.voiceJump, false, 'a pinned transcript offers no jump pill');
  assert.equal(table.pill, 'Stop', 'a live projection offers Stop, never Start');
  assert.equal(table.mute, true, 'Mute sits beside Stop while Live is on');
  assert.equal(table.stageBorder, 0, 'the stage draws no border');
  assert.equal(table.transcriptTopGap >= 0, true, 'the transcript never draws under the stage');
  assert.equal(table.composerButtons, 2, 'the composer shows exactly the attach plus and the send');
  await sample('2000x1250-dark-b-speaking', { width: 2000, height: 1250 });

  await page.evaluate(() => { for (const selector of ['.transcript', '#connected-entries']) { const el = document.querySelector(selector); if (el) el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 400); } });
  await page.waitForFunction(() => !document.querySelector('#transcript-jump').hidden && !document.querySelector('#chat-jump').hidden);
  const scrollUp = async () => {
    await page.evaluate(() => { for (const selector of ['.transcript', '#connected-entries']) { const el = document.querySelector(selector); if (el) el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 400); } });
    await page.waitForFunction(() => !document.querySelector('#transcript-jump').hidden && !document.querySelector('#chat-jump').hidden);
  };
  const repin = async () => {
    await page.locator('#transcript-jump').click();
    await page.locator('#chat-jump').click();
    await page.waitForFunction(() => document.querySelector('#transcript-jump').hidden && document.querySelector('#chat-jump').hidden);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await scrollUp();
  table = await sample('1440x900-dark-c-scrolled-up', { width: 1440, height: 900 });
  assert.equal(table.voiceJump, true, 'the transcript offers Jump to latest once the reader scrolls up');
  assert.equal(table.chatJump, true, 'the chat list offers Jump to latest once the reader scrolls up');
  await repin();
  await scrollUp();
  await sample('2000x1250-dark-c-scrolled-up', { width: 2000, height: 1250 });
  await repin();

  await page.setViewportSize({ width: 1440, height: 900 });
  // The draft frames are about the composer: scroll both lists back to the newest line first.
  await page.evaluate(() => { for (const selector of ['.transcript', '#connected-entries']) { const el = document.querySelector(selector); if (el) el.scrollTop = el.scrollHeight; } });
  await page.waitForFunction(() => document.querySelector('#transcript-jump').hidden && document.querySelector('#chat-jump').hidden);
  await page.locator('#connected-draft').fill('Synthetic draft line one\nSynthetic draft line two\nSynthetic draft line three\nSynthetic draft line four\nSynthetic draft line five\nSynthetic draft line six');
  await page.waitForFunction(() => document.querySelector('#connected-draft').getBoundingClientRect().height > 56);
  await sample('1440x900-dark-d-draft');
  await sample('2000x1250-dark-d-draft', { width: 2000, height: 1250 });
  await page.locator('#connected-draft').fill('');

  await page.setViewportSize({ width: 800, height: 900 });
  await page.locator('button[data-segment="voice"]').click();
  table = await sample('800x900-narrow-voice', { width: 800, height: 900 });
  assert.equal(table.stageShare >= 0.3 && table.stageShare <= 0.36, true, 'the narrow voice view keeps the top third stage');
} finally {
  await stop(); await browser.close();
  await rm(state, { recursive: true, force: true }).catch(() => {});
}

const columns = ['viewport', 'stageShare', 'orbDiameter', 'orbShare', 'sphereCore', 'sphereCoreShare', 'orbDrawingShare', 'orbBorderPixels', 'stageBorder', 'pill', 'mute', 'pillInsideStage', 'transcriptTopGap', 'voiceColumn', 'chatColumn', 'composerButtons', 'attachVisible', 'emptyBarsAboveComposer', 'consentInset', 'bubbleRight', 'composerBottom', 'labels', 'documentScrolls', 'listNumbers', 'voiceJump', 'chatJump'];

const markdown = [
  '# V3 DOM measurements (synthetic data, no images read)',
  '',
  `| shot | ${columns.join(' | ')} |`,
  `| --- | ${columns.map(() => '---').join(' | ')} |`,
  ...tables.map(row => { const flat = flatten(row); return `| ${flat.name} | ${columns.map(column => flat[column]).join(' | ')} |`; }),
  '',
  `Shots: ${shots.map(name => `${name}.png`).join(', ')}`,
  '',
].join('\n');
await writeFile(join(out, 'measurements.md'), markdown);
console.log(markdown);
console.log('V3_SHOTS', JSON.stringify(shots));
