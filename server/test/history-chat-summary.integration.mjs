import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {openFixture,result} from '../dist/test/chat-process.js';
import {recordHistorySession,forgetHistorySessions} from '../dist/domain/history-lifecycle.js';
import {insertSummary} from '../dist/domain/summaries.js';
const all=['ordinary','private','sensitive'];
async function replay(deleted){
 const dir=mkdtempSync('/tmp/didi-chat-summary-');let fixture,seen;
 const model={generate:async(request,control)=>{seen=request;assert(request.system.includes('Synthetic sensitive continuity.'));assert(request.dataClasses.includes('sensitive'));if(deleted){control.onEvent?.({type:'text',text:'Already delivered synthetic chunk.',provisional:true});fixture.store.transaction(tx=>forgetHistorySessions(tx,['source'],1));control.onEvent?.({type:'text',text:'Later invalid synthetic chunk.',provisional:true});}return result(request,'complete','Synthetic answer based on prior discussion.');}};
 fixture=openFixture(dir,model,{route:{provider:'synthetic',model:'counting',available:true,allows:()=>true,endpoint:'https://example.invalid',apiVersion:'v1',keyReference:'synthetic',allowedClasses:all}});
 try{
  fixture.store.transaction(tx=>{recordHistorySession(tx,'source',fixture.store.assistantId,all,[],0);insertSummary(tx,{liveSessionId:'source',dataClass:'sensitive',sourceRevision:1,status:'complete',summary:'Synthetic sensitive continuity.',endedAt:0,now:0});});
  const session=fixture.createSession();const accepted=fixture.chat.accept({sessionId:session.id,text:'Recall the prior discussion',idempotencyKey:'synthetic'},fixture.context);
  let final;const events=[];for await(const event of fixture.chat.subscribe(accepted.runId,fixture.context)){events.push(event);if(event.type==='snapshot'&&event.run.state==='terminal'){final=event.run;break;}}
  assert(seen);assert.equal(final.outcome,deleted?'unavailable':'complete');if(deleted){assert(!JSON.stringify(final).includes('Synthetic answer'));assert(JSON.stringify(events).includes('Already delivered synthetic chunk.'));assert(!JSON.stringify(events).includes('Later invalid synthetic chunk.'));}
  return {deleted,outcome:final.outcome,classes:seen.dataClasses,priorStreamReceiptPreserved:deleted,laterStreamSuppressed:deleted};
 }finally{fixture.chat.shutdown();fixture.store.close();rmSync(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({case:'chat_summary_egress_and_final_gate',controls:[await replay(false),await replay(true)]}));
