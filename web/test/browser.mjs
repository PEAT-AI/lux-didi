import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startFixture} from './fixture.mjs';
const artifacts = process.env.DIDI_WEB_ARTIFACTS || join(import.meta.dirname, '../test-artifacts');
await mkdir(artifacts,{recursive:true});
console.log(`Browser artifacts: ${artifacts}`);
const fixture=await startFixture(); let browser;
const timings=[];

async function auditLayout(page) {
  return await page.evaluate(() => {
    const r = el => el.getBoundingClientRect();
    const q = sel => document.querySelector(sel);
    const rn = v => Math.round(v);
    const inset = (sel, lane) => { const el = q(sel); if (!el) return null; const b = r(el); return { left: rn(b.left - lane.left), right: rn(lane.right - b.right) }; };
    const size = sel => { const el = q(sel); if (!el) return null; const b = r(el); return { w: rn(b.width), h: rn(b.height), right: rn(b.right) }; };
    const gap = (a, b) => { const x = q(a), y = q(b); return x && y ? rn(r(y).left - r(x).right) : null; };
    const voice = r(q('#lane-voice')), chat = r(q('#panel-right'));
    const field = q('.composer-field'), send = q('#connected-send'), draft = q('#connected-draft');
    const entries = [...document.querySelectorAll('.live-turns > *')];
    const entry = q('.live-turns .entry');
    const summary = q('.live-tool-result > summary');
    const stage = q('#orb-stage'), orb = q('#orb-holder canvas'), transcript = q('.transcript'), pillVoice = q('#transcript-jump');
    const chatList = q('#connected-entries'), pillChat = q('#chat-jump');
    const allow = q('.allow-link');
    const cs = el => el ? getComputedStyle(el) : null;
    const vis = sel => { const el = q(sel); return !!el && el.getClientRects().length > 0; };
    return {
      voice: {
        visible: vis('#lane-voice'),
        laneHeight: rn(r(q('#lane-voice')).height),
        stageHeight: stage ? rn(r(stage).height) : null,
        stageTop: stage ? rn(r(stage).top) : null,
        orb: orb ? rn(r(orb).height) : null,
        orbCentre: stage && orb ? Math.abs(Math.round((r(orb).left + r(orb).width / 2) - (r(stage).left + r(stage).width / 2))) : null,
        column: rn(r(q('.transcript .live-turns')).width),
        userRight: (() => { const mine = q('.live-turns .entry.user'); return mine ? rn(r(q('.transcript .live-turns')).right - r(mine).right) : null; })(),
        controlRight: rn(voice.right - r(q('#new-conversation')).right),
        toggleGap: null,
        labels: document.querySelectorAll('.live-turns .entry strong, .live-turns .entry header').length,
        scrollDistance: transcript ? Math.max(0, rn(transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight)) : null,
        jumpVisible: pillVoice ? !pillVoice.hidden : null,
      },
      chat: {
        visible: vis('#panel-right'),
        column: chatList ? rn(r(chatList).width) : null,
        emptyInset: inset('.connected-empty', chat),
        composerInset: inset('#connected-send-form', chat),
        composerBottom: rn(chat.bottom - r(q('.composer-field')).bottom),
        send: size('#connected-send'),
        sendInside: field && send ? rn(r(field).right - r(send).right) : null,
        userRight: (() => { const mine = q('#connected-entries .entry.user'); return mine ? rn(r(chatList).right - r(mine).right) : null; })(),
        labels: document.querySelectorAll('#connected-entries .entry strong, #connected-entries .entry header').length,
        scrollDistance: chatList ? Math.max(0, rn(chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight)) : null,
        jumpVisible: pillChat ? !pillChat.hidden : null,
      },
      documentScrolls: r(document.documentElement).height > r(document.documentElement).clientHeight,
      chipPad: summary ? { padding: `${cs(summary).paddingTop} ${cs(summary).paddingRight}`, font: cs(summary).fontSize, display: cs(summary).display } : null,
      allowHeight: allow ? rn(r(allow).height) : null,
    };
  });
}

function assertAudit(a, label, failures) {
  const bad = m => failures.push(m);
  const inb = (v, lo, hi, what) => { if (!(v >= lo && v <= hi)) bad(`${label} ${what}: ${v} not in [${lo},${hi}]`); };
  if (a.voice.visible) {
    if (a.voice.stageHeight && a.voice.laneHeight) inb(a.voice.stageHeight / a.voice.laneHeight, 0.3, 0.36, 'orb stage share of the lane');
    if (a.voice.stageHeight && a.voice.orb) inb(a.voice.orb / a.voice.stageHeight, 0.52, 0.58, 'orb diameter of the stage');
    if (a.voice.orbCentre !== null) inb(a.voice.orbCentre, 0, 1, 'orb centred in the stage');
    if (a.voice.column > 760) bad(`${label} voice column wider than 760: ${a.voice.column}`);
    if (a.voice.userRight !== null) inb(a.voice.userRight, 0, 1, 'owner bubble at the column right edge');
    inb(a.voice.controlRight, 8, 12, 'stage controls right inset');
    if (a.voice.toggleGap !== null) inb(a.voice.toggleGap, 4, 8, 'new-session to collapse gap');
    if (a.voice.labels !== 0) bad(`${label} voice speaker labels: ${a.voice.labels}`);
    if (a.voice.scrollDistance !== null) inb(a.voice.scrollDistance, 0, 2, 'transcript pinned to the newest line');
  }
  if (a.chat.visible) {
    if (a.chat.column > 760) bad(`${label} chat column wider than 760: ${a.chat.column}`);
    if (a.chat.composerBottom !== null) inb(a.chat.composerBottom, 16, 26, 'composer above the lane bottom');
    if (a.chat.sendInside !== null) inb(a.chat.sendInside, 8, 16, 'send right inset in the field');
    if (a.chat.userRight !== null) inb(a.chat.userRight, 0, 1, 'chat owner bubble at the column right edge');
    if (a.chat.labels !== 0) bad(`${label} chat speaker labels: ${a.chat.labels}`);
    if (a.chat.scrollDistance !== null) inb(a.chat.scrollDistance, 0, 2, 'chat pinned to the newest line');
  }
  if (a.documentScrolls) bad(`${label} the document scrolls`);
  if (a.chipPad && a.chipPad.font !== '12px') bad(`${label} chip font: ${a.chipPad.font}`);
  if (a.chat.visible && a.allowHeight !== null) inb(a.allowHeight, 28, 28, 'allow control height');
  return a;
}

// U1 (#282): the two side panels are #panel-left (program menu) and #panel-right (chat), around the
// always-open voice view. A collapsed panel is display:none, so it renders nothing.
async function panelAudit(page) {
  return await page.evaluate(() => {
    const rect = el => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), left: Math.round(b.left), top: Math.round(b.top), h: Math.round(b.height) }; };
    const box = sel => { const el = document.querySelector(sel); if (!el) return null; const r = rect(el); const cs = getComputedStyle(el); return { state: el.dataset.state, rendered: r.w > 0 && cs.opacity !== '0' && cs.display !== 'none', ...r }; };
    const ctl = sel => { const el = document.querySelector(sel); return el ? { rendered: el.getClientRects().length > 0, visible: getComputedStyle(el).visibility !== 'hidden', expanded: el.getAttribute('aria-expanded') } : null; };
    const orb = document.querySelector('#orb-holder canvas') || document.querySelector('#didi-orb');
    const panel = document.querySelector('#panel-left');
    return {
      left: box('#panel-left'), right: box('#panel-right'), voice: box('#lane-voice'),
      orb: orb ? rect(orb) : null,
      controlLeft: ctl('#panel-toggle-left'), controlRight: ctl('#panel-toggle-right'),
      transitionMs: panel ? getComputedStyle(panel).transitionDuration : null,
    };
  });
}
const PANEL_SEED = '{"left":"open","right":"open","leftWidth":240,"rightWidth":360}';

async function step(name,fn){const start=performance.now(); await fn(); timings.push({name,seconds:Math.round((performance.now()-start)/10)/100}); console.log(`PASS ${name}`);}
try {
  browser=await chromium.launch({channel:'chromium',headless:true,args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}); const page=await context.newPage();page.setDefaultTimeout(8000);
  await page.addInitScript(() => {
    const describe = element => element ? {tag:element.tagName,id:element.id,text:element.tagName === 'BODY' ? '' : (element.textContent || '').trim().slice(0,80)} : null;
    const events = []; window.__keyboardProof = {events};
    const record = (event, extra = {}) => events.push({at:performance.now(),event,active:describe(document.activeElement),...extra});
    for (const kind of ['focusin','focusout','keydown','keyup','click','hashchange']) document.addEventListener(kind, event => record(kind,{key:event.key,target:describe(event.target),defaultPrevented:event.defaultPrevented}),true);
    let previousMain, previousSkip;
    new MutationObserver(() => {
      const main = document.getElementById('main'), skip = document.querySelector('.skip');
      if (main !== previousMain || skip !== previousSkip) record('root-replaced',{oldMainConnected:previousMain?.isConnected,oldSkipConnected:previousSkip?.isConnected});
      previousMain=main; previousSkip=skip;
    }).observe(document,{subtree:true,childList:true});
    new PerformanceObserver(list => { for (const item of list.getEntries()) if(item.name.includes('/api/')) record('response',{path:new URL(item.name).pathname,end:item.responseEnd}); }).observe({type:'resource',buffered:true});
  });
  const shellResponse=await page.goto(fixture.url);
  const csp=shellResponse.headers()['content-security-policy'];
  for(const directive of ["frame-src 'none'","frame-ancestors 'none'","connect-src 'self'"])assert(csp.includes(directive));
  assert.equal(shellResponse.headers()['permissions-policy'],'microphone=(), camera=(), geolocation=()');
  const renderer=await page.evaluate(()=>{const c=document.createElement('canvas');const gl=c.getContext('webgl');const ext=gl?.getExtension('WEBGL_debug_renderer_info');return ext?{renderer:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),vendor:gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)}:null;});
  await writeFile(`${artifacts}/renderer.json`,JSON.stringify({browser:browser.version(),...renderer},null,2));
  assert.match(renderer?.renderer||'',/Metal/,'Actual GPU renderer must be Metal, not software');
  await step('pairing, empty data, no model, synthetic mode',async()=>{
    await page.getByLabel('One-time pairing code').fill('synthetic-only'); await page.getByRole('button',{name:'Pair this browser',exact:true}).click();
    await page.locator('#didi-orb').waitFor();
    await page.getByText('Demo test mode',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>Object.keys(localStorage).length),0);
    assert.equal(await page.evaluate(()=>document.cookie),'');
    assert.equal(await page.locator('#lane-voice').count(),1);
    assert.equal(await page.locator('#panel-right').count(),1);
    assert.equal(await page.locator('.rail').count(),1);
    await page.locator('button[data-route="settings"]').click();
    await page.locator('#sheet').waitFor();
    assert.match(await page.locator('#sheet').innerText(),/No model connected/);
    await page.locator('#sheet-close').click();
    await page.locator('#sheet').waitFor({state:'detached'});
    assert.equal(await page.locator('#connection-state').getAttribute('aria-live'),'polite');
    assert.equal(await page.locator('.allow-link').first().evaluate(el => Math.round(el.getBoundingClientRect().height)), 28, 'the Allow control is a 28 px text button');
    await page.locator('#connected-draft').waitFor();
  });

  await step('classic Canvas orb is idle not listening and honors reduced motion',async()=>{
    const canvas=page.locator('#didi-orb');
    assert.equal(await canvas.getAttribute('data-state'),'CONNECTED');
    assert.equal(await canvas.getAttribute('data-posture'),'idle');
    await page.locator('.voice-state').first().waitFor();
    assert.equal(await page.locator('.voice-state').first().innerText(), 'Live is off', 'the one Live state source reads the machine');
    assert.equal(await page.getByRole('button',{name:/record|microphone/i}).count(),0);
    const hasPaint=await canvas.evaluate(el=>{const pixels=el.getContext('2d').getImageData(0,0,el.width,el.height).data;return pixels.some((v,i)=>i%4===3&&v>0);});assert(hasPaint);
    await page.waitForFunction(()=>document.querySelector('#didi-orb').didiFrameStats().frames>=12);
    const budget=await canvas.evaluate(el=>el.didiFrameStats());
    await writeFile(`${artifacts}/orb-frame-budget.json`,JSON.stringify({mode:'normal host idle animation, 24fps draw budget; no artificial load',...budget},null,2));
    assert(budget.meanDrawMs<1000/24,`Idle mean draw ${budget.meanDrawMs}ms exceeds 24fps budget`);
    await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('#didi-orb').dataset.motion==='still');
    const first=await canvas.evaluate(el=>el.toDataURL());
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await canvas.evaluate(el=>el.toDataURL()),first);
    await page.screenshot({path:`${artifacts}/desktop-orb-reduced-motion.png`,fullPage:true});
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.waitForFunction(()=>document.querySelector('#didi-orb').dataset.motion==='animated');
  });

  await step('one Live state source and the consent gate',async()=>{
    assert.equal((await page.locator('.voice-state').first().innerText()).trim(),'Live is off');
    assert.equal(await page.getByText('Not listening',{exact:true}).count(),0);
    await page.locator('#voice-start').click();
    const allow=page.locator('#consent-allow');
    if(await allow.count())await allow.click();
    await page.waitForFunction(()=>document.querySelector('.voice-state')?.textContent==='Listening',{timeout:8000});
    assert.equal(await page.locator('#live-pill').count(),1);
    await page.locator('#pill-stop').click();
    await page.waitForFunction(()=>document.querySelector('.voice-state')?.textContent==='Live is off',{timeout:8000});
    assert.equal(await page.locator('#live-pill').count(),0);
  });

  await step('live projection drives orb state, transcript and markdown sources',async()=>{
    fixture.setLive({state:'speaking',since:'2026-10-11T16:00:00Z',cursor:3,entries:[
      {seq:1,kind:'inputTranscription',text:'what is lux 123'},
      {seq:2,kind:'outputTranscription',text:'Here is the answer.'},
      {seq:3,kind:'toolResult',tool:{name:'search',status:'completed',markdown:'**Answer** see [source](https://example.org)',sources:[{title:'lux 123',url:'https://example.org'}]}}
    ]});
    await page.waitForFunction(()=>document.querySelector('#didi-orb').dataset.state==='SPEAKING',{timeout:12000});
    await page.waitForFunction(()=>document.querySelectorAll('#live-panel').length===1&&document.querySelectorAll('#live-panel .live-tool-result').length===1,{timeout:12000});
    assert.equal(await page.locator('#didi-orb').getAttribute('data-posture'),'speaking');
    const transition=await page.locator('#didi-orb').evaluate(el=>el.didiFrameStats().transition);
    assert.notEqual(transition.activity,transition.target,'the frame after the state change draws the smoothed activity, not the target (F5)');
    assert.equal((await page.locator('.orb-stage .voice-state').textContent()).trim(),'Speaking');
    assert.equal(await page.getByText('Not listening',{exact:true}).count(),0);
    assert.equal(await page.getByText('what is lux 123',{exact:true}).count(),1);
    assert.equal(await page.locator('#live-panel .live-result').count(),0,'no card inside the lane');
    assert.ok(await page.locator('#live-panel').getByText('Here is the answer.',{exact:false}).count() >= 1,'the spoken turn is on the lane background');
    const chip=page.locator('#live-panel .live-tool-result');
    assert.equal(await chip.count(),1);
    await chip.locator('summary').click();
    const sourceLink=chip.locator('.sources a[href="https://example.org"]');
    assert.equal(await sourceLink.count(),1);
    assert.equal(await sourceLink.getAttribute('rel'),'noopener noreferrer');
    fixture.setLive({state:'listening',since:'2026-10-11T16:00:01Z',cursor:4,entries:[
      {seq:1,kind:'inputTranscription',text:'what is lux 123'},
      {seq:2,kind:'outputTranscription',text:'Here is the answer.'}
    ]});
    await page.waitForFunction(()=>document.querySelector('#didi-orb').dataset.state==='LISTENING',{timeout:8000});
    assert.equal(await page.locator('#didi-orb').getAttribute('data-posture'),'listening');
    assert.equal((await page.locator('.orb-stage .voice-state').textContent()).trim(),'Listening');
    assert.equal(await page.getByText('Not listening',{exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:/record|microphone/i}).count(),0,'no push-to-talk control');
    assert.equal(await page.getByRole('button',{name:/mute/i}).count(),1,'exactly the intended Mute control');
    assert.equal(await page.locator('#voice-mute').count(),1,'the voice-lane Mute is the stage control (main.ts:124-127)');
    assert.equal(await page.locator('#pill-mute').count(),0,'the live-pill Mute (main.ts:213) is machine-live gated, so absent for a projection');
    await page.screenshot({path:`${artifacts}/desktop-live-naya.png`,fullPage:true});
    fixture.setLive({state:'idle',since:'2026-10-11T16:00:00Z',entries:[],cursor:0});
  });


  await step('U1 panels: two states, no residue, always-visible control, keyboard and drag', async () => {
    const panelFixture = await startFixture({ configured: true });
    const panelContext = await browser.newContext({ viewport: { width: 2000, height: 1250 } });
    const panelPage = await panelContext.newPage(); panelPage.setDefaultTimeout(8000);
    try {
      await panelPage.goto(panelFixture.url);
      await panelPage.locator('#pair-code').waitFor();
      await panelPage.getByLabel('One-time pairing code').fill('synthetic-only');
      await panelPage.getByRole('button',{name:'Pair this browser',exact:true}).click();
      await panelPage.locator('#panel-toggle-left').waitFor();
      const states = {};
      for (const width of [900, 2000]) {
        await panelPage.setViewportSize({ width, height: width === 900 ? 900 : 1250 });
        await panelPage.evaluate(() => localStorage.removeItem('didi-layout'));
        await panelPage.reload();
        await panelPage.locator('#panel-toggle-left').waitFor();
        const shot = name => panelPage.screenshot({ path: `${artifacts}/w${width}-${name}.png`, fullPage: true });
        const expect = async (label, left, right) => {
          const a = await panelAudit(panelPage);
          assert.equal(a.left.state, left, `${label}: left state`);
          assert.equal(a.right.state, right, `${label}: right state`);
          assert.equal(a.left.rendered, left === 'open', `${label}: left renders only when open`);
          assert.equal(a.right.rendered, right === 'open', `${label}: right renders only when open`);
          if (left === 'open') assert.ok(a.left.w >= 200, `${label}: left at its minimum width`);
          if (right === 'open') assert.ok(a.right.w >= 320, `${label}: right at its minimum width`);
          if (left === 'collapsed') assert.equal(a.left.w, 0, `${label}: a collapsed left panel is zero width, no residue`);
          if (right === 'collapsed') assert.equal(a.right.w, 0, `${label}: a collapsed right panel is zero width, no residue`);
          assert.ok(a.controlLeft && a.controlLeft.rendered && a.controlLeft.visible, `${label}: the left control is always visible`);
          assert.ok(a.controlRight && a.controlRight.rendered && a.controlRight.visible, `${label}: the right control is always visible`);
          assert.ok(Number.parseFloat(a.transitionMs) <= 0.2, `${label}: the panel animates in at most 200 ms (${a.transitionMs})`);
          return a;
        };
        const toggleLeft = () => panelPage.locator('#panel-toggle-left').click();
        const toggleRight = () => panelPage.locator('#panel-toggle-right').click();

        const base = await expect('default', 'collapsed', 'collapsed');
        await shot('default');
        const orbTop = base.orb ? base.orb.top : null;

        await toggleLeft(); await expect('left open', 'open', 'collapsed'); await shot('left-open');
        await toggleLeft();
        await toggleRight(); await expect('right open', 'collapsed', 'open'); await shot('right-open');
        await toggleLeft(); await expect('both open', 'open', 'open'); await shot('both-open');
        const both = await panelAudit(panelPage);
        if (orbTop !== null && both.orb) assert.ok(Math.abs(both.orb.top - orbTop) <= 1, `opening a panel must not jump the orb vertically (${orbTop} -> ${both.orb.top})`);
        assert.equal(await panelPage.locator('#panel-toggle-left').getAttribute('aria-expanded'), 'true');
        assert.equal(await panelPage.locator('#panel-toggle-right').getAttribute('aria-expanded'), 'true');

        await toggleLeft(); await expect('left collapsed again', 'collapsed', 'open'); await shot('left-collapsed-again');
        await toggleLeft();
        await toggleRight(); await expect('right collapsed again', 'open', 'collapsed'); await shot('right-collapsed-again');

        // collapse then expand in each direction: the same control restores the previous width
        await toggleLeft(); const leftOpen = await expect('left re-open', 'open', 'collapsed');
        await toggleLeft(); await expect('left collapse', 'collapsed', 'collapsed');
        await toggleLeft(); const leftAgain = await expect('left expand', 'open', 'collapsed'); await shot('left-collapse-expand');
        assert.equal(leftAgain.left.w, leftOpen.left.w, 'expanding restores the previous left width');
        await toggleLeft();
        await toggleRight(); const rightOpen = await expect('right re-open', 'collapsed', 'open');
        await toggleRight(); await expect('right collapse', 'collapsed', 'collapsed');
        await toggleRight(); const rightAgain = await expect('right expand', 'collapsed', 'open'); await shot('right-collapse-expand');
        assert.equal(rightAgain.right.w, rightOpen.right.w, 'expanding restores the previous right width');

        // keyboard: Cmd/Ctrl+1 toggles the left panel, Cmd/Ctrl+2 the right
        await panelPage.keyboard.press(process.platform === 'darwin' ? 'Meta+1' : 'Control+1');
        await expect('keyboard left', 'collapsed', 'open');
        await panelPage.keyboard.press(process.platform === 'darwin' ? 'Meta+2' : 'Control+2');
        await expect('keyboard right', 'collapsed', 'collapsed');

        // dragging the divider below the minimum collapses; dragging back out restores
        await toggleLeft();
        const grip = await panelPage.locator('[data-divider="left"]').boundingBox();
        if (grip) {
          await panelPage.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
          await panelPage.mouse.down();
          await panelPage.mouse.move(grip.x - 150, grip.y + grip.height / 2, { steps: 6 });
          await panelPage.mouse.up();
        }
        await expect('drag collapse', 'collapsed', 'collapsed');
        await panelPage.mouse.move((await panelPage.locator('[data-divider="left"]').boundingBox()).x + 4, grip.y + grip.height / 2);
        await panelPage.mouse.down();
        await panelPage.mouse.move((await panelPage.locator('[data-divider="left"]').boundingBox()).x + 40 + 220, grip.y + grip.height / 2, { steps: 6 });
        await panelPage.mouse.up();
        await expect('drag restore', 'open', 'collapsed');

        await panelPage.emulateMedia({ reducedMotion: 'reduce' });
        const reduced = await panelAudit(panelPage);
        assert.equal(reduced.transitionMs, '0s', 'prefers-reduced-motion disables the panel animation');
        await panelPage.emulateMedia({ reducedMotion: null });
        states[`${width}`] = { default: base.left.state + '/' + base.right.state };
      }
      await writeFile(join(artifacts, 'u1-panels.json'), JSON.stringify(states, null, 2));
    } finally { await panelContext.close(); await panelFixture.close(); }
  });

  await step('V2-R4 layout audit A-G', async () => {
    const auditFixture = await startFixture({ configured: true });
    const auditContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const auditPage = await auditContext.newPage(); auditPage.setDefaultTimeout(8000);
    const results = {}; const failures = [];
    try {
      await auditPage.goto(auditFixture.url);
      await auditPage.locator('#pair-code').waitFor();
      await auditPage.getByLabel('One-time pairing code').fill('synthetic-only');
      await auditPage.getByRole('button',{name:'Pair this browser',exact:true}).click();
      await auditPage.locator('#connected-draft').waitFor({ state: 'attached' });
      auditFixture.setLive({ state: 'speaking', since: '2026-10-11T16:00:00Z', cursor: 6, entries: [
        { seq: 1, kind: 'inputTranscription', text: 'What should I do next?' },
        { seq: 2, kind: 'turnComplete' },
        { seq: 3, kind: 'outputTranscription', text: 'Ship the three-lane UI.' },
        { seq: 4, kind: 'turnComplete' },
        { seq: 5, kind: 'outputTranscription', text: 'Then run the layout audit.' },
        { seq: 6, kind: 'toolResult', tool: { name: 'lux-knowledge', status: 'completed', markdown: '**Found** three notes', sources: [{ title: 'note', url: 'https://example.org' }] } }
      ] });
      const run = async (viewport, theme, layoutSeed) => {
        await auditPage.setViewportSize(viewport);
        await auditPage.evaluate(([m, seed]) => { localStorage.setItem('didi-theme', m); localStorage.setItem('didi-layout', seed); }, [theme, layoutSeed]);
        await auditPage.reload();
        await auditPage.locator('.app-shell').waitFor();
        await auditPage.waitForFunction(() => document.querySelector('#connected-send') !== null);
        const a = await auditLayout(auditPage);
        assertAudit(a, `${viewport.width}x${viewport.height} ${theme}`, failures);
        results[`${viewport.width}x${viewport.height}-${theme}`] = a;
      };
      await run({ width: 1440, height: 900 }, 'dark', PANEL_SEED);
      await run({ width: 1440, height: 900 }, 'light', PANEL_SEED);
      await run({ width: 800, height: 900 }, 'dark', '{"left":"collapsed","right":"open","leftWidth":240,"rightWidth":360}');
      await run({ width: 800, height: 900 }, 'light', '{"left":"collapsed","right":"open","leftWidth":240,"rightWidth":360}');
      await writeFile(join(artifacts, 'v2r4-audit.json'), JSON.stringify(results, null, 2));
    } finally { await auditContext.close(); await auditFixture.close(); }
    console.log('V2R4_AUDIT', JSON.stringify(results));
    console.log('V2R4_FAILURES', JSON.stringify(failures));
    assert.equal(failures.length, 0, failures.join(' | '));
  });

  await step('settings unpair revokes the cookie and returns to pairing',async()=>{
    await page.locator('button[data-route="settings"]').click();
    await page.locator('#sheet').waitFor();
    await page.getByRole('button',{name:'Unpair this browser',exact:true}).click();
    await page.getByLabel('One-time pairing code').waitFor();
    assert.equal((await context.cookies()).length,0);
  });

  await writeFile(`${artifacts}/browser-results.json`,JSON.stringify({mode:'isolated synthetic HTTP/SQLite fixture, not production integration',timings,requests:fixture.requests.map(r=>({method:r.method,path:r.path}))},null,2));
  console.log('PASS browser integration; durations:',JSON.stringify(timings));
} finally {await browser?.close(); await fixture.close();}