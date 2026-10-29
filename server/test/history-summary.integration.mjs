import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {Store} from '../dist/runtime/store.js';
import {hostMigrations} from '../dist/host/runtime.js';
import {recordHistorySession,forgetHistorySessions} from '../dist/domain/history-lifecycle.js';
import {createSummarizer} from '../dist/services/summarize.js';
import {getBySession,injectionCandidates,summarySelection,insertSummary} from '../dist/domain/summaries.js';
import {createHistoryReader} from '../dist/domain/history-reader.js';
import {createLiveSessionOwner,validateLiveProfile} from '../dist/live/index.js';
import {fakeLiveVoicePort} from '../dist/test/fixtures/fake-live-voice.js';
import {composeLiveInstruction,NAYA_LIVE_BASE} from '../dist/prompt/live-persona.js';
const dir=mkdtempSync('/tmp/didi-history-summary-'),store=new Store(dir,hostMigrations),now=Date.UTC(2026,9,19),all=['ordinary','private','sensitive'];
function seed(id,cls,eligible=true){store.transaction(tx=>{
 tx.run(`INSERT INTO live_sessions(live_session_id,owner_assistant_id,authority_epoch,idempotency_key,fingerprint,client_id,audit_id,profile_identity,prompt_identity,lifecycle,dispatch_intent,ready,journal_events,journal_bytes,journal_complete,consumer_state,terminal_outcome,terminal_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'terminal',1,1,2,70,1,'ended',?,?,?,?)`,[id,store.assistantId,store.authorityEpoch,id,'f','c','a','p','p',JSON.stringify({state:'completed'}),now,now,now]);
 tx.run(`INSERT INTO live_grants(grant_id,live_session_id,provider,model,voice,key_reference,permitted_classes,chosen_input_class,revision,granted_at) VALUES(?,?,'openai','synthetic','synthetic','synthetic',?,'ordinary',1,?)`,[id,id,JSON.stringify(all),now]);
 for(let n=0;n<2;n++)tx.run(`INSERT INTO live_journal(live_session_id,provider_sequence,kind,text,finished,payload_bytes,arrived_at) VALUES(?,?,'inputTranscription',?,1,30,?)`,[id,n,'Synthetic '+cls+' discussion '+n,now+n]);
 if(eligible)recordHistorySession(tx,id,store.assistantId,[cls],[],now);
});}
const run=(model,allowed)=>createSummarizer({store,model,modelId:'fake',modelAllowedClasses:allowed,assistantName:'Synthetic',timeZone:'UTC',now:()=>now,log:()=>{}});
let owner;
try{
 let matrixCalls=0;
 for(const source of all)for(const route of all){const id=source+'-'+route;seed(id,source);const accepted=all.slice(0,all.indexOf(route)+1);let calls=0;
 await run({generate:async request=>{calls++;matrixCalls++;assert.deepEqual(request.dataClasses,[source]);return {status:'complete',text:JSON.stringify({skip:false,summary:'Synthetic '+source+' continuity.'})};}},accepted).distill(id);
 const row=store.transaction(tx=>getBySession(tx,id));assert.equal(calls,accepted.includes(source)?1:0);assert.equal(row.status,accepted.includes(source)?'complete':'skipped');
 if(calls){assert.equal(row.dataClass,source);assert.equal(row.sourceRevision,1);}else assert.equal(row.skipReason,'summary_route_class_denied');
 }
 assert.equal(matrixCalls,6);
 seed('legacy','ordinary',false);let legacyCalls=0;await run({generate:async()=>{legacyCalls++;throw Error('unexpected');}},all).distill('legacy');assert.equal(legacyCalls,0);assert.equal(store.transaction(tx=>getBySession(tx,'legacy')).skipReason,'history_provenance_unavailable');
 store.transaction(tx=>insertSummary(tx,{liveSessionId:'legacy-summary',status:'complete',summary:'Legacy unavailable text.',endedAt:now,now}));
 assert.equal(store.transaction(tx=>summarySelection(tx,all)).coverage.legacyUnavailable,1);
 const ordinary=store.transaction(tx=>{const page=createHistoryReader(()=>now).read(tx,{ownerId:store.assistantId,runId:'synthetic',routeIdentity:'synthetic',authorityEpoch:store.authorityEpoch,revision:1,allowedClasses:['ordinary']},{query:'continuity'});return {text:JSON.stringify(page.response)};});assert(!ordinary.text.includes('private'));assert(!ordinary.text.includes('sensitive'));assert(!ordinary.text.includes('Legacy'));
 seed('race','private');let entered,release;const waiting=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 const pending=run({generate:async()=>{entered();await held;return {status:'complete',text:'{"skip":false,"summary":"Stale synthetic result."}'};}},all).distill('race');await waiting;
 store.transaction(tx=>tx.run('UPDATE history_sessions SET revision=revision+1 WHERE live_session_id=?',['race']));release();await pending;assert.equal(store.transaction(tx=>getBySession(tx,'race')),null);
 let beforeSendCalls=0;
 seed('before-send','private');
 const beforeSend=createSummarizer({store,model:{generate:async()=>{beforeSendCalls++;throw Error('unexpected');}},modelId:'fake',modelAllowedClasses:all,assistantName:'Synthetic',timeZone:'UTC',now:()=>now,
 log:event=>{if(event.event==='conversation_summary_started')store.transaction(tx=>forgetHistorySessions(tx,['before-send'],now));}});
 await beforeSend.distill('before-send');assert.equal(beforeSendCalls,0);assert.equal(store.transaction(tx=>getBySession(tx,'before-send')),null);
 seed('route-before-send','private');const mutableRoute=[...all];let revokedRouteCalls=0;
 await createSummarizer({store,model:{generate:async()=>{revokedRouteCalls++;throw Error('unexpected');}},modelId:'fake',modelAllowedClasses:mutableRoute,assistantName:'Synthetic',timeZone:'UTC',now:()=>now,
 log:event=>{if(event.event==='conversation_summary_started')mutableRoute.length=0;}}).distill('route-before-send');
 assert.equal(revokedRouteCalls,0);assert.equal(store.transaction(tx=>getBySession(tx,'route-before-send')).skipReason,'summary_route_class_denied');
 seed('ordinary-opener','ordinary');store.transaction(tx=>{
  for(const [id,text] of [['ordinary-opener','Safe canonical prior greeting.'],['legacy','Unsafe legacy prior greeting.']])tx.run(`INSERT INTO live_journal(live_session_id,provider_sequence,kind,text,finished,payload_bytes,arrived_at) VALUES(?,3,'outputTranscription',?,1,30,?)`,[id,text,now]);
 });
 const fake=fakeLiveVoicePort({provider:'openai',inputRates:[16000]});
 const profile=validateLiveProfile({provider:'openai',liveModelId:'gpt-live-1',voice:'marin',keyReference:'synthetic',route:{enabled:true,provider:'openai',modelId:'gpt-live-1',dataClasses:all},prompt:{text:composeLiveInstruction({base:NAYA_LIVE_BASE,language:'en-IN'}).text,dataClass:'ordinary'}});
 owner=createLiveSessionOwner({store,voice:fake.port,profile,now:()=>now,timeZone:'UTC'});const context={clientId:'synthetic',auditId:'synthetic',authorityEpoch:store.authorityEpoch};
 const first=owner.create({idempotencyKey:'continuity-create',inputClass:'ordinary'},context);const snapshot=()=>store.transaction(tx=>JSON.parse(tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?',[first.liveSessionId]).accepted_prompt_snapshot));
 const frozen=snapshot();assert.deepEqual(frozen.dataClasses,all);assert(frozen.system.includes('Synthetic private continuity.'));assert(frozen.system.includes('Synthetic sensitive continuity.'));assert(!frozen.system.includes('Legacy unavailable'));assert(frozen.system.includes('Safe canonical prior greeting.'));assert(!frozen.system.includes('Unsafe legacy prior greeting.'));
 store.transaction(tx=>forgetHistorySessions(tx,['private-private'],now));const attached=owner.attach({liveSessionId:first.liveSessionId},context);await attached.ready;assert.equal(fake.requests[0].system.text,frozen.system);await attached.close();
 assert.equal(store.transaction(tx=>injectionCandidates(tx,['ordinary'])).length,3);
 console.log(JSON.stringify({case:'class_bearing_summary_continuity',matrixCases:9,modelCalls:matrixCalls,legacyDispatches:legacyCalls,ordinaryFallbackSafe:true,revisionRaceSuppressed:true,beforeSendDeletionCalls:beforeSendCalls,beforeSendRouteRevokeCalls:revokedRouteCalls,startupClassUnion:all,frozenAttach:true,eligibleOpenerIncluded:true,legacyOpenerExcluded:true}));
}finally{await owner?.shutdown();store.close();rmSync(dir,{recursive:true,force:true});}
