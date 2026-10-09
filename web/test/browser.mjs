import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startFixture} from './fixture.mjs';
const artifacts = process.env.DIDI_WEB_ARTIFACTS || '/Users/rob/.lux/reports/lux-didi-overnight-1009/web';
await mkdir(artifacts,{recursive:true});
const fixture=await startFixture(); let browser;
const timings=[];
async function step(name,fn){const start=performance.now(); await fn(); timings.push({name,seconds:Math.round((performance.now()-start)/10)/100}); console.log(`PASS ${name}`);}
try {
  browser=await chromium.launch({channel:'chromium',headless:true,args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}); const page=await context.newPage();
  await page.goto(fixture.url);
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
  });
  await step('failed send preserves draft; capture uses real HTTP',async()=>{
    await page.getByLabel('Your message').fill('Remember the synthetic blue notebook'); fixture.failNextEntry();
    await page.getByRole('button',{name:'Save message',exact:true}).click(); await page.getByRole('alert').filter({hasText:'Could not save'}).waitFor();
    assert.equal(await page.getByLabel('Your message').inputValue(),'Remember the synthetic blue notebook');
    await page.getByRole('button',{name:'Save message',exact:true}).click(); await page.locator('.entry').filter({hasText:'Remember the synthetic blue notebook'}).waitFor();
    assert.equal(await page.getByLabel('Your message').inputValue(),'');
    const entry=fixture.requests.find(r=>r.path.endsWith('/entries')&&r.method==='POST'); assert.equal(entry.body.role,'user');
  });
  await step('create, due correction, conflict recovery, complete and reopen',async()=>{
    await page.getByRole('button',{name:'Today',exact:true}).click();
    await page.getByLabel('Commitment title').fill('Review synthetic notes'); await page.getByRole('button',{name:'Add commitment',exact:true}).click();
    await page.getByRole('button',{name:'Edit Review synthetic notes'}).click();
    await page.getByLabel('Due date and time').fill('2030-04-10T14:30'); await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await page.getByText('Due date updated.',{exact:true}).waitFor();
    const correction=fixture.requests.find(r=>r.method==='PATCH'); assert.equal(correction.body.expectedRevision,1); assert.match(correction.body.dueAt,/Z$/);
    fixture.conflictNextWrite(); await page.getByRole('button',{name:'Complete Review synthetic notes'}).click();
    await page.getByRole('alert').filter({hasText:'another device'}).waitFor(); await page.getByText('Changed on another device',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Complete Changed on another device'}).click(); await page.getByText('Completed',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Reopen Changed on another device'}).click(); await page.getByRole('button',{name:'Complete Changed on another device'}).waitFor();
  });
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
    await page.keyboard.press('Tab'); assert(await page.evaluate(()=>document.activeElement!==document.body));
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
  for(const request of fixture.requests.filter(r=>r.method!=='GET'&&!r.path.endsWith('/pair'))){assert(request.headers['idempotency-key']);assert.equal(request.headers['x-didi-authority-epoch'],'synthetic-authority-1');}
  await writeFile(`${artifacts}/browser-results.json`,JSON.stringify({mode:'isolated synthetic HTTP/SQLite fixture, not production integration',timings,requests:fixture.requests.map(r=>({method:r.method,path:r.path}))},null,2));
  console.log('PASS browser integration; durations:',JSON.stringify(timings));
} finally {await browser?.close(); await fixture.close();}
