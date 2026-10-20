import assert from 'node:assert/strict';
import { ResearchScheduler, ResearchLedger } from '../dist/tools/research.js';
import { shapeGcalList, shapeGmailList } from '../dist/tools/live-shape.js';
const summaries=[];
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const signal=()=>new AbortController().signal;
function fixture(work, configured=['chat','calendar','mail','memory','mongoose']) {
 const steps=[],progress=[],calls=[], ledger=new ResearchLedger();let now=Date.parse('2026-10-19T12:00:00Z');
 const deps={ledger,configured,now:()=>now,timeZone:'UTC',emit:e=>progress.push(e),step:e=>steps.push(e),log(){},logSource(){},logSubcall(){},logRouted(){},
 execute:async(subs,abort)=>{calls.push(subs);return work(subs,abort,{advance:ms=>now+=ms});}};
 return {steps,progress,calls,ledger,scheduler:new ResearchScheduler(deps)};
}
const result=(sub,extra={})=>({key:sub.key,name:sub.name,ok:true,text:'Synthetic evidence',originalCharacters:18,omittedCharacters:0,...extra});
function paired(h) {
 const starts=h.steps.filter(s=>s.phase==='start'),ends=h.steps.filter(s=>s.phase==='end');
 assert.equal(new Set(starts.map(s=>s.stepId)).size,starts.length);
 assert.equal(ends.length,starts.length);
 for(const start of starts)assert.equal(ends.filter(end=>end.stepId===start.stepId&&end.callId===start.callId&&end.source===start.source).length,1);
 return starts.length;
}
for(const mode of ['success','empty','failure','throw','abort','timeout','stop','supersede','close','join']) {
 const held=defer(),entered=defer();
 const h=fixture(async(subs)=>{entered.resolve();await held.promise;if(mode==='throw')throw Error('synthetic source failed');return subs.map(sub=>result(sub,mode==='failure'?{ok:false,code:'transport_unavailable',text:''}:mode==='empty'?{text:''}:{}));});
 const ctl=new AbortController(),call={action:'start',question:'Synthetic first',callId:'first-call',lookups:[{source:'chat',query:'Synthetic'}]};
 const promise=h.scheduler.call(call,ctl.signal);await entered.promise;
 assert.equal(h.steps.length,1);assert.deepEqual(h.progress.at(-1).sourcesPending,['chat']);
 assert(h.progress.every(p=>!p.sourcesPending.includes('calendar')));
 let joined;
 if(mode==='join'){joined=h.scheduler.call({...call,callId:'joined-call'},ctl.signal);assert.equal(h.calls.length,1);}
 if(mode==='abort'||mode==='timeout')ctl.abort(mode==='timeout'?new DOMException('Synthetic deadline','TimeoutError'):undefined);
 if(mode==='stop')await h.scheduler.call({action:'stop'},signal());
 if(mode==='close')h.ledger.close();
 if(mode==='supersede')await h.scheduler.call({action:'start',question:'Different question',callId:'second-call',lookups:[{source:'calendar',query:'unresolvable synthetic window'}]},signal());
 if(['abort','timeout','stop','supersede','close'].includes(mode)) {
  assert.equal(h.steps.length,2,'abort settles its step before the late source resolves');
  assert.equal(h.steps[1].errorCode,mode==='timeout'?'timeout':'cancelled');
 }
 held.resolve();await promise;if(joined)await joined;await flush();
 assert.equal(paired(h),1);assert.equal(h.calls.length,1);
 if(mode==='throw'||mode==='failure')assert.equal(h.steps[1].errorCode,'failed');
 if(mode==='success'||mode==='empty'||mode==='join')assert.equal(h.steps[1].ok,true);
 assert(h.progress.every(p=>!p.sourcesPending.includes('calendar')));
 summaries.push({case:mode,sourceExecutions:h.calls.length,steps:h.steps.length});h.ledger.close();
}
for(const source of ['calendar','mail']) {
 const h=fixture(async subs=>subs.map(sub=> {
  if(sub.name==='calendar_list_calendars')return result(sub,{text:'- Main [primary]'});
  const second=!!sub.args.pageToken;
  return result(sub,source==='calendar'?shapeGcalList({events:Array.from({length:second?5:8},(_,n)=>({id:`event-${second?8+n:n}`,start:'2026-10-19T14:00:00Z',summary:`Synthetic event ${second?8+n:n}`})),...(!second?{nextPageToken:'next'}:{})}):shapeGmailList({messages:Array.from({length:second?5:8},(_,n)=>({id:`mail-${second?8+n:n}`,headers:{Subject:`Synthetic mail ${second?8+n:n}`}})),...(!second?{nextPageToken:'next'}:{})}));
 }),[source]);
 const query=source==='calendar'?'this week':'subject:synthetic';
 const first=await h.scheduler.call({action:'start',question:'Synthetic pages',callId:'pages',lookups:[{source,query},{source,query}]},signal());
 const before=h.steps.length,wire=h.calls.length;
 assert.equal(first.canContinue,true);assert.equal(paired(h),wire);
 const next=await h.scheduler.call({action:'continue',callId:'retained',researchId:first.researchId,...(first.nextCursor?{cursor:first.nextCursor}:{})},signal());
 assert.equal(h.steps.length,before,'retained continuation has no source step');assert.equal(h.calls.length,wire);
 assert.match(JSON.stringify(next.findings),/Synthetic/);
 summaries.push({case:`${source}-pages-dedup-retained`,sourceExecutions:wire,steps:before,retainedSteps:0});h.ledger.close();
}
for(const source of ['calendar','mail']) {
 let page=0;
 const h=fixture(async subs=>subs.map(sub=>{
  if(sub.name==='calendar_list_calendars')return result(sub,{text:'- Main [primary]',calendarScope:{received:1,partial:false}});
  page++;const more=page<9;
  return result(sub,source==='calendar'?shapeGcalList({events:[{id:`event-${page}`,start:'2026-10-19T14:00:00Z',summary:`Synthetic event ${page}`}],...(more?{nextPageToken:`page-${page}`}:{})}):shapeGmailList({messages:[{id:`mail-${page}`,headers:{Subject:`Synthetic mail ${page}`}}],...(more?{nextPageToken:`page-${page}`}:{})}));
 }),[source]);
 const first=await h.scheduler.call({action:'start',callId:'first-pages',question:'Synthetic source continuation',lookups:[{source,query:source==='calendar'?'this week':'subject:synthetic'}]},signal());
 const initial=source==='calendar'?7:8;assert.equal(h.calls.length,initial);assert.equal(first.canContinue,true);assert.equal(paired(h),initial);
 const next=await h.scheduler.call({action:'continue',callId:'new-page',researchId:first.researchId,...(first.nextCursor?{cursor:first.nextCursor}:{})},signal());
 assert.equal(h.calls.length,9,JSON.stringify({source,first,next,calls:h.calls}));assert.equal(paired(h),9);assert.equal(h.steps.at(-1).callId,'new-page');
 assert.match(JSON.stringify(next.findings),/Synthetic.*9/);
 summaries.push({case:`${source}-undispatched-source-continuation`,sourceExecutions:9,steps:18});h.ledger.close();
}
{
 const h=fixture(async subs=>subs.map(sub=>sub.name==='conversation_history'?result(sub,{binding:{executionId:sub.key},historyPage:{status:'ok',hits:[{snippet:'Synthetic retained history'}],totalMatches:1,nextCursor:null}}):result(sub)));
 await h.scheduler.call({action:'start',callId:'mixed',question:'Synthetic mixed sources',lookups:[{source:'memory',query:'Synthetic history'},{source:'company',query:'Synthetic company'},{source:'replies',query:'Synthetic replies'}]},signal());
 assert.deepEqual(new Set(h.steps.map(s=>s.source)),new Set(['memory','mongoose','chat']));assert.equal(paired(h),3);
 summaries.push({case:'local-history-company-and-replies',sourceExecutions:3,steps:6});h.ledger.close();
}
console.log(JSON.stringify({canonicalResearchScheduler:true,syntheticSourceTransport:true,modelSpeech:false,results:summaries}));
