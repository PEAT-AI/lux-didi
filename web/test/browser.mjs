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
    const voice = r(q('#lane-voice')), chat = r(q('#lane-chat'));
    const field = q('.composer-field'), send = q('#connected-send'), draft = q('#connected-draft');
    const entries = [...document.querySelectorAll('.live-turns > *')];
    const entry = q('.live-turns .entry');
    const summary = q('.live-tool-result > summary');
    const label = q('.live-turns .entry strong');
    const naya = q('.live-turns .entry.naya');
    const allow = q('.allow-link');
    const cs = el => el ? getComputedStyle(el) : null;
    const vis = sel => { const el = q(sel); return !!el && el.getClientRects().length > 0; };
    return {
      voice: {
        visible: vis('#lane-voice'),
        nayaInset: inset('.live-turns .entry.naya', voice),
        userInset: inset('.live-turns .entry.user', voice),
        turnInset: inset('.live-turns .entry', voice),
        chipInset: inset('.live-tool-result', voice),
        emptyInset: inset('.voice-empty', voice),
        hideRight: rn(voice.right - r(q('#lane-voice .lane-toggle')).right),
        headerOrb: size('#lane-voice .voice-orb canvas'),
        startNewGap: gap('#voice-start', '#new-conversation'),
        newHideGap: gap('#new-conversation', '#lane-voice .lane-toggle'),
      },
      chat: {
        visible: vis('#lane-chat'),
        emptyInset: inset('.connected-empty', chat),
        composerInset: inset('#connected-send-form', chat),
        composerBottom: rn(chat.bottom - r(q('#connected-send-form')).bottom),
        send: size('#connected-send'),
        sendInside: field && send ? rn(r(field).right - r(send).right) : null,
        sendCentre: field && send ? Math.abs(Math.round((r(send).top + r(send).height / 2) - (r(field).top + r(field).height / 2))) : null,
        clip: size('#connected-notes-summary'),
        clipFont: cs(q('#connected-notes-summary'))?.width,
      },
      chipPad: summary ? { padding: `${cs(summary).paddingTop} ${cs(summary).paddingRight}`, font: cs(summary).fontSize, display: cs(summary).display } : null,
      labelFont: label ? cs(label).fontSize : null,
      nayaMax: naya ? cs(naya).maxWidth : null,
      turnGap: entries.length > 1 ? rn(r(entries[1]).top - r(entries[0]).bottom) : null,
      labelGap: entry && label ? rn(r(entry.querySelector('.markdown, p')).top - r(label).bottom) : null,
      allowHeight: allow ? rn(r(allow).height) : null,
      draftMax: draft ? cs(draft).maxWidth : null,
    };
  });
}

function assertAudit(a, label, failures) {
  const bad = m => failures.push(m);
  const inb = (v, lo, hi, what) => { if (!(v >= lo && v <= hi)) bad(`${label} ${what}: ${v} not in [${lo},${hi}]`); };
  if (a.voice.visible) {
    if (a.voice.nayaInset) inb(a.voice.nayaInset.left, 24, 40, 'naya turn left inset');
    if (a.voice.userInset) inb(a.voice.userInset.right, 24, 40, 'user turn right inset');
    if (a.voice.chipInset) inb(a.voice.chipInset.left, 24, 40, 'chip left inset');
    if (a.voice.emptyInset) inb(a.voice.emptyInset.left, 24, 40, 'empty left inset');
    inb(a.voice.hideRight, 22, 26, 'Hide right inset');
  }
  if (a.voice.visible && a.voice.headerOrb) { inb(a.voice.headerOrb.w, 40, 56, 'header orb width'); inb(a.voice.headerOrb.h, 40, 56, 'header orb height'); }
  if (a.voice.visible && a.voice.startNewGap !== null) inb(a.voice.startNewGap, 8, 12, 'Start to New gap');
  if (a.voice.visible && a.voice.newHideGap !== null) inb(a.voice.newHideGap, 8, 12, 'New to Hide gap');
  if (!a.chat.visible) return a;
  if (a.chat.emptyInset) { inb(a.chat.emptyInset.left, 24, 400, 'chat empty left inset'); inb(a.chat.emptyInset.right, 24, 400, 'chat empty right inset'); }
  if (a.chat.composerInset) { inb(a.chat.composerInset.left, 24, 40, 'composer left inset'); inb(a.chat.composerInset.right, 24, 40, 'composer right inset'); }
  if (a.chat.composerBottom !== null) inb(a.chat.composerBottom, 14, 18, 'composer bottom gap');
  if (a.chat.send) { inb(a.chat.send.w, 32, 32, 'send width'); inb(a.chat.send.h, 32, 32, 'send height'); }
  if (a.chat.sendInside !== null) inb(a.chat.sendInside, 8, 16, 'send right inset in field');
  if (a.chat.sendCentre !== null) inb(a.chat.sendCentre, 0, 2, 'send vertical centring');
  if (a.chat.clip) inb(a.chat.clip.w, 28, 28, 'paperclip width');
  if (a.chipPad && a.chipPad.font !== '12px') bad(`${label} chip font: ${a.chipPad.font}`);
  if (a.chipPad && a.chipPad.padding !== '4px 10px') bad(`${label} chip padding: ${a.chipPad.padding}`);
  if (a.labelFont !== '12px') bad(`${label} turn label font: ${a.labelFont}`);
  if (a.nayaMax !== '640px') bad(`${label} naya max width: ${a.nayaMax}`);
  if (a.voice.visible && a.turnGap !== null) inb(a.turnGap, 16, 16, 'turn gap');
  if (a.voice.visible && a.labelGap !== null) inb(a.labelGap, 3, 5, 'label to text gap');
  return a;
}

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
    assert.equal(await page.locator('#lane-chat').count(),1);
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
    assert.equal((await page.locator('#live-panel .live-state').textContent()).trim(),'Speaking');
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
    assert.equal((await page.locator('#live-panel .live-state').textContent()).trim(),'Listening');
    assert.equal(await page.getByText('Not listening',{exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:/record|microphone|mute/i}).count(),0);
    await page.screenshot({path:`${artifacts}/desktop-live-naya.png`,fullPage:true});
    fixture.setLive({state:'idle',since:'2026-10-11T16:00:00Z',entries:[],cursor:0});
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
      const run = async (viewport, theme, segment) => {
        await auditPage.setViewportSize(viewport);
        await auditPage.evaluate(m => localStorage.setItem('didi-theme', m), theme);
        await auditPage.reload();
        await auditPage.locator('.app-shell').waitFor();
        if (segment) await auditPage.locator(`button[data-segment="${segment}"]`).click();
        await auditPage.waitForFunction(() => document.querySelector('#connected-send') !== null);
        const a = await auditLayout(auditPage);
        assertAudit(a, `${viewport.width}x${viewport.height} ${theme}${segment ? ' ' + segment : ''}`, failures);
        results[`${viewport.width}x${viewport.height}-${theme}${segment ? '-' + segment : ''}`] = a;
      };
      await run({ width: 1440, height: 900 }, 'dark', null);
      await run({ width: 1440, height: 900 }, 'light', null);
      await run({ width: 800, height: 900 }, 'dark', 'chat');
      await run({ width: 800, height: 900 }, 'light', 'voice');
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