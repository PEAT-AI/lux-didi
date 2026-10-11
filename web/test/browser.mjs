import {createHash} from 'node:crypto';
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
async function step(name,fn,slowReason){
  const start=performance.now();
  if(slowReason)console.log(`SLOW ${name}: ${slowReason}`);
  await fn();
  timings.push({name,seconds:Math.round((performance.now()-start)/10)/100,...(slowReason?{classification:'SLOW',slowReason}:{})});
  console.log(`PASS ${name}`);
}
try {
  browser=await chromium.launch({channel:'chromium',headless:true,args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}); const page=await context.newPage();page.setDefaultTimeout(8000);
  const shellResponse=await page.goto(fixture.url);
  const csp=shellResponse.headers()['content-security-policy'];
  for(const directive of ["frame-src 'none'","frame-ancestors 'none'","connect-src 'self'"])assert(csp.includes(directive));
  assert.equal(shellResponse.headers()['permissions-policy'],'microphone=(), camera=(), geolocation=()');
  const renderer=await page.evaluate(()=>{const c=document.createElement('canvas');const gl=c.getContext('webgl');const ext=gl?.getExtension('WEBGL_debug_renderer_info');return ext?{renderer:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),vendor:gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)}:null;});
  await writeFile(`${artifacts}/renderer.json`,JSON.stringify({browser:browser.version(),...renderer},null,2));
  assert.match(renderer?.renderer||'',/Metal/,'Actual GPU renderer must be Metal, not software');
  await step('pairing, empty data, no model, synthetic mode',async()=>{
    const connectedStatus=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/chat/status'&&response.request().method()==='GET');
    await page.getByLabel('One-time pairing code').fill('synthetic-only'); await page.getByRole('button',{name:'Pair this browser',exact:true}).click();
    await page.getByText('No conversations yet.',{exact:true}).waitFor();
    const statusResponse=await connectedStatus;assert.equal(statusResponse.status(),200);
    assert.deepEqual((await statusResponse.json()).data,{status:'unconfigured'});
    await page.locator('#connected-route').getByText('Model unconfigured. Local notes, Today and recall still work.',{exact:true}).waitFor();
    await page.getByText('Demo test mode',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>Object.keys(localStorage).length),0);
    assert.equal(await page.evaluate(()=>document.cookie),'');
    assert.match(await page.locator('body').innerText(),/No model connected/);
    assert.equal(await page.locator('#connection-state').getAttribute('aria-live'),'polite');
    assert(!/Cannot read properties of undefined/.test(await page.locator('body').innerText()),'synthetic unconfigured status must satisfy real ownerProfile DTO; no raw displayName error');
  });
  await step('classic Canvas orb is idle not listening and honors reduced motion',async()=>{
    const canvas=page.locator('#didi-orb');
    assert.equal(await canvas.getAttribute('data-state'),'CONNECTED');
    assert.equal(await canvas.getAttribute('data-posture'),'idle');
    await page.getByText('Not listening',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:/record|microphone/i}).count(),0);
    const hasPaint=await canvas.evaluate(el=>{const pixels=el.getContext('2d').getImageData(0,0,el.width,el.height).data;return pixels.some((v,i)=>i%4===3&&v>0);});assert(hasPaint);
    await page.waitForFunction(()=>document.querySelector('#didi-orb').didiFrameStats().frames>=12);
    const budget=await canvas.evaluate(el=>el.didiFrameStats());
    await writeFile(`${artifacts}/orb-frame-budget.json`,JSON.stringify({mode:'normal host connected classic, source high-tier cadence; no artificial load',...budget},null,2));
    assert.equal(budget.failedDraws,0);
    assert(budget.meanDrawMs<1000/budget.targetFps,`Idle mean draw ${budget.meanDrawMs}ms exceeds source ${budget.targetFps}fps interval`);
    await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('#didi-orb').dataset.motion==='still');
    const first=await canvas.evaluate(el=>el.toDataURL());
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await canvas.evaluate(el=>el.toDataURL()),first);
    await page.screenshot({path:`${artifacts}/desktop-orb-reduced-motion.png`,fullPage:true});
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.waitForFunction(()=>document.querySelector('#didi-orb').dataset.motion==='animated');
  });
  await step('unrelated UI render retains the live canvas and temporal renderer',async()=>{
    const original=await page.locator('#didi-orb').elementHandle();
    const before=await original.evaluate(el=>el.didiFrameStats());
    await page.getByRole('button',{name:'Refresh connection',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#didi-orb')?.dataset.state==='CONNECTED');
    assert(await original.evaluate(el=>el.isConnected&&el===document.querySelector('#didi-orb')),'same-view connection refresh must retain the exact live canvas');
    const after=await original.evaluate(el=>el.didiFrameStats());
    assert(after.frameTime>=before.frameTime,'ordinary render must not restart temporal state');
    try {
      await context.setOffline(true);
      await page.waitForFunction(()=>document.querySelector('#didi-orb')?.dataset.state==='DISCONNECTED');
      assert(await original.evaluate(c=>c.isConnected&&c===document.querySelector('#didi-orb')&&!c.didiFrameStats().destroyed),'same-view network failure must preserve the mounted disconnected orb');
      assert.equal(await page.locator('#didi-orb').getAttribute('data-posture'),'quiet');
      assert.equal(await page.locator('#didi-orb').getAttribute('data-disabled'),'true');
      await page.screenshot({path:join(artifacts,'orb-disconnected-mounted.png'),fullPage:true});
    }finally {await context.setOffline(false);}
    await page.waitForFunction(()=>document.querySelector('#didi-orb')?.dataset.state==='CONNECTED');
    assert(await original.evaluate(c=>c===document.querySelector('#didi-orb')),'same-view reconnect retains temporal owner');
    await original.dispose();
  });
  await step('pinned original animated reference, real-noise self-variation and DPR/layout geometry',async()=>{
    const measurements=[];
    for(const width of [1440,390])for(const dpr of [1,2]){
      const proofContext=await browser.newContext({viewport:{width,height:1000},deviceScaleFactor:dpr,
        ...(width===1440&&dpr===1?{recordVideo:{dir:join(artifacts,'orb-animation'),size:{width:1440,height:1000}}}:{})});
      const record={viewportWidth:width,dpr,status:'running',traceAttempts:0,failedTraceAttempts:0,samples:[]};measurements.push(record);
      try {
      const proofPage=await proofContext.newPage();
      await proofPage.goto(fixture.url);
      // Each isolated context must obtain its own synthetic-fixture pairing cookie.
      await proofPage.getByLabel('One-time pairing code').fill('synthetic-only');
      await proofPage.getByRole('button',{name:'Pair this browser',exact:true}).click();
      await proofPage.locator('#didi-orb').waitFor();
      const layout=await proofPage.locator('#didi-orb').evaluate(c=>({width:c.width,height:c.height,
        rect:{width:c.getBoundingClientRect().width,height:c.getBoundingClientRect().height},stats:c.didiFrameStats(),
        filter:getComputedStyle(c).filter,clip:getComputedStyle(c.parentElement).overflow,
        viewportWidth:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
      assert.equal(layout.width,(width<=767?400:600)*dpr);assert.equal(layout.height,layout.width);
      assert(Math.abs(layout.rect.width-layout.rect.height)<1,'full square logical field must display without aspect distortion');
      assert(layout.rect.width>0&&layout.rect.width<=width,'visible canvas framing');
      assert(layout.scrollWidth<=width,'orb geometry must not introduce horizontal clipping/scroll');
      const assetURLs=await proofPage.evaluate(()=>[...Array.from(document.scripts,s=>s.src),...Array.from(document.querySelectorAll('link[rel=stylesheet]'),l=>l.href)].filter(Boolean));
      const appAssets=[];
      for(const url of assetURLs){const response=await proofPage.request.get(url);assert(response.ok());const bytes=await response.body();appAssets.push({path:new URL(url).pathname,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}
      await proofPage.screenshot({path:join(artifacts,`orb-layout-${width}-dpr${dpr}.png`),fullPage:true});
      await proofPage.goto(`${fixture.url}/orb-proof/`);
      await proofPage.waitForFunction(()=>globalThis.orbProof?.measure().steps>=25);
      const metadata=await (await proofPage.request.get(`${fixture.url}/orb-proof/metadata.json`)).json();
      const gpu=await proofPage.evaluate(()=>{const gl=document.createElement('canvas').getContext('webgl');const e=gl?.getExtension('WEBGL_debug_renderer_info');return gl&&e?{vendor:gl.getParameter(e.UNMASKED_VENDOR_WEBGL),renderer:gl.getParameter(e.UNMASKED_RENDERER_WEBGL)}:null;});
      assert(gpu&&!/swiftshader|llvmpipe|software/i.test(gpu.renderer),'hardware GPU identity required');
      await proofPage.screenshot({path:join(artifacts,`orb-animated-side-by-side-${width}-dpr${dpr}.png`),fullPage:true});
      await proofPage.evaluate(()=>globalThis.orbProof.pause());
      const samples=record.samples;
      for(const state of ['IDLE','DISCONNECTED','LISTENING','SPEAKING','PROCESSING','CONNECTING','CONNECTED','RECONNECTING','ERROR']){
        for(const audible of [false,true])for(let frame=0;frame<4;frame++){
          record.traceAttempts++;
          const sample=await proofPage.evaluate(({state,audible})=>{
            globalThis.orbProof.set({state,audible,microphoneLevel:state==='LISTENING'?.45:0,audio:audible?{level:.6,low:.7,mid:.4,high:.2,flux:.9}:{level:0,low:0,mid:0,high:0,flux:0}});
            return globalThis.orbProof.step(1/30);
          },{state,audible});
          assert(sample.shapes.every(s=>s.paintedPixels>0),'all original/port frames must paint meaningful pixels');
          assert.deepEqual(sample.frames[0],sample.frames[1]);assert.deepEqual(sample.frames[0],sample.frames[2]);
          assert(Number.isFinite(sample.portVsReference.meanAbsoluteRGBA));
          samples.push({traceFrame:frame,...sample});
        }
      }
      await proofPage.screenshot({path:join(artifacts,`orb-measured-side-by-side-${width}-dpr${dpr}.png`),fullPage:true});
      await proofPage.evaluate(()=>{globalThis.connectingProof=globalThis.orbProof.connecting();});
      const connectingAlignment=await proofPage.evaluate(()=>({frames:globalThis.orbProof.measure().frames,actual:document.querySelector('#port').didiFrameStats()}));
      assert.deepEqual(connectingAlignment.frames,Array.from({length:3},()=>({time:0,ambientTime:0,hue:195})),'CONNECTING comparison must use matching fresh source state/hue/time histories');
      assert.equal(connectingAlignment.actual.frameTime,0);assert.equal(connectingAlignment.actual.ambientTime,0);
      assert(connectingAlignment.actual.frames>0,'frozen actual Orb must have successfully painted its constructor frame');
      assert.equal(connectingAlignment.actual.failedDraws,0,'frozen actual Orb must not certify a caught draw failure');
      const composition=async()=>proofPage.evaluate(async()=>{
        for(const canvas of [document.querySelector('#reference-a'),document.querySelector('#port')]){
          const target=canvas.id==='port'?canvas:canvas.parentElement;
          for(const animation of target.getAnimations()){animation.pause();animation.currentTime=750;}
        }
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return ['reference-a','port'].map(id=>{const c=document.getElementById(id),wrapper=c.parentElement,container=wrapper.parentElement;
          return {canvasOpacity:Number(getComputedStyle(c).opacity),wrapperOpacity:Number(getComputedStyle(wrapper).opacity),containerOpacity:Number(getComputedStyle(container).opacity),effectiveOpacity:Number(getComputedStyle(c).opacity)*Number(getComputedStyle(wrapper).opacity)*Number(getComputedStyle(container).opacity)};});
      });
      const animatedConnecting=await composition();
      assert(Math.abs(animatedConnecting[0].effectiveOpacity-.45)<.0001,'original disabled parent x processing midpoint');
      assert(Math.abs(animatedConnecting[1].effectiveOpacity-animatedConnecting[0].effectiveOpacity)<.0001,'actual shipped Orb disabled/pulse composition');
      const connectingCenters=await proofPage.evaluate(()=>['reference-a','reference-b','port'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.y+r.height/2;}));
      assert(Math.max(...connectingCenters)-Math.min(...connectingCenters)<1,'comparison titles must not offset canvas centers');
      await proofPage.screenshot({path:join(artifacts,`orb-connecting-composition-${width}-dpr${dpr}.png`),fullPage:true});
      await proofPage.emulateMedia({reducedMotion:'reduce'});
      const staticConnecting=await composition();
      assert.equal(staticConnecting[0].effectiveOpacity,.5);assert.equal(staticConnecting[1].effectiveOpacity,.5);
      await proofPage.evaluate(()=>globalThis.connectingProof.dispose());
      Object.assign(record,{status:'pass',layout,gpu,metadata,appAssets,sampleCount:samples.length,animatedConnecting,staticConnecting,connectingAlignment,connectingCenters,
        judgment:'Measured only. Noise differences reported against original self-variation; no invented tolerance, pixel-identity or visual-equivalence claim. Original chat host/entrance is not this isolated adapter.'});
      }catch(error){record.status='failed';record.failedTraceAttempts=record.traceAttempts-record.samples.length;record.error=String(error.message);throw error;}
      finally {await proofContext.close();await writeFile(join(artifacts,'orb-reference-measurements.json'),JSON.stringify(measurements,null,2));}
    }
  },'Four DPR/layout contexts, 288 real-noise reference samples, source-cadence animation warmup and rendered captures; required fidelity integration proof, not a unit clock simulation.');
  await step('failed local save preserves draft; capture never dispatches a model',async()=>{
    const requestStart=fixture.requests.length;
    await page.getByLabel('Local note · not sent to a model').fill('Remember the synthetic blue notebook'); fixture.failNextEntry();
    await page.getByRole('button',{name:'Save message',exact:true}).click(); await page.getByRole('alert').filter({hasText:'Could not save'}).waitFor();assert.equal(await page.getByRole('alert').filter({hasText:'Could not save'}).getAttribute('aria-live'),'assertive');
    assert.equal(await page.getByLabel('Local note · not sent to a model').inputValue(),'Remember the synthetic blue notebook');
    await page.getByRole('button',{name:'Save message',exact:true}).click(); await page.locator('.entry').filter({hasText:'Remember the synthetic blue notebook'}).waitFor();
    assert.equal(await page.getByLabel('Local note · not sent to a model').inputValue(),'');
    assert.equal(await page.getByRole('status').filter({hasText:'Message saved.'}).getAttribute('aria-live'),'polite');
    const writes=fixture.requests.slice(requestStart).filter(r=>r.method==='POST');
    const entry=writes.find(r=>r.path.endsWith('/entries')); assert.equal(entry.body.role,'user');
    assert.equal(entry.body.text,'Remember the synthetic blue notebook');
    assert(writes.every(r=>r.path==='/api/v1/sessions'||/^\/api\/v1\/sessions\/[^/]+\/entries$/.test(r.path)),
      'Local Save must only create a session or user entry, never dispatch a model');
  });
  await step('stop waiting preserves draft without claiming saved',async()=>{
    const release=fixture.holdNextEntry();
    try{await page.getByLabel('Local note · not sent to a model').fill('Cancellation synthetic note');await page.getByRole('button',{name:'Save message',exact:true}).click();
      await page.getByRole('button',{name:'Stop waiting',exact:true}).click();
      await page.getByRole('alert').filter({hasText:'may still have been saved'}).waitFor();
      assert.equal(await page.getByLabel('Local note · not sent to a model').inputValue(),'Cancellation synthetic note');
    }finally{release();}
  });
  await page.screenshot({path:`${artifacts}/desktop-conversation.png`,fullPage:true});
  await step('explicit loading state is visible during HTTP read',async()=>{
    const release=fixture.holdNextPlan();
    try{await page.getByRole('button',{name:'Today',exact:true}).click();await page.getByRole('status').filter({hasText:'Loading your records'}).waitFor();}
    finally{release();}
    await page.getByRole('status').filter({hasText:'Loading your records'}).waitFor({state:'hidden'});
  });
  await step('create, due correction, conflict recovery, complete and reopen',async()=>{
    await page.getByRole('button',{name:'Today',exact:true}).click();
    await page.getByLabel('Commitment title').fill('Review synthetic notes'); await page.getByRole('button',{name:'Add commitment',exact:true}).click();
    await page.getByRole('button',{name:'Edit Review synthetic notes'}).click();
    assert.equal(await page.getByLabel('Title',{exact:true}).evaluate(el=>el===document.activeElement),true);
    await page.getByLabel('Due date and time').fill('2025-04-10T14:30'); await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await page.getByText('Due date updated.',{exact:true}).waitFor();
    const correction=fixture.requests.find(r=>r.method==='PATCH'); assert.equal(correction.body.expectedRevision,1); assert.match(correction.body.dueAt,/Z$/);
    fixture.conflictNextWrite(); await page.getByRole('button',{name:'Complete Review synthetic notes'}).click();
    await page.getByRole('alert').filter({hasText:'another device'}).waitFor(); await page.getByText('Changed on another device',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Complete Changed on another device'}).click(); await page.getByText('Completed',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Reopen Changed on another device'}).click(); await page.getByRole('button',{name:'Complete Changed on another device'}).waitFor();
    await page.getByRole('button',{name:'Cancel commitment',exact:true}).click();await page.getByText('Cancelled',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Complete Changed on another device'}).count(),0);
    await page.getByRole('button',{name:'Reopen Changed on another device'}).click();await page.getByRole('button',{name:'Complete Changed on another device'}).waitFor();
  });
  await page.screenshot({path:`${artifacts}/desktop-today.png`,fullPage:true});
  await step('source-linked recall, missing source remains missing',async()=>{
    await page.getByRole('button',{name:'Memory',exact:true}).click(); await page.getByLabel('Search your memory').fill('notebook'); await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.getByText('Synthetic notebook',{exact:true}).waitFor(); await page.getByText('Source unavailable',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Open conversation source'}).click(); await page.locator('.entry').filter({hasText:'Remember the synthetic blue notebook'}).waitFor();
  });
  await step('offline cannot claim saved; preserves draft; no offline writer',async()=>{
    await page.getByLabel('Local note · not sent to a model').fill('Offline draft stays here'); await context.setOffline(true); await page.getByText('Offline',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Save message',exact:true}).isDisabled(),true);
    assert.equal(await page.getByLabel('Local note · not sent to a model').inputValue(),'Offline draft stays here');
    await context.setOffline(false); await page.getByText('Connected',{exact:true}).waitFor();
  });
  await step('private cache isolation and keyboard access',async()=>{
    await page.evaluate(async()=>{await navigator.serviceWorker.ready;}); await page.reload();
    await page.getByText('Connected',{exact:true}).waitFor();
    const paths=await page.evaluate(async()=>{const keys=await caches.keys(); const urls=[];for(const k of keys){for(const r of await (await caches.open(k)).keys())urls.push(new URL(r.url).pathname);}return urls;});
    assert(paths.length>0); assert(!paths.some(p=>p.startsWith('/api/'))); assert(!paths.some(p=>p.includes('pair')));
    await page.keyboard.press('Tab');
    await page.getByRole('link',{name:'Skip to content'}).waitFor();
    assert.equal(await page.getByRole('link',{name:'Skip to content'}).evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('Enter'); assert.equal(await page.locator('#main').evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.getByRole('navigation',{name:'Main navigation'}).count(),1);
    assert.equal(await page.locator('label[for=message]').count(),1);
    await page.getByRole('button',{name:'Settings',exact:true}).click(); await page.getByText('Mac companion',{exact:true}).waitFor();
    await page.screenshot({path:`${artifacts}/desktop-settings.png`,fullPage:true});
  });
  await step('375px phone and 768px tablet have no overflow',async()=>{
    for(const width of [375,768]){await page.setViewportSize({width,height:900});
      for(const tab of ['Conversation','Today','Memory','Settings']){await page.getByRole('button',{name:tab,exact:true}).click();
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${tab} overflow at ${width}`);
        await page.screenshot({path:`${artifacts}/${width}-${tab.toLowerCase()}.png`,fullPage:true});}
    }
  });
  await step('locally authored install shell and logout revoke cookie',async()=>{
    const manifest=await (await page.request.get(fixture.url+'/manifest.webmanifest')).json();assert.equal(manifest.display,'standalone');assert.equal(manifest.icons[0].src,'/icon.svg');
    assert.match(await (await page.request.get(fixture.url+'/icon.svg')).text(),/<svg/);
    await page.getByRole('button',{name:'Conversation',exact:true}).click();
    await page.locator('#didi-orb').waitFor();
    const retained=await page.locator('#didi-orb').elementHandle();
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    assert(await retained.evaluate(c=>!c.isConnected&&c.didiFrameStats().destroyed),'real tab unmount must dispose, not retain a detached renderer');
    const stopped=await retained.evaluate(c=>c.didiFrameStats().frames);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await retained.evaluate(c=>c.didiFrameStats().frames),stopped,'unmounted canvas must stop painting');
    await retained.dispose();
    await page.getByRole('button',{name:'Unpair this browser',exact:true}).click();
    assert.equal(await page.locator('#didi-orb').count(),0,'pairing view is an actual orb unmount, not a disconnected orb mount');
    await page.getByLabel('One-time pairing code').waitFor();assert.equal((await context.cookies()).length,0);
  });
  for(const request of fixture.requests.filter(r=>r.method!=='GET'&&!r.path.endsWith('/auth/pair'))){assert(request.headers['idempotency-key']);assert.equal(request.headers['x-didi-csrf'],'synthetic-csrf');assert.equal(request.headers['x-didi-authority-epoch'],'synthetic-authority-1');}
  await writeFile(`${artifacts}/browser-results.json`,JSON.stringify({mode:'isolated synthetic HTTP/SQLite fixture, not production integration',timings,requests:fixture.requests.map(r=>({method:r.method,path:r.path}))},null,2));
  console.log('PASS browser integration; durations:',JSON.stringify(timings));
} finally {await browser?.close(); await fixture.close();}
