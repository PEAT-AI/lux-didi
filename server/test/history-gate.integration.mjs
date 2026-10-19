import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {Store} from '../dist/runtime/store.js';
import {domainMigrations} from '../dist/domain/schema.js';
import {toolsMigrations,createToolsOwner} from '../dist/tools/index.js';
import {McpRegistry} from '../dist/adapters/mcp/registry.js';
import {runToolCalls} from '../dist/tools/declarations.js';
import {createSession,appendEntry,deleteEntry} from '../dist/domain/memory.js';
import {correct} from '../dist/domain/labels.js';
import {HOST_EVIDENCE} from '../dist/tools/types.js';
const signal=new AbortController().signal;
async function replay(mutation){
 const dir=mkdtempSync('/tmp/didi-history-gate-'),store=new Store(dir,[...domainMigrations,...toolsMigrations]);
 try{
  store.transaction(tx=>{const clock={now:()=>1};createSession(tx,{title:'Synthetic',startedAt:1,timeZone:'UTC'},clock,'session');appendEntry(tx,{sessionId:'session',text:'Cobalt private evidence.',capturedAt:1,timeZone:'UTC'},clock,'entry');for(const kind of ['session','entry'])correct(tx,{subject:{kind,id:kind},expectedRevision:0,dataClass:'private'},1);});
  const accepted={ownerId:store.assistantId,actorId:'actor',runId:'run',authorityEpoch:store.authorityEpoch,revision:1,route:{identity:'route',provider:'gemini',modelId:'synthetic',allowedClasses:['ordinary','private']},allowedClasses:['ordinary','private'],connectionIds:[]};
  let authority;const owner=createToolsOwner({store,registry:new McpRegistry(),port:{},ownerId:store.assistantId,grantMode:'owner-trusted-reads',lookupAuthority:async()=>authority});
  const hash=store.transaction(tx=>owner.snapshotRun(tx,accepted).sha256);authority={...accepted,acceptedRunHash:hash};
  const definitions=owner.definitions('run');assert.equal(definitions.length,1);const original=definitions[0];assert.equal(original.name,'conversation_history');
  const host={runId:'run',actorId:'actor',authorityEpoch:store.authorityEpoch,revision:1,grants:definitions.map(t=>({tool:t.name,effect:t.effect,accountId:t.accountId,resourceId:t.resourceId}))};
  let ready,release;const staged=new Promise(r=>ready=r),held=new Promise(r=>release=r);
  let firstResult;
  const wrapped={...original,execute:async(args,context)=>{if(args.query==='pending')await held;const value=await original.execute(args,context);if(args.query==='Cobalt'){firstResult=value;ready();}return value;}};
  const batch=runToolCalls(owner,[{id:'one',name:original.name,args:{query:'Cobalt'}},{id:'two',name:original.name,args:{query:'pending'}}],{registry:[wrapped],host,authority:{isCurrent:async()=>authority!==null},control:{signal,deadlineMs:Date.now()+10000},step:0,contentIndex:0,seenIds:new Set(),baseClasses:['ordinary'],authorize:true});
  await staged;
  if(mutation==='delete')store.transaction(tx=>deleteEntry(tx,'entry',new Date().toISOString(),'synthetic'));
  if(mutation==='relabel')store.transaction(tx=>correct(tx,{subject:{kind:'session',id:'session'},expectedRevision:1,dataClass:'sensitive'},2));
  if(mutation==='revoke')authority=null;
  release();const result=await batch;
  if(mutation==='none'){
   assert.equal(result.accepted.length,2);assert.equal(result.accepted[0].dataClasses[0],'private');
   const consumed=owner.consumeEvidence(host,result.bindings[0],authority,signal);assert.equal(consumed.state,'allowed');assert.equal(consumed.evidence.kind,'local-history');
   const raw=store.transaction(tx=>tx.get('SELECT result_json FROM tool_calls WHERE result_id=?',[firstResult.result.id]).result_json);assert(!raw.includes('fingerprint'));assert(!JSON.stringify(result.accepted).includes('fingerprint'));
   assert.equal(JSON.stringify({response:{ok:true},[HOST_EVIDENCE]:consumed.evidence}),'{"response":{"ok":true}}');
  }else{assert.equal(result.accepted.length,0);assert.equal(owner.authorizeDelivery(host,[{executionId:'run:0:0',name:original.name,callId:'one',contentIndex:0,partIndex:0,result:firstResult.result}],[],authority,signal).state,'refused');}
  return {mutation,accepted:result.accepted.length,denied:mutation!=='none'};
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
const cases=[];for(const mutation of ['none','delete','relabel','revoke'])cases.push(await replay(mutation));console.log(JSON.stringify({case:'canonical_history_delivery_gate',pendingSiblingCases:cases,hostOnlyReferenceNeverSerialized:true}));
