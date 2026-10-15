// U1 screenshots: the voice lane mid-lookup, then after the lookup is done. Dark theme, 1440x900.
// Reuses the accepted connected fixture (server/test/connected-process.js) and intercepts the
// Live projection the lane already polls, so the real orb and lane render around a real line.
// Run through: lux-browser-slot run --priority worker --want 1 --wait 900 -- node web/test/u1-shots.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { chromium } = createRequire(new URL('../package.json', import.meta.url))('playwright');
const root = resolve(import.meta.dirname, '../..');
const out = '/Users/rob/.lux/reports/lux-didi-stability-1015/u1-shots';
await mkdir(out, { recursive: true });
const state = await mkdtemp(join(tmpdir(), 'u1-shots-'));
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

// The lane polls this projection; the phase flips between the two shots.
let progress = { researchId: 'u1-lookup', phase: 'round', sourcesDone: ['calendar'], sourcesPending: ['mail', 'knowledge'], elapsedMs: 1200 };
const liveBody = () => ({
  state: 'listening', since: new Date().toISOString(), cursor: 2, entries: [
    { seq: 1, kind: 'inputTranscription', text: 'What is on my calendar and in my mail today?' },
    { seq: 2, kind: 'researchProgress', progress },
  ],
});

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
  const allow = page.locator('#connected-consent');
  if (await allow.count()) await allow.click();
  const setTheme = async mode => { await page.evaluate(m => localStorage.setItem('didi-theme', m), mode); await page.reload(); await ready(); };
  const shot = async name => { await page.screenshot({ path: join(out, `${name}.png`) }); shots.push(name); };

  await page.route('**/api/v1/live/current*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data = liveBody();
    await route.fulfill({ response, json: body });
  });

  await setTheme('dark');
  const line = page.locator('.lookup-slot .lookup-line');
  await line.waitFor({ timeout: 15000 });
  const mid = await line.textContent();
  await shot('1440x900-dark-lookup');

  progress = { researchId: 'u1-lookup', phase: 'done', sourcesDone: ['calendar', 'mail', 'knowledge'], sourcesPending: [], elapsedMs: 7400 };
  await line.waitFor({ state: 'detached', timeout: 15000 });
  await shot('1440x900-dark-done');

  await writeFile(join(out, 'shots.json'), JSON.stringify({ shots, mid }, null, 2));
  console.log('SHOTS', shots.join(', '));
  console.log('MIDTEXT', JSON.stringify(mid));
} finally {
  await stop();
  await browser.close();
}
