import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture,profile} from './dispatch-diagnostics.integration.mjs';
import {Store} from '../dist/runtime/store.js';
import {hostMigrations} from '../dist/host/runtime.js';
import {composeMcpRuntime} from '../dist/host/mcp.js';
import {createDomainPort} from '../dist/domain/facade.js';
import {Outbox} from '../dist/runtime/outbox.js';
import {ChatService} from '../dist/chat/index.js';
import {validatePreferences} from '../dist/prompt/index.js';
import {result} from '../dist/test/chat-process.js';
import {readDiagnosticDispatches} from '../dist/tools/dispatch.js';
import {readToolDiagnostics} from '../dist/tools/diagnostics.js';
import {diagnosticContentAccess} from '../dist/trace/content.js';
import {createLiveSessionOwner,validateLiveProfile} from '../dist/live/index.js';
import {insertSummary} from '../dist/domain/summaries.js';
const marker='SYNTHETIC_CONTEXT_MARKER';
async function replay(mode='remote',mutation='none'){
 const alternate=mutation==='seal-failure';
 const schema={type:'object',properties:{query:{type:'string'},limit:{type:'integer'},include_sensitive:{type:'boolean'}},required:['query','limit','include_sensitive'],additionalProperties:false};
 let atSecondSource=()=>{};
 const ordinary=await fixture(alternate?'search_mongoose':'search_knowledge',{},'',async()=>{atSecondSource();if(alternate)return{content:[{type:'text',text:JSON.stringify({results:[]})}]};return{content:[{type:'text',text:'Synthetic ordinary result'}],structuredContent:{result:'Synthetic ordinary result'},isError:false};},[{name:alternate?'search_mongoose':'search_knowledge',inputSchema:alternate?{type:'object',properties:{query:{type:'string'},limit:{type:'integer'}},required:['query'],additionalProperties:false}:schema,annotations:{readOnlyHint:true}}]);
 const sensitive=await fixture(alternate?'search_knowledge':'get_insight',alternate?{query:'Synthetic first query',limit:1,include_sensitive:false}:{ids:[101]},mutation==='unsupported-source'?{content:[{type:'text',text:marker}],structuredContent:{unsupported:'Synthetic unmatched metadata'}}:marker);
 const dir=mkdtempSync('/tmp/didi-context-diagnostic-'),config=join(dir,'config');mkdirSync(config,{mode:0o700});
 const endpoint=(id,server,unknownClass)=>({id,connector:alternate&&id==='ordinary'?'mongoose':'lux-knowledge',transport:'streamable-http',url:server.url,account:id,resource:id,credentialRef:null,enabled:true,allowEgress:true,unknownClass});
 writeFileSync(join(config,'mcp.json'),JSON.stringify({schemaVersion:1,grantMode:'owner-trusted-reads',endpoints:[endpoint('ordinary',ordinary,'ordinary'),endpoint('sensitive',sensitive,'sensitive')]}),{mode:0o600});
 let store=new Store(join(dir,'state'),hostMigrations),chat,mcp,live,accepted;
 try{
  const owner=store.assistantId,domain=createDomainPort({outbox:Outbox}),context={assistantId:owner,authorityEpoch:store.authorityEpoch,clientId:'synthetic',now:new Date().toISOString()};
  mcp=await composeMcpRuntime({store,ownerId:owner,configDir:config,lookupAuthority:async id=>chat?.lookupAuthority(id)??null});
  let modelCalls=0,intents=0,failed=false,recovered=false,originId,parentId,summarySession;
  const transaction=store.transaction.bind(store);
  store.transaction=body=>transaction(tx=>body(new Proxy(tx,{get(target,key){if(key==='run')return(sql,params)=>{
   if(mutation==='seal-failure'&&!failed&&sql.startsWith('UPDATE tool_dispatches SET state=?')){failed=true;throw Error('synthetic_first_dispatch_seal_failed');}
   if(sql.startsWith('UPDATE chat_runs SET trace=?')&&['write-failure','write-recovery','write-through-shutdown','write-terminal-only','write-crash'].includes(mutation)&&!failed){const next=JSON.parse(params[0]);if(next.diagnostic?.epochs?.at(-1).dataClasses.includes('sensitive')){failed=true;throw Error('synthetic_storage_failure');}}
   if((mutation==='write-through-shutdown'||mutation==='write-terminal-only'||mutation==='write-crash'||mutation==='write-recovery'&&failed&&!recovered)&&sql.startsWith('UPDATE chat_runs SET trace=json_set'))throw Error('synthetic_withholding_storage_failure');
   if(mutation==='write-terminal-only'&&failed&&sql.startsWith('UPDATE chat_runs SET trace=?'))throw Error('synthetic_all_separate_trace_writes_failed');
   if(sql.startsWith('INSERT INTO tool_calls')){intents++;if(intents===2){const capture=JSON.parse(target.get('SELECT trace FROM chat_runs WHERE run_id=?',[accepted.runId]).trace).diagnostic;if(failed)assert.equal(diagnosticContentAccess(target,accepted.runId,{ownerId:owner,allowedClasses:classes}).state,'denied');else assert(capture.withheld||capture.epochs.at(-1).dataClasses.includes('sensitive'),'capture precedes derivative intent');}}
   return target.run(sql,params);
  };const value=target[key];return typeof value==='function'?value.bind(target):value;}})));
  const model={generate:async request=>{modelCalls++;assert(modelCalls<=3);const responses=request.contents.flatMap(c=>c.parts.flatMap(p=>p.functionResponse?[p.functionResponse]:[]));const call=(name,args)=>({...result(request,'complete',''),providerContent:{role:'model',parts:[{functionCall:{id:'call-'+modelCalls,name,args}}]}});
   if(!responses.length)return mode==='remote'?(alternate?call('search_knowledge',{query:'Synthetic first query',limit:1}):call('get_insight',{ids:[101]})):call('conversation_history',{query:marker,limit:20});
   if(responses.length===1){if(mutation==='write-crash'){assert(failed);const stored=store.transaction(tx=>JSON.parse(tx.get('SELECT trace FROM chat_runs WHERE run_id=?',[accepted.runId]).trace).diagnostic);assert.equal(stored.withheld,false);assert.equal(stored.sealed,false);process.stdout.write(JSON.stringify({dir,runId:accepted.runId,owner})+'\n',()=>process.exit(0));await new Promise(()=>{});}
   assert(request.dataClasses.includes('sensitive'));assert(JSON.stringify(responses).includes(marker));return call(alternate?'search_mongoose':'search_knowledge',{query:marker,limit:1});}
   return result(request,'complete','Synthetic completed answer');}};
  const classes=['ordinary','private','sensitive'];
  const cfg={store,domain,model,tools:mcp,route:{provider:'gemini',model:'synthetic',available:true,allows:c=>c.every(v=>classes.includes(v)),endpoint:'https://generativelanguage.googleapis.com',apiVersion:'v1beta',keyReference:'synthetic',allowedClasses:classes},preferences:validatePreferences({schemaVersion:1,ownerId:owner,dataClass:'ordinary',language:'en-US',register:'plain',humor:'off',verbosity:'brief'},owner),classify:(subject,tx)=>{if(subject.kind==='recall')return null;const label=domain.getRoutingLabel(tx,subject);return label.dataClass==='unknown'?null:{ownerId:owner,dataClass:label.dataClass,revision:label.revision};},context:{sources:[],budgets:{trustedChars:60000,contextChars:12000,historyChars:12000}},deadlineMs:5000};
  chat=new ChatService(cfg);chat.recover(context);
  if(mode==='history'){
   parentId=chat.enroll({title:'Synthetic separate history',timeZone:'UTC',idempotencyKey:randomUUID()},context).sessionId;
   originId=store.transaction(tx=>domain.execute(tx,'appendEntry',{sessionId:parentId,text:marker,role:'user',timeZone:'UTC'},context,{writer:'capture',dataClass:'private'})).id;
   store.transaction(tx=>domain.correctRoutingLabel(tx,{subject:{kind:'entry',id:originId},expectedRevision:1,dataClass:'sensitive'},context));
  }
  if(mode==='summary'){
   live=createLiveSessionOwner({store,voice:{},profile:validateLiveProfile({...profile,route:{...profile.route,dataClasses:['ordinary','private','sensitive']}}),timeZone:'UTC'});summarySession=live.create({inputClass:'sensitive',idempotencyKey:'synthetic-summary'},{clientId:'synthetic',auditId:'synthetic',authorityEpoch:store.authorityEpoch}).liveSessionId;
   store.transaction(tx=>insertSummary(tx,{liveSessionId:summarySession,status:'complete',summary:marker,dataClass:'sensitive',sourceRevision:1,endedAt:1,now:1}));
  }
  const session=chat.enroll({title:'Synthetic current conversation',timeZone:'UTC',idempotencyKey:randomUUID()},context).sessionId;
  const revoke=()=>{const row=store.transaction(tx=>tx.get("SELECT policy_json,policy_sha256 FROM tool_connections WHERE connection_id='sensitive'"));const policy=JSON.parse(row.policy_json);mcp.owner.applyConnectionIntent({expectedPolicySha256:row.policy_sha256,policy:{...policy,generation:policy.generation+1,enabled:false}});};
  if(mutation==='before-seal')atSecondSource=revoke;
  if(mutation==='write-recovery')atSecondSource=()=>{recovered=true;};
  accepted=chat.accept({sessionId:session,text:'Synthetic source question',idempotencyKey:randomUUID()},context);
  let finished;for await(const e of chat.subscribe(accepted.runId,context))if(e.type==='snapshot'&&e.run.state==='terminal'){finished=e.run;break;}
  if(mutation!=='before-seal')assert.equal(finished.outcome,'complete');
  assert.equal(ordinary.calls.length,1);assert.equal(modelCalls,mutation==='before-seal'?2:3);
  const authority={ownerId:owner,allowedClasses:classes};
  const report=()=>store.transaction(tx=>readDiagnosticDispatches(tx,accepted.runId,authority));
  const access=()=>store.transaction(tx=>diagnosticContentAccess(tx,accepted.runId,authority));
  if(mutation==='before-seal'){const rows=store.transaction(tx=>tx.all('SELECT state,source_json FROM tool_dispatches WHERE run_id=? ORDER BY started_at',[accepted.runId]));assert.equal(rows.at(-1).state,'unavailable');assert.equal(rows.at(-1).source_json,null);assert.equal(access().state,'denied');}
  else if(['write-failure','write-recovery','write-through-shutdown','write-terminal-only','unsupported-source','seal-failure'].includes(mutation)){
   if(mutation!=='unsupported-source')assert(failed);if(mutation==='seal-failure'){const first=store.transaction(tx=>tx.get('SELECT result_json FROM tool_calls WHERE run_id=? ORDER BY rowid LIMIT 1',[accepted.runId]));assert.equal(JSON.parse(first.result_json).hostEvidenceRequired,undefined);revoke();}assert.equal(access().state,'denied');const calls=store.transaction(tx=>tx.all('SELECT input_json FROM tool_calls WHERE run_id=? ORDER BY rowid',[accepted.runId]));assert.equal(calls.at(-1).input_json,null);assert.equal(store.transaction(tx=>readToolDiagnostics(tx,accepted.runId,{content:true,authority})).contentAccess.state,'denied');
  }else{
   assert.equal(access().state,'allowed');assert(report().dispatches.every(row=>row.read_state==='allowed'),'earlier and later sealed epochs both readable');
   const denied=store.transaction(tx=>readDiagnosticDispatches(tx,accepted.runId,{ownerId:owner,allowedClasses:['ordinary','private']}));assert.equal(denied.access.state,'denied');
   const saved=store.transaction(tx=>tx.get('SELECT trace FROM chat_runs WHERE run_id=?',[accepted.runId]).trace);
   for(const corrupt of [v=>v.diagnostic.version=1,v=>v.diagnostic.epochs.at(-1).dataClasses=['ordinary','private'],v=>v.diagnostic.epochs.at(-1).origins[0].result.id='foreign-result',v=>v.diagnostic.epochs.at(-1).origins[0].sourceDispatchRefs=['foreign-dispatch']]){
    const value=JSON.parse(saved);corrupt(value);store.transaction(tx=>tx.run('UPDATE chat_runs SET trace=? WHERE run_id=?',[JSON.stringify(value),accepted.runId]));assert.equal(access().state,'denied');store.transaction(tx=>tx.run('UPDATE chat_runs SET trace=? WHERE run_id=?',[saved,accepted.runId]));
   }
   if(mutation==='revoke')revoke();
   if(mutation==='entry-delete')store.transaction(tx=>domain.execute(tx,'deleteEntry',{id:originId},context));
   if(mutation==='parent-label-delete'){assert.throws(()=>store.transaction(tx=>tx.run('DELETE FROM sessions WHERE id=?',[parentId])),/FOREIGN KEY/);store.transaction(tx=>tx.run("DELETE FROM routing_labels WHERE subject_kind='session' AND subject_id=?",[parentId]));}
   if(mutation==='entry-relabel'||mutation==='parent-relabel')store.transaction(tx=>domain.correctRoutingLabel(tx,{subject:{kind:mutation==='entry-relabel'?'entry':'session',id:mutation==='entry-relabel'?originId:parentId},expectedRevision:mutation==='entry-relabel'?2:1,dataClass:'ordinary'},context));
   if(mutation==='summary-revision')store.transaction(tx=>tx.run('UPDATE history_sessions SET revision=revision+1 WHERE live_session_id=?',[summarySession]));
  }
  chat.shutdown();await live?.shutdown();live=undefined;await mcp.close();mcp=undefined;store.close();store=new Store(join(dir,'state'),hostMigrations);
  const expected=mutation==='none'?'allowed':'denied';assert.equal(access().state,expected);
  if(expected==='allowed'){const reopened=report();assert(reopened.dispatches.every(row=>row.read_state==='allowed'));assert(reopened.dispatches.find(row=>row.tool_name==='search_knowledge').arguments_json.includes(marker));}
  const cli=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/didi-timeline',import.meta.url)),accepted.runId,'--data-dir',join(dir,'state'),'--json','--content'],{encoding:'utf8',maxBuffer:4_000_000}));assert.equal(cli.tools.contentAccess.state,expected,'fresh-process durable content gate');
  if(expected==='denied')assert(!JSON.stringify(cli.tools).includes(marker),'no requested/effective/bounded/full content fallback');
  return{mode,mutation,modelCalls,wire:ordinary.calls.length+sensitive.calls.length,reopened:expected};
 }finally{chat?.shutdown();await live?.shutdown();await mcp?.close();store.close();await ordinary.close();await sensitive.close();rmSync(dir,{recursive:true,force:true});}
}
async function crashRecovery(){
 const receipt=JSON.parse(execFileSync(process.execPath,[fileURLToPath(import.meta.url)],{env:{...process.env,DIDI_R12_CRASH_CHILD:'1'},encoding:'utf8',timeout:10000}).trim());
 let store;
 try{
  store=new Store(join(receipt.dir,'state'),hostMigrations);
  const owner=store.assistantId,domain=createDomainPort({outbox:Outbox}),classes=['ordinary','private','sensitive'];assert.equal(owner,receipt.owner);
  const authority={ownerId:owner,allowedClasses:classes},access=()=>store.transaction(tx=>diagnosticContentAccess(tx,receipt.runId,authority));
  const stale=store.transaction(tx=>JSON.parse(tx.get('SELECT trace FROM chat_runs WHERE run_id=?',[receipt.runId]).trace).diagnostic);
  assert.equal(stale.withheld,false);assert.equal(stale.sealed,false);assert.deepEqual(stale.epochs.at(-1).dataClasses,['ordinary','private']);assert.equal(access().state,'denied','crash loses process liveness, never restores stale capture');
  const context={assistantId:owner,authorityEpoch:store.authorityEpoch,clientId:'synthetic',now:new Date().toISOString()};
  const chat=new ChatService({store,domain,route:{provider:'gemini',model:'synthetic',available:true,allows:c=>c.every(v=>classes.includes(v)),endpoint:'https://generativelanguage.googleapis.com',apiVersion:'v1beta',keyReference:'synthetic',allowedClasses:classes},preferences:validatePreferences({schemaVersion:1,ownerId:owner,dataClass:'ordinary',language:'en-US',register:'plain',humor:'off',verbosity:'brief'},owner),classify:(subject,tx)=>{if(subject.kind==='recall')return null;const label=domain.getRoutingLabel(tx,subject);return label.dataClass==='unknown'?null:{ownerId:owner,dataClass:label.dataClass,revision:label.revision};},context:{sources:[],budgets:{trustedChars:60000,contextChars:12000,historyChars:12000}}});
  chat.recover(context);assert.equal(chat.get(receipt.runId,context).state,'terminal');assert.equal(access().state,'denied');chat.shutdown();
  const cli=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/didi-timeline',import.meta.url)),receipt.runId,'--data-dir',join(receipt.dir,'state'),'--json','--content'],{encoding:'utf8'}));assert.equal(cli.tools.contentAccess.state,'denied');assert(!JSON.stringify(cli.tools).includes(marker));
  return{mode:'actual-abrupt-child-exit',mutation:'failed-capture-and-withholding-writes',recovered:'terminal_without_seal',freshProcess:'denied'};
 }finally{store?.close();rmSync(receipt.dir,{recursive:true,force:true});}
}
if(process.env.DIDI_R12_CRASH_CHILD==='1')await replay('remote','write-crash');
else{
 const cases=[];
 for(const [mode,mutation] of [['remote','none'],['remote','revoke'],['remote','before-seal'],['remote','write-failure'],['remote','write-recovery'],['remote','write-through-shutdown'],['remote','write-terminal-only'],['remote','unsupported-source'],['remote','seal-failure'],['history','none'],['history','entry-delete'],['history','parent-label-delete'],['history','entry-relabel'],['history','parent-relabel'],['summary','summary-revision']])cases.push(await replay(mode,mutation));
 cases.push(await crashRecovery());
 console.log(JSON.stringify({case:'monotonic_actual_chat_diagnostic_context',cases}));
}
