import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {fixture,profile,text,tail} from './dispatch-diagnostics.integration.mjs';
import {Store} from '../dist/runtime/store.js';
import {hostMigrations} from '../dist/host/runtime.js';
import {createToolsOwner} from '../dist/tools/index.js';
import {McpRegistry} from '../dist/adapters/mcp/registry.js';
import {createMcpAdapter} from '../dist/adapters/mcp/adapter.js';
import {MemoryResultStore} from '../dist/adapters/mcp/store.js';
import {createLiveSessionOwner} from '../dist/live/index.js';
import {runToolCalls} from '../dist/tools/declarations.js';
import {CONNECTOR_DESCRIPTORS} from '../dist/connectors/index.js';
import {readDiagnosticDispatches} from '../dist/tools/dispatch.js';
const tick=()=>new Promise(r=>setImmediate(r));
async function until(check){for(let n=0;n<1000;n++){if(check())return;await tick();}throw Error('synthetic checkpoint not reached');}
function deferred(){let release;return{promise:new Promise(r=>release=r),release:()=>release()};}
async function environment(options={}){
 const response=options.response??text;
 const name=options.name??'get_insight',connector=options.connector??'lux-knowledge';
 const f=await fixture(name,options.args??{ids:[101]},response,options.source,options.tools),dir=mkdtempSync('/tmp/didi-dispatch-controls-');
 let store=new Store(dir,hostMigrations),live,step=0,fault;
 const transact=store.transaction.bind(store),stats={sourceSealTransactionMs:[]};
 store.transaction=body=>{let seal=false;const started=performance.now();const result=transact(tx=>body(new Proxy(tx,{get(target,key){if(key==='run')return(sql,params)=>{if(sql.startsWith('UPDATE tool_dispatches SET state=?'))seal=true;if(fault?.(sql))throw Error('synthetic diagnostic write fault');return target.run(sql,params);};const value=target[key];return typeof value==='function'?value.bind(target):value;}})));if(seal)stats.sourceSealTransactionMs.push(performance.now()-started);return result;};
 const registry=new McpRegistry(),endpoint={id:'synthetic-source',url:f.url,account:'synthetic-account',resource:'synthetic-resource'};
 registry.register(endpoint);registry.enable(endpoint.id);registry.allowEgress(endpoint.id);
 const adapter=createMcpAdapter({registry,store:new MemoryResultStore({maxBytes:4_000_000,maxEntries:20,ttlMs:20000}),...(options.concurrency?{maxConcurrentCallsByEndpoint:new Map([[endpoint.id,options.concurrency]])}:{})});
 const discovered=await adapter.discover(endpoint.id);assert.equal(discovered.state,'discovered',JSON.stringify({state:discovered.state,reason:discovered.reason,exception:discovered.exception}));
 const state={store,registry,adapter,f,endpoint,scope:undefined};
 const port=options.wrap?options.wrap(adapter,state):adapter;
 let authority;
 const owner=createToolsOwner({store,registry,port,ownerId:store.assistantId,lookupAuthority:async()=>authority,grantMode:'owner-trusted-reads',...(options.log?{log:options.log}:{})});
 const policy={schemaVersion:1,ownerId:store.assistantId,connectionId:'synthetic-connection',generation:1,enabled:true,connector,endpoint:{...endpoint,credentialRef:null},toolNames:options.toolNames??[name],schemaDigest:discovered.schemaDigest,sourcePolicy:{id:'synthetic-policy',revision:1,unknownClass:'ordinary',allowedClasses:['ordinary']},route:{identity:'synthetic-route',allowedClasses:['ordinary']},bounds:{maxQueryChars:500,maxSearchLimit:10,maxGetIds:3,maxEntityBytes:1_000_000,maxResultBytes:60000}};
 owner.applyConnection(policy);await adapter.discover(endpoint.id);owner.projectConnection(policy.connectionId);
 const liveProfile=options.privateContext?{...profile,route:{...profile.route,dataClasses:['ordinary','private']}}:profile;
 live=createLiveSessionOwner({store,voice:{},profile:liveProfile,timeZone:'UTC'});
 const created=live.create({inputClass:'ordinary',idempotencyKey:'synthetic'},{clientId:'synthetic',auditId:'synthetic',authorityEpoch:store.authorityEpoch});
 const accepted={ownerId:store.assistantId,actorId:'synthetic',runId:created.liveSessionId,authorityEpoch:store.authorityEpoch,revision:1,route:{identity:'synthetic-route',provider:'openai',modelId:'gpt-live-1',allowedClasses:['ordinary']},allowedClasses:['ordinary'],connectionIds:[policy.connectionId]};
 if(options.privateContext){accepted.allowedClasses=['ordinary','private'];accepted.route.allowedClasses=['ordinary','private'];}
 const hash=store.transaction(tx=>owner.snapshotRun(tx,accepted).sha256);authority={...accepted,acceptedRunHash:hash};
 let observedPort;const descriptor=CONNECTOR_DESCRIPTORS[connector],createReader=descriptor.createReader;
 descriptor.createReader=input=>{observedPort=input.port;const reader=createReader(input);return options.reader?options.reader(reader,input):reader;};
 let definitions;try{definitions=owner.definitions(accepted.runId);}finally{descriptor.createReader=createReader;}
 const host={runId:accepted.runId,actorId:'synthetic',authorityEpoch:store.authorityEpoch,revision:1,grants:definitions.map(t=>({tool:t.name,effect:t.effect,accountId:t.accountId,resourceId:t.resourceId}))};
 Object.assign(state,{owner,accepted,policy});
 return{
  ...state,observedPort,stats,
  rows(){return store.transaction(tx=>tx.all('SELECT * FROM tool_dispatches ORDER BY started_mono_ms,dispatch_id'));},
  coverage(){return store.transaction(tx=>tx.all('SELECT * FROM tool_dispatch_coverage'));},
  fault(value){fault=value;},
  async run(ids=[101],signal=new AbortController().signal){const current=step++;return runToolCalls(owner,[{id:`source-${current}`,name,args:Array.isArray(ids)?{ids}:ids}],{registry:definitions,host,authority:{isCurrent:async()=>true},control:{signal,deadlineMs:Date.now()+10000},step:current,contentIndex:0,seenIds:new Set(),baseClasses:['ordinary'],authorize:true});},
  async reopen(){await live.shutdown();live=undefined;await adapter.close();store.close();store=new Store(dir,hostMigrations);const next=createToolsOwner({store,registry:new McpRegistry(),port:{},ownerId:store.assistantId,lookupAuthority:async()=>null});return{store,owner:next};},
  async close(){await live?.shutdown();await adapter.close();store.close();await f.close();rmSync(dir,{recursive:true,force:true});},
 };
}
const results=[];
for(const same of [false,true]){
 const release=deferred(),second=deferred();let e;
 try{
  e=await environment({source:async(params,n)=>{if(n===1)await release.promise;else second.release();return same?'same synthetic body':`source ${params.arguments.ids[0]}`;}});
  const a=e.run([101]),b=e.run([102]);await second.promise;release.release();const batches=await Promise.all([a,b]);assert(batches.every(v=>!v.error));
  const rows=e.rows();assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.dispatch_id)).size,2);
  for(const row of rows){const id=JSON.parse(row.arguments_json).ids[0];assert.equal(JSON.parse(row.source_json).content[0].text,same?'same synthetic body':`source ${id}`);}
  assert.throws(()=>e.store.transaction(tx=>tx.run("UPDATE tool_dispatches SET reason='duplicate' WHERE dispatch_id=?",[rows[0].dispatch_id])),/dispatch_identity_or_terminal/);
  results.push({case:same?'same_content_explicit_refs':'out_of_order_distinct_contexts',dispatches:2,duplicateSealDenied:true});
 }finally{release.release();await e?.close();}
}
{
 const hold=deferred(),entered=deferred();let e;
 try{
  e=await environment({concurrency:1,source:async()=>{entered.release();await hold.promise;return text;}});
  const first=e.run();await entered.promise;const stop=new AbortController(),second=e.run([102],stop.signal);
  await until(()=>e.rows().length===2);stop.abort();await second;hold.release();await first;
  await until(()=>e.rows().every(r=>r.state!=='pending'));
  const rows=e.rows();assert.equal(e.f.calls.length,1);assert.equal(rows.filter(r=>r.wire_state==='observed').length,1);assert.equal(rows.filter(r=>r.wire_state==='not_dispatched').length,1);
  results.push({case:'queued_cancellation_conservation',attempts:2,wire:1,preWire:1});
 }finally{hold.release();await e?.close();}
}
for(const stage of ['insert','seal']){
 let e,failed=false;
 try{
  e=await environment();e.fault(sql=>{if(!failed&&sql.startsWith(stage==='insert'?'INSERT INTO tool_dispatches':'UPDATE tool_dispatches SET state=')){failed=true;return true;}return false;});
  const batch=await e.run();assert.equal(batch.error,undefined);assert.equal(e.f.calls.length,1);assert(failed);
  assert(e.coverage().some(row=>row.kind===(stage==='insert'?'wire_record_failed':'seal_write_failed')));
  if(stage==='insert')assert.equal(e.rows().length,0);else{assert.equal(e.rows()[0].state,'pending');const reopened=await e.reopen();const row=reopened.store.transaction(tx=>tx.get('SELECT state,reason,source_json FROM tool_dispatches'));assert.equal(row.state,'unknown');assert.equal(row.reason,'host_terminated');assert.equal(row.source_json,null);}
  results.push({case:`${stage}_write_failure`,sourceStillCalled:true,boundedResultCompleted:true,fullBodyUnavailable:true});
 }finally{await e?.close();}
}
for(const mutation of ['exclude','relabel']){
 let e,changed=false;
 try{
  e=await environment({wrap:(adapter,state)=>new Proxy(adapter,{get(target,key){if(key==='readSlice')return req=>{if(!changed){changed=true;state.store.transaction(tx=>mutation==='exclude'?tx.run("INSERT INTO history_exclusions VALUES('live',?,?)",[state.accepted.runId,Date.now()]):tx.run("UPDATE history_sessions SET data_class='private',revision=revision+1 WHERE live_session_id=?",[state.accepted.runId]));}return target.readSlice(req);};const value=target[key];return typeof value==='function'?value.bind(target):value;}})});
  await e.run();const row=e.rows()[0];assert.equal(row.state,'unavailable');assert.equal(row.source_json,null);assert.equal(row.reason,mutation==='exclude'?'excluded_before_seal':'source_changed');
  results.push({case:`${mutation}_before_seal`,bodyWithheld:true});
 }finally{await e?.close();}
}
for(const failure of ['hash','length','expiry']){
 let e;
 try{
  e=await environment({wrap:adapter=>new Proxy(adapter,{get(target,key){if(key==='readSlice')return req=>{const slice=target.readSlice(req);if(slice.state!=='available')return slice;return failure==='hash'?{...slice,sha256:'0'.repeat(64)}:failure==='length'?{...slice,bytes:slice.bytes.subarray(1)}:{...slice,expiresAt:1};};const value=target[key];return typeof value==='function'?value.bind(target):value;}})});
  await e.run();const row=e.rows()[0];assert.equal(row.state,'unavailable');assert.equal(row.source_json,null);assert.equal(row.reason,'source_slice_incomplete');results.push({case:`retained_${failure}_mismatch`,bodyWithheld:true});
 }finally{await e?.close();}
}
{
 let e;
 try{
  const envelopeBytes=Buffer.byteLength(JSON.stringify({result:{content:[{type:'text',text:''}],_meta:{authorization:'synthetic-transport-secret-sentinel'}},jsonrpc:'2.0',id:0}));const content='x'.repeat(1_000_000-envelopeBytes-Buffer.byteLength(tail))+tail;e=await environment({response:content});await e.run();const row=e.rows()[0];assert.equal(row.state,'completed');assert.equal(row.entity_bytes,e.policy.bounds.maxEntityBytes);assert(JSON.parse(row.source_json).content[0].text.endsWith(tail));results.push({case:'exact_existing_one_megabyte_entity_bound',entityBytes:row.entity_bytes,tailRetained:true,sourceSealTransactionMs:Number(e.stats.sourceSealTransactionMs.at(-1).toFixed(3))});
 }finally{await e?.close();}
}
{
 const held=deferred(),ready=deferred();let e;
 try{
  e=await environment({wrap:adapter=>new Proxy(adapter,{get(target,key){if(key==='call')return async(...args)=>{const result=await target.call(...args);ready.release();await held.promise;return result;};const value=target[key];return typeof value==='function'?value.bind(target):value;}})});
  const stop=new AbortController(),running=e.run([101],stop.signal);await ready.promise;stop.abort();await running;assert.equal(e.store.transaction(tx=>tx.get('SELECT state FROM tool_calls').state),'failed');held.release();await until(()=>e.rows()[0]?.state!=='pending');assert.equal(e.rows()[0].state,'completed');assert(e.rows()[0].source_json.includes(tail));results.push({case:'parent_timeout_after_real_source_response',sourceOutcomeSealed:true,modelDeliveryNotClaimed:true});
 }finally{held.release();await e?.close();}
}

for(const coldConcurrent of [false,true]){
 const release=deferred(),two=deferred();let e,listCalls=0;
 try{
  const schema=(name,properties)=>({name,inputSchema:{type:'object',properties},annotations:{readOnlyHint:true}});
  const tools=[schema('mattermost_list_channels',{limit:{type:'integer'}}),schema('mattermost_get_channel_history',{channel:{type:'string'},limit:{type:'integer'}})];
  e=await environment({connector:'mattermost',name:'mattermost_get_channel_history',args:{channel:'engineering'},tools,toolNames:tools.map(t=>t.name),source:async params=>{
   if(params.name==='mattermost_list_channels'){listCalls++;if(coldConcurrent){if(listCalls===2)two.release();await release.promise;}return JSON.stringify({channels:[{id:'a'.repeat(26),name:'engineering'}]});}
   return JSON.stringify({posts:[{id:'synthetic-post',message:'Synthetic channel body',user_id:'synthetic',create_at:1}]});
  }});
  if(coldConcurrent){const first=e.run({channel:'engineering'}),second=e.run({channel:'engineering'});await two.promise;release.release();await Promise.all([first,second]);}else{const result=await e.run({channel:'engineering'});assert.equal(result.error,undefined);}
  const prior=e.f.calls.length;await e.run({channel:'engineering'});assert.equal(e.f.calls.length,prior+1,'cache hit retains original remote call count');assert.equal(listCalls,coldConcurrent?2:1);
  const reuse=e.store.transaction(tx=>tx.all('SELECT * FROM tool_dispatch_reuse'));assert.equal(reuse.length,1);assert.equal(reuse[0].state,'referenced');const creator=e.rows().find(r=>r.dispatch_id===reuse[0].origin_dispatch_id);assert.equal(creator.tool_name,'mattermost_list_channels');assert.equal(creator.state,'completed');
  const gated=e.store.transaction(tx=>readDiagnosticDispatches(tx,e.accepted.runId,{ownerId:e.store.assistantId,allowedClasses:['ordinary']}));assert.equal(gated.reuse[0].read_state,'allowed');
  e.store.transaction(tx=>tx.run("UPDATE history_sessions SET data_class='private',revision=revision+1 WHERE live_session_id=?",[e.accepted.runId]));assert.equal(e.store.transaction(tx=>readDiagnosticDispatches(tx,e.accepted.runId,{ownerId:e.store.assistantId,allowedClasses:['ordinary']})).reuse.length,0);
  results.push({case:coldConcurrent?'concurrent_cold_cache_misses':'cache_fill_and_reuse',listWireCalls:listCalls,reuseEdges:1,originalCreatorExplicit:true,currentClassDenial:true});
 }finally{release.release();await e?.close();}
}
{
 let e,failed=false;
 try{
  const tools=[{name:'mattermost_list_channels',inputSchema:{type:'object',properties:{limit:{type:'integer'}}}},{name:'mattermost_get_channel_history',inputSchema:{type:'object',properties:{channel:{type:'string'},limit:{type:'integer'}}}}];
  e=await environment({connector:'mattermost',name:'mattermost_get_channel_history',args:{channel:'engineering'},tools,toolNames:tools.map(t=>t.name),source:params=>JSON.stringify(params.name==='mattermost_list_channels'?{channels:[{id:'a'.repeat(26),name:'engineering'}]}:{posts:[]})});
  e.fault(sql=>{if(!failed&&sql.startsWith('UPDATE tool_dispatches SET state=')){failed=true;return true;}return false;});await e.run({channel:'engineering'});await e.run({channel:'engineering'});
  assert.equal(e.f.calls.filter(c=>c.name==='mattermost_list_channels').length,1);const row=e.store.transaction(tx=>tx.get('SELECT * FROM tool_dispatch_reuse'));assert.equal(row.state,'unavailable');assert.equal(row.origin_dispatch_id,null);results.push({case:'failed_creator_seal_keeps_live_cache',listWireCalls:1,reuse:'unavailable'});
 }finally{await e?.close();}
}
{
 let e;
 try{
  const tools=[{name:'gcal_calendars',inputSchema:{type:'object',properties:{maxResults:{type:'integer'}}}},{name:'gcal_list',inputSchema:{type:'object',properties:{calendarId:{type:'string'},maxResults:{type:'integer'},timeMin:{type:'string'},timeMax:{type:'string'}}}}];
  e=await environment({connector:'google',name:'gcal_list',args:{},tools,toolNames:tools.map(t=>t.name),source:params=>JSON.stringify({data:params.name==='gcal_calendars'?{calendars:[{id:'synthetic-primary',name:'Primary',primary:true},{id:'synthetic-other',name:'Other'}]}:{events:[{id:params.arguments.calendarId,summary:params.arguments.calendarId,start:{dateTime:'2026-10-19T09:00:00Z'}}]}})});
  const batch=await e.run({});assert.equal(batch.error,undefined);const rows=e.rows();assert.equal(rows.length,3);
  const result=e.store.transaction(tx=>JSON.parse(tx.get('SELECT result_json FROM tool_calls').result_json));assert.equal(result.sourceDispatchRefs.length,3);assert.equal(new Set(result.sourceDispatchRefs).size,3);
  for(const row of rows){const source=JSON.parse(row.source_json);if(row.tool_name==='gcal_list'){const args=JSON.parse(row.arguments_json);const body=JSON.parse(source.content[0].text);assert.equal(body.data.events.length,1);assert.equal(body.data.events[0].id,args.calendarId);}else assert.equal(JSON.parse(source.content[0].text).data.calendars.length,2);}
  results.push({case:'composed_calendar_child_references',wireCalls:3,resultChildRefs:3,noComposedBodyAssignedToChild:true});
 }finally{await e?.close();}
}

{
 let e;
 try{
  e=await environment();const result=await e.observedPort.call({endpointId:e.endpoint.id,toolName:'get_insight',arguments:{ids:[101]},generation:1,account:e.endpoint.account,resource:e.endpoint.resource});assert.equal(result.state,'completed');assert.equal(e.f.calls.length,1);assert.equal(e.rows().length,0);const coverage=e.coverage();assert.equal(coverage.length,1);assert.equal(coverage[0].kind,'unattributed');assert.equal(coverage[0].run_id,null);assert.equal(coverage[0].execution_id,null);assert.equal(coverage[0].reason,'wire_observed_context_absent');results.push({case:'absent_context_never_borrows_execution',wire:1,attributedBodies:0,unattributedMarker:1});
 }finally{await e?.close();}
}
{
 let e,nested;
 try{
  e=await environment({source:params=>`source ${params.arguments.ids[0]}`,reader:reader=>({call:async(name,args,signal)=>{if(args.ids[0]===101)await nested();return reader.call(name,args,signal);}})});nested=()=>e.run([202]);await e.run([101]);
  const calls=e.store.transaction(tx=>tx.all('SELECT execution_id,input_json FROM tool_calls'));for(const row of e.rows()){const owner=calls.find(call=>call.execution_id===row.execution_id);assert.deepEqual(JSON.parse(row.arguments_json).ids,JSON.parse(owner.input_json).ids);assert.equal(JSON.parse(row.arguments_json).include_links,false);assert.equal(row.ordinal,1);}assert.equal(e.rows().length,2);results.push({case:'nested_execution_restores_immutable_parent_context',executions:2,correctOrdinals:true});
 }finally{await e?.close();}
}
{
 const release=deferred();let e,late;
 try{
  e=await environment({reader:(reader,input)=>({call:async(name,args,signal)=>{const result=await reader.call(name,args,signal);late=release.promise.then(()=>input.port.call({endpointId:input.endpoint.id,toolName:name,arguments:args,generation:input.generation,account:input.endpoint.account,resource:input.endpoint.resource}));return result;}})});await e.run();release.release();const result=await late;assert.equal(result.state,'refused');assert.equal(e.f.calls.length,1);assert.equal(e.rows().length,1);assert(e.coverage().some(row=>row.kind==='pre_wire_rejected'));results.push({case:'scheduled_late_dispatch_after_parent_terminal',originalWire:1,newWire:0,preWireRejection:true});
 }finally{release.release();await e?.close();}
}
{
 const release=deferred(),entered=deferred(),returned=deferred();let e;
 try{
  e=await environment({source:async()=>{entered.release();await release.promise;return text;},wrap:adapter=>new Proxy(adapter,{get(target,key){if(key==='call')return async(...args)=>{const result=await target.call(...args);returned.release();return result;};const value=target[key];return typeof value==='function'?value.bind(target):value;}})});
  const controller=new AbortController(),running=e.run([101],controller.signal);await entered.promise;controller.abort();await running;await returned.promise;await tick();const row=e.rows()[0];assert.equal(row.wire_state,'observed');assert.equal(row.source_outcome,'unknown');assert.equal(row.state,'unavailable');assert.equal(row.source_json,null);release.release();await tick();await tick();assert.equal(e.rows()[0].state,'unavailable');results.push({case:'actual_inflight_abort_not_assumed_source_completion',wire:1,sourceOutcome:'unknown',noLateOverwrite:true});
 }finally{release.release();await e?.close();}
}
{
 let e;
 try{
  e=await environment({privateContext:true});await e.run();const row=e.rows()[0];assert.equal(row.session_class,'private');assert.equal(row.source_class,'ordinary');assert.equal(row.state,'completed');
  const ordinary=e.store.transaction(tx=>readDiagnosticDispatches(tx,e.accepted.runId,{ownerId:e.store.assistantId,allowedClasses:['ordinary']}));assert.equal(ordinary.access.state,'denied');
  const permitted=e.store.transaction(tx=>readDiagnosticDispatches(tx,e.accepted.runId,{ownerId:e.store.assistantId,allowedClasses:['ordinary','private']}));assert.equal(permitted.dispatches[0].read_state,'allowed');results.push({case:'private_conversation_ordinary_source',captureClass:'private',sourceClass:'ordinary',ordinaryReaderDenied:true,authorizedReaderAllowed:true});
 }finally{await e?.close();}
}
{
 let e,failed=false;
 try{
  e=await environment({log:()=>{throw Error('synthetic observer unavailable');}});e.fault(sql=>{if(!failed&&sql.startsWith('INSERT INTO tool_dispatches')){failed=true;return true;}return false;});await e.run();assert.equal(e.f.calls.length,1,'diagnostic log failure must not suppress the authorized source call');results.push({case:'capture_write_and_log_observer_failure',sourceStillCalled:true});
 }finally{await e?.close();}
}
{
 const stop=new AbortController();let e,slices=0;
 try{
  e=await environment({wrap:adapter=>new Proxy(adapter,{get(target,key){if(key==='readSlice')return request=>{const value=target.readSlice(request);if(++slices===2)stop.abort();return value;};const value=target[key];return typeof value==='function'?value.bind(target):value;}})});
  const batch=await e.run([101],stop.signal);assert(batch.error);assert(slices>=2);const row=e.rows()[0];assert.equal(row.state,'completed');assert(row.source_json.includes(tail));assert.notEqual(e.store.transaction(tx=>tx.get('SELECT state FROM tool_calls')).state,'completed');results.push({case:'consumer_cancel_during_verified_reassembly',sourceTailRetained:true,modelDeliveryNotClaimed:true});
 }finally{await e?.close();}
}
{
 let e;
 try{
  e=await environment({source:()=>({content:[],structuredContent:{body:'Synthetic unsupported structured source'}})});await e.run();const row=e.rows()[0];assert.equal(row.state,'unavailable');assert.equal(row.reason,'structured_source_projection_unavailable');assert.equal(row.source_json,null);results.push({case:'unsupported_structured_source',fullBodyClaim:false,reason:row.reason});
 }finally{await e?.close();}
}
{
 let e;
 try{
  e=await environment({wrap:adapter=>new Proxy(adapter,{get(target,key){if(key==='call')return async(...args)=>{const value=await target.call(...args);if('decodedResult' in value)value.decodedResult={content:[{type:'text',text:'Synthetic decoded tamper'}]};return value;};const value=target[key];return typeof value==='function'?value.bind(target):value;}})});await e.run();const row=e.rows()[0];assert.equal(row.state,'unavailable');assert.equal(row.reason,'source_decoded_entity_mismatch');assert.equal(row.source_json,null);results.push({case:'decoded_content_must_match_verified_entity',tamperedBodyWithheld:true});
 }finally{await e?.close();}
}
{
 let e;
 try{
  e=await environment();await e.run({ids:[101],authorization:'synthetic-credential-value-never-retain'});const call=e.store.transaction(tx=>tx.get('SELECT * FROM tool_calls'));assert.equal(call.input_json,null);assert.equal(call.input_fidelity,'hash_only_unsupported_v1');assert.equal(call.input_key_count,2);assert(!call.result_json.includes('synthetic-credential-value-never-retain'));const row=e.rows()[0];assert.equal(row.arguments_key_count,2);assert(!row.arguments_json.includes('authorization'));assert.equal(JSON.parse(row.arguments_json).include_links,false);
  for(const bad of [-1,'invalid'])assert.throws(()=>e.store.transaction(tx=>tx.run("INSERT INTO tool_calls(owner_id,run_id,execution_id,intent_json,state,input_key_count) VALUES(?,?,?,'{}','intent',?)",[e.store.assistantId,e.accepted.runId,'invalid-count',bad])),/input_count_invalid/);
  results.push({case:'closed_input_projection_counts_and_sql_guard',requestedFidelity:'hash_only_unsupported_v1',requestedKeyCount:2,effectiveKeyCount:2,unknownCredentialValueAbsent:true,invalidCountsDenied:true});
 }finally{await e?.close();}
}
console.log(JSON.stringify({case:'canonical_source_dispatch_controls',results}));
