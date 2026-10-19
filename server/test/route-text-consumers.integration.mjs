import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../dist/runtime/store.js';
import {hostMigrations} from '../dist/host/runtime.js';
import {loadProviderConfig} from '../dist/config/index.js';
import {boundTextModel} from '../dist/host/provider-binding.js';
import {createGeminiSelector} from '../dist/tools/research.js';
import {createSummarizer} from '../dist/services/summarize.js';
import {recordHistorySession,forgetHistorySessions} from '../dist/domain/history-lifecycle.js';
import {getBySession} from '../dist/domain/summaries.js';
const dir=mkdtempSync('/tmp/didi-text-consumers-'),configDir=join(dir,'config');mkdirSync(configDir,{mode:0o700});const store=new Store(join(dir,'store'),hostMigrations),classes=['ordinary','private','sensitive'],now=Date.now();
const put=(name,value)=>writeFileSync(join(configDir,name),JSON.stringify(value),{mode:0o600});
const scope={provider:'gemini',modelId:'gemini-synthetic',endpoint:'https://generativelanguage.googleapis.com',apiVersion:'v1beta',keyReference:'gemini-primary',allowedClasses:classes};
const secret={schemaVersion:2,keyReference:scope.keyReference,key:'SYNTHETIC_TEXT_CONSUMERS_254',configuredAccount:'synthetic',routeScope:scope,bindingGeneration:'before'};
put('profile.json',{schemaVersion:1,enabled:true,provider:'gemini',modelId:scope.modelId,keyReference:scope.keyReference,dataClasses:classes,preferences:{dataClass:'ordinary',language:'en-US',register:'plain',humor:'off',verbosity:'brief'}});put('gemini-primary.json',secret);
function seed(id){store.transaction(tx=>{tx.run(`INSERT INTO live_sessions(live_session_id,owner_assistant_id,authority_epoch,idempotency_key,fingerprint,client_id,audit_id,profile_identity,prompt_identity,lifecycle,dispatch_intent,ready,journal_events,journal_bytes,journal_complete,consumer_state,terminal_outcome,terminal_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'terminal',1,1,2,70,1,'ended',?,?,?,?)`,[id,store.assistantId,store.authorityEpoch,id,'f','c','a','p','p',JSON.stringify({state:'completed'}),now,now,now]);for(let n=0;n<2;n++)tx.run(`INSERT INTO live_journal(live_session_id,provider_sequence,kind,text,finished,payload_bytes,arrived_at) VALUES(?,?,'inputTranscription',?,1,30,?)`,[id,n,'Synthetic preserved decision '+n,now+n]);recordHistorySession(tx,id,store.assistantId,['private'],[],now);});}
let calls=0;const requests=[];let beforeResponse;
const transport=async(url,init)=>{calls++;assert(url.includes('/v1beta/models/gemini-synthetic:'));assert.equal(init.headers['x-goog-api-key'],secret.key);const body=JSON.parse(init.body);requests.push(body);await beforeResponse?.();const text=body.systemInstruction.parts[0].text.startsWith('You choose')?JSON.stringify({questionClass:'quick_fact',actions:[{kind:'knowledge_search',query:'Mira launch'}],pUseful:{knowledge_search:0.9}}):JSON.stringify({skip:false,summary:'Synthetic preserved decision.'});return new Response('data: '+JSON.stringify({candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP'}]})+'\n\n',{headers:{'content-type':'text/event-stream'}});};
try{
 const loaded=loadProviderConfig({configDir,ownerId:store.assistantId});assert.equal(loaded.status,'ready');const bound=boundTextModel(configDir,loaded,{transport});const selector=createGeminiSelector(bound.model);const selection={question:'Mira launch',configured:['knowledge'],completed:[],candidates:['knowledge_search']};
 const summarizer=createSummarizer({store,model:bound.model,modelId:scope.modelId,modelAllowedClasses:classes,assistantName:'Synthetic',timeZone:'UTC',now:()=>now,log:()=>{}});
 seed('first');const parallel=await Promise.all([selector.select(selection,new AbortController().signal),summarizer.distill('first')]);assert.equal(parallel[0].actions[0].query,'Mira launch');assert.equal(store.transaction(tx=>getBySession(tx,'first')).status,'complete');assert.equal(calls,2);
 seed('deleted');beforeResponse=()=>store.transaction(tx=>forgetHistorySessions(tx,['deleted'],now));await summarizer.distill('deleted');assert.equal(store.transaction(tx=>getBySession(tx,'deleted')),null);beforeResponse=undefined;
 put('gemini-primary.json',{...secret,bindingGeneration:'after'});const before=calls;seed('rotated');assert.equal(await selector.select(selection,new AbortController().signal),null);await summarizer.distill('rotated');assert.equal(calls,before);assert.equal(store.transaction(tx=>getBySession(tx,'rotated')).status,'failed');
 console.log(JSON.stringify({case:'actual_bound_text_consumers',parallelSelectorAndSummary:true,sharedExactRoute:true,sourceDeletionStillGated:true,rotatedReceiptBlocksBoth:true,transportCalls:calls}));
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
