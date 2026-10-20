import assert from 'node:assert/strict';import{execFileSync}from'node:child_process';import{fileURLToPath}from'node:url';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
const dist=new URL(process.env.DIDI_TRANSCRIPT_DIST??'../dist/',import.meta.url);
const {Store}=await import(new URL('runtime/store.js',dist)),{hostMigrations}=await import(new URL('host/runtime.js',dist));
const {OpenAiLiveVoiceAdapter}=await import(new URL('adapters/live-voice/openai.js',dist)),{FakeSocket,FakeClock,options}=await import(new URL('test/openai-live-voice-fixture.js',dist));
const {createLiveSessionOwner,validateLiveProfile}=await import(new URL('live/index.js',dist)),{buildTimeline}=await import(new URL('trace/timeline.js',dist));
const {record,liveTracePort}=await import(new URL('trace/record.js',dist)),{forgetHistorySessions}=await import(new URL('domain/history-lifecycle.js',dist));
const {diagnosticQueries}=await import('./diagnostic-query-fixture.mjs');
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
const profile=()=>validateLiveProfile({provider:'openai',liveModelId:'gpt-live-1',voice:'marin',keyReference:'openai-primary',route:{enabled:true,provider:'openai',modelId:'gpt-live-1',dataClasses:['ordinary']},prompt:{text:'Synthetic diagnostic test',dataClass:'ordinary'}});
async function run(failContent){
 const dir=mkdtempSync(join(tmpdir(),'didi-trace-coverage-'));let store=new Store(dir,hostMigrations),owner;
 try{
  const original=store.transaction.bind(store);let fail=false,failed=0;
  store.transaction=fn=>original(tx=>fn(new Proxy(tx,{get(target,key){if(key==='run')return(sql,params)=>{if(fail&&sql.startsWith('INSERT INTO trace_utterance')){failed++;throw Error('synthetic write failure');}return target.run(sql,params);};const value=target[key];return typeof value==='function'?value.bind(target):value;}})));
  const clock=new FakeClock(),socket=new FakeSocket(),adapter=new OpenAiLiveVoiceAdapter(options({clock,limits:{handshakeMs:1000,idleMs:600000,sessionMs:600000,closeMs:50},socketFactory:()=>{queueMicrotask(()=>{socket.readyState=1;socket.emit('open');});return socket;}}));
  owner=createLiveSessionOwner({store,voice:adapter,profile:profile(),timeZone:'UTC'});
  const ctx={clientId:'synthetic',auditId:'synthetic',authorityEpoch:store.authorityEpoch},created=owner.create({inputClass:'ordinary',idempotencyKey:'synthetic'},ctx),a=owner.attach({liveSessionId:created.liveSessionId},ctx),consume=(async()=>{for await(const _ of a.output){}})();
  await tick();socket.deliver({type:'session.started',session:{id:'synthetic'}});await a.ready;
  socket.deliver({type:'session.output_transcript.delta',delta:'Synthetic greeting.'});await tick();
  fail=failContent;socket.deliver({type:'session.input_transcript.delta',delta:'Synthetic question.'});await tick();fail=false;
  await a.close();await consume;await owner.shutdown();owner=undefined;
  const cli=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/didi-timeline',import.meta.url)),created.liveSessionId,'--data-dir',dir,'--json','--content'],{encoding:'utf8'}));
  assert.equal(cli.contentAccess.state,'allowed');assert.equal(cli.transcript.map(x=>x.text).join(''),'Synthetic greeting.Synthetic question.');
  const queries=diagnosticQueries(join(dir,'state.sqlite'),{session:created.liveSessionId,run:created.liveSessionId,conversation:'synthetic-text-conversation'});assert.equal(queries.transcript_fragments.map(row=>row.text).join(''),'Synthetic greeting.Synthetic question.');
  const result=store.transaction(tx=>{
   const row=tx.get('SELECT journal_complete,diagnostic_metadata_state,diagnostic_content_state,diagnostic_failures,diagnostic_unattributed_transcripts,native_receipt_state FROM live_sessions WHERE live_session_id=?',[created.liveSessionId]);
   assert.equal(row.journal_complete,1);assert.equal(row.diagnostic_unattributed_transcripts,1);assert.equal(row.native_receipt_state,'unknown');
   assert.equal(row.diagnostic_metadata_state,failContent?'partial':'complete');assert.equal(row.diagnostic_content_state,failContent?'partial':'complete');assert.equal(row.diagnostic_failures,failContent?1:0);
   assert.equal(Number(tx.get('SELECT COALESCE(sum(length(text)),0) AS n FROM trace_utterance').n),0,'new trace rows do not duplicate canonical text');
   const authority={ownerId:store.assistantId,allowedClasses:['ordinary']};
   const report=buildTimeline(tx,created.liveSessionId,{content:true,contentAuthority:authority});
   assert.equal(report.contentAccess.state,'allowed');assert.equal(report.transcript.map(x=>x.text).join(''),'Synthetic greeting.Synthetic question.');
   if(!failContent)assert.equal(report.turns.flatMap(t=>t.utterances).find(x=>x.role==='owner').text,'Synthetic question.','trace reference resolves canonical text');
   assert.equal(buildTimeline(tx,created.liveSessionId,{content:true}).contentAccess.state,'denied');
   assert.equal(buildTimeline(tx,created.liveSessionId,{content:true,contentAuthority:{ownerId:store.assistantId,allowedClasses:[]}}).contentAccess.state,'denied');
   forgetHistorySessions(tx,[created.liveSessionId],Date.now());
   const denied=buildTimeline(tx,created.liveSessionId,{content:true,contentAuthority:authority});assert.equal(denied.contentAccess.state,'denied');assert.equal(denied.transcript,undefined);assert.ok(!JSON.stringify(denied).includes('Synthetic question.'));
   tx.run("UPDATE live_sessions SET lifecycle='active',diagnostic_metadata_state='in_progress',diagnostic_content_state='in_progress' WHERE live_session_id=?",[created.liveSessionId]);
   return{journalComplete:row.journal_complete,diagnosticState:row.diagnostic_metadata_state,failures:row.diagnostic_failures,expectedUnassociatedRows:row.diagnostic_unattributed_transcripts,newTraceTextBytes:0,forgottenDenied:true};
  });
  const deniedCli=execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/didi-timeline',import.meta.url)),created.liveSessionId,'--data-dir',dir,'--json','--content'],{encoding:'utf8'});
  assert.ok(!deniedCli.includes('Synthetic question.'));assert.equal(JSON.parse(deniedCli).contentAccess.state,'denied');
  store.close();store=new Store(dir,hostMigrations);owner=createLiveSessionOwner({store,voice:adapter,profile:profile(),timeZone:'UTC'});assert.equal(owner.recover(),0,'constructor already recovered the stale session exactly once');
  const recovered=store.transaction(tx=>tx.get('SELECT diagnostic_metadata_state,diagnostic_last_reason FROM live_sessions WHERE live_session_id=?',[created.liveSessionId]));assert.equal(recovered.diagnostic_metadata_state,'unknown');assert.equal(recovered.diagnostic_last_reason,'host_terminated');
  assert.equal(failed,failContent?1:0);return{...result,restart:'unknown/host_terminated'};
 }finally{await owner?.shutdown();store.close();rmSync(dir,{recursive:true,force:true});}
}
const cases=[await run(false),await run(true)];
const dir=mkdtempSync(join(tmpdir(),'didi-scoped-trace-')),store=new Store(dir);
try{
 const keys=[];
 for(const [session,epoch]of [['session-one','e0'],['session-two','e0'],['session-one','e1']]){
  const rejected=[],port=liveTracePort({port:store,liveSessionId:session,connectionEpoch:epoch,onReject:(code,kind)=>rejected.push({code,kind})});
  port.receipt('response.created',{responseKey:'r1'},{createdAt:1000,providerResponseId:'same-response'});
  port.receipt('call.intent',{callKey:'same-call',responseKey:'r1'},{name:'synthetic',argsChars:2,intentAt:1000,providerCallId:'same-call'});assert.deepEqual(rejected,[]);
  keys.push(store.transaction(tx=>String(tx.get('SELECT call_key FROM trace_call WHERE live_session_id=? AND connection_epoch=?',[session,epoch]).call_key)));
 }
 assert.equal(new Set(keys).size,3);assert.equal(store.transaction(tx=>Number(tx.get('SELECT count(*) AS n FROM trace_response').n)),3);
 record(store,'call.executed',{liveSessionId:'session-one',connectionEpoch:'e0',callKey:keys[0],clockDomain:'clock-a',monoMs:200},{executedAt:1200});
 record(store,'call.output_written',{liveSessionId:'session-one',connectionEpoch:'e0',callKey:keys[0],clockDomain:'clock-b',monoMs:1000},{outputWrittenAt:2000,outcome:'completed',ms:1,resultChars:1});
 const report=buildTimeline({get:(sql,p)=>store.transaction(tx=>tx.get(sql,p)),all:(sql,p)=>store.transaction(tx=>tx.all(sql,p))},'session-one');
 const rows=store.transaction(tx=>tx.all("SELECT clock_domain FROM trace_event WHERE kind IN ('call.executed','call.output_written')"));assert.deepEqual(rows.map(x=>x.clock_domain),['clock-a','clock-b']);
 assert.equal(report.unattributedCalls.length,2);assert.equal(report.unattributedCalls.find(x=>x.callKey===keys[0]).executionMs,null);
 console.log(JSON.stringify({case:'diagnostic_trace_canonical_references',cases,scopedCallKeys:3,scopedResponseKeys:3,unlikeClockDomainsPreserved:true,unattributedCallsStayOutsideTurns:report.turns.length===0,unlikeClockExecutionMs:report.unattributedCalls.find(x=>x.callKey===keys[0]).executionMs}));
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
