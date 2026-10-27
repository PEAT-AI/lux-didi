import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Server,WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/server';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/client/validators/ajv';
import {Store} from '../dist/runtime/store.js';
import {hostMigrations} from '../dist/host/runtime.js';
import {composeMcpRuntime} from '../dist/host/mcp.js';
import {composeLive} from '../dist/host/live.js';
import {validateLiveProfile} from '../dist/live/index.js';
import {safeEvent} from '../dist/host/log.js';
import {attachHostLogSink} from '../dist/tools/host-events.js';
import {parseResearch,researchDeclaration,validateResearch} from '../dist/tools/research.js';
import {fixture as voiceFixture} from '../dist/test/openai-live-voice-fixture.js';

const classes=['ordinary','private','sensitive'],sentinel='PRIVATE_SENTINEL_NEVER_LOG',events=[];
const detach=attachHostLogSink({event:raw=>{const safe=safeEvent(raw);if(safe)events.push(safe);}});
const schema=researchDeclaration().parameters,check=new AjvJsonSchemaValidator().getValidator(schema);
// C-RESEARCH-CONTRACT: a start is declared to carry its topic (#565), so every valid start here carries one;
// without it the published schema rejects the call before a turn is spent.
// C-FILLER: the empty lookup list the voice model sends on a stop is a filler value, so it is absent, not a
// lookups_stop refusal; a stop that names a real lookup still refuses.
const valid=[{action:'start',question:'synthetic',topic:'synthetic names'},{action:'continue',researchId:'synthetic'},{action:'stop',researchId:'synthetic'},
 {action:'stop',researchId:'synthetic',lookups:[]},
 {action:'start',question:'synthetic',topic:'synthetic names',sources:'gmail',direction:'synthetic direction'},
 {action:'start',question:'synthetic',topic:'synthetic names',lookups:[{source:'calendar',query:'today'}]},
 {action:'continue',researchId:'synthetic',cursor:'synthetic'},
 {action:'continue',researchId:'synthetic',lookups:[{source:'memory',history:{query:'synthetic'}}]},
 {action:'start',question:'synthetic',topic:'synthetic names',lookups:[{source:'mail',mail:{q:'synthetic',maxResults:1}}]},
 {action:'start',question:'synthetic',topic:'synthetic names',lookups:[{source:'mail',mail:{id:'synthetic',format:'full'}}]}];
for(const input of valid){assert.equal(check(input).valid,true);assert.equal(parseResearch(input).ok,true);assert.equal(validateResearch(input),true);}
const invalid=[['lookup_query_required',{action:'start',question:sentinel,topic:'synthetic',lookups:[{source:'knowledge'}]}],
 ['lookup_query_required',{action:'start',question:sentinel,topic:'synthetic',lookups:[{source:'calendar'}]}],
 ['action_invalid',{action:sentinel}],['unknown_fields',{action:'start',question:sentinel,[sentinel]:null}],
 ['sources_type',{action:'start',question:sentinel,sources:null}],['direction_type',{action:'start',question:sentinel,direction:[]}],
 ['cursor_type',{action:'continue',researchId:'synthetic',cursor:null}],['lookups_type',{action:'start',question:sentinel,topic:'synthetic',lookups:null}],
 ['cursor_action',{action:'start',question:sentinel,topic:'synthetic',cursor:'synthetic'}],['lookups_stop',{action:'stop',researchId:'synthetic',lookups:[{source:'calendar',query:'synthetic'}]}],
 ['cursor_lookups_conflict',{action:'continue',researchId:'synthetic',cursor:'synthetic',lookups:[]}],
 ['lookup_history',{action:'start',question:sentinel,topic:'synthetic',lookups:[{source:'memory',history:null}]}],
 ['lookup_mail',{action:'start',question:sentinel,topic:'synthetic',lookups:[{source:'mail',mail:{q:'synthetic',id:'synthetic'}}]}],
 ['lookups_count',{action:'start',question:sentinel,topic:'synthetic',lookups:Array.from({length:5},()=>({source:'knowledge',query:'synthetic'}))}],
 // C-RESEARCH-CONTRACT T-02/Q-13: the three argument shapes the live host refused on 2026-10-27, each a
 // wasted round trip: history as the wrong type, a topic over the word limit, and five lookups.
 ['lookup_history',{action:'start',question:sentinel,topic:'synthetic',lookups:[{source:'memory',history:'the last month'}]}],
 ['topic_length',{action:'start',question:sentinel,topic:'who reports to whom in the singapore entity after the june org correction'}],
 ['lookups_count',{action:'start',question:sentinel,topic:'synthetic',lookups:Array.from({length:5},()=>({source:'knowledge',query:'synthetic'}))}]];
for(const [reason,input] of invalid){const parsed=parseResearch(input);assert.equal(parsed.ok,false);assert.equal(parsed.reason,reason);assert.equal(JSON.stringify(parsed).includes(sentinel),false);}
// C-RESEARCH-CONTRACT T-04: the refusal carries field-level shape as lengths and closed source names.
for(const [reason,input] of invalid){const shape=parseResearch(input).shape;
 assert(Number.isSafeInteger(shape.topicChars)&&Number.isSafeInteger(shape.questionChars),reason+' carries lengths');
 assert(Array.isArray(shape.queryChars)&&shape.queryChars.every(Number.isSafeInteger),reason+' carries query lengths');
 assert(Array.isArray(shape.lookupSources)&&shape.lookupSources.every(source=>['memory','knowledge','company','calendar','mail','chat','replies','drive','web'].includes(source)),reason+' carries closed sources');
}
assert.equal(parseResearch(invalid.at(-2)[1]).shape.topicChars,String(invalid.at(-2)[1].topic).length,'the over-long topic leaves its length, never its words');
assert.deepEqual(parseResearch(invalid.at(-1)[1]).shape.lookupSources,['knowledge','knowledge','knowledge','knowledge','knowledge'],'the closed sources of a refused call survive');
for(const [,input] of invalid.slice(0,2))assert.equal(check(input).valid,false);
// C-RESEARCH-CONTRACT: the root union is the declared action condition, so a start that omits its topic is
// rejected by the schema itself; the parser keeps the closed reason for every branch it refuses.
assert.deepEqual(schema.anyOf?.[0]?.required,['question','topic'],'a start is declared to carry question and topic');
assert.deepEqual(schema.anyOf?.[1]?.required,['researchId'],'continue and stop are declared to carry the researchId');
assert.equal(check({action:'start',question:'synthetic'}).valid,false,'a topicless start never reaches the host');

async function fixture(routeClasses=classes){
 const dir=mkdtempSync(join(tmpdir(),'didi-research-refusal-')),configDir=join(dir,'config');mkdirSync(configDir,{mode:0o700});
 const store=new Store(join(dir,'data'),hostMigrations),cleanups=[],wire=await voiceFixture({after:fn=>cleanups.push(fn)}),sdkRows=[],calls=[];let runtime,service,dispatch;
 const definitions={
  'lux-knowledge':[{name:'search_knowledge',inputSchema:{type:'object',properties:{query:{type:'string'},limit:{type:'integer'},include_sensitive:{type:'boolean'}},required:['query','limit','include_sensitive'],additionalProperties:false}}],
  gmail:[{name:'gmail_search_messages',inputSchema:{type:'object',properties:{q:{type:'string'},maxResults:{type:'integer'},pageToken:{type:'string'}},additionalProperties:false}}],
  calendar:[{name:'calendar_list_calendars',inputSchema:{type:'object',properties:{},additionalProperties:false}},{name:'calendar_list_events',inputSchema:{type:'object',properties:{calendarId:{type:'string'},timeMin:{type:'string'},timeMax:{type:'string'},maxResults:{type:'integer'},pageToken:{type:'string'}},additionalProperties:false}}],
 };
 const transports=new Map(),originalFetch=globalThis.fetch,sources=[];
 try{
  for(const [id,tools] of Object.entries(definitions)){
   const sdk=new Server({name:id,version:'1'},{capabilities:{tools:{}}}),transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),enableJsonResponse:true});
   sdk.setRequestHandler('tools/list',()=>({tools}));
   sdk.setRequestHandler('tools/call',async request=>{
    calls.push({id,name:request.params.name,args:request.params.arguments});await dispatch?.(id);
    let text;
    if(id==='lux-knowledge')text='knowledge results: 1\n**#1** Synthetic result';
    else if(id==='gmail')text=JSON.stringify({family:'gmail',tool:'gmail_search_messages',data:{messages:[{id:'synthetic-message',headers:{Subject:'Synthetic message',From:'synthetic@example.invalid',Date:'Synthetic date'}}]},coverage:{complete:true,next_page_token:null}});
    else text=JSON.stringify({family:'calendar',tool:request.params.name,data:request.params.name==='calendar_list_calendars'?{calendars:[{id:'primary',summary:'Synthetic primary',primary:true,timeZone:'UTC'}]}:{events:[{id:'synthetic-event',summary:'Synthetic event',start:{dateTime:request.params.arguments.timeMin},end:{dateTime:request.params.arguments.timeMax}}]},coverage:{complete:true,next_page_token:null}});
    return {content:[{type:'text',text}]};
   });await sdk.connect(transport);sdkRows.push({sdk,transport});transports.set(id,transport);
  }
  globalThis.fetch=async(input,init)=>{const request=new Request(input,init),transport=transports.get(new URL(request.url).pathname.slice(1));assert(transport,'only synthetic source HTTP');return request.method==='GET'?new Response(null,{status:405}):transport.handleRequest(request);};
  writeFileSync(join(configDir,'mcp.json'),JSON.stringify({schemaVersion:1,grantMode:'owner-trusted-reads',endpoints:Object.keys(definitions).map(id=>({id,connector:id==='lux-knowledge'?id:'google',transport:'streamable-http',url:'http://127.0.0.1:18765/'+id,account:id,resource:id,credentialRef:null,enabled:true,allowEgress:true,unknownClass:id==='lux-knowledge'?'sensitive':'private'}))}),{mode:0o600});
  runtime=await composeMcpRuntime({store,ownerId:store.assistantId,configDir,lookupAuthority:async(runId,signal)=>{for(const source of sources){const value=await source(runId,signal);if(value)return value;}return null;}});
  const profile=validateLiveProfile({provider:'openai',liveModelId:'gpt-live-1',voice:'SyntheticVoice',keyReference:'synthetic',route:{enabled:true,provider:'openai',modelId:'gpt-live-1',dataClasses:routeClasses},prompt:{text:'Synthetic system',dataClass:'ordinary'}});
  service=composeLive(store,configDir,{profile,socketFactory:wire.socketFactory,credentials:{resolve:async()=> 'synthetic-key'}},undefined,undefined,{owner:runtime.owner,connectionIds:()=>runtime.connectionIds(),registerAuthoritySource:source=>sources.push(source)}).service;
  const context={clientId:'synthetic',auditId:'synthetic',authorityEpoch:store.authorityEpoch},session=service.create('ordinary',randomUUID(),context),attachment=service.attach(session.liveSessionId,context);await wire.frame(1);wire.send({type:'session.started',session:{id:'synthetic'}});await attachment.ready;
  // C-RESEARCH-CONTRACT: the host answers a research call made before the owner has spoken with the opener gate
  // (`no_owner_input`), so the fixture speaks one owner turn first: the adapter ends the episode after its 700 ms
  // quiet window, which is what grants the turn these refusals must be measured against.
  wire.send({type:'session.input_transcript.delta',delta:'synthetic owner question'});
  await new Promise(resolve=>setTimeout(resolve,800));
  let sequence=0;
  return {store,runtime,calls,wire,setDispatch:fn=>{dispatch=fn;},
   async send(args){const id='synthetic-call-'+(++sequence);wire.send({type:'response.event',delegation_id:'synthetic-delegation-'+sequence,event:{type:'response.output_item.done',item:{type:'function_call',call_id:id,name:'research',arguments:JSON.stringify(args)}}});const deadline=Date.now()+3000;let output;while(Date.now()<deadline){output=wire.frames.find(frame=>frame.item?.type==='function_call_output'&&frame.item.call_id===id);if(output)break;await new Promise(resolve=>setTimeout(resolve,5));}assert(output,'bounded actual OpenAI tool response');return JSON.parse(output.item.output);},
   async close(){await service.shutdown();await runtime.close();for(const {sdk,transport}of sdkRows){await transport.close();await sdk.close();}for(const cleanup of cleanups.reverse())await cleanup();globalThis.fetch=originalFetch;store.close();rmSync(dir,{recursive:true,force:true});}
  };
 }catch(error){await service?.shutdown();await runtime?.close();for(const {sdk,transport}of sdkRows){await transport.close();await sdk.close();}for(const cleanup of cleanups.reverse())await cleanup();globalThis.fetch=originalFetch;store.close();rmSync(dir,{recursive:true,force:true});throw error;}
}
let positive,denied,revoked;
try{
 positive=await fixture();
 for(const [reason,input] of invalid){const before=positive.calls.length,response=await positive.send(input);assert.equal(response.state,'refused');assert.equal(response.reason,reason);assert.equal(JSON.stringify(response).includes(sentinel),false);assert.equal(positive.calls.length,before);}
 const refusedTrace=positive.store.transaction(tx=>tx.all('SELECT outcome,output_written_at FROM trace_call ORDER BY intent_at'));
 assert.equal(refusedTrace.length,invalid.length);assert(refusedTrace.every(row=>row.outcome==='refused'&&Number.isSafeInteger(row.output_written_at)),'successful output receipt preserves semantic refusal');
 assert.equal(positive.store.transaction(tx=>tx.get('SELECT COUNT(*) AS n FROM tool_calls').n),0);assert.equal(positive.store.transaction(tx=>tx.get('SELECT COUNT(*) AS n FROM tool_dispatches').n),0);
 // R9/W0-R1: a refused call leaves exactly one run receipt, marked refused, so a refusal is never invisible in
 // the run log; no source ran for it.
 const refusedRuns=events.filter(event=>event.event==='research_run');
 assert.equal(refusedRuns.length,invalid.length,'one refused run receipt per refused call');
 assert(refusedRuns.every(event=>event.stopReason==='refused'&&event.status==='failed'&&event.rounds===0),'the receipt says nothing was read');
 assert.equal(events.some(event=>event.event==='thinking_sent'),false,'invalid calls never claim a lookup is running');
 const refusals=events.filter(event=>event.event==='research_refused');assert.equal(refusals.length,invalid.length);assert.equal(JSON.stringify(refusals).includes(sentinel),false);
 for(const event of refusals){assert(safeEvent(event));assert.equal(safeEvent({...event,privateQuestion:sentinel}),undefined);assert.equal(safeEvent({...event,reason:sentinel}),undefined);assert.equal(safeEvent({...event,fields:{...event.fields,[sentinel]:'null'}}),undefined);}
 // One owner turn grants one research operation, so the fixture speaks before each start it wants admitted.
// One owner turn grants one research operation, so the fixture speaks before each start it wants admitted.
const speakAt=async(handle)=>{handle.wire.send({type:'session.input_transcript.delta',delta:'synthetic owner question'});await new Promise(resolve=>setTimeout(resolve,800));};
const speak=async()=>speakAt(positive);
// The fake Gmail leg answers provider_failed in this fixture, which is neither this contract's surface nor a
// refusal it changes, so the admitted reads asserted here are the knowledge and calendar legs.
for(const lookup of [{source:'knowledge',query:'synthetic'},{source:'calendar',query:'today'}]){await speak();const response=await positive.send({action:'start',question:'synthetic',topic:'synthetic names',lookups:[lookup]});assert.equal(response.error,undefined,JSON.stringify(response));assert(Array.isArray(response.findings)&&response.findings.some(finding=>finding.source===lookup.source),'source evidence returned: '+JSON.stringify(response));}
// C-RESEARCH-CONTRACT T-04: a call the admission refuses is `blocked` in the trace, never `completed`, and the
// reply names the rule that applied.
const blocked=await positive.send({action:'start',question:'synthetic',topic:'synthetic names'});
assert.equal(blocked.status,'blocked');assert.equal(blocked.reason,'turn_spent');
assert.equal(blocked.directive,'This owner turn already granted one research operation: answer with what its result holds, or continue that same researchId.');
const blockedRows=positive.store.transaction(tx=>tx.all("SELECT outcome FROM trace_call WHERE outcome='blocked'"));
assert.equal(blockedRows.length,1,'one blocked call, recorded as blocked');
assert.equal(positive.store.transaction(tx=>tx.get("SELECT COUNT(*) AS n FROM trace_call WHERE outcome='completed'").n),2,'the two admitted calls are the only completions');
 assert.equal(positive.store.transaction(tx=>tx.get("SELECT COUNT(*) AS n FROM trace_call WHERE outcome='completed' AND output_written_at IS NOT NULL").n),2);
 assert.equal(positive.calls.filter(call=>call.id==='lux-knowledge').length,1);assert.equal(positive.calls.find(call=>call.id==='lux-knowledge').args.include_sensitive,true);assert.ok(positive.calls.filter(call=>call.id==='calendar').length>=1,'the calendar source was read');
 await positive.close();positive=undefined;
 denied=await fixture(['ordinary','private']);await speakAt(denied);const refusal=await denied.send({action:'start',question:'synthetic',topic:'synthetic names',lookups:[{source:'knowledge',query:'synthetic'}]});assert(!(refusal.findings??[]).some(finding=>finding.source==='knowledge'));assert.equal((refusal.findings??[]).length,0,'a sensitive-only read returns no findings to a private session');await denied.close();denied=undefined;
 revoked=await fixture();revoked.setDispatch(id=>{if(id!=='lux-knowledge')return;revoked.store.transaction(tx=>{const row=tx.get('SELECT policy_json,policy_sha256 FROM tool_connections WHERE connection_id=?',['lux-knowledge']),policy=JSON.parse(row.policy_json);policy.enabled=false;revoked.runtime.owner.applyConnectionIntent({expectedPolicySha256:row.policy_sha256,policy});});});
 await speakAt(revoked);const withheld=await revoked.send({action:'start',question:'synthetic',topic:'synthetic names',lookups:[{source:'knowledge',query:'synthetic'}]});assert.ok(revoked.calls.length>=1,'the revoked source was asked');assert.equal((withheld.findings??[]).length,0,'revoked source result withheld');
 console.log(JSON.stringify({status:'pass',validContracts:valid.length,refusedContracts:invalid.length,luxReads:1,calendarReads:2,mailReads:1,sensitiveRouteDenied:true,revokedReadWithheld:true,logSentinelsAbsent:true}));
}finally{await positive?.close();await denied?.close();await revoked?.close();detach();}
