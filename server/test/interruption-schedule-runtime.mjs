import assert from 'node:assert/strict';
const dist=new URL(process.env.DIDI_TRANSCRIPT_DIST??'../dist/',import.meta.url);
const {OpenAiLiveVoiceAdapter}=await import(new URL('adapters/live-voice/openai.js',dist));
const {attachHostLogSink}=await import(new URL('tools/host-events.js',dist));
const {FakeSocket,options,request,pcm16,silence}=await import(new URL('test/openai-live-voice-fixture.js',dist));
class Clock {
 time=1000000; next=0; pending=new Map(); callbacks=[];
 now(){return this.time;}
 setTimer(ms,fire){const id=++this.next;this.pending.set(id,{at:this.time+ms,fire});this.callbacks.push({at:this.time+ms,fire});return id;}
 clearTimer(id){this.pending.delete(id);}
 jump(to){this.time=1000000+to;}
 runDue(){for(;;){const pair=[...this.pending].filter(([,t])=>t.at<=this.time).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!pair)return;this.pending.delete(pair[0]);pair[1].fire();}}
 to(to){const target=1000000+to;for(;;){const due=[...this.pending.values()].filter(t=>t.at<=target).sort((a,b)=>a.at-b.at)[0];if(!due)break;this.time=Math.max(this.time,due.at);this.runDue();}this.time=target;}
}
const tick=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
async function run({name,last=1400,input='stop',action,actionAt=1720,expect=[1750],largeTail=false,tieFirst=false,late=false,stale=false}){
 const clock=new Clock(),socket=new FakeSocket(),events=[],flushes=[];let replacement,replacementSocket,replacementConsume;
 const detach=attachHostLogSink({event:e=>{if(e.event==='gptlive_flush')flushes.push(clock.now()-1000000);}});
 const adapter=new OpenAiLiveVoiceAdapter(options({clock,limits:{handshakeMs:1000,idleMs:600000,sessionMs:600000,closeMs:50},socketFactory:()=>{const peer=socket.readyState===3?new FakeSocket():socket;if(peer!==socket)replacementSocket=peer;queueMicrotask(()=>{peer.readyState=1;peer.emit('open');});return peer;}}));
 const session=adapter.open(request(),{signal:new AbortController().signal,deadlineMs:Date.now()+600000});
 const consume=(async()=>{for await(const e of session.events)events.push({type:e.type,at:clock.now()-1000000});})();
 const audio=(silent=false,big=false)=>socket.deliver({type:'session.output_audio.delta',delta:Buffer.from(silent?silence(2400):pcm16(big?12000:2400)).toString('base64')});
 const text=delta=>socket.deliver({type:'session.input_transcript.delta',delta});
 try{
  await tick();socket.deliver({type:'session.started',session:{id:'synthetic'}});await session.ready;
  const schedule=[];
  if(last!==null){for(let at=0;at<=last;at+=100)schedule.push({at,do:()=>audio(false,largeTail&&at===last)});if(last%100)schedule.push({at:last,do:()=>audio(false,largeTail)});}
  if(input!==null)schedule.push({at:1000,do:()=>text(input)});
  if(action)schedule.push({at:actionAt,do:()=>{if(action==='speech')audio();else if(action==='silence')audio(true);else if(action==='owner')text('wait');else if(action==='whitespace')text(' ');else if(action==='generation')socket.deliver({type:'response.event',event:{type:'response.created',response:{id:'new-synthetic-generation'}}});else if(action==='terminate')session.close();else if(action==='reconnect'){session.close();replacement=adapter.open(request(),{signal:new AbortController().signal,deadlineMs:Date.now()+600000});replacementConsume=(async()=>{for await(const e of replacement.events)events.push({type:e.type,at:clock.now()-1000000});})();}}});
  for(const step of schedule.sort((a,b)=>a.at-b.at)){
   if(tieFirst&&step.at===actionAt){clock.jump(step.at);step.do();await tick();clock.runDue();}
   else{clock.to(step.at);step.do();}await tick();
  }
  if(replacement){await tick();replacementSocket.deliver({type:'session.started',session:{id:'new-synthetic-connection'}});await replacement.ready;}
  if(late){clock.jump(2051);clock.runDue();}else clock.to(3000);await tick();
  if(stale){for(const cb of clock.callbacks.filter(cb=>cb.at===1001750))cb.fire();await tick();}
  assert.deepEqual(flushes,expect,name);
  assert.equal(events.filter(x=>x.type==='interrupted').length,expect.length,name+' emitted interruption count');
  console.log('PASS '+name);
 }finally{await session.close();await consume;if(replacement){await replacement.close();await replacementConsume;}detach();}
}
for(const last of [1350,1399,1400,1699])await run({name:'last speech '+last,last,expect:[last+350]});
for(const actionAt of [1700,1701])await run({name:'new speech cancels at '+actionAt,action:'speech',actionAt,expect:[],tieFirst:true});
await run({name:'new owner episode replaces old token',action:'owner',largeTail:true,expect:[2070],stale:true});
await run({name:'whitespace retains pending check',action:'whitespace'});
for(const action of ['terminate','reconnect','generation'])await run({name:action+' clears old token',action,expect:[],stale:true});
await run({name:'silent fill retains pending check',action:'silence'});
await run({name:'speech first at equal tick cancels',last:1350,action:'speech',actionAt:1700,expect:[],tieFirst:true});
await run({name:'check first at equal tick stays executed',last:1350,action:'speech',actionAt:1700,expect:[1700]});
await run({name:'already fired check cannot repeat',last:1350,action:'whitespace',actionAt:1701,expect:[1700],stale:true});
await run({name:'late callback beyond closed bound cannot flush',last:1699,late:true,expect:[]});
await run({name:'continuous provider speech',last:2500,expect:[]});
await run({name:'no input',input:null,expect:[]});
await run({name:'whitespace only',input:' ',expect:[]});
await run({name:'zero queue',last:null,expect:[]});
await run({name:'background same events has same result'});
console.log('PASS 21 actual-adapter bounded interruption schedules; no acoustic inference');
