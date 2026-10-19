import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startFixture} from './fixture.mjs';
import {OpenAiLiveVoiceAdapter} from '../../server/dist/adapters/live-voice/openai.js';
import {FakeSocket,FakeClock,options} from '../../server/dist/test/openai-live-voice-fixture.js';
import {Store} from '../../server/dist/runtime/store.js';
import {hostMigrations} from '../../server/dist/host/runtime.js';
import {createLiveSessionOwner,validateLiveProfile} from '../../server/dist/live/index.js';
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
const dir=mkdtempSync(join(tmpdir(),'didi-terminal-pagination-')),store=new Store(dir,hostMigrations),clock=new FakeClock();let socket=new FakeSocket();
const adapter=new OpenAiLiveVoiceAdapter(options({clock,limits:{handshakeMs:1000,idleMs:600000,sessionMs:600000,closeMs:50},socketFactory:()=>{queueMicrotask(()=>{socket.readyState=1;socket.emit('open');});return socket;}}));
const owner=createLiveSessionOwner({store,voice:adapter,profile:validateLiveProfile({provider:'openai',liveModelId:'gpt-live-1',voice:'marin',keyReference:'openai-primary',route:{enabled:true,provider:'openai',modelId:'gpt-live-1',dataClasses:['ordinary']},prompt:{text:'Synthetic pagination diagnostics',dataClass:'ordinary'}}),timeZone:'UTC'});
let browser,fixture,attachment,collect,page;const cursors=[];
try{
 const context={clientId:'synthetic',auditId:'synthetic-audit',authorityEpoch:store.authorityEpoch};
 const created=owner.create({inputClass:'ordinary',idempotencyKey:'pagination'},context);attachment=owner.attach({liveSessionId:created.liveSessionId},context);collect=(async()=>{for await(const _ of attachment.output){}})();
 await tick();socket.deliver({type:'session.started',session:{id:'synthetic'}});await attachment.ready;
 const fragments=Array.from({length:220},(_,i)=>`word${String(i).padStart(3,'0')} `);
 for(const delta of fragments){socket.deliver({type:'session.output_transcript.delta',delta});await tick();}
 socket.deliver({type:'session.input_transcript.delta',delta:'Quiet owner correction.'});await tick();
 await attachment.close();await collect;attachment=undefined;
 const rows=store.transaction(tx=>tx.all("SELECT text FROM live_journal WHERE kind='outputTranscription' ORDER BY journal_id"));assert.equal(rows.map(row=>row.text??'').join(''),fragments.join(''));
 fixture=await startFixture({liveSource:cursor=>{cursors.push(Number(cursor??0));return owner.current(Number(cursor??0));}});
 browser=await chromium.launch({headless:true,args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});page=await browser.newPage({viewport:{width:1100,height:760}});
 if(process.env.LUX_BROWSER_SLOT_TOKEN){const {assertGpu}=await import(new URL('../../../lux-harness/skills/pi-control/scripts/pi_browser_launch.mjs',import.meta.url));await assertGpu(page);}
 await page.goto(fixture.url);await page.locator('#pair-code').fill('synthetic-only');await page.locator('#pair-form').evaluate(form=>form.requestSubmit());
 await page.locator('#past-session-list').waitFor({state:'attached'});
 await page.locator('#past-sessions > summary').click();await page.locator('.feed-session > summary').click();
 await page.waitForFunction(()=>document.querySelector('#past-session-list')?.textContent.includes('word219'),{},{timeout:15000});
 const output=await page.locator('#past-session-list article.assistant').evaluateAll(articles=>articles.map(article=>(article.querySelector('.feed-turn-detail .markdown')??article.querySelector(':scope > .markdown')).textContent).join(''));
 assert.deepEqual(output.match(/word\d{3}/g),fragments.map(text=>text.trim()),'all220 canonical model tokens render once in original order, not only the tail');
 assert.equal(await page.locator('#past-session-list article.user .bubble').textContent(),'Quiet owner correction.');
 assert.equal(await page.locator('#past-sessions').getAttribute('open'),'');assert.equal(await page.locator('.feed-session').getAttribute('open'),'');
 const firstCounts=store.transaction(tx=>({journal:Number(tx.get('SELECT count(*) AS n FROM live_journal').n),transcript:Number(tx.get("SELECT count(*) AS n FROM live_journal WHERE kind IN ('inputTranscription','outputTranscription') AND length(text)>0").n)}));
 assert.deepEqual(firstCounts,{journal:223,transcript:221});
 socket=new FakeSocket();const second=owner.create({inputClass:'ordinary',idempotencyKey:'full-duplex'},context);attachment=owner.attach({liveSessionId:second.liveSessionId},context);collect=(async()=>{for await(const _ of attachment.output){}})();await tick();socket.deliver({type:'session.started',session:{id:'synthetic-two'}});await attachment.ready;
 for(const [kind,text]of [['output','Model overlap one.'],['input','Owner overlap one.'],['output','Model overlap two.'],['input','Owner overlap two.']]){socket.deliver({type:`session.${kind}_transcript.delta`,delta:text});await tick();}
 await page.waitForFunction(()=>document.querySelector('.live-turns')?.textContent.includes('Owner overlap two.'),{},{timeout:6000});
 const rendered=await page.locator('.live-turns article.entry').evaluateAll(articles=>articles.map(article=>({role:article.classList.contains('user')?'owner':'model',text:(article.querySelector('.bubble')??article.querySelector('.feed-turn-detail .markdown')??article.querySelector(':scope > .markdown')).textContent.trim()})));
 assert.deepEqual(rendered,[{role:'model',text:'Model overlap one.'},{role:'owner',text:'Owner overlap one.'},{role:'model',text:'Model overlap two.'},{role:'owner',text:'Owner overlap two.'}]);
 assert.equal((await page.locator('#past-session-list').textContent()).includes('word219'),true,'complete archived first session survives new active session');
 console.log(JSON.stringify({case:'actual_main_terminal_pagination',firstSession:firstCounts,modelTokensRenderedOnce:220,ownerCorrectionRendered:true,openDisclosurePreserved:true,allPagesFetched:cursors,fullDuplexRolesInSourceOrder:4,newSessionPreservesArchive:true,audioFrames:0}));
}finally{if(page){console.log(JSON.stringify({case:'terminal_pagination_observation',cursors,canonicalRows:store.transaction(tx=>tx.get('SELECT count(*) AS n FROM live_journal').n),firstWordInPast:(await page.locator('#past-session-list').textContent().catch(()=>''))?.includes('word000')??false,lastWordInPast:(await page.locator('#past-session-list').textContent().catch(()=>''))?.includes('word219')??false}));if(process.env.LUX_BROWSER_SLOT_TOKEN){const {assertGpu}=await import(new URL('../../../lux-harness/skills/pi-control/scripts/pi_browser_launch.mjs',import.meta.url));await assertGpu(page);}}await browser?.close();await fixture?.close();await attachment?.close();await collect;await owner.shutdown();store.close();rmSync(dir,{recursive:true,force:true});}
