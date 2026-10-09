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
  const shellResponse=await page.goto(fixture.url);
  const csp=shellResponse.headers()['content-security-policy'];
  for(const directive of ["frame-src 'none'","frame-ancestors 'none'","connect-src 'self'"])assert(csp.includes(directive));
  assert.equal(shellResponse.headers()['permissions-policy'],'microphone=(), camera=(), geolocation=()');
  const renderer=await page.evaluate(()=>{const c=document.createElement('canvas');const gl=c.getContext('webgl');const ext=gl?.getExtension('WEBGL_debug_renderer_info');return ext?{renderer:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),vendor:gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)}:null;});
  await writeFile(`${artifacts}/renderer.json`,JSON.stringify({browser:browser.version(),...renderer},null,2));
  assert.match(renderer?.renderer||'',/Metal/,'Actual GPU renderer must be Metal, not software');
  await step('pairing, empty data, no model, synthetic mode',async()=>{
    await page.getByLabel('One-time pairing code').fill('synthetic-only'); await page.getByRole('button',{name:'Pair this browser',exact:true}).click();
    await page.getByText('No conversations yet.',{exact:true}).waitFor();
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
    await page.getByText('Not listening',{exact:true}).waitFor();
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
  await step('failed send preserves draft; capture uses real HTTP',async()=>{
    await page.getByLabel('Your message').fill('Remember the synthetic blue notebook'); fixture.failNextEntry();
    await page.getByRole('button',{name:'Save message',exact:true}).click(); await page.getByRole('alert').filter({hasText:'Could not save'}).waitFor();assert.equal(await page.getByRole('alert').getAttribute('aria-live'),'assertive');
    assert.equal(await page.getByLabel('Your message').inputValue(),'Remember the synthetic blue notebook');
    await page.getByRole('button',{name:'Save message',exact:true}).click(); await page.locator('.entry').filter({hasText:'Remember the synthetic blue notebook'}).waitFor();
    assert.equal(await page.getByLabel('Your message').inputValue(),'');
    assert.equal(await page.getByRole('status').filter({hasText:'Message saved.'}).getAttribute('aria-live'),'polite');
    const entry=fixture.requests.find(r=>r.path.endsWith('/entries')&&r.method==='POST'); assert.equal(entry.body.role,'user');
  });
  await step('stop waiting preserves draft without claiming saved',async()=>{
    const release=fixture.holdNextEntry();
    try{await page.getByLabel('Your message').fill('Cancellation synthetic note');await page.getByRole('button',{name:'Save message',exact:true}).click();
      await page.getByRole('button',{name:'Stop waiting',exact:true}).click();
      await page.getByRole('alert').filter({hasText:'may still have been saved'}).waitFor();
      assert.equal(await page.getByLabel('Your message').inputValue(),'Cancellation synthetic note');
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
    await page.getByLabel('Your message').fill('Offline draft stays here'); await context.setOffline(true); await page.getByText('Offline',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Save message',exact:true}).isDisabled(),true);
    assert.equal(await page.getByLabel('Your message').inputValue(),'Offline draft stays here');
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
    await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Unpair this browser',exact:true}).click();
    await page.getByLabel('One-time pairing code').waitFor();assert.equal((await context.cookies()).length,0);
  });
  for(const request of fixture.requests.filter(r=>r.method!=='GET'&&!r.path.endsWith('/auth/pair'))){assert(request.headers['idempotency-key']);assert.equal(request.headers['x-didi-csrf'],'synthetic-csrf');assert.equal(request.headers['x-didi-authority-epoch'],'synthetic-authority-1');}
  await writeFile(`${artifacts}/browser-results.json`,JSON.stringify({mode:'isolated synthetic HTTP/SQLite fixture, not production integration',timings,requests:fixture.requests.map(r=>({method:r.method,path:r.path}))},null,2));
  console.log('PASS browser integration; durations:',JSON.stringify(timings));
} finally {await browser?.close(); await fixture.close();}
