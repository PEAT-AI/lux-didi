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
    try { await page.locator('#didi-orb').waitFor({ timeout: 8000 }); }
    catch { console.log('ORB_TIMEOUT', JSON.stringify(await page.evaluate(() => ({ pairing: !!document.querySelector('#pair-code'), shell: !!document.querySelector('.app-shell'), lane: !!document.querySelector('#lane-voice'), empty: !!document.querySelector('.voice-empty'), orb: !!document.querySelector('#didi-orb'), state: document.querySelector('.voice-state')?.textContent, bodyLen: document.body.innerHTML.length })))); throw new Error('orb missing'); }
    await page.getByText('Demo test mode',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>Object.keys(localStorage).length),0);
    assert.equal(await page.evaluate(()=>document.cookie),'');
    assert.match(await page.locator('body').innerText(),/No model connected/);
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
  await step('live projection drives orb state, transcript and markdown sources',async()=>{
    fixture.setLive({state:'speaking',since:'2026-10-11T16:00:00Z',cursor:3,entries:[
      {seq:1,kind:'inputTranscription',text:'what is lux 123'},
      {seq:2,kind:'outputTranscription',text:'Here is the answer.'},
      {seq:3,kind:'toolResult',tool:{name:'search',status:'completed',markdown:'**Answer** see [source](https://example.org)',sources:[{title:'lux 123',url:'https://example.org'}]}}
    ]});
    await page.waitForFunction(()=>document.querySelector('#didi-orb').dataset.state==='SPEAKING',{timeout:12000});
    assert.equal(await page.locator('#didi-orb').getAttribute('data-posture'),'speaking');
    assert.equal((await page.locator('#live-panel .live-state').textContent()).trim(),'Speaking');
    assert.equal(await page.getByText('Not listening',{exact:true}).count(),0);
    assert.equal(await page.getByText('what is lux 123',{exact:true}).count(),1);
    assert.equal(await page.locator('.live-latest-turn').getByText('Here is the answer.',{exact:true}).count(),1);
    const link=page.locator('#live-panel .live-result p a[href="https://example.org"]');
    assert.equal(await link.count(),1);
    assert.equal(await link.getAttribute('rel'),'noopener noreferrer');
    assert.equal(await link.getAttribute('target'),'_blank');
    const sourceLink=page.locator('#live-panel .live-result .sources a[href="https://example.org"]');
    assert.equal(await sourceLink.count(),1);
    assert.equal(await sourceLink.getAttribute('rel'),'noopener noreferrer');
    assert.match(await page.locator('#live-panel .live-result strong').first().textContent(),/Answer/);
    fixture.setLive({state:'listening',since:'2026-10-11T16:00:01Z',cursor:4,entries:[]});
    await page.waitForFunction(()=>document.querySelector('#didi-orb').dataset.state==='LISTENING',{timeout:8000});
    assert.equal(await page.locator('#didi-orb').getAttribute('data-posture'),'listening');
    assert.equal((await page.locator('#live-panel .live-state').textContent()).trim(),'Listening');
    assert.equal(await page.getByText('Not listening',{exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:/record|microphone|mute/i}).count(),0);
    await page.screenshot({path:`${artifacts}/desktop-live-naya.png`,fullPage:true});
    fixture.setLive({state:'idle',since:'2026-10-11T16:00:00Z',entries:[],cursor:0});
  });
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
  await step('memory Search button never wraps its label and review shots land',async()=>{
    const review=process.env.DIDI_WEB_REVIEW||artifacts;
    await mkdir(review,{recursive:true});
    const measureSearch=()=>page.evaluate(()=>{
      const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Search');
      if(!btn) throw new Error('Search button not found on the Memory tab');
      const range=document.createRange(); range.selectNodeContents(btn);
      const lines=range.getClientRects().length;
      const style=getComputedStyle(btn);
      const lineHeight=style.lineHeight==='normal'?parseFloat(style.fontSize)*1.5:parseFloat(style.lineHeight);
      const chrome=parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth);
      const minHeight=parseFloat(style.minHeight)||0;
      return {lines,height:btn.getBoundingClientRect().height,single:Math.max(lineHeight+chrome,minHeight)};
    });
    await page.getByRole('button',{name:'Memory',exact:true}).click();
    await page.getByLabel('Filter memories').fill('');
    await page.getByRole('button',{name:'Search',exact:true}).waitFor();
    const desktop=await measureSearch();
    assert.equal(desktop.lines,1,`Search label wraps at 1440px (${desktop.lines} lines)`);
    assert.ok(desktop.height<=desktop.single+1,`Search button ${desktop.height}px exceeds one line ${desktop.single}px at 1440px`);
    await page.screenshot({path:`${review}/desktop-memory.png`,fullPage:true});
    await page.setViewportSize({width:375,height:900});
    await page.getByRole('button',{name:'Search',exact:true}).waitFor();
    const phone=await measureSearch();
    assert.equal(phone.lines,1,`Search label wraps at 375px (${phone.lines} lines)`);
    assert.ok(phone.height<=phone.single+1,`Search button ${phone.height}px exceeds one line ${phone.single}px at 375px`);
    await page.screenshot({path:`${review}/375-memory.png`,fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('button',{name:'Conversation',exact:true}).click();
  });
  await step('rendered memory deletion confirms, preserves pending/failed entries and reloads server payload',async()=>{
    const text='Synthetic browser deletion canary';
    await page.getByLabel('Local note · not sent to a model').fill(text);
    await page.getByRole('button',{name:'Save message',exact:true}).click();
    await page.locator('.entry').filter({hasText:text}).waitFor();
    // Read it back through recall and the conversation GET, not client capture state.
    await page.getByRole('button',{name:'Memory',exact:true}).click();
    await page.getByLabel('Search your memory').fill(text);
    await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.getByRole('button',{name:'Open conversation source',exact:true}).click();
    const row=page.locator('.entry').filter({hasText:text});
    await row.waitFor();
    const id=await row.getByRole('button',{name:'Delete memory',exact:true}).getAttribute('data-delete-memory');
    assert(id);
    const write=fixture.requests.findLast(r=>r.method==='POST'&&r.path.endsWith('/entries')&&r.body.text===text);
    assert(write);
    const sessionPath=write.path.replace(/\/entries$/,'');
    const envelope=await (await page.request.get(`${fixture.url}${sessionPath}`)).json();
    const original=envelope.data.entries.find(entry=>entry.id===id);
    assert.equal(original.text,text);
    const retained={...original,id:'00000000-0000-4000-8000-000000000050',text:'New retained entry from the server reload'};
    let deleted=false,releaseDelete,receivedDelete,releaseReload,receivedReload;
    let arrival=new Promise(resolve=>{receivedDelete=resolve;});
    const reloadArrival=new Promise(resolve=>{receivedReload=resolve;});
    const reloadRelease=new Promise(resolve=>{releaseReload=resolve;});
    await page.route(`${fixture.url}/api/v1/entries/${id}`,async route=>{
      const response=new Promise(resolve=>{releaseDelete=resolve;});
      receivedDelete(route.request());
      await route.fulfill(await response);
    });
    await page.route(`${fixture.url}${sessionPath}`,async route=>{
      if(!deleted){await route.continue();return;}
      receivedReload();
      await reloadRelease;
      await route.fulfill({json:{...envelope,data:{...envelope.data,entries:[...envelope.data.entries.filter(entry=>entry.id!==id),retained]}}});
    });
    await page.route('**/api/v1/recall?*',async route=>{
      const response=await route.fetch();const payload=await response.json();
      if(deleted){payload.data.hits=payload.data.hits.filter(hit=>hit.entryId!==id);payload.data.totalMatches=payload.data.hits.length;}
      await route.fulfill({response,json:payload});
    });
    const confirmDelete=async()=>{
      const requestPromise=page.waitForRequest(request=>request.url()===`${fixture.url}/api/v1/entries/${id}`&&request.method()==='DELETE');
      const dialogPromise=page.waitForEvent('dialog');
      const click=row.getByRole('button',{name:'Delete memory',exact:true}).click();
      const dialog=await dialogPromise;
      assert.equal(dialog.type(),'confirm');assert.match(dialog.message(),/Delete this memory permanently/);
      await dialog.accept();await click;await requestPromise;
      const request=await arrival;assert.equal(request.method(),'DELETE');assert.deepEqual(request.postDataJSON(),{});
    };
    await confirmDelete();
    assert.equal(await row.isVisible(),true,'pending DELETE must retain the entry');
    releaseDelete({status:503,json:{error:{code:'WRITE_FAILED',message:'Could not delete this memory.'}}});
    await page.getByRole('alert').filter({hasText:'Could not delete this memory.'}).waitFor();
    assert.equal(await row.isVisible(),true,'failed DELETE must retain the entry');
    arrival=new Promise(resolve=>{receivedDelete=resolve;});
    await confirmDelete();
    assert.equal(await row.isVisible(),true,'retry must not optimistically filter the entry');
    deleted=true;
    const reloadRequest=page.waitForRequest(request=>request.url()===`${fixture.url}${sessionPath}`&&request.method()==='GET');
    releaseDelete({json:{...envelope,data:{entryId:id,deletedAt:'2026-01-01T00:00:00.000Z',actor:'browser-fixture',reasonCode:'owner_request'}}});
    await reloadRequest;await reloadArrival;
    assert.equal(await row.isVisible(),true,'DELETE success alone must not replace the server list');
    releaseReload();
    await row.waitFor({state:'detached'});
    await page.locator('.entry').filter({hasText:retained.text}).waitFor();
    assert.equal(await page.getByRole('alert').filter({hasText:'Could not delete this memory.'}).count(),0);
  });
  await step('offline cannot claim saved; preserves draft; no offline writer',async()=>{
    await page.getByLabel('Local note · not sent to a model').fill('Offline draft stays here'); await context.setOffline(true); await page.getByText('Offline',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Save message',exact:true}).isDisabled(),true);
    assert.equal(await page.getByLabel('Local note · not sent to a model').inputValue(),'Offline draft stays here');
    await context.setOffline(false); await page.getByText('Connected',{exact:true}).waitFor();
  });
  await step('private cache isolation and keyboard access',async()=>{
    await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
    let releaseBootstrap; const lateBootstrap = new Promise(resolve=>releaseBootstrap=resolve);
    await page.route('**/api/v1/chat/status',async route=>{const response=await route.fetch();await lateBootstrap;await route.fulfill({response});});
    await page.reload();
    await page.getByText('Connected',{exact:true}).waitFor();
    const paths=await page.evaluate(async()=>{const keys=await caches.keys(); const urls=[];for(const k of keys){for(const r of await (await caches.open(k)).keys())urls.push(new URL(r.url).pathname);}return urls;});
    assert(paths.length>0); assert(!paths.some(p=>p.startsWith('/api/'))); assert(!paths.some(p=>p.includes('pair')));
    await page.keyboard.press('Tab');
    await writeFile(`${artifacts}/keyboard-after-tab.json`,JSON.stringify(await page.evaluate(()=>window.__keyboardProof),null,2));
    await page.evaluate(()=>window.__keyboardProof.releaseAt=performance.now());
    releaseBootstrap();
    await page.waitForFunction(()=>window.__keyboardProof.events.some(event=>event.event==='root-replaced' && event.at >= window.__keyboardProof.releaseAt));
    await writeFile(`${artifacts}/keyboard-after-bootstrap.json`,JSON.stringify(await page.evaluate(()=>window.__keyboardProof),null,2));
    await page.getByRole('link',{name:'Skip to content'}).waitFor();
    assert.equal(await page.getByRole('link',{name:'Skip to content'}).evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('Enter');
    await writeFile(`${artifacts}/keyboard-after-enter.json`,JSON.stringify(await page.evaluate(()=>window.__keyboardProof),null,2));
    assert.equal(await page.locator('#main').evaluate(el=>el===document.activeElement),true);
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
    await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Unpair this browser',exact:true}).click();
    await page.getByLabel('One-time pairing code').waitFor();assert.equal((await context.cookies()).length,0);
  });
  for(const request of fixture.requests.filter(r=>r.method!=='GET'&&!r.path.endsWith('/auth/pair'))){assert(request.headers['idempotency-key']);assert.equal(request.headers['x-didi-csrf'],'synthetic-csrf');assert.equal(request.headers['x-didi-authority-epoch'],'synthetic-authority-1');}
  await writeFile(`${artifacts}/browser-results.json`,JSON.stringify({mode:'isolated synthetic HTTP/SQLite fixture, not production integration',timings,requests:fixture.requests.map(r=>({method:r.method,path:r.path}))},null,2));
  console.log('PASS browser integration; durations:',JSON.stringify(timings));
} finally {await browser?.close(); await fixture.close();}
