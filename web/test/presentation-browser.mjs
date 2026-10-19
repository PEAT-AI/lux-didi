import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startFixture} from './fixture.mjs';
const artifacts=process.env.DIDI_WEB_ARTIFACTS||join(import.meta.dirname,'../test-artifacts/presentation');
await mkdir(artifacts,{recursive:true});
const fixture=await startFixture();let browser;
try{
  browser=await chromium.launch({headless:true,args:(process.env.LUX_BROWSER_GPU_ARGS||'--use-angle=metal --enable-gpu').split(' ').filter(Boolean)});
  const context=await browser.newContext({viewport:{width:980,height:760}});
  await context.route('**/*',route=>new URL(route.request().url()).origin===fixture.url?route.continue():route.abort());
  await context.addInitScript(()=>{
    window.fixtureMessages=[];
    window.webkit={messageHandlers:{didi:{postMessage(message){window.fixtureMessages.push(message);}}}};
    window.didiNativeSurfaceVisible=false;
  });
  const paired=await context.request.post(`${fixture.url}/api/v1/auth/pair`,{data:{pairingCode:'synthetic-only'}});
  assert(paired.ok());
  const results=[];
  for(const mode of ['full','mini']){
    const page=await context.newPage();
    if(process.env.LUX_BROWSER_SLOT_TOKEN){const {assertGpu}=await import('/Users/rob/GitHub/lux-harness/skills/pi-control/scripts/pi_browser_launch.mjs');await assertGpu(page);}
    await page.goto(`${fixture.url}/${mode==='mini'?'?view=mini':''}`);
    await page.locator('#didi-orb').waitFor();
    if(mode==='full'){await page.locator('#connection-state',{hasText:'Connected'}).waitFor();await page.waitForFunction(()=>!document.querySelector('.loading'));}
    await page.waitForTimeout(300);
    await page.waitForFunction(()=>typeof window.didiPrepareSurface==='function');
    const proof=await page.evaluate(()=>window.didiPrepareSurface(1));
    assert.deepEqual(proof,{generation:1,painted:true});
    const refreshed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/status');
    await page.evaluate(()=>{window.priorOrb=document.getElementById('didi-orb');window.didiSetSurfaceVisible(true,1);});
    await refreshed;
    await page.waitForTimeout(250);
    const retained=await page.evaluate(()=>window.priorOrb===document.getElementById('didi-orb'));
    assert(retained,`${mode} refresh retains its canvas`);
    await page.evaluate(()=>window.didiSetSurfaceVisible(false,2));
    const stopped=await page.evaluate(()=>document.getElementById('didi-orb').didiFrameStats().paints);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(()=>document.getElementById('didi-orb').didiFrameStats().paints),stopped,`${mode} hidden has no paint loop`);
    await page.evaluate(()=>window.didiSetSurfaceVisible(true,3));
    await page.waitForFunction(previous=>document.getElementById('didi-orb').didiFrameStats().paints>previous,stopped);
    assert.deepEqual(await page.evaluate(()=>window.didiPrepareSurface(2)),{generation:2,painted:false});
    if(mode==='full'){
      await page.locator('#mini-mode').click();
      if(await page.locator('#panel-toggle-left').getAttribute('aria-expanded')!=='true')await page.locator('#panel-toggle-left').click();
      await page.locator('[data-route="settings"]').click();
      await page.locator('#mini-mode-settings').click();
      const commands=await page.evaluate(()=>window.fixtureMessages.filter(m=>['mini','start','stop','mute','unmute'].includes(m.type)));
      assert.deepEqual(commands,[{type:'mini'},{type:'mini'}]);
      await page.screenshot({path:join(artifacts,'full-settings-mini.png')});
    }
    if(mode==='mini'){
      fixture.setLive({state:'speaking',since:'synthetic-mini-current',entries:[{seq:1,kind:'outputTranscription',text:'Synthetic output'}],cursor:1});
      await page.evaluate(()=>window.didiSetSurfaceVisible(true,4));
      await page.locator('.mini-stage[data-mini-state="speaking"]').waitFor();
    }
    results.push({mode,prepared:proof,retainedCanvas:retained,hiddenPaints:stopped,resumed:true,staleRejected:true});
    await page.close();
  }
  await writeFile(join(artifacts,'result.json'),JSON.stringify(results,null,2));
  console.log('PRESENTATION-BROWSER PASS '+JSON.stringify(results));
}finally{await browser?.close();await fixture.close();}
