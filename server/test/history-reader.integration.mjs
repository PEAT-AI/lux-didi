import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {Store} from '../dist/runtime/store.js';
import {domainMigrations} from '../dist/domain/schema.js';
import {liveMigrations} from '../dist/live/schema.js';
import {createHistoryReader,historyEvidenceCurrent} from '../dist/domain/history-reader.js';
import {recordHistorySession,forgetHistorySessions} from '../dist/domain/history-lifecycle.js';
import {createSession,appendEntry,deleteEntry} from '../dist/domain/memory.js';
import {correct} from '../dist/domain/labels.js';
import {insertSummary} from '../dist/domain/summaries.js';
const dir=mkdtempSync('/tmp/didi-history-reader-');const store=new Store(dir,[...domainMigrations,...liveMigrations]);
const now=Date.UTC(2026,9,19),old=now-60*86400000,clock={now:()=>now};
const scope={ownerId:store.assistantId,runId:'synthetic-run',routeIdentity:'synthetic-route',authorityEpoch:store.authorityEpoch,revision:1,allowedClasses:['ordinary','private','sensitive']};
const reader=createHistoryReader(()=>now);const read=(args,s=scope)=>store.transaction(tx=>reader.read(tx,s,args));
function live(id,text,cls='ordinary',eligible=true,at=old){store.transaction(tx=>{
 tx.run(`INSERT INTO live_sessions(live_session_id,owner_assistant_id,authority_epoch,idempotency_key,fingerprint,client_id,audit_id,profile_identity,prompt_identity,lifecycle,dispatch_intent,ready,journal_events,journal_bytes,journal_complete,consumer_state,terminal_outcome,terminal_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'terminal',1,1,1,70,1,'ended',?,?,?,?)`,[id,store.assistantId,store.authorityEpoch,id,'f','c','a','p','p',JSON.stringify({state:'completed'}),at,at,at]);
 tx.run(`INSERT INTO live_journal(live_session_id,provider_sequence,kind,text,finished,payload_bytes,arrived_at) VALUES(?,1,'inputTranscription',?,1,?,?)`,[id,text,text.length,at]);
 if(eligible)recordHistorySession(tx,id,store.assistantId,[cls],[],at);
});}
function entry(id,text,ec='ordinary',pc='ordinary',imported=false){store.transaction(tx=>{
 createSession(tx,{title:'Synthetic',startedAt:now,timeZone:'UTC'},clock,id+'-session');
 appendEntry(tx,{sessionId:id+'-session',text,capturedAt:now,timeZone:'UTC',...(imported?{source:{label:'Synthetic import',provider:'import-history',externalId:'synthetic-import',availability:'present'}}:{})},clock,id);
 if(ec)correct(tx,{subject:{kind:'entry',id},expectedRevision:0,dataClass:ec},now);
 if(pc)correct(tx,{subject:{kind:'session',id:id+'-session'},expectedRevision:0,dataClass:pc},now);
});}
try{
 live('old','Mira decided the Cobalt launch uses violet flags.');
 store.transaction(tx=>insertSummary(tx,{liveSessionId:'old',status:'complete',summary:'A routine planning discussion.',endedAt:old,now}));
 live('legacy','Mira legacy unproven.', 'ordinary',false);
 live('private','Mira private decision.','private');live('sensitive','Mira sensitive decision.','sensitive');
 for(let i=0;i<60;i++)entry('new-'+i,'New unrelated groceries '+i);
 entry('private-parent','Mira parent decision.','ordinary','private');entry('unknown','Mira unknown.',null);entry('import','Mira imported derived note.','ordinary','ordinary',true);
 const ordinary={...scope,allowedClasses:['ordinary']};const found=read({query:'Cobalt'},ordinary);
 assert.equal(found.response.hits.length,1);assert.equal(found.response.hits[0].date,new Date(old).toISOString());assert.equal(found.response.coverage.legacyRawUnavailable,true);
 const detail=read({recordRef:found.response.hits[0].recordRef},ordinary);assert.match(detail.response.text,/violet flags/);assert.equal(detail.response.derivation,'automatic_transcription');
 assert.equal(read({query:'unmatched-wombat'}).response.hits.length,0);
 assert.equal(read({query:'Mira'},ordinary).response.hits.length,2);assert.equal(read({query:'Mira'}).response.hits.length,5);
 assert.equal(read({query:'',from:new Date(old).toISOString(),to:new Date(old+1).toISOString()}).response.hits.length,3);
 const imported=read({query:'imported'}).response.hits[0];assert.equal(imported.derivation,'imported_note');
 assert.equal(read({query:'Mira'},{...scope,allowedClasses:['ordinary','private']}).response.hits.length,4);
 entry('long','Long synthetic '+ 'Cobalt '.repeat(2000));
 const long=read({query:'Long synthetic'}).response.hits.find(hit=>hit.sourceId==='long');
 let chunk=read({recordRef:long.recordRef}),body=chunk.response.text;
 assert.equal(chunk.response.complete,false);
 while(chunk.response.nextCursor){chunk=read({cursor:chunk.response.nextCursor});body+=chunk.response.text;}
 assert.equal(body,'Long synthetic '+ 'Cobalt '.repeat(2000));
 const page=read({query:'groceries',limit:7});let hits=[...page.response.hits],cursor=page.response.nextCursor;entry('insert-late','New unrelated groceries late');
 while(cursor){const next=read({cursor});hits.push(...next.response.hits);cursor=next.response.nextCursor;}
 assert.equal(hits.length,60);assert.equal(new Set(hits.map(h=>h.sourceId)).size,60);
 const stale=read({query:'groceries',limit:1});store.transaction(tx=>deleteEntry(tx,'new-5',new Date(now).toISOString(),'synthetic'));
 assert.equal(read({cursor:stale.response.nextCursor}).response.status,'history_snapshot_invalidated');
 const label=read({query:'parent'});store.transaction(tx=>correct(tx,{subject:{kind:'session',id:'private-parent-session'},expectedRevision:1,dataClass:'sensitive'},now));
 assert.equal(store.transaction(tx=>historyEvidenceCurrent(tx,scope.ownerId,label.evidence)),false);
 const forgotten=read({query:'Cobalt'});store.transaction(tx=>forgetHistorySessions(tx,['old'],now));
 assert.equal(store.transaction(tx=>historyEvidenceCurrent(tx,scope.ownerId,forgotten.evidence)),false);assert.equal(read({recordRef:found.response.hits[0].recordRef},ordinary).response.status,'history_snapshot_invalidated');
 assert.equal(read({recordRef:imported.recordRef},{...scope,runId:'other-run'}).response.status,'history_reference_unavailable');
 console.log(JSON.stringify({case:'canonical_history_reader',oldDays:60,olderRelevantSurvivesNewerUnrelated:true,ordinaryMiraHits:2,allClassMiraHits:5,legacyUnavailable:true,unknownExcluded:true,stablePagedRecords:60,deleteInvalidates:true,relabelInvalidates:true,exactImportProvenance:true,crossRunDenied:true,fullDetailCharacters:body.length,summaryOmittedDecisionRecovered:true}));
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
