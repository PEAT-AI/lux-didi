import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {OpenAiLiveVoiceAdapter} from '../../server/dist/adapters/live-voice/openai.js';
import {GeminiLiveVoiceAdapter} from '../../server/dist/adapters/live-voice/gemini.js';
import {FakeSocket,FakeClock,options} from '../../server/dist/test/openai-live-voice-fixture.js';
import {Store} from '../../server/dist/runtime/store.js';
import {hostMigrations} from '../../server/dist/host/runtime.js';
import {createLiveSessionOwner,validateLiveProfile} from '../../server/dist/live/index.js';
import {liveTranscript,sessionItems,mergeLive} from '../src/live-view.ts';

const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
let browser;
async function verify(provider) {
 const dir=mkdtempSync(join(tmpdir(),'didi-transcript-replay-')),store=new Store(dir,hostMigrations),clock=new FakeClock(),socket=new FakeSocket();
 const openai=provider==='openai',modelId=openai?'gpt-live-1':'models/explicit-live-test',voice=openai?'marin':'ExplicitVoice';
 const adapter=new (openai?OpenAiLiveVoiceAdapter:GeminiLiveVoiceAdapter)(options({clock,modelId,voice,route:{enabled:true,provider,modelId,dataClasses:['ordinary']},
  limits:{handshakeMs:1000,idleMs:600000,sessionMs:600000,closeMs:50},socketFactory:()=>{queueMicrotask(()=>{socket.readyState=1;socket.emit('open');});return socket;}}));
 const owner=createLiveSessionOwner({store,voice:adapter,profile:validateLiveProfile({provider,liveModelId:modelId,voice,keyReference:openai?'openai-primary':'test-reference',
  route:{enabled:true,provider,modelId,dataClasses:['ordinary']},prompt:{text:'Synthetic neutral transcript test',dataClass:'ordinary'}}),timeZone:'UTC'});
 const context={clientId:'synthetic',auditId:'synthetic-audit',authorityEpoch:store.authorityEpoch};
 const created=owner.create({inputClass:'ordinary',idempotencyKey:'replay'},context),attachment=owner.attach({liveSessionId:created.liveSessionId},context);
 const collect=(async()=>{for await(const _ of attachment.output){}})();
 try {
  await tick();socket.deliver(openai?{type:'session.started',session:{id:'synthetic'}}:{setupComplete:{}});await attachment.ready;await tick();
  const fragments=openai?['Please re','schedule',' the call',' at 8',':','30','.',' Very',' very',' important.']:['Legacy','words','stay separate.'];
  for(const [i,delta]of fragments.entries()){
   socket.deliver(openai?{type:'session.input_transcript.delta',event_id:'synthetic-'+i,delta,start_ms:1000+i*10,end_ms:1010+i*10}:{serverContent:{inputTranscription:{text:delta,finished:i===fragments.length-1}}});
   await tick();
  }
  const rows=store.transaction(tx=>tx.all("SELECT text FROM live_journal WHERE kind='inputTranscription' ORDER BY journal_id",[]));
  assert.equal(rows.map(x=>x.text??'').join(''),fragments.join(''),'canonical journal preserves source fragments exactly');
  const outputFragments=openai?['I can re','schedule',' it',' at 8',':','30','.']:['The','answer','is ready.'];
  for(const [i,delta]of outputFragments.entries()){
   socket.deliver(openai?{type:'session.output_transcript.delta',event_id:'output-'+i,delta,start_ms:2000+i*10,end_ms:2010+i*10}:{serverContent:{outputTranscription:{text:delta,finished:i===outputFragments.length-1}}});
   await tick();
  }
  const outputRows=store.transaction(tx=>tx.all("SELECT text FROM live_journal WHERE kind='outputTranscription' ORDER BY journal_id",[]));
  assert.equal(outputRows.map(x=>x.text??'').join(''),outputFragments.join(''),'output journal preserves generated transcript fragments');
  const view=owner.current(),expected=openai?fragments.join(''):fragments.join(' '),outputExpected=openai?outputFragments.join(''):outputFragments.join(' ');
  const page=await browser.newPage();
  try {
   await page.setContent('<main>'+sessionItems(view).map(item=>item.html).join('')+'</main>');
   assert.equal(await page.locator('article.user').innerText(),expected,provider+' rendered browser text');
   assert.equal(await page.locator('article.assistant').innerText(),outputExpected,provider+' rendered generated transcript');
  } finally {await page.close();}
  assert.equal(liveTranscript(view).find(x=>x.role==='user')?.text,expected);
  assert.equal(liveTranscript(view).find(x=>x.role==='naya')?.text,outputExpected);
  assert.deepEqual(liveTranscript(mergeLive(view,{...view,entries:view.entries,cursor:view.cursor})),liveTranscript(view),'repeated poll does not duplicate a delta');
  if(openai){
   clock.advance(701);await tick();
   owner.text('First complete typed message.');owner.text('Second complete typed message.');await tick();
   const lines=liveTranscript(owner.current()).filter(x=>x.role==='user');
   assert.deepEqual(lines.map(x=>x.text),[expected,'First complete typed message.','Second complete typed message.'],'existing final boundaries keep complete messages separate');
  }
  console.log('PASS actual '+provider+' adapter -> canonical Store -> projection -> headless browser; exact fragments and truthful boundaries');
 } finally {await attachment.close();await collect;await owner.shutdown();store.close();rmSync(dir,{recursive:true,force:true});}
}
try {browser=await chromium.launch({headless:true});await verify('openai');await verify('gemini');} finally {await browser?.close();}
