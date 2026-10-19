import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {openFixture,result} from '../dist/test/chat-process.js';
import {ChatService} from '../dist/chat/index.js';
import {createToolsOwner,toolsMigrations} from '../dist/tools/index.js';
import {McpRegistry} from '../dist/adapters/mcp/registry.js';
import {createSession,appendEntry,deleteEntry} from '../dist/domain/memory.js';
import {correct} from '../dist/domain/labels.js';
const all=['ordinary','private','sensitive'];
async function replay(mode){
 const dir=mkdtempSync('/tmp/didi-history-chat-continuation-'),realNow=Date.now;let now=realNow(),chat,f,cursor,recordRef,phase=1,calls=0,lastPage,firstRun,expected='ok';Date.now=()=>now;
 const text='Mira chose ultraviolet flags. '+'Synthetic preserved historical detail. '.repeat(220);
 const model={generate:async request=>{
  calls++;const replies=request.contents.flatMap(c=>c.parts.flatMap(p=>p.functionResponse?.name==='conversation_history'?[p.functionResponse.response]:[]));
  const call=args=>({...result(request,'complete',''),providerContent:{role:'model',parts:[{functionCall:{name:'conversation_history',id:'h'+calls,args}}]}});
  if(phase===1){if(!replies.length)return call({query:'Mira ultraviolet flags'});if(replies.at(-1).hits){recordRef=replies.at(-1).hits[0].recordRef;return call({recordRef});}cursor=replies.at(-1).nextCursor;assert(cursor);return result(request,'complete','First bounded page received.');}
  if(!replies.length)return call(mode==='new-search'?{query:'fresh unrelated'}:{cursor});
  if(mode==='new-search'&&replies.length===1)return call({cursor});
  const page=replies.at(-1);assert.equal(page.status,expected,JSON.stringify(page));
  if(mode==='none'){assert.equal(page.text,text.slice(6000));if(replies.length===1){lastPage=page;return call({cursor});}assert.deepEqual(page,lastPage);}
  return result(request,'complete',expected==='ok'?'Second canonical page received.':'Exact prior coordinate is unavailable.');
 }};
 f=openFixture(dir,model,{now:()=>now,route:{provider:'gemini',model:'synthetic',available:true,allows:()=>true,endpoint:'https://example.invalid',apiVersion:'v1',keyReference:'synthetic',allowedClasses:[...all]}},undefined,toolsMigrations);
 const owner=createToolsOwner({store:f.store,registry:new McpRegistry(),port:{},ownerId:f.store.assistantId,grantMode:'owner-trusted-reads',lookupAuthority:async id=>chat?.lookupAuthority(id)??null});
 const config={...f.config,tools:{owner,connectionIds:()=>[]}};
 chat=new ChatService(config);chat.recover(f.recoveryContext);
 try{
  f.store.transaction(tx=>{createSession(tx,{title:'Synthetic archive',startedAt:0,timeZone:'UTC'},{now:()=>0},'parent');appendEntry(tx,{sessionId:'parent',text,capturedAt:0,timeZone:'UTC'},{now:()=>0},'entry');for(const subject of [{kind:'session',id:'parent'},{kind:'entry',id:'entry'}])correct(tx,{subject,expectedRevision:0,dataClass:'sensitive'},0);});
  const enroll=key=>chat.enroll({title:'Synthetic text',timeZone:'UTC',idempotencyKey:key},f.context).sessionId;let sessionId=enroll('first');
  async function turn(key){const accepted=chat.accept({sessionId,text:'Continue the discussion',idempotencyKey:key},f.context);for await(const event of chat.subscribe(accepted.runId,f.context))if(event.type==='snapshot'&&event.run.state==='terminal')return event.run;throw Error('no final');}
  firstRun=await turn('first-turn');assert.equal(firstRun.outcome,'complete');phase=2;
  if(mode==='delete'){f.store.transaction(tx=>deleteEntry(tx,'entry',new Date(now).toISOString(),'synthetic'));expected='history_snapshot_invalidated';}
  if(mode==='relabel'){f.store.transaction(tx=>correct(tx,{subject:{kind:'entry',id:'entry'},expectedRevision:1,dataClass:'private'},now));expected='history_snapshot_invalidated';}
  if(mode==='other-conversation'){sessionId=enroll('other');expected='history_reference_unavailable';}
  if(mode==='cancel'){chat.cancel(firstRun.runId,f.context);expected='history_reference_unavailable';}
  if(mode==='revoke'){chat.revoke(sessionId,f.context);sessionId=enroll('new-grant');expected='history_reference_unavailable';}
  if(mode==='shutdown'){chat.shutdown();chat=new ChatService(config);chat.recover(f.recoveryContext);expected='history_reference_unavailable';}
  if(mode==='expiry'){now+=31*60000;expected='history_reference_unavailable';}
  if(mode==='new-search')expected='history_reference_unavailable';
  if(mode==='route'||mode==='classes'){if(mode==='route')config.route.keyReference='new-synthetic-generation';else config.route.allowedClasses=['ordinary'];chat.shutdown();chat=new ChatService(config);chat.recover(f.recoveryContext);const before=calls;assert.throws(()=>chat.accept({sessionId,text:'Continue',idempotencyKey:'route-change'},f.context),/route_changed/);assert.equal(calls,before);return {mode,currentConsentDenied:true};}
  const second=await turn('second-turn');assert.equal(second.outcome,'complete',JSON.stringify(second));
  const rows=f.store.transaction(tx=>tx.all("SELECT run_id,state FROM tool_calls WHERE json_extract(intent_json,'$.toolName')='conversation_history'"));assert(rows.some(r=>r.run_id===firstRun.runId));assert(rows.some(r=>r.run_id===second.runId));assert.notEqual(second.runId,firstRun.runId);
  return {mode,status:expected,freshCurrentRun:true,repeatedPageIdempotent:mode==='none'};
 }finally{chat.shutdown();f.chat.shutdown();f.store.close();rmSync(dir,{recursive:true,force:true});Date.now=realNow;}
}
const controls=[];for(const mode of ['none','delete','relabel','other-conversation','cancel','revoke','shutdown','expiry','new-search','route','classes'])controls.push(await replay(mode));console.log(JSON.stringify({case:'actual_chat_history_continuation',controls}));
