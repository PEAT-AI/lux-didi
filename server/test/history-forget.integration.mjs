import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {Store} from '../dist/runtime/store.js';
import {Outbox} from '../dist/runtime/outbox.js';
import {createDomainPort} from '../dist/domain/facade.js';
import {liveMigrations} from '../dist/live/schema.js';
import {insertSummary,deleteSummary,getBySession,endedSessionsWithoutSummary} from '../dist/domain/summaries.js';
import {recordHistorySession, historyForgotten} from '../dist/domain/history-lifecycle.js';
import {createSummarizer} from '../dist/services/summarize.js';
const dir=mkdtempSync('/tmp/didi-history-lifecycle-');
const d=createDomainPort({outbox:Outbox,resolveTarget:()=>null});let store=new Store(dir,[...d.migrations,...liveMigrations]);
const now=Date.UTC(2026,9,19),at=now-60*86400000;
try {
 store.transaction(tx=>{
  for(const id of ['parent-voice','descendant-voice','pending-voice']){
   tx.run(`INSERT INTO live_sessions(live_session_id,owner_assistant_id,authority_epoch,idempotency_key,fingerprint,client_id,audit_id,profile_identity,prompt_identity,lifecycle,dispatch_intent,ready,journal_events,journal_bytes,journal_complete,consumer_state,terminal_outcome,terminal_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'terminal',1,1,2,70,1,'ended',?,?,?,?)`,[id,store.assistantId,store.authorityEpoch,id,'f','c','a','p','p',JSON.stringify({state:'completed'}),at,at,at]);
   tx.run(`INSERT INTO live_grants(grant_id,live_session_id,provider,model,voice,key_reference,permitted_classes,chosen_input_class,revision,granted_at) VALUES(?,?,'openai','synthetic','synthetic','synthetic','["ordinary"]','ordinary',1,?)`,[id,id,at]);
   for(const n of [1,2])tx.run(`INSERT INTO live_journal(live_session_id,provider_sequence,kind,text,finished,payload_bytes,arrived_at) VALUES(?,?,'inputTranscription',?,1,30,?)`,[id,n,'Synthetic Cobalt discussion '+n,at+n]);
  }
 });
 store.transaction(tx=>recordHistorySession(tx,'parent-voice',store.assistantId,['ordinary','private'],[],at));
 const parent=store.transaction(tx=>insertSummary(tx,{liveSessionId:'parent-voice',dataClass:'private',sourceRevision:1,status:'complete',summary:'Synthetic parent.',endedAt:at,now:at}));
 store.transaction(tx=>recordHistorySession(tx,'descendant-voice',store.assistantId,['ordinary','private'],[parent.id],at));
 const child=store.transaction(tx=>insertSummary(tx,{liveSessionId:'descendant-voice',dataClass:'private',sourceRevision:1,status:'complete',summary:'Synthetic child.',endedAt:at,now:at,injectedSummaryIds:[parent.id]}));
 store.transaction(tx=>{
  recordHistorySession(tx,'pending-voice',store.assistantId,['ordinary','private'],[parent.id],at);
 });
 let release;let entered;const enteredPromise=new Promise(r=>entered=r);
 const wait=new Promise(r=>release=r);
 const racing=createSummarizer({store,model:{generate:async()=>{entered();await wait;return {status:'complete',text:'{"skip":false,"summary":"Synthetic stale result."}'};}},modelId:'fake',modelAllowedClasses:['ordinary','private'],assistantName:'Synthetic',timeZone:'UTC',now:()=>now,log:()=>{}});
 const running=racing.distill('pending-voice');await enteredPromise;
 const removed=store.transaction(tx=>deleteSummary(tx,parent.id));assert.deepEqual(new Set(removed.deletedIds),new Set([parent.id,child.id]));
 release();await running;
 assert.equal(store.transaction(tx=>getBySession(tx,'pending-voice')),null,'in-flight result cannot recreate forgotten source');
 assert(store.transaction(tx=>historyForgotten(tx,'pending-voice')));
 store.close();store=new Store(dir,[...d.migrations,...liveMigrations]);
 const eligible=store.transaction(tx=>endedSessionsWithoutSummary(tx));assert.equal(eligible.length,0, 'forgotten sessions never reenter reconciliation');
 let calls=0;const model={generate:async()=>{calls++;return {status:'complete',text:'{"skip":false,"summary":"Synthetic recreated Cobalt summary."}'};}};
 await createSummarizer({store,model,modelId:'fake',modelAllowedClasses:['ordinary','private'],assistantName:'Synthetic',timeZone:'UTC',now:()=>now,log:()=>{}}).reconcile();
 const after=store.transaction(tx=>['parent-voice','descendant-voice'].map(id=>getBySession(tx,id)));
 assert(after.every(row=>row===null));assert.equal(calls,0);
 
 console.log(JSON.stringify({case:'deleted_summary_and_descendant_recreated',deleted:removed.deletedIds.length,reconciliationCandidates:eligible.length,fakeModelCalls:calls,restoredComplete:after.filter(Boolean).length,restartSafe:true,inflightDescendantSuppressed:true}));
} finally {store.close();rmSync(dir,{recursive:true,force:true});}
