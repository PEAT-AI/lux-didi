import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
const dist=new URL(process.env.DIDI_TRANSCRIPT_DIST??'../dist/',import.meta.url);
const {Store}=await import(new URL('runtime/store.js',dist));const {hostMigrations}=await import(new URL('host/runtime.js',dist));
const {OpenAiLiveVoiceAdapter}=await import(new URL('adapters/live-voice/openai.js',dist));
const {FakeSocket,FakeClock,options}=await import(new URL('test/openai-live-voice-fixture.js',dist));
const {createLiveSessionOwner,validateLiveProfile}=await import(new URL('live/index.js',dist));
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
const dir=mkdtempSync(join(tmpdir(),'didi-journal-provenance-')),store=new Store(dir,hostMigrations),socket=new FakeSocket(),clock=new FakeClock();
const adapter=new OpenAiLiveVoiceAdapter(options({clock,limits:{handshakeMs:1000,idleMs:600000,sessionMs:600000,closeMs:50},socketFactory:()=>{queueMicrotask(()=>{socket.readyState=1;socket.emit('open');});return socket;}}));
const owner=createLiveSessionOwner({store,voice:adapter,profile:validateLiveProfile({provider:'openai',liveModelId:'gpt-live-1',voice:'marin',keyReference:'openai-primary',route:{enabled:true,provider:'openai',modelId:'gpt-live-1',dataClasses:['ordinary']},prompt:{text:'Synthetic journal test',dataClass:'ordinary'}}),timeZone:'UTC'});
const ctx={clientId:'synthetic',auditId:'synthetic',authorityEpoch:store.authorityEpoch};
const created=owner.create({inputClass:'ordinary',idempotencyKey:'synthetic'},ctx),a=owner.attach({liveSessionId:created.liveSessionId},ctx),consumed=(async()=>{for await(const _ of a.output){}})();
try{
 await tick();socket.deliver({type:'session.started',session:{id:'synthetic'}});await a.ready;
 for(const frame of [
  {delta:'very',event_id:'same-event',start_ms:100,end_ms:200},
  {delta:' very',event_id:'same-event',start_ms:200,end_ms:300},
  {delta:' again'},
  {delta:'!',event_id:'bad event id',start_ms:500,end_ms:400},
 ]){socket.deliver({type:'session.input_transcript.delta',...frame});await tick();}
 clock.advance(701);await tick();owner.text('A typed message.');await tick();
 const rows=store.transaction(tx=>tx.all("SELECT * FROM live_journal WHERE kind='inputTranscription' ORDER BY journal_id"));
 assert.equal(rows[0].provider_event_id,'same-event','observed provider event id retained');
 assert.equal(rows[0].provider_start_ms,100);assert.equal(rows[0].provider_end_ms,200);assert.equal(rows[0].connection_epoch,'e0');
 assert.equal(rows[1].provider_event_id,'same-event','same-id event not suppressed without idempotency contract');
 assert.equal(rows.slice(0,4).map(x=>x.text).join(''),'very very again!','legitimate repetitions preserved exactly');
 assert.equal(rows[2].provider_event_id,null);assert.equal(rows[2].provider_start_ms,null);
 assert.equal(rows[3].provider_event_id,null);assert.equal(rows[3].provider_start_ms,null);assert.equal(rows[3].provider_end_ms,null);
 assert.ok(rows.every(x=>Number.isSafeInteger(x.received_mono_ms)&&String(x.clock_domain).startsWith('host:')));
 assert.equal(rows.find(x=>x.finished===1&&x.text==='').final_origin,'app_quiet');
 assert.equal(rows.at(-1).final_origin,'typed');assert.ok(rows.at(-1).finalized_at>=rows.at(-1).arrived_at);
 console.log('PASS actual adapter -> Store journal provenance, observed/absent/invalid intervals, same-id repeats, app/typed final origin and host clock domain');
}finally{await a.close();await consumed;await owner.shutdown();store.close();rmSync(dir,{recursive:true,force:true});}
