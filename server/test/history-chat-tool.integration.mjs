import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {openFixture,result} from '../dist/test/chat-process.js';
import {ChatService} from '../dist/chat/index.js';
import {createToolsOwner,toolsMigrations} from '../dist/tools/index.js';
import {McpRegistry} from '../dist/adapters/mcp/registry.js';
import {createSession,appendEntry,deleteEntry} from '../dist/domain/memory.js';
import {correct} from '../dist/domain/labels.js';
const all=['ordinary','private','sensitive'];
async function replay(deleted){
 const dir=mkdtempSync('/tmp/didi-history-chat-tool-');let chat,f,oldRef,calls=0,secondTurn=false;const requests=[];
 const model={generate:async(request,control)=>{
  requests.push(request);calls++;
  const replies=request.contents.flatMap(c=>c.parts.flatMap(p=>p.functionResponse?.name==='conversation_history'?[p.functionResponse.response]:[]));
  const call=args=>({...result(request,'complete',''),providerContent:{role:'model',parts:[{functionCall:{name:'conversation_history',id:'history-'+calls,args}}]}});
  if(secondTurn){if(!replies.length)return call({recordRef:oldRef});assert.equal(replies.at(-1).status,'ok');assert.match(replies.at(-1).text,/violet flags/);return result(request,'complete','Prior coordinate resolved under this turn authority.');}
  if(!replies.length){assert(request.declarations.some(d=>d.name==='conversation_history'));return call({query:'Mira violet flags'});}
  const page=replies.at(-1);if(page.hits){oldRef=page.hits[0].recordRef;return call({recordRef:oldRef});}
  assert.match(page.text,/violet flags/);assert(request.dataClasses.includes('sensitive'));
  control.onEvent?.({type:'text',text:'Earlier lawful receipt.',provisional:true});
  if(deleted)f.store.transaction(tx=>deleteEntry(tx,'source-entry',new Date().toISOString(),'synthetic'));
  control.onEvent?.({type:'text',text:'Later synthesized receipt.',provisional:true});
  return result(request,'complete','Blended answer from Cobalt evidence.');
 }};
 f=openFixture(dir,model,{now:Date.now,route:{provider:'gemini',model:'synthetic',available:true,allows:()=>true,endpoint:'https://example.invalid',apiVersion:'v1',keyReference:'synthetic',allowedClasses:all}},undefined,toolsMigrations);
 const owner=createToolsOwner({store:f.store,registry:new McpRegistry(),port:{},ownerId:f.store.assistantId,grantMode:'owner-trusted-reads',lookupAuthority:async id=>chat?.lookupAuthority(id)??null});
 chat=new ChatService({...f.config,tools:{owner,connectionIds:()=>[]}});chat.recover(f.recoveryContext);
 try{
  f.store.transaction(tx=>{createSession(tx,{title:'Synthetic archive',startedAt:0,timeZone:'UTC'},{now:()=>0},'source-parent');appendEntry(tx,{sessionId:'source-parent',text:'Cobalt discussion with Mira decided violet flags.',capturedAt:0,timeZone:'UTC'},{now:()=>0},'source-entry');for(const subject of [{kind:'session',id:'source-parent'},{kind:'entry',id:'source-entry'}])correct(tx,{subject,expectedRevision:0,dataClass:'sensitive'},0);});
  const sessionId=chat.enroll({title:'Synthetic text',timeZone:'UTC',idempotencyKey:'session'},f.context).sessionId;
  async function turn(key){const accepted=chat.accept({sessionId,text:'Recall Cobalt',idempotencyKey:key},f.context);const events=[];for await(const event of chat.subscribe(accepted.runId,f.context)){events.push(event);if(event.type==='snapshot'&&event.run.state==='terminal')return {final:event.run,events};}throw Error('no terminal');}
  const first=await turn('first');assert.equal(first.final.outcome,deleted?'unavailable':'complete',JSON.stringify(first.final));
  if(deleted){assert(JSON.stringify(first.events).includes('Earlier lawful receipt.'));assert(!JSON.stringify(first.events).includes('Later synthesized receipt.'));assert(!JSON.stringify(first.final).includes('Blended answer'));}
  else{secondTurn=true;assert.equal((await turn('second')).final.outcome,'complete');}
  return {deleted,outcome:first.final.outcome,modelCalls:calls,streamPublicationGated:deleted,nextTurnFreshAuthority:!deleted};
 }finally{chat.shutdown();f.chat.shutdown();f.store.close();rmSync(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({case:'actual_chat_history_tool',controls:[await replay(false),await replay(true)]}));
