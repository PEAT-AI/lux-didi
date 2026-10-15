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
    await page.waitForFunction(()=>document.querySelectorAll('#live-panel').length===1&&document.querySelectorAll('.live-latest-turn').length===1,{timeout:12000});
    assert.equal(await page.locator('#didi-orb').getAttribute('data-posture'),'speaking');
    assert.equal((await page.locator('#live-panel .live-state').textContent()).trim(),'Speaking');
    assert.equal(await page.getByText('Not listening',{exact:true}).count(),0);
    assert.equal(await page.getByText('what is lux 123',{exact:true}).count(),1);
    const card=page.locator('#live-panel .live-result');
    assert.equal(await card.count(),1);
    assert.match(await card.innerText(),/Here is the answer\./);
    assert.equal(await card.locator('a[href="https://example.org"]').count(),2,'the inline link and the source chip');
    const sourceLink=page.locator('#live-panel .live-result .sources a[href="https://example.org"]');
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